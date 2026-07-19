package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all configuration values for the backend.
type Config struct {
	// Server
	Port         int
	ReadTimeout  time.Duration
	WriteTimeout time.Duration

	// Database
	DatabaseURL string
	MaxConns    int
	MinConns    int

	// Redis
	RedisURL string
	RedisDB  int

	// Auth
	JWTSecret     string
	JWTExpiration time.Duration

	// Solana
	SolanaRPCURL    string
	SolanaWSSURL    string
	VerifierKeyPath string
	// VerifierCosignerKeyPaths holds additional verifier_set member keypair
	// paths (see contracts/programs/gamee/src/state/verifier_set.rs) that
	// co-sign settle_session alongside VerifierKeyPath to meet the on-chain
	// quorum threshold. May be empty (e.g. a devnet verifier_set with
	// threshold 1) — settlement then signs with only the primary verifier.
	VerifierCosignerKeyPaths []string
	ProgramID                string
	VaultAddress             string
	USDTMint                 string
	Commitment               string

	// Game
	TickRate           int
	MaxPlayers         int
	ReplayWorkers      int
	VerifierScriptPath string
	// VRFMode selects the per-spin randomness source: "slothash" (default,
	// on-chain SlotHashes entropy), "switchboard" (Switchboard On-Demand
	// oracle randomness, opt-in — falls back to slothash on any error), or
	// "deterministic" (legacy hash, tests).
	VRFMode string
	// VRFHelperNode/VRFHelperScript/VRFKeypairPath/VRFTimeoutSeconds only
	// matter when VRFMode == "switchboard"; see
	// gamesession.SwitchboardConfig and gamesession/switchboard.go.
	VRFHelperNode     string
	VRFHelperScript   string
	VRFKeypairPath    string
	VRFTimeoutSeconds int

	// Beta faucet (devnet-only): when enabled, POST /api/v1/beta/faucet
	// funds the authed wallet with FaucetSOLLamports + FaucetUSDCMicro
	// (minted — FaucetKeypairPath must be the test mint's authority),
	// FaucetPerDay grants per wallet per UTC day. NEVER enable against a
	// real mint.
	BetaFaucetEnabled bool
	// AntiCheatAutoBan: when false (ANTICHEAT_AUTOBAN=false, for betas while
	// thresholds are uncalibrated), the action ladder never escalates past
	// "hardened" — cheat_flags are still recorded, wallets are never banned.
	AntiCheatAutoBan bool
	FaucetKeypairPath string
	FaucetSOLLamports int64
	FaucetUSDCMicro   int64
	FaucetPerDay      int
	// BetaAllowedWallets, when non-empty, restricts auth (nonce+verify) to
	// exactly these wallet addresses — the small-group beta gate. Empty =
	// open (default).
	BetaAllowedWallets []string

	// AllowedOrigins is the exact-match Origin allowlist for WebSocket
	// upgrades (ALLOWED_ORIGINS, comma-separated, e.g.
	// "https://gamee.example,https://www.gamee.example"). Empty = accept
	// any origin — allowed only when Environment == "development".
	AllowedOrigins []string

	// GovernorExcludeWallets are wallets whose session outcomes the
	// difficulty governor ignores (GOVERNOR_EXCLUDE_WALLETS, comma-
	// separated). Meant for test/bot wallets (the devnet e2e player):
	// their superhuman win rates would otherwise walk base_difficulty to
	// max for real players.
	GovernorExcludeWallets []string

	// Rate Limiting
	RateLimitPerSecond int
	RateLimitBurst     int

	// Admin / payout review
	AdminAPIKey                string
	LargePayoutReviewThreshold int64
	AutoReviewMaxPayout        int64

	// Environment
	Environment string
}

// Load reads configuration from environment variables with sensible defaults.
func Load() *Config {
	return &Config{
		Port:                     getEnvInt("PORT", 8080),
		ReadTimeout:              getEnvDuration("READ_TIMEOUT", 30*time.Second),
		WriteTimeout:             getEnvDuration("WRITE_TIMEOUT", 30*time.Second),
		DatabaseURL:              getEnv("DATABASE_URL", "postgres://gamee:gamee@localhost:5432/gamee?sslmode=disable"),
		MaxConns:                 getEnvInt("DB_MAX_CONNS", 25),
		MinConns:                 getEnvInt("DB_MIN_CONNS", 5),
		RedisURL:                 getEnv("REDIS_URL", "redis://localhost:6379/0"),
		RedisDB:                  getEnvInt("REDIS_DB", 0),
		JWTSecret:                getEnv("JWT_SECRET", "dev-secret-change-in-production-min-32-bytes!!"),
		JWTExpiration:            getEnvDuration("JWT_EXPIRATION", 24*time.Hour),
		SolanaRPCURL:             getEnv("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
		SolanaWSSURL:             getEnv("SOLANA_WSS_URL", "wss://api.devnet.solana.com/"),
		VerifierKeyPath:          getEnv("VERIFIER_KEY_PATH", "./keys/verifier.json"),
		VerifierCosignerKeyPaths: getEnvStringSlice("VERIFIER_COSIGNER_KEYPAIRS", nil),
		ProgramID:                getEnv("PROGRAM_ID", ""),
		VaultAddress:             getEnv("VAULT_ADDRESS", ""),
		USDTMint:                 getEnv("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
		Commitment:               getEnv("SOLANA_COMMITMENT", "confirmed"),
		TickRate:                 getEnvInt("TICK_RATE", 60),
		MaxPlayers:               getEnvInt("MAX_PLAYERS", 10000),
		ReplayWorkers:            getEnvInt("REPLAY_WORKERS", 4),
		// "../games/sdk/run.js" relative to the process CWD works for both
		// local dev (run from backend/, games/ is a sibling) and the Docker
		// image (WORKDIR /app, compiled games SDK copied to /games — see
		// backend/Dockerfile). Override only for non-standard layouts.
		VerifierScriptPath: getEnv("VERIFIER_SCRIPT_PATH", "../games/sdk/run.js"),
		VRFMode:            getEnv("VRF_MODE", "slothash"),
		// ts-node (not plain "node"): the helper is TypeScript source
		// (contracts/scripts/vrf-switchboard.ts), and this repo's other
		// ad-hoc scripts (contracts/package.json's "vrf" script,
		// scripts/package.json's "sim" script) run the same way rather than
		// relying on Node's native TS type-stripping, which is unflagged
		// only on very recent Node and isn't present on the Alpine
		// nodejs/npm packages backend/Dockerfile installs. Path is relative
		// to the backend process's CWD, same local-dev-vs-Docker duality as
		// VerifierScriptPath above — override VRF_HELPER_NODE/VRF_HELPER_SCRIPT
		// for other layouts.
		VRFHelperNode:      getEnv("VRF_HELPER_NODE", "../contracts/node_modules/.bin/ts-node"),
		VRFHelperScript:    getEnv("VRF_HELPER_SCRIPT", "../contracts/scripts/vrf-switchboard.ts"),
		VRFKeypairPath:     getEnv("VRF_KEYPAIR", "./keys/verifier-devnet.json"),
		VRFTimeoutSeconds:  getEnvInt("VRF_TIMEOUT_SECONDS", 20),
		BetaFaucetEnabled:  getEnv("BETA_FAUCET", "") == "true",
		AntiCheatAutoBan:   getEnv("ANTICHEAT_AUTOBAN", "true") != "false",
		FaucetKeypairPath:  getEnv("FAUCET_KEYPAIR", ""),
		FaucetSOLLamports:  getEnvInt64("FAUCET_SOL_LAMPORTS", 50_000_000),  // 0.05 SOL
		FaucetUSDCMicro:    getEnvInt64("FAUCET_USDC_MICRO", 20_000_000),    // 20 test USDC
		FaucetPerDay:       getEnvInt("FAUCET_PER_DAY", 2),
		BetaAllowedWallets: getEnvStringSlice("BETA_ALLOWED_WALLETS", nil),
		AllowedOrigins:     getEnvStringSlice("ALLOWED_ORIGINS", nil),
		GovernorExcludeWallets: getEnvStringSlice("GOVERNOR_EXCLUDE_WALLETS", nil),
		RateLimitPerSecond: getEnvInt("RATE_LIMIT_PER_SECOND", 10),
		RateLimitBurst:     getEnvInt("RATE_LIMIT_BURST", 20),
		// 1,000 USDC — matches jackpot.Service's "mega" tier boundary; a
		// payout at or above this size is held for staff approval.
		AdminAPIKey:                getEnv("ADMIN_API_KEY", ""),
		LargePayoutReviewThreshold: getEnvInt64("LARGE_PAYOUT_REVIEW_THRESHOLD", 1_000_000_000),
		// Held payouts with clean trust signals are auto-approved below
		// this cap (10,000 USDC); at/above it — or set <= 0 to disable
		// auto-review entirely — a human must approve via /admin.
		AutoReviewMaxPayout: getEnvInt64("AUTO_REVIEW_MAX_PAYOUT", 10_000_000_000),
		Environment:                getEnv("ENVIRONMENT", "development"),
	}
}

func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if val, ok := os.LookupEnv(key); ok {
		if i, err := strconv.Atoi(val); err == nil {
			return i
		}
	}
	return fallback
}

func getEnvInt64(key string, fallback int64) int64 {
	if val, ok := os.LookupEnv(key); ok {
		if i, err := strconv.ParseInt(val, 10, 64); err == nil {
			return i
		}
	}
	return fallback
}

// getEnvStringSlice reads a comma-separated env var into a string slice.
// Empty entries (from "", extra commas, or surrounding whitespace) are
// dropped; an unset or entirely-empty var returns fallback (typically nil).
func getEnvStringSlice(key string, fallback []string) []string {
	val, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	var out []string
	for _, part := range strings.Split(val, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	if len(out) == 0 {
		return fallback
	}
	return out
}

func getEnvDuration(key string, fallback time.Duration) time.Duration {
	if val, ok := os.LookupEnv(key); ok {
		if d, err := time.ParseDuration(val); err == nil {
			return d
		}
	}
	return fallback
}
