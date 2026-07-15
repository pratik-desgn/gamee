package ticket

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"gamee-backend/internal/jackpot"
	"gamee-backend/internal/models"
	pkgsolana "gamee-backend/pkg/solana"
)

// Service handles ticket purchase confirmation and tracking.
type Service struct {
	db        *pgxpool.Pool
	rdb       *redis.Client
	solanaRPC string
	programID string
	usdcMint  string
	vaultAddr string
	solClient *pkgsolana.Client

	// vaultCache memoizes tier -> jackpot vault token account resolution
	// (see resolveVaultTokenAccount) — the vault token account for a given
	// tier is fixed at initialize_jackpot time and never changes, so it's
	// safe to resolve once per tier and reuse for the life of the process.
	vaultMu    sync.RWMutex
	vaultCache map[string]string
}

// NewService creates a new ticket service.
func NewService(db *pgxpool.Pool, rdb *redis.Client, solanaRPC, programID, usdcMint, vaultAddr string) *Service {
	return &Service{
		db:         db,
		rdb:        rdb,
		solanaRPC:  solanaRPC,
		programID:  programID,
		usdcMint:   usdcMint,
		vaultAddr:  vaultAddr,
		solClient:  pkgsolana.NewClient(solanaRPC, "confirmed"),
		vaultCache: make(map[string]string),
	}
}

// ConfirmRequest is the request body for POST /api/v1/tickets/confirm.
// Tier is optional and defaults to "small" — the frontend tier selector is
// increment 3; this field just lets it (or the e2e script, or any other
// caller) claim a higher tier today. The claim is not trusted on its own:
// verifyAndConfirm cross-checks it against which vault the transaction
// actually funded and the wallet's qualification (jackpot.EntryThreshold)
// before ever storing it.
type ConfirmRequest struct {
	TxSignature string `json:"tx_signature" binding:"required"`
	Tier        string `json:"tier"`
}

// accountKeyInfo mirrors one entry of a parsed transaction's
// message.accountKeys — hoisted to package scope so both verifyAndConfirm
// and tokenAccountDelta can share the type.
type accountKeyInfo struct {
	Pubkey string `json:"pubkey"`
	Signer bool   `json:"signer"`
}

// tokenBalance mirrors one entry of getTransaction's
// pre/postTokenBalances — hoisted to package scope for the same reason.
type tokenBalance struct {
	AccountIndex  int    `json:"accountIndex"`
	Mint          string `json:"mint"`
	Owner         string `json:"owner"`
	UiTokenAmount struct {
		Amount string `json:"amount"`
	} `json:"uiTokenAmount"`
}

// ConfirmResponse is the response for ticket confirmation.
type ConfirmResponse struct {
	Ticket models.Ticket `json:"ticket"`
}

// RegisterRoutes registers ticket routes on the gin router.
func (s *Service) RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/confirm", s.HandleConfirm)
	rg.GET("/mine", s.HandleMine)
}

// HandleConfirm handles POST /api/v1/tickets/confirm.
func (s *Service) HandleConfirm(c *gin.Context) {
	var req ConfirmRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "invalid request: " + err.Error(),
			"code":  "INVALID_REQUEST",
		})
		return
	}

	wallet, _ := c.Get("wallet")
	walletStr, _ := wallet.(string)

	ctx := c.Request.Context()

	if banned, err := s.isWalletBanned(ctx, walletStr); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check wallet status", "code": "INTERNAL_ERROR"})
		return
	} else if banned {
		c.JSON(http.StatusForbidden, gin.H{"error": "wallet is banned", "code": "WALLET_BANNED"})
		return
	}

	// Check if this ticket was already confirmed.
	existing, err := s.getTicketByTx(ctx, req.TxSignature)
	if err == nil && existing != nil {
		c.JSON(http.StatusOK, ConfirmResponse{Ticket: *existing})
		return
	}

	// Verify the transaction on-chain.
	ticket, err := s.verifyAndConfirm(ctx, req.TxSignature, walletStr, req.Tier)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "ticket verification failed: " + err.Error(),
			"code":  "VERIFICATION_FAILED",
		})
		return
	}

	c.JSON(http.StatusOK, ConfirmResponse{Ticket: *ticket})
}

// HandleMine handles GET /api/v1/tickets/mine.
func (s *Service) HandleMine(c *gin.Context) {
	wallet, _ := c.Get("wallet")
	walletStr, _ := wallet.(string)

	status := c.DefaultQuery("status", "")
	limit := c.DefaultQuery("limit", "20")
	offset := c.DefaultQuery("offset", "0")

	ctx := c.Request.Context()

	tickets, total, err := s.getUserTickets(ctx, walletStr, status, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "failed to fetch tickets: " + err.Error(),
			"code":  "INTERNAL_ERROR",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"tickets": tickets,
		"total":   total,
	})
}

// isWalletBanned checks the action-ladder ban flag set by anti-cheat
// escalation (see verification.Worker.escalateWallet). A wallet with no row
// yet (never linked via auth) isn't banned — pgx.ErrNoRows is not an error here.
func (s *Service) isWalletBanned(ctx context.Context, wallet string) (bool, error) {
	var banned bool
	err := s.db.QueryRow(ctx, `SELECT is_banned FROM wallets WHERE address = $1`, wallet).Scan(&banned)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return banned, nil
}

// getTicketByTx looks up a ticket by its transaction signature.
func (s *Service) getTicketByTx(ctx context.Context, txSig string) (*models.Ticket, error) {
	t := &models.Ticket{}
	err := s.db.QueryRow(ctx,
		`SELECT id, wallet_address, tx_signature, purchased_at, consumed_at,
		        status, on_chain_ticket_pda, amount_usdc, tier
		 FROM tickets WHERE tx_signature = $1`, txSig).
		Scan(&t.ID, &t.WalletAddress, &t.TxSignature, &t.PurchasedAt,
			&t.ConsumedAt, &t.Status, &t.OnChainTicketPDA, &t.AmountUSDC, &t.Tier)
	if err != nil {
		return nil, err
	}
	return t, nil
}

// verifyAndConfirm verifies the on-chain transaction and records the ticket.
// tier is the caller's claimed jackpot tier (empty defaults to "small") —
// it is not trusted at face value: it must name a real tier, the
// transaction must have actually funded that tier's vault (not some other
// tier's), and the wallet must already be qualified for it (prior
// small-tier wins >= jackpot.EntryThreshold(tier)).
// rpcTransactionResult/rpcTransactionResponse mirror just the fields
// verifyAndConfirm needs from Solana's getTransaction response.
type rpcTransactionResult struct {
	Slot        int64            `json:"slot"`
	Meta        *json.RawMessage `json:"meta"`
	Transaction *json.RawMessage `json:"transaction"`
}
type rpcTransactionResponse struct {
	Result *rpcTransactionResult `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// fetchTransactionWithRetry calls getTransaction at "confirmed" commitment
// (matching what the frontend already waited for before calling us), retrying
// on a "not found yet" result to absorb ordinary propagation lag between
// nodes behind a public multi-node RPC endpoint. It does NOT retry on an
// RPC-reported error (a real error, e.g. malformed signature, won't resolve
// by waiting) — only on a nil result, which is what "not indexed on this
// node yet" looks like.
func (s *Service) fetchTransactionWithRetry(ctx context.Context, txSig string) (*rpcTransactionResponse, error) {
	const maxAttempts = 6
	const delay = 1500 * time.Millisecond

	var last *rpcTransactionResponse
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		payload := map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      1,
			"method":  "getTransaction",
			"params": []interface{}{txSig, map[string]interface{}{
				"encoding":                       "jsonParsed",
				"commitment":                     "confirmed",
				"maxSupportedTransactionVersion": 0,
			}},
		}
		body, _ := json.Marshal(payload)

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.solanaRPC, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("build RPC request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("RPC call failed: %w", err)
		}
		var rpcResp rpcTransactionResponse
		decErr := json.NewDecoder(resp.Body).Decode(&rpcResp)
		resp.Body.Close()
		if decErr != nil {
			return nil, fmt.Errorf("failed to decode RPC response: %w", decErr)
		}
		if rpcResp.Error != nil {
			return nil, fmt.Errorf("Solana RPC error [%d]: %s", rpcResp.Error.Code, rpcResp.Error.Message)
		}
		if rpcResp.Result != nil && rpcResp.Result.Meta != nil {
			return &rpcResp, nil
		}

		last = &rpcResp
		if attempt < maxAttempts {
			log.Printf("[ticket] tx %s not yet visible on attempt %d/%d, retrying in %s", txSig, attempt, maxAttempts, delay)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
		}
	}
	return last, nil
}

func (s *Service) verifyAndConfirm(ctx context.Context, txSig, wallet, tier string) (*models.Ticket, error) {
	log.Printf("[ticket] verifying on-chain transaction %s for wallet %s (claimed tier=%q)", txSig, wallet, tier)

	if tier == "" {
		tier = jackpot.TierSmall
	}
	if !jackpot.IsValidTier(tier) {
		return nil, fmt.Errorf("unknown jackpot tier %q", tier)
	}

	// Decode program ID once for PDA derivation.
	programIDBytes, err := pkgsolana.DecodePubkey(s.programID)
	if err != nil {
		return nil, fmt.Errorf("invalid program ID: %w", err)
	}
	_ = programIDBytes

	// 1. Fetch the raw transaction from Solana via JSON-RPC, retrying for a
	// few seconds: the frontend only calls us after its own RPC node
	// already observed the tx at "confirmed" commitment, but against a
	// public multi-node endpoint like api.devnet.solana.com a follow-up
	// call can land on a different node that hasn't seen it propagate yet
	// — a single unretried lookup here previously surfaced that normal
	// propagation lag as a hard "transaction not found" and lost the
	// buyer's payment (the on-chain purchase had already succeeded).
	rpcResp, err := s.fetchTransactionWithRetry(ctx, txSig)
	if err != nil {
		return nil, err
	}
	if rpcResp.Result == nil || rpcResp.Result.Meta == nil {
		return nil, fmt.Errorf("transaction not found: %s", txSig)
	}

	// 2. Check transaction error/meta: must have succeeded.
	// Token balances carry the owner so we can compute the buyer's USDC delta
	// and confirm the debit came from the wallet that is claiming the ticket.
	var meta struct {
		Err               interface{}    `json:"err"`
		PreTokenBalances  []tokenBalance `json:"preTokenBalances"`
		PostTokenBalances []tokenBalance `json:"postTokenBalances"`
		Logs              []string       `json:"logMessages"`
	}
	metaRaw, _ := json.Marshal(rpcResp.Result.Meta)
	json.Unmarshal(metaRaw, &meta)

	if meta.Err != nil {
		return nil, fmt.Errorf("transaction failed on-chain: %v", meta.Err)
	}

	// 3. Parse the transaction to verify it calls the GAMEE program and that
	// the claiming wallet is a signer (the fee payer is always accountKeys[0]).
	var txData struct {
		Message struct {
			AccountKeys  []accountKeyInfo `json:"accountKeys"`
			Instructions []struct {
				ProgramId string `json:"programId"`
				Data      string `json:"data,omitempty"`
			} `json:"instructions"`
		} `json:"message"`
	}
	txRaw, _ := json.Marshal(rpcResp.Result.Transaction)
	json.Unmarshal(txRaw, &txData)

	// Verify the GAMEE program was invoked and extract the nonce.
	hasProgram := false
	var nonce uint64
	for _, ix := range txData.Message.Instructions {
		if ix.ProgramId == s.programID {
			hasProgram = true
			// Instruction data layout: discriminator(8) + nonce(8 LE) + amount(8 LE).
			// jsonParsed RPC responses encode instruction data as base58 (NOT
			// hex — decoding as hex silently yielded nonce=0, so the ticket
			// PDA was never recorded and on-chain settlement couldn't run).
			if ix.Data != "" {
				data, err := pkgsolana.Base58Decode(ix.Data)
				if err == nil && len(data) >= 16 {
					nonce = binary.LittleEndian.Uint64(data[8:16])
				}
			}
			break
		}
	}
	if !hasProgram {
		return nil, fmt.Errorf("transaction does not contain an instruction to the GAMEE program")
	}

	// Bind the ticket to the on-chain payer: the claiming wallet must have
	// signed this transaction. Without this check any client could confirm
	// someone else's purchase as their own ticket.
	walletSigned := false
	for _, ak := range txData.Message.AccountKeys {
		if ak.Pubkey == wallet && ak.Signer {
			walletSigned = true
			break
		}
	}
	if !walletSigned {
		return nil, fmt.Errorf("claiming wallet %s did not sign this transaction", wallet)
	}

	// Compute the buyer's USDC debit from pre/post token balances (owner==wallet).
	preAmt := int64(-1)
	postAmt := int64(-1)
	for _, tb := range meta.PreTokenBalances {
		if tb.Mint == s.usdcMint && tb.Owner == wallet {
			preAmt, _ = strconv.ParseInt(tb.UiTokenAmount.Amount, 10, 64)
		}
	}
	for _, tb := range meta.PostTokenBalances {
		if tb.Mint == s.usdcMint && tb.Owner == wallet {
			postAmt, _ = strconv.ParseInt(tb.UiTokenAmount.Amount, 10, 64)
		}
	}
	var transferAmount int64
	if preAmt >= 0 && postAmt >= 0 {
		transferAmount = preAmt - postAmt
	}
	if transferAmount <= 0 {
		return nil, fmt.Errorf("no USDC debit from wallet %s detected in transaction", wallet)
	}

	// 3.5. Anti-spoof: the claimed tier must be where the 80% jackpot cut
	// actually landed, not just an unverified client claim. Resolve the
	// claimed tier's on-chain vault token account and confirm this exact
	// transaction credited it (post-pre balance delta > 0). A transaction
	// that funded a different tier's vault (or none at all) is rejected
	// here regardless of what tier the caller asked to store.
	vaultTokenAccount, err := s.resolveVaultTokenAccount(ctx, tier)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve jackpot vault for tier %q: %w", tier, err)
	}
	vaultDelta, found := tokenAccountDelta(txData.Message.AccountKeys, meta.PreTokenBalances, meta.PostTokenBalances, s.usdcMint, vaultTokenAccount)
	if !found || vaultDelta <= 0 {
		return nil, fmt.Errorf("transaction did not credit the %q tier's jackpot vault (%s) — claimed tier does not match the vault this purchase actually funded", tier, vaultTokenAccount)
	}

	// 3.6. Enforce the qualification ladder: a wallet may only fund a tier
	// it has unlocked via prior small-tier wins (jackpot.EntryThreshold).
	// Counted via game_sessions (won, tier='small') joined through tickets,
	// since game_sessions itself has no wallet column.
	smallWins, err := s.countSmallWins(ctx, wallet)
	if err != nil {
		return nil, fmt.Errorf("failed to check tier qualification: %w", err)
	}
	if err := checkQualified(tier, smallWins); err != nil {
		return nil, err
	}

	// 4. Compute the ticket PDA from the nonce extracted from instruction data.
	// The PDA seeds are [b"ticket", wallet_bytes, nonce_le_bytes] under the GAMEE program.
	// This is the authoritative on-chain identifier for the ticket.
	ticketPDA := ""
	if nonce > 0 {
		walletBytes, err := pkgsolana.DecodePubkey(wallet)
		if err == nil {
			nonceBytes := make([]byte, 8)
			binary.LittleEndian.PutUint64(nonceBytes, nonce)
			pdaHex, _, pdaErr := pkgsolana.FindProgramAddress(
				[][]byte{[]byte("ticket"), walletBytes, nonceBytes},
				programIDBytes,
			)
			if pdaErr == nil && len(pdaHex) == 64 {
				// Store as base58-encoded Solana pubkey (32 bytes → base58).
				pdaRaw, _ := hex.DecodeString(pdaHex)
				if len(pdaRaw) == 32 {
					ticketPDA = pkgsolana.Base58Encode(pdaRaw)
				}
			}
		}
	}

	// 5. Insert the ticket record. 'unused' is the ready-to-spin state —
	// it must match both the tickets.valid_ticket_status CHECK constraint
	// and HandleSpin's atomic claim (WHERE status = 'unused'); the previous
	// value 'confirmed' satisfied neither, so no ticket could ever be
	// inserted, let alone spun.
	// Tier is the caller's claim, validated above against both the actual
	// on-chain funded vault (3.5) and the wallet's qualification (3.6) — by
	// this point it's provably the tier this purchase really funded and the
	// wallet is provably entitled to it, not merely a client-side default.
	status := "unused"
	ticket := &models.Ticket{
		WalletAddress:    wallet,
		TxSignature:      txSig,
		PurchasedAt:      time.Now(),
		Status:           status,
		OnChainTicketPDA: ticketPDA,
		AmountUSDC:       transferAmount,
		Tier:             tier,
	}

	err = s.db.QueryRow(ctx,
		`INSERT INTO tickets (wallet_address, tx_signature, status, amount_usdc, on_chain_ticket_pda, tier)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id`,
		wallet, txSig, status, transferAmount, ticketPDA, ticket.Tier).Scan(&ticket.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to insert ticket: %w", err)
	}

	// Update Redis jackpot cache.
	s.updateJackpotCache(ctx)

	log.Printf("[ticket] confirmed ticket %s for wallet %s (amount=%d, pda=%s)",
		ticket.ID, wallet, transferAmount, ticketPDA)
	return ticket, nil
}

// resolveVaultTokenAccount returns the SPL token account address backing a
// tier's jackpot vault PDA ([b"jackpot", tier]), resolving it from on-chain
// state on first use per tier and caching the result — a vault's token
// account is fixed at initialize_jackpot time and never changes, so there's
// no reason to re-fetch and re-parse the vault account on every confirm.
func (s *Service) resolveVaultTokenAccount(ctx context.Context, tier string) (string, error) {
	s.vaultMu.RLock()
	if addr, ok := s.vaultCache[tier]; ok {
		s.vaultMu.RUnlock()
		return addr, nil
	}
	s.vaultMu.RUnlock()

	programIDBytes, err := pkgsolana.DecodePubkey(s.programID)
	if err != nil {
		return "", fmt.Errorf("invalid program ID: %w", err)
	}
	vaultPDAHex, _, err := pkgsolana.FindProgramAddress(
		[][]byte{[]byte("jackpot"), []byte(tier)}, programIDBytes)
	if err != nil {
		return "", fmt.Errorf("failed to derive jackpot vault PDA for tier %q: %w", tier, err)
	}
	pdaRaw, err := hex.DecodeString(vaultPDAHex)
	if err != nil || len(pdaRaw) != 32 {
		return "", fmt.Errorf("failed to decode derived vault PDA for tier %q", tier)
	}
	vaultPDA := pkgsolana.Base58Encode(pdaRaw)

	data, err := s.solClient.GetAccountData(ctx, vaultPDA)
	if err != nil {
		return "", fmt.Errorf("failed to fetch jackpot vault %s for tier %q: %w", vaultPDA, tier, err)
	}
	if data == nil {
		return "", fmt.Errorf("jackpot vault for tier %q does not exist on-chain (%s) — has initialize_jackpot(%q) been run?", tier, vaultPDA, tier)
	}
	vault, err := pkgsolana.DeserializeJackpotVault(data)
	if err != nil {
		return "", fmt.Errorf("failed to parse jackpot vault account for tier %q: %w", tier, err)
	}

	s.vaultMu.Lock()
	s.vaultCache[tier] = vault.VaultTokenAccount
	s.vaultMu.Unlock()
	return vault.VaultTokenAccount, nil
}

// tokenAccountDelta finds `account` among a parsed transaction's account
// keys and returns its USDC (mint-matched) balance delta (post - pre)
// across the transaction, using the same accountIndex-based matching the
// Solana RPC uses to correlate pre/postTokenBalances entries to accounts.
// found is false if `account` doesn't appear in the transaction's
// postTokenBalances at all (e.g. it was never touched).
func tokenAccountDelta(accountKeys []accountKeyInfo, pre, post []tokenBalance, mint, account string) (delta int64, found bool) {
	idx := -1
	for i, ak := range accountKeys {
		if ak.Pubkey == account {
			idx = i
			break
		}
	}
	if idx < 0 {
		return 0, false
	}

	var preAmt, postAmt int64
	for _, tb := range pre {
		if tb.AccountIndex == idx && tb.Mint == mint {
			preAmt, _ = strconv.ParseInt(tb.UiTokenAmount.Amount, 10, 64)
		}
	}
	postFound := false
	for _, tb := range post {
		if tb.AccountIndex == idx && tb.Mint == mint {
			postAmt, _ = strconv.ParseInt(tb.UiTokenAmount.Amount, 10, 64)
			postFound = true
		}
	}
	if !postFound {
		return 0, false
	}
	return postAmt - preAmt, true
}

// countSmallWins counts a wallet's prior *settled, won* small-tier
// sessions — the currency the qualification ladder is denominated in
// (jackpot.EntryThreshold). game_sessions has no wallet column, so this
// joins through the owning ticket, same as settlement's queries.
func (s *Service) countSmallWins(ctx context.Context, wallet string) (int, error) {
	var count int
	err := s.db.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM game_sessions gs
		JOIN tickets t ON t.id = gs.ticket_id
		WHERE t.wallet_address = $1 AND gs.result = 'won' AND gs.tier = $2
	`, wallet, jackpot.TierSmall).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count small-tier wins for %s: %w", wallet, err)
	}
	return count, nil
}

// checkQualified enforces the jackpot tier qualification ladder
// (jackpot.EntryThreshold): a wallet needs at least that many prior
// small-tier wins to fund tier's vault. Pure function — no DB/RPC access —
// so the gating logic is unit-testable without a database.
func checkQualified(tier string, smallWins int) error {
	required := jackpot.EntryThreshold(tier)
	if smallWins < required {
		return fmt.Errorf("wallet not qualified for tier %q: requires %d prior small-tier win(s), has %d", tier, required, smallWins)
	}
	return nil
}

// updateJackpotCache refreshes the jackpot amount in Redis.
func (s *Service) updateJackpotCache(ctx context.Context) {
	// In production, query the Solana vault balance.
	// For now, increment by the ticket amount.
	s.rdb.IncrBy(ctx, "jackpot:current_amount", 800_000) // 80% of 1 USDC
}

// getUserTickets fetches tickets for a user with optional filters.
func (s *Service) getUserTickets(ctx context.Context, wallet, status, limit, offset string) ([]models.Ticket, int, error) {
	var whereClause string
	args := []interface{}{wallet}
	argIdx := 2

	if status != "" {
		whereClause = fmt.Sprintf(" AND status = $%d", argIdx)
		args = append(args, status)
		argIdx++
	}

	// Count total.
	var total int
	countQuery := fmt.Sprintf(
		`SELECT COUNT(*) FROM tickets WHERE wallet_address = $1%s`, whereClause)
	err := s.db.QueryRow(ctx, countQuery, args...).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count tickets: %w", err)
	}

	// Fetch tickets.
	query := fmt.Sprintf(
		`SELECT id, wallet_address, tx_signature, purchased_at, consumed_at,
		        status, on_chain_ticket_pda, amount_usdc, tier
		 FROM tickets WHERE wallet_address = $1%s
		 ORDER BY purchased_at DESC LIMIT $%d OFFSET $%d`,
		whereClause, argIdx, argIdx+1)

	args = append(args, limit, offset)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query tickets: %w", err)
	}
	defer rows.Close()

	var tickets []models.Ticket
	for rows.Next() {
		var t models.Ticket
		if err := rows.Scan(&t.ID, &t.WalletAddress, &t.TxSignature, &t.PurchasedAt,
			&t.ConsumedAt, &t.Status, &t.OnChainTicketPDA, &t.AmountUSDC, &t.Tier); err != nil {
			return nil, 0, fmt.Errorf("failed to scan ticket: %w", err)
		}
		tickets = append(tickets, t)
	}

	if tickets == nil {
		tickets = []models.Ticket{}
	}

	return tickets, total, nil
}
