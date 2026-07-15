package verification

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"gamee-backend/internal/anticheat"
	"gamee-backend/internal/settlement"
)

// Worker handles replay verification by spawning Node.js workers.
type Worker struct {
	db              *pgxpool.Pool
	rdb             *redis.Client
	nodePath        string
	verifierScript  string
	verifierVersion string
	numWorkers      int
	queueKey        string
	mu              sync.Mutex
	activeJobs      map[string]context.CancelFunc
	settlementSvc   *settlement.Service
	autoBan         bool
}

// NewWorker creates a new verification worker pool. verifierScript is the
// path to games/sdk/run.js — differs between local dev (relative, siblings
// of backend/) and the Docker image (baked into the image at a fixed path);
// see config.VerifierScriptPath and backend/Dockerfile.
// autoBan=false (config.AntiCheatAutoBan) caps the anti-cheat action ladder at
// "hardened": flags are still recorded, but wallets are never auto-banned.
func NewWorker(db *pgxpool.Pool, rdb *redis.Client, numWorkers int, settlementSvc *settlement.Service, verifierScript string, autoBan bool) *Worker {
	return &Worker{
		db:              db,
		rdb:             rdb,
		nodePath:        GetNodePath(),
		verifierScript:  verifierScript,
		verifierVersion: "1.0.0",
		numWorkers:      numWorkers,
		queueKey:        "verification:queue",
		activeJobs:      make(map[string]context.CancelFunc),
		settlementSvc:   settlementSvc,
		autoBan:         autoBan,
	}
}

// Start launches the worker pool that listens for verification jobs.
func (w *Worker) Start(ctx context.Context) {
	log.Printf("[verification] starting %d workers", w.numWorkers)

	var wg sync.WaitGroup
	for i := 0; i < w.numWorkers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			w.run(ctx, workerID)
		}(i)
	}

	<-ctx.Done()
	log.Println("[verification] shutting down workers")
	wg.Wait()
}

// run is the main loop for a single worker.
func (w *Worker) run(ctx context.Context, workerID int) {
	log.Printf("[verification] worker %d started", workerID)

	for {
		select {
		case <-ctx.Done():
			return
		default:
			// Pop a session ID from the verification queue.
			sessionID, err := w.rdb.BLPop(ctx, 5*time.Second, w.queueKey).Result()
			if err != nil {
				// No job available — continue polling.
				continue
			}

			if len(sessionID) < 2 {
				continue
			}

			id := sessionID[1]
			log.Printf("[verification] worker %d picked session %s", workerID, id)

			// Process the verification.
			if err := w.processSession(ctx, id); err != nil {
				log.Printf("[verification] worker %d failed session %s: %v", workerID, id, err)
				// Re-queue for retry.
				w.rdb.RPush(ctx, w.queueKey, id)
			}
		}
	}
}

// VerifierInput is the data sent to the Node.js verifier.
type VerifierInput struct {
	SessionID   string          `json:"session_id"`
	GameID      string          `json:"game_id"`
	Seed        string          `json:"seed"`
	Difficulty  json.RawMessage `json:"difficulty"`
	InputLog    json.RawMessage `json:"input_log"`
	ClientScore int             `json:"client_score"`
	TargetScore int             `json:"target_score"`
}

// VerifierOutput is the result returned by the Node.js verifier.
// Verdict, when set by the verifier, is authoritative:
//   - "valid"      replay reproduced the claimed score
//   - "invalid"    replay produced a different score (cheat)
//   - "timeout"    replay exceeded the frame budget
//   - "unverified" the deterministic sim could not be run (missing module)
type VerifierOutput struct {
	VerifiedScore int    `json:"verified_score"`
	// Won is the sim's own win verdict, decided by each game's internal
	// rules during the replay. Authoritative for settlement — score-vs-
	// target comparisons can't express per-game semantics (block-merge
	// wins at 2048, simon-pro at ~20, sliding-puzzle is lower-is-better).
	Won        bool   `json:"won"`
	Verdict    string `json:"verdict,omitempty"`
	DurationMs int    `json:"duration_ms"`
	Error      string `json:"error,omitempty"`
}

// processSession verifies a single session by spawning a Node.js worker.
func (w *Worker) processSession(ctx context.Context, sessionID string) error {
	// Fetch session and replay data.
	inputLog, clientScore, gameID, seed, targetScore, difficultyJSON, wallet, err := w.loadSessionData(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("failed to load session data: %w", err)
	}

	// Prepare input for the Node.js verifier.
	input := VerifierInput{
		SessionID:   sessionID,
		GameID:      gameID,
		Seed:        seed,
		Difficulty:  difficultyJSON,
		InputLog:    inputLog,
		ClientScore: clientScore,
		TargetScore: targetScore,
	}

	// Spawn Node.js process.
	startTime := time.Now()

	output, err := w.runVerifier(ctx, input)
	if err != nil {
		return fmt.Errorf("verifier execution failed: %w", err)
	}

	durationMs := int(time.Since(startTime).Milliseconds())
	output.DurationMs = durationMs

	// 2.7 — Run behavioral anti-cheat analysis on input timing.
	// If the input pattern is bot-like (sub-100ms reactions, metronomic timing,
	// frame-perfect inputs), the session is rejected regardless of score match.
	var anticheatVerdict string
	var inputEvents []anticheat.InputEvent
	if err := json.Unmarshal(inputLog, &inputEvents); err == nil && len(inputEvents) > 0 {
		analysis := anticheat.AnalyzeInputTiming(inputEvents)
		if analysis.RecommendAction != "pass" {
			// Shadow-flag: record every non-pass session (not just rejected
			// ones) so ladder history actually accumulates. Previously this
			// only ran inside ShouldReject(), so "flag"-tier sessions (the
			// shadow-flag rung of the ladder itself) left no trace at all.
			tier, escErr := w.recordAndEscalate(ctx, sessionID, wallet, analysis)
			if escErr != nil {
				log.Printf("[verification] anti-cheat: failed to record/escalate wallet %s: %v", wallet, escErr)
			} else if tier == anticheat.TierBanned {
				log.Printf("[verification] anti-cheat: wallet %s banned (action=%s)", wallet, analysis.RecommendAction)
			} else if tier == anticheat.TierHardened {
				log.Printf("[verification] anti-cheat: wallet %s hardened (action=%s)", wallet, analysis.RecommendAction)
			}
		}
		if analysis.ShouldReject() {
			anticheatVerdict = "rejected"
			log.Printf("[verification] anti-cheat: session %s rejected (bot=%0.2f, action=%s)",
				sessionID, analysis.BotLikelyhood, analysis.RecommendAction)
		}
	}

	// Resolve the final verdict. Anti-cheat rejection takes priority.
	//   - "unverified"/"timeout": terminal, non-winning (kept as-is)
	// Resolve the final verdict. Anti-cheat rejection takes priority.
	var verdict string
	if anticheatVerdict == "rejected" {
		verdict = "rejected"
	} else {
		switch output.Verdict {
		case "unverified", "timeout":
			verdict = output.Verdict
		case "invalid":
			verdict = "mismatch"
		default:
			verdict = w.determineVerdict(clientScore, output.VerifiedScore)
		}
	}

	// Write verdict to database.
	if err := w.writeVerdict(ctx, sessionID, verdict, output, durationMs); err != nil {
		return fmt.Errorf("failed to write verdict: %w", err)
	}

	log.Printf("[verification] session %s: client=%d verified=%d won=%v verdict=%s (%dms)",
		sessionID, clientScore, output.VerifiedScore, output.Won, verdict, durationMs)

	// A verified replay that didn't win is a settled loss — record it.
	// (Wins are settled by the settlement service; without this branch,
	// losing sessions stayed 'pending' forever.) The result='pending'
	// guard keeps this disjoint from settlement and payout-review writes.
	if verdict == "match" && !output.Won {
		if _, err := w.db.Exec(ctx,
			`UPDATE game_sessions
			 SET result = 'lost', final_score = $1, ended_at = NOW()
			 WHERE id = $2::uuid AND result = 'pending'`,
			output.VerifiedScore, sessionID); err != nil {
			log.Printf("[verification] failed to mark session %s lost: %v", sessionID, err)
		}
	}

	// Every other verdict (rejected, mismatch, suspicious, unverified,
	// timeout) is terminal and refuses payout — mark the session rejected.
	// Without this the row stays 'pending' and the result page polls forever.
	if verdict != "match" {
		if _, err := w.db.Exec(ctx,
			`UPDATE game_sessions
			 SET result = 'rejected', final_score = $1, ended_at = NOW()
			 WHERE id = $2::uuid AND result = 'pending'`,
			output.VerifiedScore, sessionID); err != nil {
			log.Printf("[verification] failed to mark session %s rejected: %v", sessionID, err)
		}
	}

	// Notify settlement service when a match is found — a winning session
	// is ready to be processed (or in dev mode, immediately marked as won).
	if verdict == "match" && w.settlementSvc != nil {
		w.settlementSvc.NotifySettlement(ctx, sessionID)
	}

	return nil
}

// loadSessionData fetches session and replay data from the database.
// The buyer wallet is joined from the ticket (game_sessions has no wallet column).
func (w *Worker) loadSessionData(ctx context.Context, sessionID string) (
	inputLog json.RawMessage, clientScore int, gameID string,
	seed string, targetScore int, difficultyJSON json.RawMessage, wallet string, err error,
) {
	err = w.db.QueryRow(ctx,
		`SELECT r.input_log, r.client_score, gs.game_id, gs.seed,
		        gs.target_score, gs.difficulty_params, t.wallet_address
		 FROM replays r
		 JOIN game_sessions gs ON gs.id = r.session_id
		 JOIN tickets t ON t.id = gs.ticket_id
		 WHERE r.session_id = $1::uuid`, sessionID).
		Scan(&inputLog, &clientScore, &gameID, &seed, &targetScore, &difficultyJSON, &wallet)
	if err != nil {
		return nil, 0, "", "", 0, nil, "", err
	}
	return
}

// runVerifier spawns a Node.js process to replay the game.
func (w *Worker) runVerifier(ctx context.Context, input VerifierInput) (*VerifierOutput, error) {
	inputJSON, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal input: %w", err)
	}

	// Create a temporary input file.
	tmpFile, err := os.CreateTemp("", "verifier-input-*.json")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.Write(inputJSON); err != nil {
		tmpFile.Close()
		return nil, fmt.Errorf("failed to write input: %w", err)
	}
	tmpFile.Close()

	// Check if verifier script exists.
	if _, err := os.Stat(w.verifierScript); os.IsNotExist(err) {
		// The deterministic sim cannot be run. Never silently trust the
		// client score — mark the session "unverified" so payout logic
		// refuses it. Set GAMEE_ALLOW_UNVERIFIED=true only for local dev.
		if os.Getenv("GAMEE_ALLOW_UNVERIFIED") == "true" {
			log.Printf("[verification] script missing at %s; GAMEE_ALLOW_UNVERIFIED set, trusting client score (DEV ONLY)", w.verifierScript)
			return &VerifierOutput{VerifiedScore: input.ClientScore, Verdict: "valid", DurationMs: 1}, nil
		}
		log.Printf("[verification] verifier script not found at %s; marking session unverified", w.verifierScript)
		return &VerifierOutput{VerifiedScore: 0, Verdict: "unverified", DurationMs: 1}, nil
	}

	// Execute the Node.js verifier.
	cmd := exec.CommandContext(ctx, w.nodePath, w.verifierScript, "--input", tmpFile.Name())
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("verifier process failed: %w, output: %s", err, string(output))
	}

	var result VerifierOutput
	if err := json.Unmarshal(output, &result); err != nil {
		return nil, fmt.Errorf("failed to parse verifier output: %w", err)
	}

	if result.Error != "" {
		return nil, fmt.Errorf("verifier error: %s", result.Error)
	}

	return &result, nil
}

// determineVerdict compares client and verified scores.
func (w *Worker) determineVerdict(clientScore, verifiedScore int) string {
	if clientScore == verifiedScore {
		return "match"
	}
	diff := clientScore - verifiedScore
	if diff < 0 {
		diff = -diff
	}
	if diff <= 5 {
		return "suspicious"
	}
	return "mismatch"
}

// recordAndEscalate writes this session's cheat_flags rows and applies the
// Stage-3 action ladder (shadow-flag -> harder difficulty -> ban) atomically
// per wallet.
//
// Both steps run inside one transaction serialized by a Postgres advisory
// lock keyed on the wallet address. Without that lock, two verification
// workers processing two different sessions for the same wallet at the same
// time (REPLAY_WORKERS defaults to 4, so this isn't hypothetical) would each
// read the wallet's flag history *before* the other's insert lands, and each
// independently compute a lower tier than the combined history actually
// warrants — e.g. two concurrent "review"-grade sessions each seeing zero
// prior review/ban flags, so neither reaches DetermineTier's ban threshold
// even though the pair together should. gamesession.isWalletHardened reads
// the same history independently (read-only, no lock needed there) to decide
// whether to harden difficulty on the wallet's *next* spin.
func (w *Worker) recordAndEscalate(ctx context.Context, sessionID, wallet string, analysis *anticheat.SessionAnalysis) (anticheat.WalletRiskTier, error) {
	tx, err := w.db.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to begin escalation tx for wallet %s: %w", wallet, err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, wallet); err != nil {
		return "", fmt.Errorf("failed to acquire escalation lock for wallet %s: %w", wallet, err)
	}

	rows, err := tx.Query(ctx,
		`SELECT action_taken FROM cheat_flags
		 WHERE wallet_address = $1 AND created_at > NOW() - INTERVAL '30 days'`, wallet)
	if err != nil {
		return "", fmt.Errorf("failed to load cheat flag history for wallet %s: %w", wallet, err)
	}
	var actions []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err == nil {
			actions = append(actions, a)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("failed to read cheat flag history for wallet %s: %w", wallet, err)
	}

	tier := anticheat.DetermineTier(actions, analysis.RecommendAction)
	if tier == anticheat.TierBanned && !w.autoBan {
		log.Printf("[verification] anti-cheat: wallet %s reached ban tier but auto-ban is disabled — capping at hardened", wallet)
		tier = anticheat.TierHardened
	}

	for _, flag := range analysis.ToCheatFlagModels(sessionID, wallet) {
		f := flag.(map[string]interface{})
		if _, err := tx.Exec(ctx,
			`INSERT INTO cheat_flags (wallet_address, session_id, rule_triggered, severity, action_taken)
			 VALUES ($1, $2::uuid, $3, $4, $5)`,
			f["wallet_address"], f["session_id"], f["rule_triggered"], f["severity"], f["action_taken"],
		); err != nil {
			return "", fmt.Errorf("failed to write cheat_flag for session %s: %w", sessionID, err)
		}
	}

	if tier == anticheat.TierBanned {
		if _, err := tx.Exec(ctx,
			`UPDATE wallets SET is_banned = TRUE, ban_reason = $2
			 WHERE address = $1 AND is_banned = FALSE`,
			wallet, fmt.Sprintf("anti-cheat action ladder: %s-tier behavioral flag", analysis.RecommendAction),
		); err != nil {
			return tier, fmt.Errorf("failed to ban wallet %s: %w", wallet, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("failed to commit escalation tx for wallet %s: %w", wallet, err)
	}
	return tier, nil
}

// writeVerdict persists the verification result.
func (w *Worker) writeVerdict(ctx context.Context, sessionID string, verdict string,
	output *VerifierOutput, durationMs int) error {
	_, err := w.db.Exec(ctx,
		`UPDATE replays
		 SET verified_score = $1, won = $2, verdict = $3, verifier_version = $4,
		     verified_at = NOW(), duration_ms = $5
		 WHERE session_id = $6::uuid`,
		output.VerifiedScore, verdict == "match" && output.Won, verdict,
		w.verifierVersion, durationMs, sessionID)
	return err
}

// Session represents a queued session for the worker to process.
type Session struct {
	ID string `json:"session_id"`
}

// GetNodePath returns the path to the Node.js binary, checking common locations.
func GetNodePath() string {
	paths := []string{
		"node",
		"/usr/local/bin/node",
		"/usr/bin/node",
		"/usr/local/bin/nodejs",
		"C:\\Program Files\\nodejs\\node.exe",
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "node"
}
