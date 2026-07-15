package gamesession

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// SwitchboardConfig groups the knobs switchboardProvider needs to exec the
// Node helper (contracts/scripts/vrf-switchboard.ts). Kept as its own
// struct rather than threading individual config.Config fields through
// NewRandomnessProvider so this package doesn't need to import
// internal/config (which would risk an import cycle down the line).
type SwitchboardConfig struct {
	// NodePath is the interpreter used to run the helper script. It is NOT
	// plain "node": the helper is TypeScript source, and this repo's other
	// ad-hoc scripts (contracts/package.json's "vrf" script,
	// scripts/package.json's "sim" script) all run via ts-node rather than
	// relying on Node's native (still-recent, alpine-images-don't-have-it)
	// unflagged TS type-stripping. Point this at the ts-node binary
	// (contracts/node_modules/.bin/ts-node) unless the deployment's Node
	// build is known to support .ts files directly.
	NodePath string
	// ScriptPath is contracts/scripts/vrf-switchboard.ts (or wherever it's
	// deployed) — "../contracts/scripts/vrf-switchboard.ts" relative to the
	// backend process's CWD works for local dev the same way
	// config.VerifierScriptPath's default does.
	ScriptPath string
	// KeypairPath is the Solana keypair the helper pays randomness-account
	// rent and tx fees with. Devnet default: backend/keys/verifier-devnet.json.
	KeypairPath string
	// RPCURL is the Solana RPC endpoint the helper talks to — reuses
	// config.SolanaRPCURL, no separate env var.
	RPCURL string
	// Timeout bounds the whole exec — commit-reveal against a live oracle
	// can take several seconds, but Seed() must never hang a spin.
	Timeout time.Duration
}

// switchboardProvider derives the per-spin seed from Switchboard On-Demand
// commit-reveal randomness: it shells out to a Node helper (same pattern as
// verification.Worker running games/sdk/run.js) that creates a randomness
// account on the devnet default queue, commits it, waits for the assigned
// oracle to reveal, and prints the revealed 32-byte value as hex.
//
// This is the swap slotHashProvider's doc comment calls out as removing
// *verifier* trust (not just player predictability): the revealed value is
// signed by a Switchboard oracle running in an SGX enclave, so — unlike
// SlotHashes, which the backend just reads off-chain — the backend itself
// cannot bias or predict it either.
//
// Seed must never fail a spin: any exec error, timeout, malformed output, or
// helper-reported failure falls back to fallback.Seed (by construction, the
// slotHashProvider, which itself falls back to deterministic).
type switchboardProvider struct {
	cfg      SwitchboardConfig
	fallback RandomnessProvider
}

func (p *switchboardProvider) Name() string { return "switchboard" }

// switchboardHelperOutput mirrors the single JSON line vrf-switchboard.ts
// prints to stdout — either the ok:true shape or ok:false with an error.
type switchboardHelperOutput struct {
	OK            bool   `json:"ok"`
	RandomnessHex string `json:"randomness_hex"`
	Slot          int64  `json:"slot"`
	CommitTx      string `json:"commit_tx"`
	RevealTx      string `json:"reveal_tx"`
	Error         string `json:"error"`
}

func (p *switchboardProvider) Seed(ctx context.Context, ticketID string) string {
	seed, err := p.seedFromHelper(ctx, ticketID)
	if err != nil {
		log.Printf("[gamesession] switchboard randomness unavailable (%v) — falling back to %s", err, p.fallback.Name())
		return p.fallback.Seed(ctx, ticketID)
	}
	return seed
}

// seedFromHelper execs the Node helper and derives the seed from its
// revealed randomness. It never blocks longer than cfg.Timeout regardless of
// what the caller's ctx allows, since a hung oracle round trip must not hang
// a spin.
func (p *switchboardProvider) seedFromHelper(ctx context.Context, ticketID string) (string, error) {
	timeout := p.cfg.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Resolve to absolute paths and run with cmd.Dir set to the script's own
	// directory (contracts/scripts): ts-node discovers contracts/tsconfig.json
	// by walking up from its *working* directory, not from the script path,
	// so leaving cmd.Dir at the Go process's cwd (backend/, or Docker's
	// /app) makes it fall back to bare-ES5 compiler defaults and fail on
	// this file's async/Promise/Buffer/process usage. Absolute-ing the
	// paths first keeps --keypair (and the node/script paths themselves)
	// correct after that cwd change, regardless of what relative paths the
	// config defaults use.
	nodePath := absPathOrOriginal(p.cfg.NodePath)
	scriptPath := absPathOrOriginal(p.cfg.ScriptPath)
	keypairPath := absPathOrOriginal(p.cfg.KeypairPath)

	start := time.Now()
	cmd := exec.CommandContext(runCtx, nodePath, scriptPath,
		"--ticket", ticketID,
		"--keypair", keypairPath,
		"--rpc", p.cfg.RPCURL,
	)
	cmd.Dir = filepath.Dir(scriptPath)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	latency := time.Since(start)
	log.Printf("[gamesession] switchboard helper for ticket %s finished in %s", ticketID, latency)

	if stderrText := strings.TrimSpace(stderr.String()); stderrText != "" {
		log.Printf("[gamesession] switchboard helper stderr: %s", stderrText)
	}

	if runCtx.Err() != nil {
		// Context expired (our timeout or the caller's) — the process was
		// killed by exec.CommandContext, so runErr will be a generic "signal:
		// killed"/"context deadline exceeded" that's less useful than saying
		// what actually happened.
		return "", fmt.Errorf("switchboard helper did not finish within %s: %w", timeout, runCtx.Err())
	}

	var out switchboardHelperOutput
	// The helper is contractually required to print exactly one JSON line
	// to stdout even on failure (ok:false), so try to parse it regardless of
	// runErr — that gives the real reason instead of just the exec error.
	if jsonErr := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out); jsonErr != nil {
		if runErr != nil {
			return "", fmt.Errorf("switchboard helper exec failed: %w", runErr)
		}
		return "", fmt.Errorf("switchboard helper produced malformed output: %w", jsonErr)
	}
	if !out.OK {
		errMsg := out.Error
		if errMsg == "" {
			errMsg = "helper reported failure with no error message"
		}
		return "", fmt.Errorf("switchboard helper failed: %s", errMsg)
	}
	if len(out.RandomnessHex) != 64 {
		return "", fmt.Errorf("switchboard helper returned randomness_hex of length %d, want 64", len(out.RandomnessHex))
	}
	if _, hexErr := hex.DecodeString(out.RandomnessHex); hexErr != nil {
		return "", fmt.Errorf("switchboard helper returned non-hex randomness_hex: %w", hexErr)
	}

	log.Printf("[gamesession] switchboard randomness ok for ticket %s (slot=%d reveal_tx=%s)", ticketID, out.Slot, out.RevealTx)

	// Same shape as the other providers' seeds: sha256 of a ":"-joined,
	// versioned string, truncated to 16 bytes (32 hex chars).
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:switchboard-vrf-v1", ticketID, out.RandomnessHex)))
	return "vrf_" + hex.EncodeToString(sum[:16]), nil
}

// absPathOrOriginal returns path made absolute against the current working
// directory. It falls back to the original string on error (e.g. an empty
// path in tests) rather than failing the whole call — exec will then just
// report a clearer "not found" error itself.
func absPathOrOriginal(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}
