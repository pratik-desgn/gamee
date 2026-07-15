package gamesession

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// stubRandomnessHex is a fixed 64-hex-char (32-byte) helper output used
// across happy-path tests so the derived seed is reproducible and can be
// checked against a hand-computed value.
const stubRandomnessHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// fallbackProvider is a trivial RandomnessProvider double so tests can
// assert switchboardProvider actually delegated to its fallback, without
// depending on deterministicProvider's DB query.
type fallbackProvider struct {
	name string
	seed string
}

func (f *fallbackProvider) Name() string { return f.name }
func (f *fallbackProvider) Seed(ctx context.Context, ticketID string) string {
	return f.seed
}

// writeStubNode writes an executable shell script to dir that behaves like
// "node <script.ts> --ticket X --keypair Y --rpc Z" for the purposes of
// switchboardProvider — it ignores its arguments and just emits the given
// stdout/stderr, optionally sleeping first (to exercise the timeout path),
// then exits with the given code. This stands in for the real
// contracts/scripts/vrf-switchboard.ts helper, which switchboard_test.go
// intentionally does not depend on (no Node/network in unit tests).
func writeStubNode(t *testing.T, stdout, stderr string, sleep time.Duration, exitCode int) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "stub-node.sh")
	// The sleep, when present, uses `exec` so the shell process image is
	// replaced by `sleep` itself rather than forking a child — otherwise,
	// when exec.CommandContext SIGKILLs the shell on timeout, the
	// grandchild `sleep` process would be orphaned but keep holding the
	// stdout/stderr pipe's write end open, and Cmd.Wait() (which drains
	// those pipes to EOF before returning) would block for the rest of the
	// sleep regardless of the kill — defeating the point of this test case.
	script := fmt.Sprintf(`#!/bin/sh
if [ %d -gt 0 ]; then exec sleep %s; fi
printf '%%s' %q >&2
printf '%%s' %q
exit %d
`, sleep.Milliseconds(), fmt.Sprintf("%.3f", sleep.Seconds()), stderr, stdout, exitCode)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("failed to write stub node script: %v", err)
	}
	return path
}

func newTestProvider(t *testing.T, stdout, stderr string, sleep time.Duration, exitCode int, timeout time.Duration) *switchboardProvider {
	stub := writeStubNode(t, stdout, stderr, sleep, exitCode)
	return &switchboardProvider{
		cfg: SwitchboardConfig{
			NodePath:    stub,
			ScriptPath:  "unused-in-tests", // the stub ignores argv entirely
			KeypairPath: "unused-in-tests",
			RPCURL:      "unused-in-tests",
			Timeout:     timeout,
		},
		fallback: &fallbackProvider{name: "stub-fallback", seed: "vrf_fallback"},
	}
}

func expectedSeed(ticketID, randomnessHex string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:switchboard-vrf-v1", ticketID, randomnessHex)))
	return "vrf_" + hex.EncodeToString(sum[:16])
}

func TestSwitchboardProvider_HappyPath_SeedDerivedDeterministically(t *testing.T) {
	stdout := fmt.Sprintf(`{"ok":true,"randomness_hex":"%s","slot":12345,"commit_tx":"commitSig","reveal_tx":"revealSig"}`, stubRandomnessHex)
	p := newTestProvider(t, stdout, "", 0, 0, 5*time.Second)

	got := p.Seed(context.Background(), "ticket-abc")
	want := expectedSeed("ticket-abc", stubRandomnessHex)
	if got != want {
		t.Fatalf("Seed() = %q, want %q", got, want)
	}
	if got == "vrf_fallback" {
		t.Fatal("Seed() used the fallback on a successful helper run")
	}

	// Same ticket + same helper output must reproduce exactly (no hidden
	// non-determinism like time.Now()).
	got2 := p.Seed(context.Background(), "ticket-abc")
	if got2 != got {
		t.Fatalf("Seed() not deterministic: %q != %q", got2, got)
	}

	// A different ticket id must change the seed (ticket id is folded in).
	gotOther := p.Seed(context.Background(), "ticket-xyz")
	if gotOther == got {
		t.Fatal("Seed() did not vary with ticket id")
	}
}

func TestSwitchboardProvider_HelperReportsFailure_FallsBack(t *testing.T) {
	stdout := `{"ok":false,"error":"oracle gateway unreachable"}`
	p := newTestProvider(t, stdout, "", 0, 1, 5*time.Second)

	got := p.Seed(context.Background(), "ticket-1")
	if got != "vrf_fallback" {
		t.Fatalf("Seed() = %q, want fallback seed", got)
	}
}

func TestSwitchboardProvider_Timeout_FallsBack(t *testing.T) {
	// Stub sleeps far longer than the provider's timeout, so
	// exec.CommandContext should kill it and Seed() should fall back
	// without blocking the caller for the full sleep duration.
	p := newTestProvider(t, `{"ok":true,"randomness_hex":"`+stubRandomnessHex+`","slot":1,"commit_tx":"a","reveal_tx":"b"}`, "", 3*time.Second, 0, 200*time.Millisecond)

	start := time.Now()
	got := p.Seed(context.Background(), "ticket-1")
	elapsed := time.Since(start)

	if got != "vrf_fallback" {
		t.Fatalf("Seed() = %q, want fallback seed on timeout", got)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("Seed() took %s, want it to return promptly after the %s timeout", elapsed, 200*time.Millisecond)
	}
}

func TestSwitchboardProvider_MalformedJSON_FallsBack(t *testing.T) {
	p := newTestProvider(t, `not valid json at all`, "", 0, 0, 5*time.Second)

	got := p.Seed(context.Background(), "ticket-1")
	if got != "vrf_fallback" {
		t.Fatalf("Seed() = %q, want fallback seed on malformed output", got)
	}
}

func TestSwitchboardProvider_ShortRandomnessHex_FallsBack(t *testing.T) {
	// Sanity check: even if the helper claims ok:true, a randomness_hex
	// that isn't the expected 64 hex chars (32 bytes) must not be trusted.
	p := newTestProvider(t, `{"ok":true,"randomness_hex":"deadbeef","slot":1,"commit_tx":"a","reveal_tx":"b"}`, "", 0, 0, 5*time.Second)

	got := p.Seed(context.Background(), "ticket-1")
	if got != "vrf_fallback" {
		t.Fatalf("Seed() = %q, want fallback seed on short randomness_hex", got)
	}
}
