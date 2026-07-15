package verification

import (
	"encoding/json"
	"testing"
)

func TestDetermineVerdict_Match(t *testing.T) {
	w := &Worker{}
	got := w.determineVerdict(100, 100)
	if got != "match" {
		t.Errorf("equal scores should be match, got %s", got)
	}
}

func TestDetermineVerdict_Suspicious(t *testing.T) {
	w := &Worker{}
	got := w.determineVerdict(100, 97)
	if got != "suspicious" {
		t.Errorf("scores within 5 should be suspicious, got %s", got)
	}
}

func TestDetermineVerdict_Mismatch(t *testing.T) {
	w := &Worker{}
	got := w.determineVerdict(100, 90)
	if got != "mismatch" {
		t.Errorf("scores differing by >5 should be mismatch, got %s", got)
	}
}

func TestDetermineVerdict_ClientExceedsVerified(t *testing.T) {
	w := &Worker{}
	got := w.determineVerdict(50, 100)
	if got != "mismatch" {
		t.Errorf("client score < verified score by >5 should be mismatch, got %s", got)
	}
}

func TestDetermineVerdict_NegativeDelta(t *testing.T) {
	w := &Worker{}
	got := w.determineVerdict(80, 82)
	if got != "suspicious" {
		t.Errorf("scores within 5 (including client > verified) should be suspicious, got %s", got)
	}
}

func TestVerifierInput_JSONRoundTrip(t *testing.T) {
	input := VerifierInput{
		SessionID:   "test-session",
		GameID:      "wing-rush",
		Seed:        "test-seed-123",
		Difficulty:  json.RawMessage(`{"level":3,"speed":3.5}`),
		InputLog:    json.RawMessage(`[{"frame":1,"type":"tap"}]`),
		ClientScore: 100,
		TargetScore: 80,
	}
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var output VerifierInput
	if err := json.Unmarshal(data, &output); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if output.SessionID != input.SessionID {
		t.Errorf("SessionID mismatch: %s != %s", output.SessionID, input.SessionID)
	}
	if output.ClientScore != input.ClientScore {
		t.Errorf("ClientScore mismatch: %d != %d", output.ClientScore, input.ClientScore)
	}
	if output.TargetScore != input.TargetScore {
		t.Errorf("TargetScore mismatch: %d != %d", output.TargetScore, input.TargetScore)
	}
}

func TestGetNodePath_Default(t *testing.T) {
	// GetNodePath should return "node" when no known binary exists
	path := GetNodePath()
	if path == "" {
		t.Error("GetNodePath() returned empty string")
	}
}
