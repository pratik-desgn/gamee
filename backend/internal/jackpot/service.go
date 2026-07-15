package jackpot

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// LiveJackpotResponse is the response for GET /api/v1/jackpot/live.
type LiveJackpotResponse struct {
	CurrentAmount int64  `json:"current_amount"`
	Tier          string `json:"tier"`
	VaultAddress  string `json:"vault_address"`
	PlayersOnline int    `json:"players_online"`
	TodayPlays    int64  `json:"today_plays"`
}

// HistoryEntry represents a jackpot win in history.
type HistoryEntry struct {
	WonAt     time.Time `json:"won_at"`
	AmountUSDC int64    `json:"amount_usdc"`
	Winner    string    `json:"winner"`
	GameID    string    `json:"game_id"`
}

// Service manages jackpot state with Redis caching.
type Service struct {
	db         *pgxpool.Pool
	rdb        *redis.Client
	vaultAddr  string
	cacheKey   string
	historyKey string
}

// NewService creates a new jackpot service.
func NewService(db *pgxpool.Pool, rdb *redis.Client, vaultAddr string) *Service {
	return &Service{
		db:         db,
		rdb:        rdb,
		vaultAddr:  vaultAddr,
		cacheKey:   "jackpot:current_amount",
		historyKey: "jackpot:history",
	}
}

// RegisterRoutes registers jackpot routes.
func (s *Service) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/live", s.HandleLive)
	rg.GET("/history", s.HandleHistory)
}

// HandleLive handles GET /api/v1/jackpot/live.
func (s *Service) HandleLive(c *gin.Context) {
	ctx := c.Request.Context()

	// Try Redis cache first.
	amount, err := s.rdb.Get(ctx, s.cacheKey).Int64()
	if err != nil {
		// Cache miss — query database or on-chain.
		amount, err = s.loadFromDB(ctx)
		if err != nil {
			amount = 0
		}
		// Refresh cache.
		s.rdb.Set(ctx, s.cacheKey, amount, 30*time.Second)
	}

	// Determine tier based on amount.
	tier := s.determineTier(amount)

	// Get online players from Redis.
	playersOnline, _ := s.rdb.Get(ctx, "jackpot:players_online").Int()

	// Get today's plays.
	todayPlays, _ := s.getTodayPlays(ctx)

	c.JSON(http.StatusOK, LiveJackpotResponse{
		CurrentAmount: amount,
		Tier:          tier,
		VaultAddress:  s.vaultAddr,
		PlayersOnline: playersOnline,
		TodayPlays:    todayPlays,
	})
}

// HandleHistory handles GET /api/v1/jackpot/history.
func (s *Service) HandleHistory(c *gin.Context) {
	ctx := c.Request.Context()

	// Try Redis cache first.
	cached, err := s.rdb.LRange(ctx, s.historyKey, 0, 49).Result()
	if err == nil && len(cached) > 0 {
		var history []HistoryEntry
		for _, item := range cached {
			var entry HistoryEntry
			if err := json.Unmarshal([]byte(item), &entry); err == nil {
				history = append(history, entry)
			}
		}
		if history != nil {
			c.JSON(http.StatusOK, gin.H{"history": history})
			return
		}
	}

	// Fallback: query database.
	history, err := s.loadHistoryFromDB(ctx)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"history": []HistoryEntry{}})
		return
	}

	// Cache in Redis.
	for _, entry := range history {
		data, _ := json.Marshal(entry)
		s.rdb.RPush(ctx, s.historyKey, string(data))
	}
	s.rdb.Expire(ctx, s.historyKey, 5*time.Minute)

	c.JSON(http.StatusOK, gin.H{"history": history})
}

// UpdateFromChainEvent is called by the chain watcher when a jackpot event occurs.
func (s *Service) UpdateFromChainEvent(ctx context.Context, amount int64) error {
	// Update Redis cache.
	if err := s.rdb.Set(ctx, s.cacheKey, amount, 30*time.Second).Err(); err != nil {
		return fmt.Errorf("failed to update cache: %w", err)
	}

	// Update database.
	_, err := s.db.Exec(ctx,
		`UPDATE jackpots SET current_amount = $1 WHERE vault_address = $2`,
		amount, s.vaultAddr)
	if err != nil {
		log.Printf("[jackpot] failed to update DB: %v", err)
	}

	return nil
}

// loadFromDB loads the current jackpot amount from the database.
func (s *Service) loadFromDB(ctx context.Context) (int64, error) {
	var amount int64
	err := s.db.QueryRow(ctx,
		`SELECT current_amount FROM jackpots
		 WHERE vault_address = $1 ORDER BY created_at DESC LIMIT 1`,
		s.vaultAddr).Scan(&amount)
	if err != nil {
		return 0, fmt.Errorf("failed to load from DB: %w", err)
	}
	return amount, nil
}

// loadHistoryFromDB loads jackpot history from the database.
func (s *Service) loadHistoryFromDB(ctx context.Context) ([]HistoryEntry, error) {
	rows, err := s.db.Query(ctx,
		`SELECT j.last_won_at, j.current_amount, w.address, gs.game_id
		 FROM jackpots j
		 LEFT JOIN game_sessions gs ON gs.result = 'won' AND gs.payout_tx IS NOT NULL
		 LEFT JOIN wallets w ON w.user_id = gs.user_id
		 WHERE j.last_won_at IS NOT NULL
		 ORDER BY j.last_won_at DESC LIMIT 50`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var history []HistoryEntry
	for rows.Next() {
		var entry HistoryEntry
		if err := rows.Scan(&entry.WonAt, &entry.AmountUSDC, &entry.Winner, &entry.GameID); err != nil {
			continue
		}
		history = append(history, entry)
	}

	if history == nil {
		history = []HistoryEntry{}
	}
	return history, nil
}

// determineTier maps an amount to a jackpot tier.
func (s *Service) determineTier(amount int64) string {
	switch {
	case amount >= 10_000_000_000: // 10,000 USDC
		return "legend"
	case amount >= 1_000_000_000: // 1,000 USDC
		return "mega"
	case amount >= 100_000_000: // 100 USDC
		return "medium"
	default:
		return "small"
	}
}

// getTodayPlays returns the number of plays today.
func (s *Service) getTodayPlays(ctx context.Context) (int64, error) {
	var plays int64
	err := s.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM game_sessions
		 WHERE started_at >= CURRENT_DATE`).Scan(&plays)
	return plays, err
}
