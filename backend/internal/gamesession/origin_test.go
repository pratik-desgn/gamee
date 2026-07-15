package gamesession

import (
	"net/http"
	"testing"
)

func wsOriginAllowed(t *testing.T, origin string) bool {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, "/ws", nil)
	if err != nil {
		t.Fatalf("building request: %v", err)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return upgrader.CheckOrigin(req)
}

func TestCheckOrigin(t *testing.T) {
	t.Cleanup(func() { SetAllowedOrigins(nil) })

	// No allowlist configured (dev mode): everything passes.
	SetAllowedOrigins(nil)
	if !wsOriginAllowed(t, "https://evil.example") {
		t.Error("dev mode (no allowlist) should accept any origin")
	}

	SetAllowedOrigins([]string{"https://gamee.example", " https://www.gamee.example/ "})

	cases := []struct {
		origin string
		want   bool
	}{
		{"https://gamee.example", true},
		{"https://gamee.example/", true},       // trailing slash normalized
		{"https://www.gamee.example", true},    // allowlist entry had whitespace + slash
		{"https://evil.example", false},
		{"http://gamee.example", false},        // scheme matters
		{"https://gamee.example.evil.io", false}, // exact match, not prefix
		{"", true},                             // non-browser client: no Origin header
	}
	for _, tc := range cases {
		if got := wsOriginAllowed(t, tc.origin); got != tc.want {
			t.Errorf("origin %q: got %v, want %v", tc.origin, got, tc.want)
		}
	}
}
