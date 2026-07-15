package leaderboard

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"gamee-backend/internal/models"
)

// countryCodePattern validates the 2-letter code in "country/:code" scopes.
// Enforced before the code is ever used in a query, in addition to it only
// ever being passed as a bound parameter (never interpolated into SQL).
var countryCodePattern = regexp.MustCompile(`^[a-zA-Z]{2}$`)

// Service manages leaderboard data with materialized views.
type Service struct {
	db  *pgxpool.Pool
	rdb *redis.Client
}

// NewService creates a new leaderboard service.
func NewService(db *pgxpool.Pool, rdb *redis.Client) *Service {
	return &Service{
		db:  db,
		rdb: rdb,
	}
}

// RegisterRoutes registers leaderboard routes.
func (s *Service) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/leaderboard/:scope", s.HandleLeaderboard)
}

// HandleLeaderboard handles GET /api/v1/leaderboard/:scope.
func (s *Service) HandleLeaderboard(c *gin.Context) {
	scope := c.Param("scope")
	limit := c.DefaultQuery("limit", "100")
	offset := c.DefaultQuery("offset", "0")

	ctx := c.Request.Context()

	// Try Redis cache first.
	cacheKey := fmt.Sprintf("leaderboard:%s:%s:%s", scope, limit, offset)
	cached, err := s.rdb.Get(ctx, cacheKey).Result()
	if err == nil && cached != "" {
		c.Header("X-Cache", "HIT")
		c.Data(http.StatusOK, "application/json", []byte(cached))
		return
	}

	// Query the materialized view.
	entries, err := s.queryLeaderboard(c, scope, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "failed to fetch leaderboard: " + err.Error(),
			"code":  "INTERNAL_ERROR",
		})
		return
	}

	response := gin.H{"entries": entries}

	// Cache the result. Must be marshaled to bytes first — go-redis's Set
	// only accepts string/[]byte/BinaryMarshaler, so passing the gin.H map
	// directly fails on every call (silently, since the error was
	// previously discarded) and the cache never actually populated.
	if len(entries) > 0 {
		if payload, err := json.Marshal(response); err != nil {
			log.Printf("[leaderboard] failed to marshal cache payload: %v", err)
		} else if err := s.rdb.Set(ctx, cacheKey, payload, 30*time.Second).Err(); err != nil {
			log.Printf("[leaderboard] failed to write cache: %v", err)
		}
	}

	c.Header("X-Cache", "MISS")
	c.JSON(http.StatusOK, response)
}

// fixedViewNames is the whitelist of materialized views that don't take a
// filter parameter. Never derived from user input.
var fixedViewNames = map[string]string{
	"daily":   "leaderboard_daily",
	"weekly":  "leaderboard_weekly",
	"monthly": "leaderboard_monthly",
	"alltime": "leaderboard_alltime",
}

// queryLeaderboard queries the appropriate materialized view. The view name
// is always one of the fixed constants above — for the "country/:code" scope,
// a single leaderboard_country view (with a country column) is filtered by
// a bound query parameter instead of building a per-country view name, so
// no part of the scope path ever reaches the query as an interpolated
// identifier.
func (s *Service) queryLeaderboard(ctx *gin.Context, scope, limit, offset string) ([]models.LeaderboardEntry, error) {
	if code, ok := strings.CutPrefix(scope, "country/"); ok {
		if !countryCodePattern.MatchString(code) {
			return nil, fmt.Errorf("invalid country code: %s", code)
		}
		return s.queryView(ctx, "leaderboard_country", "WHERE UPPER(lb.country) = UPPER($3)", limit, offset, code)
	}

	viewName, ok := fixedViewNames[scope]
	if !ok {
		return nil, fmt.Errorf("invalid scope: %s", scope)
	}
	return s.queryView(ctx, viewName, "", limit, offset)
}

// queryView runs the shared leaderboard projection against the given view
// name (always a compile-time constant, never derived from request input)
// with an optional WHERE clause and its bound args appended after limit/offset.
func (s *Service) queryView(ctx *gin.Context, viewName, whereClause, limit, offset string, extraArgs ...any) ([]models.LeaderboardEntry, error) {
	query := fmt.Sprintf(`
		SELECT
			ROW_NUMBER() OVER (ORDER BY total_score DESC) AS rank,
			w.address AS wallet,
			COALESCE(lb.total_score, 0) AS score,
			COALESCE(lb.games_played, 0) AS games_played,
			COALESCE(lb.wins, 0) AS wins,
			CASE WHEN lb.games_played > 0
				THEN ROUND(lb.wins::numeric / lb.games_played * 100, 2)
				ELSE 0
			END AS win_rate
		FROM %s lb
		JOIN wallets w ON w.user_id = lb.user_id
		%s
		ORDER BY total_score DESC
		LIMIT $1 OFFSET $2
	`, viewName, whereClause)

	args := append([]any{limit, offset}, extraArgs...)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query failed: %w", err)
	}
	defer rows.Close()

	var entries []models.LeaderboardEntry
	for rows.Next() {
		var e models.LeaderboardEntry
		if err := rows.Scan(&e.Rank, &e.Wallet, &e.Score, &e.GamesPlayed, &e.Wins, &e.WinRate); err != nil {
			return nil, fmt.Errorf("scan failed: %w", err)
		}
		entries = append(entries, e)
	}

	if entries == nil {
		entries = []models.LeaderboardEntry{}
	}

	return entries, nil
}

// StartRefreshLoop periodically refreshes the materialized views until ctx
// is canceled. Without this, the views only ever reflect data present at
// DB init time — RefreshMaterializedViews existed but was never called
// from anywhere.
func (s *Service) StartRefreshLoop(ctx context.Context, interval time.Duration) {
	log.Printf("[leaderboard] starting refresh loop (interval=%s)", interval)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("[leaderboard] refresh loop shutting down")
			return
		case <-ticker.C:
			if err := s.RefreshMaterializedViews(ctx); err != nil {
				log.Printf("[leaderboard] refresh failed: %v", err)
			}
		}
	}
}

// RefreshMaterializedViews refreshes all materialized views (called
// periodically by StartRefreshLoop).
func (s *Service) RefreshMaterializedViews(bgCtx context.Context) error {
	views := []string{
		"leaderboard_daily",
		"leaderboard_weekly",
		"leaderboard_monthly",
		"leaderboard_alltime",
		// Single view with a country column (see scripts/init-db.sql),
		// filtered at query time rather than one materialized view per
		// country — no fixed country list to maintain here.
		"leaderboard_country",
	}

	for _, view := range views {
		_, err := s.db.Exec(bgCtx, fmt.Sprintf("REFRESH MATERIALIZED VIEW CONCURRENTLY %s", view))
		if err != nil {
			return fmt.Errorf("failed to refresh %s: %w", view, err)
		}
	}

	return nil
}
