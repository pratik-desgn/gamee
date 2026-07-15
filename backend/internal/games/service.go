package games

import (
	"context"
	"fmt"
	"math"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service provides game metadata and difficulty engine.
type Service struct {
	db *pgxpool.Pool
}

// GameInfo holds game metadata.
type GameInfo struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Category        string `json:"category"`
	Description     string `json:"description,omitempty"`
	BaseDifficulty  int    `json:"base_difficulty"`
	MinDifficulty   int    `json:"min_difficulty"`
	MaxDifficulty   int    `json:"max_difficulty"`
	WheelWeight     int    `json:"wheel_weight"`
	AvgPlayDuration int    `json:"avg_play_duration"`
	Enabled         bool   `json:"enabled"`
}

// DifficultyConfig defines scaling parameters for a game.
type DifficultyConfig struct {
	Level       int     `json:"level"`
	GapSize     float64 `json:"gap_size,omitempty"`
	Speed       float64 `json:"speed,omitempty"`
	Gravity     float64 `json:"gravity,omitempty"`
	TargetScore int     `json:"target_score"`
	Params      map[string]float64 `json:"params"`
}

// NewService creates a game service.
func NewService(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

// RegisterRoutes registers game routes.
func (s *Service) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/games", s.HandleListGames)
	rg.GET("/games/:id", s.HandleGetGame)
	rg.GET("/games/:id/difficulty", s.HandleGetDifficulty)
}

// HandleListGames returns all enabled games.
func (s *Service) HandleListGames(c *gin.Context) {
	games, err := s.listGames(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"games": games})
}

// HandleGetGame returns a single game by ID.
func (s *Service) HandleGetGame(c *gin.Context) {
	id := c.Param("id")
	game, err := s.getGame(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "game not found"})
		return
	}
	c.JSON(http.StatusOK, game)
}

// HandleGetDifficulty returns calculated difficulty for a game + level.
func (s *Service) HandleGetDifficulty(c *gin.Context) {
	id := c.Param("id")
	game, err := s.getGame(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "game not found"})
		return
	}
	level := 3
	c.DefaultQuery("level", "3")
	fmt.Sscanf(c.Query("level"), "%d", &level)
	if level < game.MinDifficulty {
		level = game.MinDifficulty
	}
	if level > game.MaxDifficulty {
		level = game.MaxDifficulty
	}
	diff := CalculateDifficulty(game, level)
	c.JSON(http.StatusOK, diff)
}

// CalculateDifficulty computes game-specific difficulty parameters.
func CalculateDifficulty(game *GameInfo, level int) *DifficultyConfig {
	config := &DifficultyConfig{
		Level:  level,
		Params: make(map[string]float64),
	}
	// Normalize level to 0-1 range
	t := float64(level-game.MinDifficulty) / float64(game.MaxDifficulty-game.MinDifficulty)
	if t > 1 {
		t = 1
	}
	if t < 0 {
		t = 0
	}

	switch game.Category {
	case "precision":
		config.Speed = 2 + t*3           // 2-5
		config.Gravity = 0.4 + t*0.3     // 0.4-0.7
		config.GapSize = 200 - t*100     // 200-100
		config.TargetScore = 5 + level*5 // 10-55
		config.Params["pipeFrequency"] = math.Round(100 - t*40)
	case "endless":
		config.Speed = 2 + t*3
		config.Gravity = 0.4 + t*0.4
		config.TargetScore = 5 + level*5
		config.Params["jumpVelocity"] = -(10 - t*4)
		config.Params["obstacleFrequency"] = math.Round(90 - t*30)
	case "reflex":
		config.TargetScore = 5 + level*3
		config.Params["targetCount"] = math.Round(5 + t*15)
		config.Params["targetRadius"] = 40 - t*25
		config.Params["timeLimit"] = math.Round(60 - t*30)
	case "memory":
		config.TargetScore = 8 + level*2
		config.Params["sequenceSpeed"] = math.Round(120 - t*90)
		config.Params["colors"] = math.Round(4 + t*2)
	case "puzzle":
		config.TargetScore = int(math.Pow(2, float64(9+level))) // 512, 1024, 2048...
		config.Params["gridSize"] = math.Round(4 + t*2)
	case "luck-skill":
		config.TargetScore = 5 + level*3
		config.Params["gridSize"] = math.Round(4 + t*4)
		config.Params["mineRatio"] = 0.1 + t*0.3
	}

	config.Params["level"] = float64(level)
	config.Params["targetScore"] = float64(config.TargetScore)
	return config
}

func (s *Service) listGames(ctx context.Context) ([]GameInfo, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, name, category, COALESCE(description,''), base_difficulty,
		        min_difficulty, max_difficulty, wheel_weight, avg_play_duration, enabled
		 FROM games ORDER BY wheel_weight DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var games []GameInfo
	for rows.Next() {
		var g GameInfo
		if err := rows.Scan(&g.ID, &g.Name, &g.Category, &g.Description,
			&g.BaseDifficulty, &g.MinDifficulty, &g.MaxDifficulty,
			&g.WheelWeight, &g.AvgPlayDuration, &g.Enabled); err != nil {
			return nil, err
		}
		games = append(games, g)
	}
	return games, nil
}

func (s *Service) getGame(ctx context.Context, id string) (*GameInfo, error) {
	var g GameInfo
	err := s.db.QueryRow(ctx,
		`SELECT id, name, category, COALESCE(description,''), base_difficulty,
		        min_difficulty, max_difficulty, wheel_weight, avg_play_duration, enabled
		 FROM games WHERE id = $1`, id).
		Scan(&g.ID, &g.Name, &g.Category, &g.Description,
			&g.BaseDifficulty, &g.MinDifficulty, &g.MaxDifficulty,
			&g.WheelWeight, &g.AvgPlayDuration, &g.Enabled)
	if err != nil {
		return nil, err
	}
	return &g, nil
}
