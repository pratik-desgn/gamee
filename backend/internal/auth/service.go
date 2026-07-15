package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	pkgsolana "gamee-backend/pkg/solana"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"gamee-backend/internal/middleware"
)

// Service handles Solana wallet-based authentication.
type Service struct {
	db        *pgxpool.Pool
	rdb       *redis.Client
	jwtSecret string
	jwtExpiry time.Duration
	// allowedWallets, when non-nil, restricts login to exactly these
	// wallets (the small-group beta gate). nil = open registration.
	allowedWallets map[string]bool
}

// SetAllowedWallets installs the beta wallet allowlist. Call once at
// startup, before serving. An empty/nil list leaves auth open.
func (s *Service) SetAllowedWallets(wallets []string) {
	if len(wallets) == 0 {
		s.allowedWallets = nil
		return
	}
	m := make(map[string]bool, len(wallets))
	for _, w := range wallets {
		m[w] = true
	}
	s.allowedWallets = m
}

// walletAllowed reports whether the wallet may authenticate.
func (s *Service) walletAllowed(wallet string) bool {
	return s.allowedWallets == nil || s.allowedWallets[wallet]
}

// NewService creates a new auth service.
func NewService(db *pgxpool.Pool, rdb *redis.Client, jwtSecret string, jwtExpiry time.Duration) *Service {
	return &Service{
		db:        db,
		rdb:       rdb,
		jwtSecret: jwtSecret,
		jwtExpiry: jwtExpiry,
	}
}

// storeNonce records an issued nonce for a wallet with a 5-minute TTL in Redis.
func (s *Service) storeNonce(ctx context.Context, wallet, nonce string) {
	key := fmt.Sprintf("auth:nonce:%s:%s", wallet, nonce)
	s.rdb.Set(ctx, key, nonce, 5*time.Minute)
}

// consumeNonce validates and removes the nonce for a wallet (single use).
// Uses Redis GET + DEL for atomicity within a single replica; TTL handles expiry.
func (s *Service) consumeNonce(ctx context.Context, wallet, nonce string) bool {
	key := fmt.Sprintf("auth:nonce:%s:%s", wallet, nonce)
	val, err := s.rdb.Get(ctx, key).Result()
	if err != nil {
		return false
	}
	if val != nonce {
		return false
	}
	s.rdb.Del(ctx, key)
	return true
}

// NonceRequest is the request body for POST /api/v1/auth/nonce.
type NonceRequest struct {
	Wallet string `json:"wallet" binding:"required,min=32,max=44"`
}

// NonceResponse is the response body for POST /api/v1/auth/nonce.
type NonceResponse struct {
	Nonce   string `json:"nonce"`
	Message string `json:"message"`
}

// VerifyRequest is the request body for POST /api/v1/auth/verify.
type VerifyRequest struct {
	Wallet    string `json:"wallet" binding:"required,min=32,max=44"`
	Signature string `json:"signature" binding:"required"`
	Nonce     string `json:"nonce" binding:"required"`
}

// VerifyResponse is the response body for POST /api/v1/auth/verify.
type VerifyResponse struct {
	Token string   `json:"token"`
	User  UserInfo `json:"user"`
}

// UserInfo is a subset of user data returned after auth.
type UserInfo struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
	Wallet    string    `json:"wallet"`
}

// generateNonce produces a cryptographically random nonce.
func generateNonce() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("failed to generate nonce: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// buildSignMessage constructs the message that the wallet must sign.
// It must be fully deterministic from (wallet, nonce) so the backend can
// reconstruct the exact bytes at verification time.
func buildSignMessage(wallet, nonce string) string {
	return fmt.Sprintf(`GAMEE Authentication

Wallet: %s
Nonce: %s

By signing this message, you confirm ownership of this wallet.`,
		wallet, nonce)
}

// verifySignature verifies an ed25519 signature over the raw message bytes.
// Phantom's signMessage signs the raw bytes directly (no pre-hashing).
func verifySignature(wallet, message, signature string) error {
	// Decode the base58-encoded signature (shared, golden-tested decoder —
	// an earlier private copy here mis-decoded real signatures, which made
	// every wallet login fail; see pkg/solana/address_test.go).
	sigBytes, err := pkgsolana.Base58Decode(signature)
	if err != nil {
		return fmt.Errorf("invalid signature encoding: %w", err)
	}
	if len(sigBytes) != 64 {
		return fmt.Errorf("invalid signature length: expected 64, got %d", len(sigBytes))
	}

	// Decode the wallet address (public key).
	pubkeyBytes, err := pkgsolana.Base58Decode(wallet)
	if err != nil {
		return fmt.Errorf("invalid wallet encoding: %w", err)
	}
	if len(pubkeyBytes) != 32 {
		return fmt.Errorf("invalid public key length: expected 32, got %d", len(pubkeyBytes))
	}

	if !ed25519.Verify(ed25519.PublicKey(pubkeyBytes), []byte(message), sigBytes) {
		return fmt.Errorf("signature verification failed")
	}

	return nil
}

// base58Decode decodes a base58-encoded string to bytes.
// This is a minimal base58 decoder for Solana addresses/signatures.
// RegisterRoutes registers auth routes on the gin router.
func (s *Service) RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/nonce", s.HandleNonce)
	rg.POST("/verify", s.HandleVerify)
}

// HandleNonce handles POST /api/v1/auth/nonce.
func (s *Service) HandleNonce(c *gin.Context) {
	var req NonceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "invalid request: " + err.Error(),
			"code":  "INVALID_REQUEST",
		})
		return
	}

	// Validate wallet address format. Base58-encoded 32-byte pubkeys are
	// 32-44 chars, not a fixed 44 (leading zero bytes shorten the string);
	// the real check is the base58 decode + ed25519 size check at verify.
	if len(req.Wallet) < 32 || len(req.Wallet) > 44 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "invalid wallet address length",
			"code":  "INVALID_WALLET",
		})
		return
	}

	// Beta gate: reject non-invited wallets before issuing a nonce.
	if !s.walletAllowed(req.Wallet) {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "this wallet is not on the beta access list",
			"code":  "NOT_INVITED",
		})
		return
	}

	nonce, err := generateNonce()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "failed to generate nonce",
			"code":  "INTERNAL_ERROR",
		})
		return
	}

	message := buildSignMessage(req.Wallet, nonce)

	// Store the nonce server-side (single-use, 5-minute TTL).
	s.storeNonce(c.Request.Context(), req.Wallet, nonce)

	c.JSON(http.StatusOK, NonceResponse{
		Nonce:   nonce,
		Message: message,
	})
}

// HandleVerify handles POST /api/v1/auth/verify.
func (s *Service) HandleVerify(c *gin.Context) {
	var req VerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "invalid request: " + err.Error(),
			"code":  "INVALID_REQUEST",
		})
		return
	}

	// Beta gate: both here and at nonce issuance — checking at verify too
	// keeps a nonce issued before the allowlist changed from slipping past.
	if !s.walletAllowed(req.Wallet) {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "this wallet is not on the beta access list",
			"code":  "NOT_INVITED",
		})
		return
	}

	// The nonce must have been issued by us, be unexpired, and is single-use.
	if !s.consumeNonce(c.Request.Context(), req.Wallet, req.Nonce) {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "unknown or expired nonce — request a new one",
			"code":  "NONCE_INVALID",
		})
		return
	}

	message := buildSignMessage(req.Wallet, req.Nonce)

	// Verify the ed25519 signature.
	if err := verifySignature(req.Wallet, message, req.Signature); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "signature verification failed: " + err.Error(),
			"code":  "SIGNATURE_INVALID",
		})
		return
	}

	ctx := c.Request.Context()

	// Upsert user and wallet in database.
	userID, createdAt, err := s.upsertUserAndWallet(ctx, req.Wallet)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "failed to upsert user: " + err.Error(),
			"code":  "INTERNAL_ERROR",
		})
		return
	}

	// Generate JWT.
	now := time.Now()
	claims := middleware.Claims{
		UserID: userID,
		Wallet: req.Wallet,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(s.jwtExpiry)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			Issuer:    "gamee-backend",
			Subject:   userID,
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, err := token.SignedString([]byte(s.jwtSecret))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "failed to sign token",
			"code":  "INTERNAL_ERROR",
		})
		return
	}

	c.JSON(http.StatusOK, VerifyResponse{
		Token: tokenStr,
		User: UserInfo{
			ID:        userID,
			CreatedAt: createdAt,
			Wallet:    req.Wallet,
		},
	})
}

// upsertUserAndWallet creates or retrieves a user and links their wallet.
func (s *Service) upsertUserAndWallet(ctx context.Context, wallet string) (string, time.Time, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Try to find existing wallet.
	var userID string
	var createdAt time.Time

	err = tx.QueryRow(ctx,
		`SELECT u.id::text, u.created_at FROM wallets w
		 JOIN users u ON u.id = w.user_id
		 WHERE w.address = $1`, wallet).Scan(&userID, &createdAt)

	if err == nil {
		// Wallet exists, update last_active.
		_, _ = tx.Exec(ctx, `UPDATE users SET last_active = NOW() WHERE id = $1::uuid`, userID)
		if err := tx.Commit(ctx); err != nil {
			return "", time.Time{}, fmt.Errorf("failed to commit: %w", err)
		}
		return userID, createdAt, nil
	}

	// Wallet doesn't exist — create user and wallet.
	err = tx.QueryRow(ctx,
		`INSERT INTO users (country, status) VALUES ('XX', 'active')
		 RETURNING id::text, created_at`).Scan(&userID, &createdAt)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to create user: %w", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO wallets (address, user_id) VALUES ($1, $2::uuid)`,
		wallet, userID)
	if err != nil {
		// Handle duplicate wallet (race condition between lookup and insert).
		_ = tx.QueryRow(ctx,
			`SELECT u.id::text, u.created_at FROM wallets w
			 JOIN users u ON u.id = w.user_id
			 WHERE w.address = $1`, wallet).Scan(&userID, &createdAt)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", time.Time{}, fmt.Errorf("failed to commit: %w", err)
	}

	return userID, createdAt, nil
}

// GetDB returns the database pool (for use by the JSON serialization).
func (s *Service) GetDB() *pgxpool.Pool {
	return s.db
}
