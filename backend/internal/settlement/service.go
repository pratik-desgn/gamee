package settlement

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"gamee-backend/internal/payoutreview"
	pkgsolana "gamee-backend/pkg/solana"
)

// defaultJackpotTier is the fallback used only if a session's own tier
// column is somehow empty (e.g. a pre-migration row). Every session now
// carries its own tier (set at ticket-confirm time, copied onto the session
// at /spin — see ticket.verifyAndConfirm and gamesession.HandleSpin), and
// settlement reads and uses that instead. Today every real ticket is tier
// "small" (the frontend only ever funds the small vault at buy time), so in
// practice this still resolves to "small" — see docs/NEXT-STEPS.md's
// "Jackpot tiers — increment 1" entry for the follow-up that lets buyers
// fund other tiers.
const defaultJackpotTier = "small"

// Service handles settlement of winning game sessions by reading replay
// verdicts and (when the contract is deployed) calling settle_session
// on-chain with the verifier key.
type Service struct {
	db              *pgxpool.Pool
	rdb             *redis.Client
	solana          *pkgsolana.Client
	programID       string
	usdcMint        string
	verifierKeyPath string
	// cosignerKeyPaths are additional verifier_set member keypairs
	// (contracts/programs/gamee/src/state/verifier_set.rs) that co-sign
	// settle_session alongside the primary verifier to meet the on-chain
	// quorum threshold. May be empty (threshold-1 verifier_set).
	cosignerKeyPaths []string
	settleInterval   time.Duration
	mu               sync.Mutex
	activeSettles    map[string]context.CancelFunc
	// Off-chain mode: when true, mark sessions won without on-chain tx.
	// Set to false after contract is deployed and program ID is set.
	devMode bool
	// review gates payouts above its threshold behind manual staff
	// approval instead of letting settle() pay them automatically.
	review *payoutreview.Service

	keypairOnce sync.Once
	keypair     *pkgsolana.Keypair
	keypairErr  error

	cosignersOnce sync.Once
	cosigners     []*pkgsolana.Keypair
	cosignersErr  error
}

// NewService creates a settlement worker. review may be nil in tests that
// don't care about the large-payout hold path — settle() then pays everything.
// cosignerKeyPaths may be nil/empty — see Service.cosignerKeyPaths.
func NewService(db *pgxpool.Pool, rdb *redis.Client, solanaRPC, programID, usdcMint, verifierKeyPath string, cosignerKeyPaths []string, review *payoutreview.Service) *Service {
	return &Service{
		db:               db,
		rdb:              rdb,
		solana:           pkgsolana.NewClient(solanaRPC, "confirmed"),
		programID:        programID,
		usdcMint:         usdcMint,
		verifierKeyPath:  verifierKeyPath,
		cosignerKeyPaths: cosignerKeyPaths,
		settleInterval:   5 * time.Second,
		activeSettles:    make(map[string]context.CancelFunc),
		devMode:          programID == "" || programID == "GAMEE11111111111111111111111111111111111111",
		review:           review,
	}
}

// Start begins polling for sessions that need settlement.
func (s *Service) Start(ctx context.Context) {
	log.Printf("[settlement] starting settlement worker (devMode=%v)", s.devMode)
	if s.devMode {
		log.Println("[settlement] WARNING: running in dev mode — sessions marked won off-chain only")
	}

	ticker := time.NewTicker(s.settleInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("[settlement] shutting down")
			return
		case <-ticker.C:
			s.processPending(ctx)
		}
	}
}

// PendingSession represents a session ready for settlement.
type PendingSession struct {
	SessionID      string `json:"session_id"`
	Wallet         string `json:"wallet"`
	GameID         string `json:"game_id"`
	VerifiedScore  int    `json:"verified_score"`
	TargetScore    int    `json:"target_score"`
	TicketID       string `json:"ticket_id"`
	VerifierOutput string `json:"verifier_output"`
	Tier           string `json:"tier"`
}

// jackpotTier returns ps.Tier, falling back to defaultJackpotTier if the
// session's tier column is somehow empty (should not happen post-migration —
// tier has a NOT NULL DEFAULT 'small' — but keeps settlement from deriving a
// bogus empty-string vault PDA if it ever does).
func (ps PendingSession) jackpotTier() string {
	if ps.Tier == "" {
		return defaultJackpotTier
	}
	return ps.Tier
}

// processPending queries for un-settled winning sessions and settles them.
func (s *Service) processPending(ctx context.Context) {
	// Find sessions where the replay verdict is 'match' AND the sim itself
	// declared the session won (r.won — each game's own win rules, surfaced
	// by the verifier; NOT a raw score-vs-target comparison, which breaks on
	// per-game score scales) AND the game_session hasn't been settled yet.
	// game_sessions has no wallet column — the buyer wallet lives on the ticket.
	rows, err := s.db.Query(ctx, `
		SELECT r.session_id, t.wallet_address, gs.game_id,
		       r.verified_score, gs.target_score, gs.ticket_id,
		       r.verified_score as verifier_output, gs.tier
		FROM replays r
		JOIN game_sessions gs ON gs.id = r.session_id
		JOIN tickets t ON t.id = gs.ticket_id
		WHERE r.verdict = 'match'
		  AND r.won = TRUE
		  AND gs.result = 'pending'
		LIMIT 10
	`)
	if err != nil {
		log.Printf("[settlement] query error: %v", err)
		return
	}
	defer rows.Close()

	var sessions []PendingSession
	for rows.Next() {
		var ps PendingSession
		if err := rows.Scan(&ps.SessionID, &ps.Wallet, &ps.GameID,
			&ps.VerifiedScore, &ps.TargetScore, &ps.TicketID, &ps.VerifierOutput, &ps.Tier); err != nil {
			log.Printf("[settlement] scan error: %v", err)
			continue
		}
		sessions = append(sessions, ps)
	}

	for _, ps := range sessions {
		s.settle(ctx, ps)
	}
}

// settle processes a single winning session.
func (s *Service) settle(ctx context.Context, ps PendingSession) {
	log.Printf("[settlement] settling session %s (wallet=%s, score=%d/%d, game=%s)",
		ps.SessionID, ps.Wallet, ps.VerifiedScore, ps.TargetScore, ps.GameID)

	if s.review != nil {
		payoutEstimate, err := s.estimatePayout(ctx, ps.jackpotTier())
		if err != nil {
			log.Printf("[settlement] failed to estimate payout for session %s: %v", ps.SessionID, err)
			return
		}
		switch decision, err := s.review.CheckAndHold(ctx, ps.SessionID, ps.Wallet, ps.GameID, payoutEstimate); {
		case err != nil:
			log.Printf("[settlement] payout review check failed for session %s: %v", ps.SessionID, err)
			return
		case decision == payoutreview.DecisionHold:
			log.Printf("[settlement] session %s held for manual payout review (estimate=%d)", ps.SessionID, payoutEstimate)
			return
		case decision == payoutreview.DecisionReject:
			log.Printf("[settlement] session %s payout was rejected by staff review", ps.SessionID)
			return
		}
	}

	if s.devMode {
		// Off-chain mode: mark as won, record no payout tx.
		_, err := s.db.Exec(ctx, `
			UPDATE game_sessions
			SET result = 'won', final_score = $1, ended_at = NOW()
			WHERE id = $2::uuid AND result = 'pending'
		`, ps.VerifiedScore, ps.SessionID)
		if err != nil {
			log.Printf("[settlement] failed to mark session %s as won: %v", ps.SessionID, err)
			return
		}
		log.Printf("[settlement] dev-mode: session %s marked as WON", ps.SessionID)
		return
	}

	payoutTx, err := s.submitSettleTransaction(ctx, ps)
	if err != nil {
		log.Printf("[settlement] on-chain settlement failed for session %s: %v", ps.SessionID, err)
		// Don't mark as won — on-chain tx must succeed first. The session
		// stays 'pending' and will be retried on the next poll cycle.
		return
	}

	// Record the successful settlement.
	_, err = s.db.Exec(ctx, `
		UPDATE game_sessions
		SET result = 'won', final_score = $1, ended_at = NOW(), payout_tx = $2
		WHERE id = $3::uuid AND result = 'pending'
	`, ps.VerifiedScore, payoutTx, ps.SessionID)
	if err != nil {
		log.Printf("[settlement] failed to update session %s: %v", ps.SessionID, err)
	}
	log.Printf("[settlement] session %s settled on-chain tx=%s", ps.SessionID, payoutTx)
}

// winnerPayoutPct mirrors the on-chain settle_session split (95% winner /
// 5% reseed) — see contracts/programs/gamee/src/instructions/settle_session.rs.
const winnerPayoutPct = 0.95

// onChainTargetScore returns the target_score to submit alongside
// verified_score in the settle_session instruction.
//
// settle() only ever reaches submitSettleTransaction for sessions the
// off-chain replay verifier already declared won (processPending filters on
// r.won = TRUE) — the on-chain "final_score >= target_score" check
// (contracts/programs/gamee/src/instructions/settle_session.rs) is a
// defense-in-depth replay of that same decision, not a fresh one. It only
// needs the two numbers to be on the same scale as each other.
//
// Most games keep verified_score and gs.target_score on the same points
// scale (higher is better), so the stored target_score already satisfies
// the check. reaction-test is an exception: its target_score column holds a
// raw average-reaction-time-in-ms threshold (display-only — see
// displayTargetScore below), while verified_score is the game's points
// score (games/games/reaction-test/index.ts: targetReactionMs - avg,
// clamped to 0 on a loss). Passing the raw ms threshold on-chain made
// final_score >= target_score unsatisfiable even for a real win, so
// settle_session ran successfully but paid out nothing. The sim's points
// win-threshold is always 0 there, so that's what goes on-chain instead.
//
// sliding-puzzle has the same inverted (lower-is-better) target_score
// column: games/games/sliding-puzzle/index.ts keeps finalScore() equal to
// getState().score (both are this.moves, so no client/server mismatch like
// reaction-test's original bug), but the win decision
// (gridsEqual(grid, goalGrid) — the puzzle got solved at all) is entirely
// independent of moves-vs-par. A player who solves it in fewer moves than
// par (a better result) would fail the naive on-chain
// "final_score >= target_score" check, since moves < par there — the exact
// same failure shape as reaction-test, just triggered by skill instead of
// every win. It has no bot yet and has never reached settlement, but gets
// the same target=0 fix now, before it's ever wired up.
func onChainTargetScore(gameID string, targetScore int) int {
	switch gameID {
	case "reaction-test", "sliding-puzzle":
		return 0
	default:
		return targetScore
	}
}

// estimatePayout reads the current jackpot pool for the session's tier and
// returns what a win would actually pay the winner (95% of the pool), for
// the review-threshold check. It's an estimate, not the settlement source
// of truth — the on-chain program computes the real split at settle time.
func (s *Service) estimatePayout(ctx context.Context, tier string) (int64, error) {
	var currentAmount int64
	err := s.db.QueryRow(ctx,
		`SELECT current_amount FROM jackpots WHERE tier = $1 ORDER BY created_at DESC LIMIT 1`,
		tier,
	).Scan(&currentAmount)
	if err != nil {
		return 0, fmt.Errorf("failed to read jackpot pool for tier %q: %w", tier, err)
	}
	return int64(float64(currentAmount) * winnerPayoutPct), nil
}

// loadVerifierKeypair loads the verifier signing key once and caches it —
// the same key signs every settlement, so there's no reason to re-read and
// re-parse the file on every poll cycle.
func (s *Service) loadVerifierKeypair() (*pkgsolana.Keypair, error) {
	s.keypairOnce.Do(func() {
		s.keypair, s.keypairErr = pkgsolana.LoadKeypairFromFile(s.verifierKeyPath)
	})
	return s.keypair, s.keypairErr
}

// loadCosignerKeypairs loads the additional verifier_set member keypairs
// (s.cosignerKeyPaths) once and caches them — same rationale as
// loadVerifierKeypair. Each file is loaded with the same
// pkgsolana.LoadKeypairFromFile used for the primary verifier, which
// cross-checks the derived public key against the key stored in the file,
// so a corrupt cosigner keypair file fails loudly here rather than at
// signing time. Returns an empty (nil) slice, not an error, if
// cosignerKeyPaths is empty.
func (s *Service) loadCosignerKeypairs() ([]*pkgsolana.Keypair, error) {
	s.cosignersOnce.Do(func() {
		cosigners := make([]*pkgsolana.Keypair, 0, len(s.cosignerKeyPaths))
		for _, path := range s.cosignerKeyPaths {
			kp, err := pkgsolana.LoadKeypairFromFile(path)
			if err != nil {
				s.cosignersErr = fmt.Errorf("failed to load verifier cosigner keypair %q: %w", path, err)
				return
			}
			cosigners = append(cosigners, kp)
		}
		s.cosigners = cosigners
	})
	return s.cosigners, s.cosignersErr
}

// settleSessionDiscriminator is sha256("global:settle_session")[:8] — the
// Anchor instruction discriminator for settle_session, computed once.
var settleSessionDiscriminator = func() []byte {
	h := sha256.Sum256([]byte("global:settle_session"))
	return h[:8]
}()

// submitSettleTransaction builds, signs, and sends the real settle_session
// instruction, then waits for on-chain confirmation. The account list and
// their signer/writable flags must exactly match
// contracts/programs/gamee/src/instructions/settle_session.rs's
// SettleSession struct — a mismatch there fails on-chain with an Anchor
// account-constraint error, not silently.
func (s *Service) submitSettleTransaction(ctx context.Context, ps PendingSession) (string, error) {
	verifier, err := s.loadVerifierKeypair()
	if err != nil {
		return "", fmt.Errorf("failed to load verifier keypair: %w", err)
	}
	cosigners, err := s.loadCosignerKeypairs()
	if err != nil {
		return "", fmt.Errorf("failed to load verifier cosigner keypairs: %w", err)
	}

	programIDBytes, err := pkgsolana.DecodePubkey(s.programID)
	if err != nil {
		return "", fmt.Errorf("invalid program id: %w", err)
	}

	// Fetch the ticket's on-chain PDA and the player's wallet.
	var ticketPDA, playerWallet string
	err = s.db.QueryRow(ctx, `
		SELECT t.on_chain_ticket_pda, t.wallet_address
		FROM tickets t
		JOIN game_sessions gs ON gs.ticket_id = t.id
		WHERE gs.id = $1::uuid
	`, ps.SessionID).Scan(&ticketPDA, &playerWallet)
	if err != nil {
		return "", fmt.Errorf("failed to fetch ticket data: %w", err)
	}
	if ticketPDA == "" {
		return "", fmt.Errorf("session %s has no on-chain ticket PDA recorded — ticket confirmation must have failed to derive it", ps.SessionID)
	}

	ticketPDABytes, err := pkgsolana.DecodePubkey(ticketPDA)
	if err != nil {
		return "", fmt.Errorf("invalid stored ticket PDA %q: %w", ticketPDA, err)
	}

	// Derive the remaining PDAs. The ticket account itself is passed as-is
	// (its address is already known and stored) — Anchor validates it
	// against the ticket's own stored nonce on-chain, so we don't need to
	// independently recompute or supply the nonce here.
	gameSessionPDAHex, _, err := pkgsolana.FindProgramAddress(
		[][]byte{[]byte("game_session"), ticketPDABytes}, programIDBytes)
	if err != nil {
		return "", fmt.Errorf("failed to derive game_session PDA: %w", err)
	}
	gameSessionPDA := hexToBase58(gameSessionPDAHex)

	platformConfigPDAHex, _, err := pkgsolana.FindProgramAddress(
		[][]byte{[]byte("platform_config")}, programIDBytes)
	if err != nil {
		return "", fmt.Errorf("failed to derive platform_config PDA: %w", err)
	}
	platformConfigPDA := hexToBase58(platformConfigPDAHex)

	// The verifier_set singleton (contracts/programs/gamee/src/state/verifier_set.rs)
	// supplies the on-chain quorum membership settle_session checks against
	// the `verifier` account plus any cosigners added below.
	verifierSetPDAHex, _, err := pkgsolana.FindProgramAddress(
		[][]byte{[]byte("verifier_set")}, programIDBytes)
	if err != nil {
		return "", fmt.Errorf("failed to derive verifier_set PDA: %w", err)
	}
	verifierSetPDA := hexToBase58(verifierSetPDAHex)

	// The vault PDA must match whatever tier this session's ticket actually
	// funded at buy-time ([b"jackpot", tier]) — settle_session pays from
	// whatever jackpot_vault account is passed, so settling from the wrong
	// tier's vault would be a real (if currently unreachable, since only
	// "small" is ever funded today) fund-routing bug, not just a display one.
	tier := ps.jackpotTier()
	jackpotVaultPDAHex, _, err := pkgsolana.FindProgramAddress(
		[][]byte{[]byte("jackpot"), []byte(tier)}, programIDBytes)
	if err != nil {
		return "", fmt.Errorf("failed to derive jackpot_vault PDA: %w", err)
	}
	jackpotVaultPDA := hexToBase58(jackpotVaultPDAHex)

	// Fetch the jackpot vault account on-chain to get its real USDC token
	// account — this isn't tracked in Postgres, only on-chain.
	vaultData, err := s.solana.GetAccountData(ctx, jackpotVaultPDA)
	if err != nil {
		return "", fmt.Errorf("failed to fetch jackpot vault account: %w", err)
	}
	if vaultData == nil {
		return "", fmt.Errorf("jackpot vault %q does not exist on-chain — has initialize_jackpot(%q) been called?", jackpotVaultPDA, tier)
	}
	vault, err := pkgsolana.DeserializeJackpotVault(vaultData)
	if err != nil {
		return "", fmt.Errorf("failed to parse jackpot vault account: %w", err)
	}

	winnerUsdcAccount, err := pkgsolana.DeriveAssociatedTokenAddress(playerWallet, s.usdcMint)
	if err != nil {
		return "", fmt.Errorf("failed to derive winner's USDC account: %w", err)
	}

	// The 5% seed re-feeds the same vault the winning ticket funded (this
	// tier's own vault) — settle_session doesn't roll winnings up to a
	// different tier. next_jackpot_vault (added alongside next_jackpot_usdc_account
	// — see contracts/programs/gamee/src/instructions/settle_session.rs) ties
	// that destination to a real, admin-initialized JackpotVault; since the
	// reseed target is this same tier's vault, it's simply jackpotVaultPDA
	// again.
	nextJackpotUsdcAccount := vault.VaultTokenAccount
	nextJackpotVaultPDA := jackpotVaultPDA

	blockhash, err := s.solana.GetLatestBlockhash(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get latest blockhash: %w", err)
	}

	data := make([]byte, 0, 24)
	data = append(data, settleSessionDiscriminator...)
	data = append(data, uint64LE(uint64(ps.VerifiedScore))...)
	data = append(data, uint64LE(uint64(onChainTargetScore(ps.GameID, ps.TargetScore)))...)

	// Account order must exactly match
	// contracts/programs/gamee/src/instructions/settle_session.rs's
	// SettleSession struct field order (0-indexed):
	//   0  verifier               (signer, writable)  — fee payer, primary co-signer
	//   1  player                 (—, —)
	//   2  ticket                 (—, writable)
	//   3  game_session           (—, writable)
	//   4  platform_config        (—, —)
	//   5  verifier_set           (—, —)
	//   6  jackpot_vault          (—, writable)
	//   7  jackpot_usdc_account   (—, writable)
	//   8  winner_usdc_account    (—, writable)
	//   9  next_jackpot_usdc_account (—, writable)
	//   10 next_jackpot_vault     (—, —)
	//   11 token_program          (—, —)
	//   12 system_program         (—, —)
	// Any additional verifier_set members (cosigners) are appended after
	// index 12 as remaining_accounts — the program counts distinct
	// verifier_set members among all signers (verifier + these) against its
	// quorum threshold.
	accounts := []pkgsolana.AccountMeta{
		{Pubkey: verifier.PublicKey, IsSigner: true, IsWritable: true},
		{Pubkey: playerWallet, IsSigner: false, IsWritable: false},
		{Pubkey: ticketPDA, IsSigner: false, IsWritable: true},
		{Pubkey: gameSessionPDA, IsSigner: false, IsWritable: true},
		{Pubkey: platformConfigPDA, IsSigner: false, IsWritable: false},
		{Pubkey: verifierSetPDA, IsSigner: false, IsWritable: false},
		{Pubkey: jackpotVaultPDA, IsSigner: false, IsWritable: true},
		{Pubkey: vault.VaultTokenAccount, IsSigner: false, IsWritable: true},
		{Pubkey: winnerUsdcAccount, IsSigner: false, IsWritable: true},
		{Pubkey: nextJackpotUsdcAccount, IsSigner: false, IsWritable: true},
		{Pubkey: nextJackpotVaultPDA, IsSigner: false, IsWritable: false},
		{Pubkey: pkgsolana.TokenProgramID, IsSigner: false, IsWritable: false},
		{Pubkey: pkgsolana.SystemProgramID, IsSigner: false, IsWritable: false},
	}
	for _, cosigner := range cosigners {
		accounts = append(accounts, pkgsolana.AccountMeta{
			Pubkey: cosigner.PublicKey, IsSigner: true, IsWritable: false,
		})
	}

	ix := pkgsolana.Instruction{
		ProgramID: s.programID,
		Accounts:  accounts,
		Data:      data,
	}

	msg, err := pkgsolana.CompileMessage(verifier.PublicKey, []pkgsolana.Instruction{ix}, blockhash)
	if err != nil {
		return "", fmt.Errorf("failed to compile transaction message: %w", err)
	}
	signers := map[string]ed25519.PrivateKey{
		verifier.PublicKey: verifier.PrivateKey,
	}
	for _, cosigner := range cosigners {
		signers[cosigner.PublicKey] = cosigner.PrivateKey
	}
	rawTx, err := pkgsolana.SignTransaction(msg, signers)
	if err != nil {
		return "", fmt.Errorf("failed to sign transaction: %w", err)
	}

	sig, err := s.solana.SendTransaction(ctx, rawTx, false)
	if err != nil {
		return "", fmt.Errorf("failed to send settle_session transaction: %w", err)
	}

	confirmCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := s.solana.ConfirmTransaction(confirmCtx, sig, 2*time.Second); err != nil {
		return "", fmt.Errorf("settle_session transaction %s did not confirm: %w", sig, err)
	}

	return sig, nil
}

// hexToBase58 re-encodes a hex-encoded 32-byte PDA (as returned by
// FindProgramAddress) into the base58 form used everywhere else.
func hexToBase58(pdaHex string) string {
	raw, err := hex.DecodeString(pdaHex)
	if err != nil {
		return ""
	}
	return pkgsolana.Base58Encode(raw)
}

func uint64LE(v uint64) []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, v)
	return b
}

// NotifySettlement is called by the verification worker after writing a "match"
// verdict. It pushes the session ID to the settlement queue so the next poll
// cycle picks it up immediately rather than waiting for the full interval.
func (s *Service) NotifySettlement(ctx context.Context, sessionID string) {
	s.rdb.Publish(ctx, "settlement:notify", sessionID)
}
