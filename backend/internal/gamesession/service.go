package gamesession

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"gamee-backend/internal/anticheat"
)

// newUUIDv4 returns a random RFC-4122 v4 UUID string. Used for game session
// IDs so they satisfy the ::uuid columns in Postgres (a "sess_..." string does
// not, which previously caused every game_sessions insert to fail silently).
func newUUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// allowedWSOrigins is the exact-match Origin allowlist for WebSocket
// upgrades, set once at startup via SetAllowedOrigins (from
// config.AllowedOrigins / the ALLOWED_ORIGINS env var). Empty means
// dev-permissive: accept any origin — fine for local development, refused
// at startup for non-development ENVIRONMENT by main.go.
var allowedWSOrigins map[string]bool

// SetAllowedOrigins installs the WebSocket origin allowlist. Call once
// before serving; not safe to call concurrently with active upgrades.
func SetAllowedOrigins(origins []string) {
	if len(origins) == 0 {
		allowedWSOrigins = nil
		return
	}
	m := make(map[string]bool, len(origins))
	for _, o := range origins {
		m[strings.TrimRight(strings.TrimSpace(o), "/")] = true
	}
	allowedWSOrigins = m
}

// upgrader upgrades HTTP connections to WebSocket.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		if allowedWSOrigins == nil {
			return true // dev mode: no allowlist configured
		}
		// Browsers always send Origin on cross-site WS handshakes; a
		// missing header means a non-browser client (curl, native app,
		// the e2e script), which the JWT auth layer still gates.
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		return allowedWSOrigins[strings.TrimRight(origin, "/")]
	},
}

// GameState represents the current state sent to the client each tick.
type GameState struct {
	Type     string      `json:"type"`
	Frame    int         `json:"frame"`
	Score    int         `json:"score"`
	HP       int         `json:"hp,omitempty"`
	Finished bool        `json:"finished"`
	State    interface{} `json:"state,omitempty"`
}

// GameResult is sent when the game ends.
type GameResult struct {
	Type           string `json:"type"`
	Frame          int    `json:"frame"`
	Verdict        string `json:"verdict"`
	Score          int    `json:"score"`
	FinalizedScore int    `json:"finalized_score"`
	PayoutTx       string `json:"payout_tx,omitempty"`
}

// ClientMessage represents a message from the client over WebSocket.
// The "action" field is the protocol envelope type (input/ping).
// The "input_type" field is the game-specific input type (tap/keydown/etc).
type ClientMessage struct {
	Action    string                 `json:"action"` // "input" | "ping"
	Frame     int                    `json:"frame,omitempty"`
	InputType string                 `json:"input_type,omitempty"` // game input type
	Data      map[string]interface{} `json:"data,omitempty"`
	Time      int64                  `json:"time,omitempty"`
}

// Session represents an active game session.
type Session struct {
	ID           string
	UserID       string
	Wallet       string
	GameID       string
	Seed         string
	Difficulty   map[string]interface{}
	TargetScore  int
	TicketID     string
	FPS          int
	InputLog     []InputRecord
	mu           sync.Mutex
	Conn         *websocket.Conn
	Connected    bool
	CurrentFrame int
	CurrentScore int
	Finished     bool
	LastInputAt  time.Time
}

// InputRecord stores a single input event for replay.
type InputRecord struct {
	Frame int                    `json:"frame"`
	Type  string                 `json:"type"`
	Data  map[string]interface{} `json:"data"`
	Time  int64                  `json:"time"`
}

// Service manages game sessions and WebSocket connections.
type Service struct {
	db        *pgxpool.Pool
	rdb       *redis.Client
	sessions  map[string]*Session
	mu        sync.RWMutex
	tickRate  int
	maxActive int
	rand      RandomnessProvider
}

// NewService creates a new game session service. rand supplies the per-spin
// seed source (see randomness.go / NewRandomnessProvider).
func NewService(db *pgxpool.Pool, rdb *redis.Client, tickRate, maxActive int, rand RandomnessProvider) *Service {
	return &Service{
		db:        db,
		rdb:       rdb,
		sessions:  make(map[string]*Session),
		tickRate:  tickRate,
		maxActive: maxActive,
		rand:      rand,
	}
}

// SpinRequest is the request body for POST /api/v1/spin.
type SpinRequest struct {
	TicketID string `json:"ticket_id" binding:"required"`
}

// SpinResponse is the response for a successful spin.
type SpinResponse struct {
	SessionID   string                 `json:"session_id"`
	GameID      string                 `json:"game_id"`
	Seed        string                 `json:"seed"`
	Difficulty  map[string]interface{} `json:"difficulty"`
	TargetScore int                    `json:"target_score"`
	FPS         int                    `json:"fps"`
}

// RegisterRoutes registers game session routes.
func (s *Service) RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/spin", s.HandleSpin)
	rg.GET("/session/:id/play", s.HandleWebSocket)
	rg.POST("/session/:id/finish", s.HandleFinish)
	rg.GET("/session/:id/result", s.HandleResult)
	rg.GET("/me/history", s.HandleUserHistory)
}

// ResultResponse is the response for GET /api/v1/session/:id/result.
type ResultResponse struct {
	SessionID   string  `json:"session_id"`
	Verdict     string  `json:"verdict"` // "pending" | "won" | "lost" | "rejected" | "review_hold"
	Score       *int    `json:"score,omitempty"`
	PayoutTx    *string `json:"payout_tx,omitempty"`
	GameID      string  `json:"game_id"`
	TargetScore *int    `json:"target_score,omitempty"`
	Tier        string  `json:"tier"`
}

// HandleResult handles GET /api/v1/session/:id/result. The real, verified
// outcome — driven by the verification worker's replay + the settlement
// service, not the WebSocket tick loop's client-facing preview.
func (s *Service) HandleResult(c *gin.Context) {
	sessionID := c.Param("id")
	userID, _ := c.Get("user_id")
	userIDStr, _ := userID.(string)

	var ownerID, result, gameID, tier string
	var finalScore, targetScore *int
	var payoutTx *string
	err := s.db.QueryRow(c.Request.Context(),
		`SELECT user_id, result, final_score, payout_tx, game_id, target_score, tier FROM game_sessions WHERE id = $1::uuid`,
		sessionID,
	).Scan(&ownerID, &result, &finalScore, &payoutTx, &gameID, &targetScore, &tier)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found", "code": "SESSION_NOT_FOUND"})
		return
	}
	if ownerID != userIDStr {
		c.JSON(http.StatusForbidden, gin.H{"error": "session does not belong to this account", "code": "FORBIDDEN"})
		return
	}

	c.JSON(http.StatusOK, ResultResponse{
		SessionID:   sessionID,
		Verdict:     result,
		Score:       finalScore,
		PayoutTx:    payoutTx,
		GameID:      gameID,
		TargetScore: targetScore,
		Tier:        tier,
	})
}

// HistoryEntry is one row of GET /api/v1/me/history.
type HistoryEntry struct {
	ID          string `json:"id"`
	GameID      string `json:"game_id"`
	Seed        string `json:"seed"`
	StartedAt   string `json:"started_at"`
	Result      string `json:"result"`
	FinalScore  *int   `json:"final_score,omitempty"`
	TargetScore int    `json:"target_score"`
}

// HandleUserHistory handles GET /api/v1/me/history — the authenticated
// wallet's own game session history. The frontend profile page
// (frontend/src/app/profile/page.tsx) has called this endpoint since it was
// written, but no backend route ever existed for it (a silent 404, swallowed
// by the page's .catch(() => {})) until now.
func (s *Service) HandleUserHistory(c *gin.Context) {
	userID, _ := c.Get("user_id")
	userIDStr, _ := userID.(string)

	rows, err := s.db.Query(c.Request.Context(),
		`SELECT id, game_id, seed, started_at, result, final_score, target_score
		 FROM game_sessions
		 WHERE user_id = $1::uuid
		 ORDER BY started_at DESC
		 LIMIT 50`, userIDStr)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load session history", "code": "INTERNAL_ERROR"})
		return
	}
	defer rows.Close()

	sessions := []HistoryEntry{}
	for rows.Next() {
		var e HistoryEntry
		var startedAt time.Time
		if err := rows.Scan(&e.ID, &e.GameID, &e.Seed, &startedAt, &e.Result, &e.FinalScore, &e.TargetScore); err != nil {
			continue
		}
		e.StartedAt = startedAt.Format(time.RFC3339)
		sessions = append(sessions, e)
	}

	c.JSON(http.StatusOK, gin.H{"sessions": sessions})
}

// HandleSpin handles POST /api/v1/spin — creates a new game session.
func (s *Service) HandleSpin(c *gin.Context) {
	var req SpinRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_REQUEST"})
		return
	}

	userID, _ := c.Get("user_id")
	wallet, _ := c.Get("wallet")
	userIDStr, _ := userID.(string)
	walletStr, _ := wallet.(string)

	ctx := c.Request.Context()

	if banned, err := s.isWalletBanned(ctx, walletStr); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check wallet status", "code": "INTERNAL_ERROR"})
		return
	} else if banned {
		c.JSON(http.StatusForbidden, gin.H{"error": "wallet is banned", "code": "WALLET_BANNED"})
		return
	}

	// Atomically claim the ticket: the WHERE clause only matches an unused
	// ticket owned by this wallet, so two concurrent /spin calls for the
	// same ticket can't both pass — only one UPDATE affects a row. A
	// separate read-then-write (SELECT status, then later UPDATE) would
	// leave a race window letting one paid ticket spin twice. RETURNING
	// tier carries the ticket's tier onto the session in the same atomic
	// statement rather than a separate follow-up read.
	var ticketTier string
	err := s.db.QueryRow(ctx,
		`UPDATE tickets SET status = 'consumed', consumed_at = NOW()
		 WHERE id = $1::uuid AND wallet_address = $2 AND status = 'unused'
		 RETURNING tier`,
		req.TicketID, walletStr).Scan(&ticketTier)
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ticket not found or already used", "code": "TICKET_UNAVAILABLE"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to claim ticket: " + err.Error(), "code": "INTERNAL_ERROR"})
		return
	}

	// Select a game using wheel weights.
	// Seed comes from VRF-derived hash.
	seed := s.generateVRFSeed(ctx, req.TicketID)
	game, err := s.selectGame(ctx, seed)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to select game: " + err.Error(), "code": "INTERNAL_ERROR"})
		return
	}

	hardened, err := s.isWalletHardened(ctx, walletStr)
	if err != nil {
		log.Printf("[gamesession] failed to check anti-cheat tier for %s: %v", walletStr, err)
	}
	difficultyParams, targetScore := s.calculateDifficulty(game, seed, hardened)

	// Create session ID (must be a valid UUID for the game_sessions.id column).
	sessionID := newUUIDv4()

	// Insert game session record.
	paramsJSON, _ := json.Marshal(difficultyParams)
	_, err = s.db.Exec(ctx,
		`INSERT INTO game_sessions (id, ticket_id, user_id, game_id, seed,
		 difficulty_params, target_score, started_at, result, tier)
		 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, NOW(), 'pending', $8)`,
		sessionID, req.TicketID, userIDStr, game.ID, seed,
		string(paramsJSON), targetScore, ticketTier)
	if err != nil {
		log.Printf("[gamesession] failed to insert session: %v", err)
		// Continue even if DB insert fails — session can still be played.
	}

	// Create in-memory session.
	session := &Session{
		ID:          sessionID,
		UserID:      userIDStr,
		Wallet:      walletStr,
		GameID:      game.ID,
		Seed:        seed,
		Difficulty:  difficultyParams,
		TargetScore: targetScore,
		TicketID:    req.TicketID,
		FPS:         s.tickRate,
		InputLog:    []InputRecord{},
	}

	s.mu.Lock()
	s.sessions[sessionID] = session
	s.mu.Unlock()

	// Track active players in Redis.
	s.rdb.Incr(ctx, "jackpot:players_online")

	c.JSON(http.StatusOK, SpinResponse{
		SessionID:   sessionID,
		GameID:      game.ID,
		Seed:        seed,
		Difficulty:  difficultyParams,
		TargetScore: targetScore,
		FPS:         s.tickRate,
	})
}

// HandleWebSocket handles WS /api/v1/session/:id/play.
func (s *Service) HandleWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

	s.mu.RLock()
	session, exists := s.sessions[sessionID]
	s.mu.RUnlock()

	if !exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found", "code": "SESSION_NOT_FOUND"})
		return
	}

	// Upgrade to WebSocket.
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[gamesession] WebSocket upgrade failed for session %s: %v", sessionID, err)
		return
	}

	session.mu.Lock()
	session.Conn = conn
	session.Connected = true
	session.LastInputAt = time.Now()
	session.mu.Unlock()

	// Send init message.
	initMsg := map[string]interface{}{
		"type":         "init",
		"session_id":   sessionID,
		"game_id":      session.GameID,
		"seed":         session.Seed,
		"difficulty":   session.Difficulty,
		"target_score": session.TargetScore,
		"fps":          session.FPS,
	}
	conn.WriteJSON(initMsg)

	// Start game tick loop in a goroutine.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer conn.Close()
	defer func() {
		session.mu.Lock()
		session.Connected = false
		session.mu.Unlock()
		s.rdb.Decr(ctx, "jackpot:players_online")
	}()

	// Goroutine to read client messages.
	inputCh := make(chan ClientMessage, 100)
	go func() {
		defer close(inputCh)
		for {
			var msg ClientMessage
			if err := conn.ReadJSON(&msg); err != nil {
				log.Printf("[gamesession] read error for session %s: %v", sessionID, err)
				return
			}

			if msg.Action == "ping" {
				conn.WriteJSON(map[string]string{"type": "pong"})
				continue
			}

			if msg.Action == "input" {
				session.mu.Lock()
				session.CurrentFrame = msg.Frame
				session.LastInputAt = time.Now()
				session.InputLog = append(session.InputLog, InputRecord{
					Frame: msg.Frame,
					Type:  msg.InputType,
					Data:  msg.Data,
					Time:  msg.Time,
				})
				session.mu.Unlock()

				select {
				case inputCh <- msg:
				default:
					// Drop if channel full (rate limiting).
				}
			}
		}
	}()

	// Game tick loop (fixed timestep).
	ticker := time.NewTicker(time.Second / time.Duration(s.tickRate))
	defer ticker.Stop()

	// Placeholder game simulation.
	session.mu.Lock()
	score := session.CurrentScore
	target := session.TargetScore
	session.mu.Unlock()

	frame := 0
	const maxFrames = 60 * 30 // 30 seconds at 60 FPS

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			frame++

			// Process queued inputs.
			select {
			case msg := <-inputCh:
				// Apply input to game state.
				if tap, ok := msg.Data["tap"].(bool); ok && tap {
					score += 10
				}
			default:
			}

			// Simulate game difficulty (score naturally increases slightly).
			score += 1

			session.mu.Lock()
			session.CurrentScore = score
			session.mu.Unlock()

			// Send state update.
			state := GameState{
				Type:     "state",
				Frame:    frame,
				Score:    score,
				Finished: false,
				State: map[string]interface{}{
					"obstacles": []interface{}{},
				},
			}

			if err := conn.WriteJSON(state); err != nil {
				log.Printf("[gamesession] write error for session %s: %v", sessionID, err)
				return
			}

			// Check game over conditions.
			if frame >= maxFrames || score >= target*2 {
				// This tick loop is a placeholder client-facing preview, not
				// the authoritative simulation — the real score comes from
				// the replay verification worker re-running the actual
				// deterministic game module against the submitted input log
				// (see HandleFinish + verification.Worker + settlement.Service).
				// It must NOT decide or persist game_sessions.result: doing
				// so would flip the row out of 'pending' before the real
				// verified verdict is computed, permanently blocking
				// settlement from ever seeing it as payable (settlement
				// only polls sessions still 'pending'). The verdict sent
				// here is a preview only — the client still calls
				// /session/:id/finish, which is what actually queues
				// verification and eventual settlement.
				previewVerdict := "lost"
				if score >= target {
					previewVerdict = "won"
				}

				result := GameResult{
					Type:           "result",
					Frame:          frame,
					Verdict:        previewVerdict,
					Score:          score,
					FinalizedScore: score,
				}
				conn.WriteJSON(result)

				// Drop the in-memory tracking entry — HandleFinish looks up
				// session state from Postgres (the durable, restart-safe
				// source of truth), not this map, so it doesn't race against
				// this cleanup.
				s.mu.Lock()
				delete(s.sessions, session.ID)
				s.mu.Unlock()
				return
			}
		}
	}
}

// HandleFinish handles POST /api/v1/session/:id/finish.
func (s *Service) HandleFinish(c *gin.Context) {
	sessionID := c.Param("id")

	var req struct {
		InputLog []InputRecord `json:"input_log" binding:"required"`
		// gte=0, NOT required: gin's required tag rejects the zero value,
		// and a score of 0 is a legitimate loss submission.
		ClientScore int `json:"client_score" binding:"gte=0"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_REQUEST"})
		return
	}

	userID, _ := c.Get("user_id")
	userIDStr, _ := userID.(string)
	ctx := c.Request.Context()

	// Look up the session in Postgres — not the in-memory map, which may
	// already be empty (backend restart, or the WS handler's cleanup
	// having already run) even though the session is still legitimately
	// awaiting verification. This also confirms ownership: only the wallet
	// that owns the session may submit its replay.
	var ownerID string
	var result string
	err := s.db.QueryRow(ctx,
		`SELECT user_id, result FROM game_sessions WHERE id = $1::uuid`, sessionID,
	).Scan(&ownerID, &result)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found", "code": "SESSION_NOT_FOUND"})
		return
	}
	if ownerID != userIDStr {
		c.JSON(http.StatusForbidden, gin.H{"error": "session does not belong to this account", "code": "FORBIDDEN"})
		return
	}
	if result != "pending" {
		c.JSON(http.StatusConflict, gin.H{"error": "session already finalized", "code": "ALREADY_FINALIZED"})
		return
	}

	// Store input log and client score for verification.
	inputLogJSON, _ := json.Marshal(req.InputLog)
	_, err = s.db.Exec(ctx,
		`INSERT INTO replays (session_id, input_log, client_score, verdict, verifier_version)
		 VALUES ($1::uuid, $2, $3, 'pending', '1.0.0')
		 ON CONFLICT (session_id) DO UPDATE SET input_log = $2, client_score = $3`,
		sessionID, string(inputLogJSON), req.ClientScore)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save replay: " + err.Error(), "code": "INTERNAL_ERROR"})
		return
	}

	// Publish to Redis queue for verification workers.
	s.rdb.LPush(ctx, "verification:queue", sessionID)

	c.JSON(http.StatusOK, gin.H{
		"verdict": "pending",
		"queued":  true,
	})
}

// GameInfo holds basic game info for wheel selection and difficulty assignment.
type GameInfo struct {
	ID             string
	WheelWeight    int
	BaseDifficulty int
	MinDifficulty  int
	MaxDifficulty  int
}

// selectGame picks a game using weighted random selection.
func (s *Service) selectGame(ctx context.Context, seed string) (*GameInfo, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, wheel_weight, base_difficulty, min_difficulty, max_difficulty
		 FROM games WHERE enabled = true`)
	if err != nil {
		return nil, fmt.Errorf("failed to query games: %w", err)
	}
	defer rows.Close()

	var games []GameInfo
	var totalWeight int
	for rows.Next() {
		var g GameInfo
		if err := rows.Scan(&g.ID, &g.WheelWeight, &g.BaseDifficulty,
			&g.MinDifficulty, &g.MaxDifficulty); err != nil {
			return nil, fmt.Errorf("failed to scan game: %w", err)
		}
		games = append(games, g)
		totalWeight += g.WheelWeight
	}

	if len(games) == 0 {
		// Fallback if no games registered in DB.
		return &GameInfo{ID: "wing-rush", WheelWeight: 10,
			BaseDifficulty: 6, MinDifficulty: 1, MaxDifficulty: 10}, nil
	}

	// Weighted selection using VRF-derived seed.
	// In production, this uses the actual VRF result from the oracle.
	// The seed is deterministic from (ticketID, slot) so the wheel result
	// is verifiable on-chain.
	rng := s.seededRNG(seed)
	roll := rng() % int64(totalWeight)
	cumulative := 0
	for _, g := range games {
		cumulative += g.WheelWeight
		if roll < int64(cumulative) {
			return &g, nil
		}
	}

	return &games[len(games)-1], nil
}

// hardenedLevelBoost is added to a game's base difficulty for wallets the
// action ladder has flagged enough to harden (see anticheat.TierHardened)
// but not enough to ban outright — makes it costlier for a bot to keep
// matching scores without shutting the wallet out entirely. Clamped to the
// game's max_difficulty.
const hardenedLevelBoost = 3

// calculateDifficulty assigns the session's difficulty level from the game's
// catalog row (games.base_difficulty, adjusted live by the difficulty
// governor within [min_difficulty, max_difficulty]).
//
// The returned params use the shape the replay verifier and the games SDK
// consume ({level, params}): every game derives all of its own tuning — and
// its real win condition — from `level` (see games/games/<id>/index.ts), so
// the platform only picks the level. The nested "params" map stays available
// for explicit per-session overrides.
func (s *Service) calculateDifficulty(game *GameInfo, seed string, hardened bool) (map[string]interface{}, int) {
	level := game.BaseDifficulty
	if level <= 0 {
		level = 6
	}
	if hardened {
		level += hardenedLevelBoost
	}
	if game.MaxDifficulty > 0 && level > game.MaxDifficulty {
		level = game.MaxDifficulty
	}
	if game.MinDifficulty > 0 && level < game.MinDifficulty {
		level = game.MinDifficulty
	}

	params := map[string]interface{}{
		"level":   level,
		"params":  map[string]interface{}{},
		"seed":    seed,
		"game_id": game.ID,
	}

	return params, displayTargetScore(game.ID, level)
}

// displayTargetScore mirrors each game's own level→target formula from
// games/games/<id>/index.ts for DISPLAY ONLY (the spin and play pages show
// it as "Target"). The authoritative win decision is the sim's `won` flag
// surfaced by the replay verifier — if a formula here drifts from the TS
// original the UI shows a stale number, but no payout is affected.
// Note two inverted scales: reaction-test's target is an average reaction
// time in ms and sliding-puzzle's is a move-count par — lower is better.
func displayTargetScore(gameID string, level int) int {
	lerp := func(a, b float64) float64 { return a + float64(level-1)*((b-a)/9.0) }
	switch gameID {
	case "wing-rush", "dino-sprint":
		return level * 5
	case "block-merge":
		if level <= 3 {
			return 512
		}
		if level <= 6 {
			return 1024
		}
		return 2048
	case "simon-pro":
		return int(math.Round(lerp(8, 20)))
	case "aim-master":
		targets := math.Round(lerp(5, 20))
		hit := math.Round(targets * (0.7 - float64(level-1)*(0.2/9.0)))
		if hit < 1 {
			hit = 1
		}
		return int(hit)
	case "perfect-stack":
		return level * 3
	case "reaction-test":
		ms := math.Round(500 - float64(level-1)*(300.0/9.0))
		if ms < 200 {
			ms = 200
		}
		return int(ms)
	case "helix-drop":
		platforms := math.Round(lerp(10, 100))
		return int(math.Round(platforms * (0.4 + float64(level-1)*(0.4/9.0))))
	case "minefield":
		grid := math.Round(lerp(4, 8))
		total := grid * grid
		mines := math.Round(total * (0.10 + float64(level-1)*((0.50-0.10)/9.0)))
		if mines < 1 {
			mines = 1
		}
		return int(total - mines)
	case "sliding-puzzle":
		grid := math.Round(lerp(3, 5))
		tiles := grid*grid - 1
		par := math.Round(tiles*2 - float64(level-1)*(tiles/9.0))
		if par < 10 {
			par = 10
		}
		return int(par)
	default:
		return 100 + level*50
	}
}

// isWalletBanned checks the action-ladder ban flag (see
// verification.Worker.escalateWallet). No wallet row yet means not banned.
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

// isWalletHardened re-derives the action-ladder tier from the same 30-day
// cheat_flags history verification.Worker.escalateWallet reads, so a wallet
// that's been shadow-flagged enough gets harder difficulty on its next spin.
// latestAction is empty here — this runs at spin time, not right after a
// fresh analysis, so there's no "current session" action to fold in.
func (s *Service) isWalletHardened(ctx context.Context, wallet string) (bool, error) {
	rows, err := s.db.Query(ctx,
		`SELECT action_taken FROM cheat_flags
		 WHERE wallet_address = $1 AND created_at > NOW() - INTERVAL '30 days'`, wallet)
	if err != nil {
		return false, err
	}
	defer rows.Close()

	var actions []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err == nil {
			actions = append(actions, a)
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}

	tier := anticheat.DetermineTier(actions, "")
	return tier == anticheat.TierHardened || tier == anticheat.TierBanned, nil
}

// GetSession retrieves a session by ID (for verification workers).
func (s *Service) GetSession(id string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessions[id]
}

// generateVRFSeed returns the per-spin seed from the configured randomness
// provider (SlotHashes sysvar entropy by default, deterministic fallback).
// See randomness.go. The seed is recorded on-chain by commit_spin.
func (s *Service) generateVRFSeed(ctx context.Context, ticketID string) string {
	return s.rand.Seed(ctx, ticketID)
}

// seededRNG returns a deterministic pseudo-random function from a seed string.
// Uses a simple mulberry32 PRNG seeded from the VRF-derived seed.
func (s *Service) seededRNG(seed string) func() int64 {
	// Hash seed to get a 32-bit integer.
	h := sha256.Sum256([]byte(seed))
	state := int64(h[0])<<24 | int64(h[1])<<16 | int64(h[2])<<8 | int64(h[3])
	if state == 0 {
		state = 1
	}
	return func() int64 {
		state ^= state << 13
		state ^= state >> 17
		state ^= state << 5
		// Mask to positive int64
		return state & 0x7FFFFFFFFFFFFFFF
	}
}
