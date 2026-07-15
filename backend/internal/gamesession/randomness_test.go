package gamesession

import (
	"encoding/binary"
	"testing"

	"gamee-backend/pkg/solana"
)

// buildSlotHashes serializes a SlotHashes sysvar buffer (newest first) the same
// way the runtime does: 8-byte LE count, then each entry 8-byte LE slot + 32
// byte hash.
func buildSlotHashes(entries [][40]byte) []byte {
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(buf[0:8], uint64(len(entries)))
	for _, e := range entries {
		buf = append(buf, e[:]...)
	}
	return buf
}

func TestParseRecentSlotHash_ReadsNewestEntry(t *testing.T) {
	var newest [40]byte
	binary.LittleEndian.PutUint64(newest[0:8], 123456789) // slot
	for i := 8; i < 40; i++ {
		newest[i] = byte(i) // deterministic hash bytes
	}
	var older [40]byte
	binary.LittleEndian.PutUint64(older[0:8], 123456700)

	data := buildSlotHashes([][40]byte{newest, older})

	slot, hash, err := parseRecentSlotHash(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if slot != 123456789 {
		t.Fatalf("slot = %d, want 123456789 (newest entry, not %d)", slot, 123456700)
	}
	if len(hash) != 32 {
		t.Fatalf("hash len = %d, want 32", len(hash))
	}
	if hash[0] != 8 || hash[31] != 39 {
		t.Fatalf("hash bytes mismatch: got [0]=%d [31]=%d", hash[0], hash[31])
	}
}

func TestParseRecentSlotHash_RejectsShortAndEmpty(t *testing.T) {
	if _, _, err := parseRecentSlotHash([]byte{1, 2, 3}); err == nil {
		t.Fatal("expected error for too-short buffer")
	}
	empty := buildSlotHashes(nil) // count = 0, no entries
	if _, _, err := parseRecentSlotHash(empty); err == nil {
		t.Fatal("expected error for empty (count=0) sysvar")
	}
}

// A nil solana client must force the deterministic provider so the seam is
// safe to construct even without chain access (tests, offline).
func TestNewRandomnessProvider_NilClientFallsBackDeterministic(t *testing.T) {
	p := NewRandomnessProvider("slothash", nil, nil, SwitchboardConfig{})
	if p.Name() != "deterministic" {
		t.Fatalf("provider = %q, want deterministic when client is nil", p.Name())
	}
}

func TestNewRandomnessProvider_DeterministicMode(t *testing.T) {
	p := NewRandomnessProvider("deterministic", nil, nil, SwitchboardConfig{})
	if p.Name() != "deterministic" {
		t.Fatalf("provider = %q, want deterministic", p.Name())
	}
}

// With a non-nil client and default mode, the slothash provider is selected.
func TestNewRandomnessProvider_SlotHashModeSelected(t *testing.T) {
	client := solana.NewClient("http://127.0.0.1:1", "confirmed") // no network call here
	p := NewRandomnessProvider("slothash", client, nil, SwitchboardConfig{})
	if p.Name() != "slothash" {
		t.Fatalf("provider = %q, want slothash", p.Name())
	}
}

// switchboard mode selects switchboardProvider and wires its fallback to
// slothash (itself falling back to deterministic) — never to deterministic
// directly, so a Switchboard outage still gets on-chain entropy first.
func TestNewRandomnessProvider_SwitchboardModeSelected(t *testing.T) {
	client := solana.NewClient("http://127.0.0.1:1", "confirmed")
	p := NewRandomnessProvider("switchboard", client, nil, SwitchboardConfig{})
	if p.Name() != "switchboard" {
		t.Fatalf("provider = %q, want switchboard", p.Name())
	}
	sp, ok := p.(*switchboardProvider)
	if !ok {
		t.Fatalf("provider type = %T, want *switchboardProvider", p)
	}
	if sp.fallback.Name() != "slothash" {
		t.Fatalf("fallback = %q, want slothash", sp.fallback.Name())
	}
}

// A nil solana client forces deterministic regardless of mode — same rule
// as slothash mode — since switchboard mode's only real dependency on the
// rest of the backend's chain access is its fallback chain.
func TestNewRandomnessProvider_SwitchboardModeNilClientFallsBackDeterministic(t *testing.T) {
	p := NewRandomnessProvider("switchboard", nil, nil, SwitchboardConfig{})
	if p.Name() != "deterministic" {
		t.Fatalf("provider = %q, want deterministic when client is nil", p.Name())
	}
}
