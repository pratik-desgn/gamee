package middleware

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// Claims represents the JWT claims structure.
type Claims struct {
	UserID string `json:"user_id"`
	Wallet string `json:"wallet"`
	jwt.RegisteredClaims
}

// AuthMiddleware returns a Gin middleware that validates JWT tokens.
func AuthMiddleware(jwtSecret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			// Also check query string for WebSocket connections.
			authHeader = c.Query("token")
			if authHeader != "" {
				authHeader = "Bearer " + authHeader
			}
		}

		if authHeader == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "missing authorization header",
				"code":  "MISSING_AUTH",
			})
			return
		}

		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
		if tokenStr == authHeader {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "invalid authorization format",
				"code":  "INVALID_AUTH_FORMAT",
			})
			return
		}

		claims := &Claims{}
		token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return []byte(jwtSecret), nil
		})
		if err != nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "invalid or expired token",
				"code":  "INVALID_TOKEN",
			})
			return
		}

		// Store user info in context for downstream handlers.
		c.Set("user_id", claims.UserID)
		c.Set("wallet", claims.Wallet)
		c.Next()
	}
}

// AdminAuthMiddleware gates staff-only endpoints (payout review, etc.)
// behind a static shared key, checked via the X-Admin-Key header. This is a
// stopgap consistent with the project's other single-key trust boundaries
// (the settlement verifier key is likewise one hot key) — replace with real
// staff accounts + roles before public launch. An empty adminKey fails
// closed: every request is rejected rather than the check being skipped.
func AdminAuthMiddleware(adminKey string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if adminKey == "" {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
				"error": "admin endpoints are not configured on this deployment",
				"code":  "ADMIN_NOT_CONFIGURED",
			})
			return
		}

		provided := c.GetHeader("X-Admin-Key")
		if provided == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(adminKey)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "invalid or missing admin key",
				"code":  "INVALID_ADMIN_KEY",
			})
			return
		}

		c.Next()
	}
}
