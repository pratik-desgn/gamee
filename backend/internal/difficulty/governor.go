// Package difficulty holds the closed-loop difficulty governor.
//
// The economics target an average jackpot payout of 1,000-2,000 USDC. With
// an 80% jackpot cut of $1 tickets and a 95/5 winner/seed payout split, the
// average win is ~= 0.95 * 0.80 * plays-per-win, so the per-play win rate
// has to sit between roughly 1-in-1300 (avg ~$1,000) and 1-in-2600
// (avg ~$2,000).
//
// Human win rates per game can't be predicted offline — they depend on real
// player skill against each game's level curve. So instead of guessing,
// the governor observes verified outcomes (replays.won on verdict='match')
// and nudges games.base_difficulty one level at a time within the game's
// [min_difficulty, max_difficulty] band: too many wins → harder, too few →
// easier. Sessions always snapshot the level at creation, so an adjustment
// only affects future sessions.
package difficulty

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// Win-rate band derived from the 1,000-2,000 USDC average-jackpot target.
	targetWinRateLow  = 1.0 / 2600.0
	targetWinRateHigh = 1.0 / 1300.0

	// Look-back window for outcome sampling. Long enough to accumulate
	// meaningful samples at rare win rates, short enough to react within
	// days of a difficulty misjudgment.
	sampleWindow = 7 * 24 * time.Hour

	// Minimum verified sessions per game before acting. Below this, a
	// handful of lucky wins would whipsaw the level. At the target win
	// rate (~1/1900), 500 sessions with 1-2 wins is expected noise; the
	// band check below only reacts to rates clearly outside it.
	minSample = 500

	adjustInterval = 1 * time.Hour
)

// Governor periodically adjusts per-game difficulty from observed win rates.
type Governor struct {
	db *pgxpool.Pool
	// excludeWallets are ignored when sampling outcomes. The devnet e2e
	// bots (contracts/scripts/e2e-bots.ts) win at superhuman rates — a few
	// test runs would read as "winning too often" and walk every game's
	// base_difficulty to max, wrecking the tuning real players see.
	excludeWallets []string
}

func New(db *pgxpool.Pool, excludeWallets []string) *Governor {
	// Never nil: pgx encodes a nil slice as SQL NULL, and
	// `NOT (x = ANY(NULL))` is NULL — which would silently filter out
	// every row instead of none.
	if excludeWallets == nil {
		excludeWallets = []string{}
	}
	return &Governor{db: db, excludeWallets: excludeWallets}
}

// Start runs the adjustment loop until ctx is cancelled.
func (g *Governor) Start(ctx context.Context) {
	ticker := time.NewTicker(adjustInterval)
	defer ticker.Stop()
	log.Printf("[difficulty] governor started (band %.6f..%.6f wins/play, window %s, min sample %d)",
		targetWinRateLow, targetWinRateHigh, sampleWindow, minSample)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			g.runOnce(ctx)
		}
	}
}

// runOnce samples the window and applies at most one level step per game.
func (g *Governor) runOnce(ctx context.Context) {
	// Denominator is verified sessions only (verdict = 'match'): mismatch/
	// rejected/timeout replays are cheating attempts or infra failures, not
	// skill outcomes, and would dilute the observed rate.
	// game_sessions has no wallet column — the owning wallet lives on the
	// ticket, so the exclusion filter joins through tickets.
	rows, err := g.db.Query(ctx, `
		SELECT gs.game_id,
		       COUNT(*) FILTER (WHERE r.won),
		       COUNT(*),
		       gm.base_difficulty, gm.min_difficulty, gm.max_difficulty
		FROM replays r
		JOIN game_sessions gs ON gs.id = r.session_id
		JOIN tickets t ON t.id = gs.ticket_id
		JOIN games gm ON gm.id = gs.game_id
		WHERE r.verdict = 'match'
		  AND r.verified_at > NOW() - $1::interval
		  AND NOT (t.wallet_address = ANY($2))
		GROUP BY gs.game_id, gm.base_difficulty, gm.min_difficulty, gm.max_difficulty`,
		sampleWindow.String(), g.excludeWallets)
	if err != nil {
		log.Printf("[difficulty] sample query failed: %v", err)
		return
	}
	defer rows.Close()

	type adjustment struct {
		gameID   string
		from, to int
		wins     int
		total    int
	}
	var adjustments []adjustment
	for rows.Next() {
		var gameID string
		var wins, total, base, min, max int
		if err := rows.Scan(&gameID, &wins, &total, &base, &min, &max); err != nil {
			log.Printf("[difficulty] scan failed: %v", err)
			return
		}
		next := Decide(base, min, max, wins, total)
		if next != base {
			adjustments = append(adjustments, adjustment{gameID, base, next, wins, total})
		}
	}
	if rows.Err() != nil {
		log.Printf("[difficulty] sample rows failed: %v", rows.Err())
		return
	}

	for _, a := range adjustments {
		// Guard on the read value so concurrent instances can't double-step.
		if _, err := g.db.Exec(ctx,
			`UPDATE games SET base_difficulty = $1
			 WHERE id = $2 AND base_difficulty = $3`,
			a.to, a.gameID, a.from); err != nil {
			log.Printf("[difficulty] failed to adjust %s: %v", a.gameID, err)
			continue
		}
		log.Printf("[difficulty] %s: level %d -> %d (observed %d wins / %d verified plays)",
			a.gameID, a.from, a.to, a.wins, a.total)
	}
}

// Decide returns the next difficulty level for a game given its observed
// verified outcomes. Pure function, one step at a time, clamped to
// [min, max]; returns current unchanged when the sample is too small or the
// rate is inside the target band.
func Decide(current, min, max, wins, total int) int {
	if total < minSample {
		return current
	}
	rate := float64(wins) / float64(total)
	next := current
	switch {
	case rate > targetWinRateHigh:
		next = current + 1 // winning too often → harder
	case rate < targetWinRateLow:
		next = current - 1 // winning too rarely → easier
	}
	if max > 0 && next > max {
		next = max
	}
	if min > 0 && next < min {
		next = min
	}
	return next
}
