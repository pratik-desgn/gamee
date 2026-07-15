package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

// RateLimitStore holds per-IP rate limiters.
type RateLimitStore struct {
	mu       sync.RWMutex
	clients  map[string]*rate.Limiter
	burst    int
	rps      int
	cleanupT *time.Ticker
	stopCh   chan struct{}
}

// NewRateLimitStore creates a new rate limiter store.
func NewRateLimitStore(rps, burst int) *RateLimitStore {
	rls := &RateLimitStore{
		clients:  make(map[string]*rate.Limiter),
		burst:    burst,
		rps:      rps,
		cleanupT: time.NewTicker(10 * time.Minute),
		stopCh:   make(chan struct{}),
	}
	go rls.cleanup()
	return rls
}

// Stop stops the background cleanup goroutine.
func (rls *RateLimitStore) Stop() {
	close(rls.stopCh)
	rls.cleanupT.Stop()
}

func (rls *RateLimitStore) cleanup() {
	for {
		select {
		case <-rls.cleanupT.C:
			rls.mu.Lock()
			for ip, lim := range rls.clients {
				if lim.AllowN(time.Now(), rls.burst) {
					delete(rls.clients, ip)
				}
			}
			rls.mu.Unlock()
		case <-rls.stopCh:
			return
		}
	}
}

func (rls *RateLimitStore) getLimiter(ip string) *rate.Limiter {
	rls.mu.RLock()
	lim, ok := rls.clients[ip]
	rls.mu.RUnlock()
	if ok {
		return lim
	}

	rls.mu.Lock()
	defer rls.mu.Unlock()

	// Double-check after acquiring write lock.
	if lim, ok = rls.clients[ip]; ok {
		return lim
	}

	lim = rate.NewLimiter(rate.Limit(rls.rps), rls.burst)
	rls.clients[ip] = lim
	return lim
}

// RateLimit returns a Gin middleware that rate-limits requests per client IP.
func RateLimit(store *RateLimitStore) gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		limiter := store.getLimiter(ip)

		if !limiter.Allow() {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "rate limit exceeded",
				"code":  "RATE_LIMITED",
			})
			return
		}

		c.Next()
	}
}
