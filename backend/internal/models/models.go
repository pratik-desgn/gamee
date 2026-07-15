package models

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// User represents a platform user.
type User struct {
	ID         pgtype.UUID        `json:"id"`
	CreatedAt  time.Time          `json:"created_at"`
	Country    string             `json:"country"`
	Status     string             `json:"status"`
	LastActive *time.Time         `json:"last_active,omitempty"`
}

// Wallet represents a linked Solana wallet.
type Wallet struct {
	Address    string    `json:"address"`
	UserID     pgtype.UUID `json:"user_id"`
	FirstSeen  time.Time `json:"first_seen"`
	IsBanned   bool      `json:"is_banned"`
	BanReason  *string   `json:"ban_reason,omitempty"`
}

// Ticket represents a purchased game ticket.
type Ticket struct {
	ID              pgtype.UUID `json:"id"`
	WalletAddress   string      `json:"wallet_address"`
	TxSignature     string      `json:"tx_signature"`
	PurchasedAt     time.Time   `json:"purchased_at"`
	ConsumedAt      *time.Time  `json:"consumed_at,omitempty"`
	Status          string      `json:"status"`
	OnChainTicketPDA string     `json:"on_chain_ticket_pda"`
	AmountUSDC      int64       `json:"amount_usdc"`
	Tier            string      `json:"tier"`
}

// GameSession represents a single play session.
type GameSession struct {
	ID              pgtype.UUID        `json:"id"`
	TicketID        pgtype.UUID        `json:"ticket_id"`
	UserID          pgtype.UUID        `json:"user_id"`
	GameID          string             `json:"game_id"`
	VRFRequest      *string            `json:"vrf_request,omitempty"`
	VRFResult       *int64             `json:"vrf_result,omitempty"`
	DifficultyParams map[string]interface{} `json:"difficulty_params"`
	Seed            string             `json:"seed"`
	StartedAt       time.Time          `json:"started_at"`
	EndedAt         *time.Time         `json:"ended_at,omitempty"`
	Result          string             `json:"result"`
	TargetScore     int                `json:"target_score"`
	FinalScore      *int               `json:"final_score,omitempty"`
	PayoutTx        *string            `json:"payout_tx,omitempty"`
	Tier            string             `json:"tier"`
}

// Replay represents a verified replay of a game session.
type Replay struct {
	SessionID      pgtype.UUID `json:"session_id"`
	InputLog       []byte      `json:"input_log"`
	ClientScore    int         `json:"client_score"`
	VerifiedScore  *int        `json:"verified_score,omitempty"`
	Verdict        string      `json:"verdict"`
	VerifierVersion string     `json:"verifier_version"`
	VerifiedAt     *time.Time  `json:"verified_at,omitempty"`
	DurationMs     *int        `json:"duration_ms,omitempty"`
}

// Game represents a registered game in the wheel.
type Game struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Category        string    `json:"category"`
	Description     string    `json:"description"`
	BaseDifficulty  int       `json:"base_difficulty"`
	MinDifficulty   int       `json:"min_difficulty"`
	MaxDifficulty   int       `json:"max_difficulty"`
	WheelWeight     int       `json:"wheel_weight"`
	AvgPlayDuration int       `json:"avg_play_duration"`
	Enabled         bool      `json:"enabled"`
	SDKVersion      string    `json:"sdk_version"`
	CreatedAt       time.Time `json:"created_at"`
}

// Jackpot represents a jackpot pool.
type Jackpot struct {
	ID            pgtype.UUID `json:"id"`
	Tier          string      `json:"tier"`
	VaultAddress  string      `json:"vault_address"`
	CurrentAmount int64       `json:"current_amount"`
	SeededFrom    *pgtype.UUID `json:"seeded_from,omitempty"`
	CreatedAt     time.Time   `json:"created_at"`
	LastWonAt     *time.Time  `json:"last_won_at,omitempty"`
	TotalPlays    int64       `json:"total_plays"`
}

// Transaction represents an on-chain transaction record.
type Transaction struct {
	ID            pgtype.UUID `json:"id"`
	WalletAddress string      `json:"wallet_address"`
	Type          string      `json:"type"`
	Amount        int64       `json:"amount"`
	TxSignature   string      `json:"tx_signature"`
	Status        string      `json:"status"`
	CreatedAt     time.Time   `json:"created_at"`
}

// CheatFlag represents a detected cheating incident.
type CheatFlag struct {
	ID            pgtype.UUID `json:"id"`
	WalletAddress string      `json:"wallet_address"`
	SessionID     pgtype.UUID `json:"session_id"`
	RuleTriggered string      `json:"rule_triggered"`
	Severity      string      `json:"severity"`
	ActionTaken   string      `json:"action_taken"`
	CreatedAt     time.Time   `json:"created_at"`
}

// Referral represents a referral relationship.
type Referral struct {
	ID             pgtype.UUID `json:"id"`
	ReferrerWallet string      `json:"referrer_wallet"`
	RefereeWallet  string      `json:"referee_wallet"`
	Pct            int         `json:"pct"`
	CapGames       *int        `json:"cap_games,omitempty"`
	EarnedTotal    int64       `json:"earned_total"`
	CreatedAt      time.Time   `json:"created_at"`
}

// DailyStats represents aggregated daily statistics.
type DailyStats struct {
	Date          time.Time `json:"date"`
	Plays         int64     `json:"plays"`
	UniquePlayers int64     `json:"unique_players"`
	Revenue       int64     `json:"revenue"`
	JackpotDelta  int64     `json:"jackpot_delta"`
	Winners       int       `json:"winners"`
	AvgDifficulty float64   `json:"avg_difficulty"`
}

// LeaderboardEntry represents a single entry on the leaderboard.
type LeaderboardEntry struct {
	Rank        int     `json:"rank"`
	Wallet      string  `json:"wallet"`
	Score       int     `json:"score"`
	GamesPlayed int     `json:"games_played"`
	Wins        int     `json:"wins"`
	WinRate     float64 `json:"win_rate"`
}
