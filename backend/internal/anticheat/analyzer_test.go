package anticheat

import (
	"testing"
	"time"
)

func TestAnalyzeInputTiming_EmptyInputs(t *testing.T) {
	analysis := AnalyzeInputTiming(nil)
	if analysis.RecommendAction != "pass" {
		t.Errorf("expected pass for nil inputs, got %s", analysis.RecommendAction)
	}

	analysis = AnalyzeInputTiming([]InputEvent{})
	if analysis.RecommendAction != "pass" {
		t.Errorf("expected pass for empty inputs, got %s", analysis.RecommendAction)
	}
}

func TestAnalyzeInputTiming_FewInputs(t *testing.T) {
	// Less than 3 inputs should pass
	inputs := []InputEvent{
		{Frame: 0, Type: "tap", Time: 0},
		{Frame: 60, Type: "tap", Time: 1000},
	}
	analysis := AnalyzeInputTiming(inputs)
	if analysis.RecommendAction != "pass" {
		t.Errorf("expected pass for <3 inputs, got %s", analysis.RecommendAction)
	}
}

func TestAnalyzeInputTiming_NormalHumanInputs(t *testing.T) {
	// Simulate human-like reaction with jitter: 200-500ms between inputs,
	// varying intervals so metronomic timing doesn't trigger
	inputs := make([]InputEvent, 15)
	frames := []int{14, 28, 44, 58, 76, 90, 108, 124, 140, 158, 174, 192, 208, 226, 242}
	for i := 0; i < 15; i++ {
		inputs[i] = InputEvent{
			Frame: frames[i],
			Type:  "tap",
			Time:  time.Duration(frames[i]*16) * time.Millisecond,
		}
	}
	analysis := AnalyzeInputTiming(inputs)
	// Human with 200-400ms variable reactions should not be banned
	if analysis.RecommendAction == "ban" {
		t.Errorf("human-like inputs should not be banned, got bot=%0.2f action=%s",
			analysis.BotLikelyhood, analysis.RecommendAction)
	}
}

func TestAnalyzeInputTiming_Sub100msReactions(t *testing.T) {
	// Bot-like: all reactions under 100ms
	inputs := make([]InputEvent, 20)
	for i := 0; i < 20; i++ {
		inputs[i] = InputEvent{
			Frame: i*3 + 1, // ~50ms apart at 60fps
			Type:  "tap",
			Time:  time.Duration(i*50) * time.Millisecond,
		}
	}
	analysis := AnalyzeInputTiming(inputs)
	if analysis.BotLikelyhood < 0.3 {
		t.Errorf("sub-100ms reactions should have elevated bot score, got %0.2f", analysis.BotLikelyhood)
	}
}

func TestAnalyzeInputTiming_MetronomicTiming(t *testing.T) {
	// Perfect metronomic timing — every input exactly 16ms apart (frame-perfect)
	inputs := make([]InputEvent, 15)
	for i := 0; i < 15; i++ {
		inputs[i] = InputEvent{
			Frame: i + 1, // exactly 1 frame apart every time
			Type:  "tap",
			Time:  time.Duration(i*16) * time.Millisecond,
		}
	}
	analysis := AnalyzeInputTiming(inputs)
	// Should flag metronomic timing
	if analysis.BotLikelyhood < 0.3 {
		t.Errorf("metronomic timing should have elevated bot score, got %0.2f", analysis.BotLikelyhood)
	}
}

func TestAnalyzeInputTiming_HighInputRate(t *testing.T) {
	// More than 15 inputs/second
	inputs := make([]InputEvent, 30)
	for i := 0; i < 30; i++ {
		inputs[i] = InputEvent{
			Frame: i / 2, // 2 inputs per frame = 120 inputs/sec
			Type:  "tap",
			Time:  time.Duration(i*8) * time.Millisecond,
		}
	}
	analysis := AnalyzeInputTiming(inputs)
	if analysis.BotLikelyhood < 0.2 {
		t.Errorf("120 inputs/sec should trigger bot detection, got %0.2f", analysis.BotLikelyhood)
	}
}

func TestAnalyzeInputTiming_FlagCount(t *testing.T) {
	// Aggressive cheating: sub-100ms, metronomic, frame-perfect, high rate
	inputs := make([]InputEvent, 20)
	for i := 0; i < 20; i++ {
		inputs[i] = InputEvent{
			Frame: i + 1, // exactly 1 frame apart
			Type:  "tap",
			Time:  time.Duration(i*16) * time.Millisecond,
		}
	}
	analysis := AnalyzeInputTiming(inputs)
	if len(analysis.Flags) < 2 {
		t.Errorf("aggressive cheating should trigger multiple flags, got %d", len(analysis.Flags))
	}
	if analysis.RecommendAction == "pass" {
		t.Errorf("aggressive cheating should not pass, got action=%s", analysis.RecommendAction)
	}
}

func TestShouldReject(t *testing.T) {
	tests := []struct {
		name     string
		action   string
		expected bool
	}{
		{"ban should reject", "ban", true},
		{"review should reject", "review", true},
		{"flag should not reject", "flag", false},
		{"pass should not reject", "pass", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := &SessionAnalysis{RecommendAction: tt.action}
			if got := a.ShouldReject(); got != tt.expected {
				t.Errorf("ShouldReject() = %v, want %v", got, tt.expected)
			}
		})
	}
}

func TestAnalyzeInputTiming_CompositeFlagFallback(t *testing.T) {
	// The exact-frame-boundary botScore signal (+0.2, no length gate) fires
	// on any input here — intervals are always integer-frame multiples of
	// 16.667ms by construction, since that's what a deterministic 60fps replay
	// actually produces. The explicit "frame_perfect_inputs" Flags rule only
	// records that when len(frameIntervals) >= 5; with just 4 intervals (5
	// inputs) below, botScore still gets the +0.2 but Flags would be empty
	// without the composite fallback. Large varied gaps keep stddev/sub-100ms
	// from contributing so this exercises the frame-boundary signal in isolation.
	frameGaps := []int{20, 25, 15, 30}
	frame := 0
	inputs := make([]InputEvent, 0, len(frameGaps)+1)
	inputs = append(inputs, InputEvent{Frame: frame, Type: "tap"})
	for _, g := range frameGaps {
		frame += g
		inputs = append(inputs, InputEvent{Frame: frame, Type: "tap"})
	}
	analysis := AnalyzeInputTiming(inputs)
	if analysis.RecommendAction == "pass" {
		t.Fatalf("expected this timing pattern to cross the flag threshold, got pass (bot=%0.2f)", analysis.BotLikelyhood)
	}
	if len(analysis.Flags) == 0 {
		t.Errorf("RecommendAction=%s but Flags is empty — composite_bot_score fallback should have fired", analysis.RecommendAction)
	}
	if analysis.Flags[0].Rule != "composite_bot_score" {
		t.Errorf("expected composite_bot_score fallback rule, got %q", analysis.Flags[0].Rule)
	}
}

func TestDetermineTier(t *testing.T) {
	tests := []struct {
		name          string
		recentActions []string
		latestAction  string
		want          WalletRiskTier
	}{
		{"clean history, pass", nil, "pass", TierClear},
		{"single ban is immediate ban", nil, "ban", TierBanned},
		{"single flag is clear", nil, "flag", TierClear},
		{"single review is hardened", nil, "review", TierHardened},
		{"two flags plus new flag is hardened", []string{"flag", "flag"}, "flag", TierHardened},
		{"one flag plus new flag stays clear", []string{"flag"}, "flag", TierClear},
		{"prior review plus new review is banned", []string{"review"}, "review", TierBanned},
		{"prior ban plus new review is banned", []string{"ban"}, "review", TierBanned},
		{"prior review plus new flag is hardened", []string{"review"}, "flag", TierHardened},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DetermineTier(tt.recentActions, tt.latestAction); got != tt.want {
				t.Errorf("DetermineTier(%v, %q) = %s, want %s", tt.recentActions, tt.latestAction, got, tt.want)
			}
		})
	}
}

func TestToCheatFlagModels(t *testing.T) {
	analysis := &SessionAnalysis{
		SessionID: "test-session",
		Wallet:    "test-wallet",
		Flags: []CheatFlag{
			{Rule: "sub_100ms_reaction", Severity: "high", Value: 0.8, Reason: "fast"},
			{Rule: "metronomic_timing", Severity: "medium", Value: 5.0, Reason: "too consistent"},
		},
		RecommendAction: "ban",
	}
	models := analysis.ToCheatFlagModels("test-session", "test-wallet")
	if len(models) != 2 {
		t.Errorf("expected 2 flag models, got %d", len(models))
	}
	for _, m := range models {
		f, ok := m.(map[string]interface{})
		if !ok {
			t.Errorf("expected map[string]interface{}, got %T", m)
			continue
		}
		if f["wallet_address"] != "test-wallet" {
			t.Errorf("expected wallet test-wallet, got %v", f["wallet_address"])
		}
		if f["action_taken"] != "ban" {
			t.Errorf("expected action ban, got %v", f["action_taken"])
		}
	}
}
