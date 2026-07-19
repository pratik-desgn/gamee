package payoutreview

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
)

// AutoReviewer clears pending payout reviews automatically when every trust
// signal is clean, so a legitimate big win settles in ~a minute instead of
// waiting for a human with curl. Anything suspicious stays held: the
// auto-reviewer never rejects — that judgement (and any payout above
// maxAuto) remains a human decision via the /admin endpoints.
//
// A hold is auto-approved only when ALL of these are true:
//   - the winning wallet is not banned
//   - the session being paid has zero cheat flags (the verification worker
//     has already replayed the input log by the time a session is 'won')
//   - the wallet has no high/critical cheat flags and no review/ban-grade
//     actions anywhere in its history
//   - the payout is below maxAuto
//
// Signals that fail are written into the review's notes so the human
// queue explains itself.
type AutoReviewer struct {
	svc      *Service
	maxAuto  int64 // USDC base units; payouts >= this always wait for a human
	interval time.Duration
	minAge   time.Duration // let the verification/flag writes fully land first
}

// NewAutoReviewer wires an auto-reviewer over the same DB as the review
// service. maxAuto <= 0 disables auto-approval entirely.
func NewAutoReviewer(svc *Service, maxAuto int64) *AutoReviewer {
	return &AutoReviewer{svc: svc, maxAuto: maxAuto, interval: 30 * time.Second, minAge: 30 * time.Second}
}

// Start runs the polling loop until ctx is cancelled.
func (a *AutoReviewer) Start(ctx context.Context) {
	if a.maxAuto <= 0 {
		log.Println("[autoreview] disabled (AUTO_REVIEW_MAX_PAYOUT <= 0) — all held payouts wait for staff")
		return
	}
	log.Printf("[autoreview] started (auto-approve clean holds under %.2f USDC, poll %s)",
		float64(a.maxAuto)/1e6, a.interval)
	ticker := time.NewTicker(a.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.sweep(ctx)
		}
	}
}

type pendingHold struct {
	id        string
	sessionID string
	wallet    string
	payout    int64
	notes     string
}

func (a *AutoReviewer) sweep(ctx context.Context) {
	rows, err := a.svc.db.Query(ctx, `
		SELECT id, session_id, wallet_address, payout_estimate, COALESCE(notes, '')
		FROM payout_reviews
		WHERE status = 'pending' AND created_at < NOW() - $1::interval
		ORDER BY created_at ASC
		LIMIT 20
	`, a.minAge.String())
	if err != nil {
		log.Printf("[autoreview] failed to load pending reviews: %v", err)
		return
	}
	holds := []pendingHold{}
	for rows.Next() {
		var h pendingHold
		if err := rows.Scan(&h.id, &h.sessionID, &h.wallet, &h.payout, &h.notes); err == nil {
			holds = append(holds, h)
		}
	}
	rows.Close()

	for _, h := range holds {
		reasons, err := a.suspicions(ctx, h)
		if err != nil {
			log.Printf("[autoreview] signal check failed for review %s: %v", h.id, err)
			continue
		}
		if len(reasons) == 0 {
			a.approve(ctx, h)
			continue
		}
		// Leave it for a human, but make the queue self-explanatory. Only
		// write once (empty notes) so a human's own notes are never clobbered.
		if h.notes == "" {
			note := "auto-review: needs human — " + strings.Join(reasons, "; ")
			if _, err := a.svc.db.Exec(ctx,
				`UPDATE payout_reviews SET notes = $1 WHERE id = $2::uuid AND status = 'pending' AND (notes IS NULL OR notes = '')`,
				note, h.id); err != nil {
				log.Printf("[autoreview] failed to note review %s: %v", h.id, err)
			} else {
				log.Printf("[autoreview] holding review %s for staff: %s", h.id, note)
			}
		}
	}
}

// suspicions returns the list of failed trust signals (empty = clean).
func (a *AutoReviewer) suspicions(ctx context.Context, h pendingHold) ([]string, error) {
	reasons := []string{}

	if h.payout >= a.maxAuto {
		reasons = append(reasons, fmt.Sprintf("payout %.2f USDC exceeds auto-approve cap %.2f", float64(h.payout)/1e6, float64(a.maxAuto)/1e6))
	}

	var banned bool
	if err := a.svc.db.QueryRow(ctx,
		`SELECT is_banned FROM wallets WHERE address = $1`, h.wallet).Scan(&banned); err != nil {
		return nil, fmt.Errorf("wallet lookup: %w", err)
	}
	if banned {
		reasons = append(reasons, "wallet is banned")
	}

	var sessionFlags int
	if err := a.svc.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM cheat_flags WHERE session_id = $1::uuid`, h.sessionID).Scan(&sessionFlags); err != nil {
		return nil, fmt.Errorf("session flags: %w", err)
	}
	if sessionFlags > 0 {
		reasons = append(reasons, fmt.Sprintf("%d cheat flag(s) on the winning session", sessionFlags))
	}

	var walletFlags int
	if err := a.svc.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM cheat_flags
		WHERE wallet_address = $1
		  AND (severity IN ('high', 'critical') OR action_taken IN ('review', 'ban'))
	`, h.wallet).Scan(&walletFlags); err != nil {
		return nil, fmt.Errorf("wallet history: %w", err)
	}
	if walletFlags > 0 {
		reasons = append(reasons, fmt.Sprintf("%d high-severity flag(s) in wallet history", walletFlags))
	}

	return reasons, nil
}

// approve mirrors HandleApprove: mark the review approved and put the
// session back to 'pending' so the settlement poll loop pays it (its
// CheckAndHold will now see the approved row and return DecisionPay).
func (a *AutoReviewer) approve(ctx context.Context, h pendingHold) {
	note := fmt.Sprintf("auto-approved: wallet clean, session unflagged, %.2f USDC under cap", float64(h.payout)/1e6)
	tag, err := a.svc.db.Exec(ctx, `
		UPDATE payout_reviews
		SET status = 'approved', reviewed_by = 'auto-reviewer', notes = $1, reviewed_at = NOW()
		WHERE id = $2::uuid AND status = 'pending'
	`, note, h.id)
	if err != nil || tag.RowsAffected() == 0 {
		log.Printf("[autoreview] failed to approve review %s: %v", h.id, err)
		return
	}
	if _, err := a.svc.db.Exec(ctx, `
		UPDATE game_sessions SET result = 'pending' WHERE id = $1::uuid AND result = 'review_hold'
	`, h.sessionID); err != nil {
		log.Printf("[autoreview] review %s approved but session release failed: %v", h.id, err)
		return
	}
	log.Printf("[autoreview] approved review %s (session %s, %.2f USDC) — releasing to settlement",
		h.id, h.sessionID, float64(h.payout)/1e6)
}
