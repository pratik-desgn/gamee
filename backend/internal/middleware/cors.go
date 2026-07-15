package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// CORS returns a middleware that sets Access-Control-* headers and answers
// preflight OPTIONS requests. Without this, every non-"simple" browser
// request (any POST with a JSON body, which is the entire auth/ticket/spin
// flow) is preflighted and silently blocked client-side the moment the
// frontend runs on a different origin than the API — no request even
// reaches the handlers, so it fails before any backend log line is written.
//
// allowedOrigins mirrors gamesession.SetAllowedOrigins: empty means
// dev-permissive (reflect whatever Origin the browser sent, so local dev
// across any port/host works without configuration); non-empty means
// exact-match against the configured list.
func CORS(allowedOrigins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		allowed[strings.TrimRight(strings.TrimSpace(o), "/")] = true
	}
	openMode := len(allowed) == 0

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && (openMode || allowed[strings.TrimRight(origin, "/")]) {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key")
			c.Header("Access-Control-Max-Age", "600")
		}

		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
