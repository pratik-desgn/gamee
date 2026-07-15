package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func newTestRouter(allowed []string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(CORS(allowed))
	r.POST("/x", func(c *gin.Context) { c.Status(http.StatusOK) })
	return r
}

func TestCORS_PreflightOpenMode(t *testing.T) {
	r := newTestRouter(nil)
	req := httptest.NewRequest(http.MethodOptions, "/x", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Method", "POST")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("Allow-Origin = %q, want reflected origin (open mode)", got)
	}
}

func TestCORS_ActualRequestGetsHeaders(t *testing.T) {
	r := newTestRouter(nil)
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("Allow-Origin = %q", got)
	}
}

func TestCORS_AllowlistRejectsUnknownOrigin(t *testing.T) {
	r := newTestRouter([]string{"https://gamee.example"})
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Allow-Origin = %q, want empty for a non-allowlisted origin", got)
	}
}

func TestCORS_AllowlistAcceptsKnownOrigin(t *testing.T) {
	r := newTestRouter([]string{"https://gamee.example"})
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set("Origin", "https://gamee.example")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://gamee.example" {
		t.Fatalf("Allow-Origin = %q", got)
	}
}

func TestCORS_NoOriginHeaderNoCORSHeaders(t *testing.T) {
	r := newTestRouter(nil)
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Allow-Origin = %q, want empty for same-origin/non-browser request", got)
	}
}
