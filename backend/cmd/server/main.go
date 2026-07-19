package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"gamee-backend/internal/auth"
	"gamee-backend/internal/faucet"
	"gamee-backend/internal/config"
	"gamee-backend/internal/database"
	"gamee-backend/internal/difficulty"
	"gamee-backend/internal/games"
	"gamee-backend/internal/gamesession"
	"gamee-backend/internal/jackpot"
	"gamee-backend/internal/leaderboard"
	"gamee-backend/internal/middleware"
	"gamee-backend/internal/payoutreview"
	"gamee-backend/internal/settlement"
	"gamee-backend/internal/ticket"
	"gamee-backend/internal/verification"
	"gamee-backend/pkg/solana"
)

func main() {
	// Load configuration.
	cfg := config.Load()
	log.Printf("[main] starting GAMEE backend (env=%s, port=%d)", cfg.Environment, cfg.Port)

	// Create root context with cancellation.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize database connections.
	pgPool, err := database.NewPostgresPool(ctx, cfg.DatabaseURL, cfg.MaxConns, cfg.MinConns)
	if err != nil {
		log.Fatalf("[main] failed to connect to PostgreSQL: %v", err)
	}
	defer pgPool.Close()

	rdb, err := database.NewRedisClient(ctx, cfg.RedisURL, cfg.RedisDB)
	if err != nil {
		log.Fatalf("[main] failed to connect to Redis: %v", err)
	}
	defer rdb.Close()

	// WebSocket origin allowlist — fail closed outside development: an
	// empty allowlist means "accept any origin", which is a CSWSH hole on
	// a real deployment.
	if len(cfg.AllowedOrigins) == 0 && cfg.Environment != "development" {
		log.Fatalf("[main] ALLOWED_ORIGINS must be set when ENVIRONMENT=%q (empty allowlist accepts any WebSocket origin)", cfg.Environment)
	}
	gamesession.SetAllowedOrigins(cfg.AllowedOrigins)

	// Initialize Solana client.
	solClient := solana.NewClient(cfg.SolanaRPCURL, cfg.Commitment)

	// Initialize services.
	authSvc := auth.NewService(pgPool, rdb, cfg.JWTSecret, cfg.JWTExpiration)
	authSvc.SetAllowedWallets(cfg.BetaAllowedWallets)
	ticketSvc := ticket.NewService(pgPool, rdb, cfg.SolanaRPCURL, cfg.ProgramID, cfg.USDTMint, cfg.VaultAddress)
	sbCfg := gamesession.SwitchboardConfig{
		NodePath:    cfg.VRFHelperNode,
		ScriptPath:  cfg.VRFHelperScript,
		KeypairPath: cfg.VRFKeypairPath,
		RPCURL:      cfg.SolanaRPCURL,
		Timeout:     time.Duration(cfg.VRFTimeoutSeconds) * time.Second,
	}
	randProvider := gamesession.NewRandomnessProvider(cfg.VRFMode, solClient, pgPool, sbCfg)
	gameSvc := gamesession.NewService(pgPool, rdb, cfg.TickRate, cfg.MaxPlayers, randProvider)
	jackpotSvc := jackpot.NewService(pgPool, rdb, cfg.VaultAddress)
	leaderSvc := leaderboard.NewService(pgPool, rdb)

	// Initialize game service (game metadata + difficulty engine).
	gamesSvc := games.NewService(pgPool)

	// Large payouts are held for staff approval instead of auto-settling.
	reviewSvc := payoutreview.NewService(pgPool, cfg.LargePayoutReviewThreshold)

	// Auto-clear held payouts whose trust signals are all clean; only
	// suspicious (or very large) wins wait for a human.
	go payoutreview.NewAutoReviewer(reviewSvc, cfg.AutoReviewMaxPayout).Start(ctx)

	// Initialize settlement worker (watches for winning verdicts).
	settlementSvc := settlement.NewService(pgPool, rdb, cfg.SolanaRPCURL, cfg.ProgramID, cfg.USDTMint, cfg.VerifierKeyPath, cfg.VerifierCosignerKeyPaths, reviewSvc)
	go settlementSvc.Start(ctx)

	// Initialize verification worker pool.
	verifyWorker := verification.NewWorker(pgPool, rdb, cfg.ReplayWorkers, settlementSvc, cfg.VerifierScriptPath, cfg.AntiCheatAutoBan)
	if !cfg.AntiCheatAutoBan {
		log.Println("[main] anti-cheat auto-ban DISABLED (ANTICHEAT_AUTOBAN=false) — flags recorded, ladder capped at hardened")
	}
	go verifyWorker.Start(ctx)

	// Periodically refresh leaderboard materialized views.
	go leaderSvc.StartRefreshLoop(ctx, 5*time.Minute)

	// Closed-loop difficulty: nudge games.base_difficulty from observed
	// verified win rates to hold the average jackpot in its target range.
	go difficulty.New(pgPool, cfg.GovernorExcludeWallets).Start(ctx)

	// Initialize Gin router.
	router := gin.New()
	router.Use(gin.Logger())
	router.Use(gin.Recovery())
	router.Use(middleware.CORS(cfg.AllowedOrigins))

	// Health check endpoint.
	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "ok",
			"version": "1.0.0",
			"env":     cfg.Environment,
			"time":    time.Now().UTC(),
		})
	})

	// Rate limiter store.
	rateLimitStore := middleware.NewRateLimitStore(cfg.RateLimitPerSecond, cfg.RateLimitBurst)
	defer rateLimitStore.Stop()

	// Global rate limiting for all /api/v1 routes.
	apiV1 := router.Group("/api/v1")
	apiV1.Use(middleware.RateLimit(rateLimitStore))

	// Auth routes (no JWT required).
	authGroup := apiV1.Group("/auth")
	authSvc.RegisterRoutes(authGroup)

	// Protected routes (JWT required).
	protected := apiV1.Group("")
	protected.Use(middleware.AuthMiddleware(cfg.JWTSecret))

	// Ticket routes.
	ticketGroup := protected.Group("/tickets")
	ticketSvc.RegisterRoutes(ticketGroup)

	// Game session routes.
	gameSvc.RegisterRoutes(protected)

	// Game metadata + difficulty routes.
	gamesSvc.RegisterRoutes(protected)

	// Jackpot routes (public data — the homepage shows the live jackpot to
	// anonymous visitors, so requiring a JWT here just guarantees 401s).
	jackpotSvc.RegisterRoutes(apiV1)

	// Leaderboard routes (public data — no JWT required).
	leaderSvc.RegisterRoutes(apiV1)

	// Staff-only routes (large-payout review queue), gated by a static
	// admin key rather than the player JWT flow.
	adminGroup := apiV1.Group("/admin")
	adminGroup.Use(middleware.AdminAuthMiddleware(cfg.AdminAPIKey))
	reviewSvc.RegisterRoutes(adminGroup)

	// Beta faucet (devnet only, env-gated).
	if cfg.BetaFaucetEnabled {
		faucetSvc := faucet.NewService(rdb, cfg.SolanaRPCURL, cfg.USDTMint,
			cfg.FaucetKeypairPath, cfg.FaucetSOLLamports, cfg.FaucetUSDCMicro, cfg.FaucetPerDay)
		faucetSvc.RegisterRoutes(protected)
		log.Printf("[main] beta faucet ENABLED (mint %s, %.3f SOL + %.2f USDC per grant, %d/day)",
			cfg.USDTMint, float64(cfg.FaucetSOLLamports)/1e9, float64(cfg.FaucetUSDCMicro)/1e6, cfg.FaucetPerDay)
	}

	// Start HTTP server.
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      router,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
	}

	// Graceful shutdown.
	go func() {
		quit := make(chan os.Signal, 1)
		signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
		<-quit
		log.Println("[main] shutting down server...")
		cancel()

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Fatalf("[main] server forced to shutdown: %v", err)
		}

		log.Println("[main] server exited gracefully")
	}()

	log.Printf("[main] server listening on %s", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[main] server error: %v", err)
	}
}
