// Package payoutreview holds large jackpot payouts for manual staff
// approval before settlement pays them out. Stage 3 anti-cheat hardening —
// behavioral detection catches bots, but an unusually large payout (a
// bug, an exploited edge case, or a genuinely huge jackpot) still warrants
// a human look before money moves.
package payoutreview

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Decision is what CheckAndHold tells the caller to do with a pending payout.
type Decision int

const (
	// DecisionPay means the payout is under threshold, or was already
	// approved by staff — proceed with settlement normally.
	DecisionPay Decision = iota
	// DecisionHold means a review was just opened (or one is still
	// pending) — do not pay, do not requeue, wait for staff.
	DecisionHold
	// DecisionReject means staff rejected this payout — the caller should
	// mark the session 'rejected' and never pay it.
	DecisionReject
)

// Review is a single payout awaiting or having received a staff decision.
type Review struct {
	ID             string     `json:"id"`
	SessionID      string     `json:"session_id"`
	WalletAddress  string     `json:"wallet_address"`
	GameID         string     `json:"game_id"`
	PayoutEstimate int64      `json:"payout_estimate"`
	Status         string     `json:"status"`
	ReviewedBy     string     `json:"reviewed_by,omitempty"`
	ReviewedAt     *time.Time `json:"reviewed_at,omitempty"`
	Notes          string     `json:"notes,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
}

// Service gates large payouts behind manual staff approval.
type Service struct {
	db        *pgxpool.Pool
	threshold int64 // lamports (USDC base units, 6 decimals); payouts >= this are held.
}

// NewService creates a payout review service. threshold is in USDC base
// units (1 USDC = 1_000_000) — payouts at or above it are held for review.
func NewService(db *pgxpool.Pool, threshold int64) *Service {
	return &Service{db: db, threshold: threshold}
}

// CheckAndHold decides whether a winning session's payout can proceed.
// Called by the settlement worker immediately before it would pay out.
//
// - No existing review + payout < threshold: DecisionPay, nothing recorded.
// - No existing review + payout >= threshold: opens a review, DecisionHold.
// - Existing review, status 'pending': DecisionHold (still waiting on staff).
// - Existing review, status 'approved': DecisionPay (staff cleared it).
// - Existing review, status 'rejected': DecisionReject.
func (s *Service) CheckAndHold(ctx context.Context, sessionID, wallet, gameID string, payoutEstimate int64) (Decision, error) {
	var status string
	err := s.db.QueryRow(ctx,
		`SELECT status FROM payout_reviews WHERE session_id = $1::uuid`, sessionID,
	).Scan(&status)

	switch {
	case err == nil:
		switch status {
		case "approved":
			return DecisionPay, nil
		case "rejected":
			return DecisionReject, nil
		default:
			return DecisionHold, nil
		}
	case errors.Is(err, pgx.ErrNoRows):
		if payoutEstimate < s.threshold {
			return DecisionPay, nil
		}
		if _, insertErr := s.db.Exec(ctx, `
			INSERT INTO payout_reviews (session_id, wallet_address, game_id, payout_estimate)
			VALUES ($1::uuid, $2, $3, $4)
		`, sessionID, wallet, gameID, payoutEstimate); insertErr != nil {
			return DecisionHold, fmt.Errorf("failed to open payout review: %w", insertErr)
		}
		if _, updErr := s.db.Exec(ctx, `
			UPDATE game_sessions SET result = 'review_hold' WHERE id = $1::uuid AND result = 'pending'
		`, sessionID); updErr != nil {
			return DecisionHold, fmt.Errorf("failed to mark session held for review: %w", updErr)
		}
		return DecisionHold, nil
	default:
		return DecisionHold, fmt.Errorf("failed to check payout review status: %w", err)
	}
}

// RegisterRoutes registers the staff review endpoints. Callers must mount
// this under an admin-authenticated group — these endpoints move real money.
func (s *Service) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/payout-reviews", s.HandleList)
	rg.POST("/payout-reviews/:id/approve", s.HandleApprove)
	rg.POST("/payout-reviews/:id/reject", s.HandleReject)
}

// HandleList handles GET /admin/payout-reviews?status=pending (default: pending).
func (s *Service) HandleList(c *gin.Context) {
	status := c.DefaultQuery("status", "pending")
	rows, err := s.db.Query(c.Request.Context(), `
		SELECT id, session_id, wallet_address, game_id, payout_estimate,
		       status, COALESCE(reviewed_by, ''), reviewed_at, COALESCE(notes, ''), created_at
		FROM payout_reviews
		WHERE status = $1
		ORDER BY created_at ASC
	`, status)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load reviews"})
		return
	}
	defer rows.Close()

	reviews := []Review{}
	for rows.Next() {
		var r Review
		if err := rows.Scan(&r.ID, &r.SessionID, &r.WalletAddress, &r.GameID, &r.PayoutEstimate,
			&r.Status, &r.ReviewedBy, &r.ReviewedAt, &r.Notes, &r.CreatedAt); err != nil {
			continue
		}
		reviews = append(reviews, r)
	}
	c.JSON(http.StatusOK, gin.H{"reviews": reviews})
}

type decisionRequest struct {
	ReviewedBy string `json:"reviewed_by" binding:"required"`
	Notes      string `json:"notes"`
}

// HandleApprove handles POST /admin/payout-reviews/:id/approve. Setting the
// session back to 'pending' lets the ordinary settlement poll loop pay it —
// CheckAndHold will see the 'approved' row and return DecisionPay.
func (s *Service) HandleApprove(c *gin.Context) {
	s.decide(c, "approved", "pending")
}

// HandleReject handles POST /admin/payout-reviews/:id/reject. The session
// moves straight to 'rejected' — settlement never queries 'rejected' sessions.
func (s *Service) HandleReject(c *gin.Context) {
	s.decide(c, "rejected", "rejected")
}

func (s *Service) decide(c *gin.Context, reviewStatus, sessionResult string) {
	id := c.Param("id")
	var req decisionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "reviewed_by is required"})
		return
	}

	ctx := c.Request.Context()
	var sessionID string
	err := s.db.QueryRow(ctx, `
		UPDATE payout_reviews
		SET status = $1, reviewed_by = $2, notes = $3, reviewed_at = NOW()
		WHERE id = $4::uuid AND status = 'pending'
		RETURNING session_id
	`, reviewStatus, req.ReviewedBy, req.Notes, id).Scan(&sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "no pending review with that id"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update review"})
		return
	}

	if _, err := s.db.Exec(ctx, `
		UPDATE game_sessions SET result = $1 WHERE id = $2::uuid AND result = 'review_hold'
	`, sessionResult, sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "review recorded but session update failed"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"session_id": sessionID, "status": reviewStatus})
}
