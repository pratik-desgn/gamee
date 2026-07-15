package anticheat

import (
	"math"
	"time"
)

// InputEvent represents a single recorded input for analysis.
type InputEvent struct {
	Frame int           `json:"frame"`
	Type  string        `json:"type"`
	Time  time.Duration `json:"time"` // ms from session start
}

// SessionAnalysis contains the results of anti-cheat checks.
type SessionAnalysis struct {
	SessionID        string
	Wallet           string
	TotalInputs      int
	AvgReactionMs    float64
	StdDevReactionMs float64
	MinReactionMs    float64
	Sub100msCount    int
	BotLikelyhood    float64
	Flags            []CheatFlag
	RecommendAction  string
}

// CheatFlag records a specific rule that triggered.
type CheatFlag struct {
	Rule     string  `json:"rule"`
	Severity string  `json:"severity"`
	Value    float64 `json:"value"`
	Reason   string  `json:"reason"`
}

const (
	minHumanReactionMs      = 100.0
	minHumanStdDevMs        = 30.0
	maxHumanInputsPerSecond = 15.0
)

// AnalyzeInputTiming checks the input log for bot-like patterns.
func AnalyzeInputTiming(inputs []InputEvent) *SessionAnalysis {
	analysis := &SessionAnalysis{
		TotalInputs: len(inputs),
		Flags:       []CheatFlag{},
	}
	if len(inputs) < 3 {
		analysis.RecommendAction = "pass"
		return analysis
	}
	intervals := make([]float64, 0, len(inputs)-1)
	for i := 1; i < len(inputs); i++ {
		frameDiff := inputs[i].Frame - inputs[i-1].Frame
		if frameDiff > 0 {
			intervals = append(intervals, float64(frameDiff)*16.667)
		}
	}
	if len(intervals) == 0 {
		analysis.RecommendAction = "pass"
		return analysis
	}
	analysis.MinReactionMs = minFloat64(intervals)
	analysis.AvgReactionMs = avgFloat64(intervals)
	analysis.StdDevReactionMs = stdDevFloat64(intervals, analysis.AvgReactionMs)

	sub100ms := 0
	for _, iv := range intervals {
		if iv < minHumanReactionMs {
			sub100ms++
		}
	}
	analysis.Sub100msCount = sub100ms

	sub100Pct := float64(sub100ms) / float64(len(intervals))
	if sub100Pct > 0.5 && sub100ms >= 5 {
		analysis.Flags = append(analysis.Flags, CheatFlag{
			Rule: "sub_100ms_reaction", Severity: "high",
			Value: sub100Pct, Reason: "Over 50% of reactions are sub-100ms",
		})
	}
	if analysis.StdDevReactionMs < minHumanStdDevMs && len(intervals) >= 10 {
		analysis.Flags = append(analysis.Flags, CheatFlag{
			Rule: "metronomic_timing", Severity: "medium",
			Value: analysis.StdDevReactionMs, Reason: "Input timing too consistent (bot-like)",
		})
	}
	if len(inputs) > 0 {
		totalFrames := inputs[len(inputs)-1].Frame - inputs[0].Frame
		if totalFrames > 0 {
			ips := float64(len(inputs)) / (float64(totalFrames) * 16.667 / 1000.0)
			if ips > maxHumanInputsPerSecond {
				analysis.Flags = append(analysis.Flags, CheatFlag{
					Rule: "input_rate_exceeded", Severity: "high",
					Value: ips, Reason: "Input rate exceeds human capability",
				})
			}
		}
	}
	frameIntervals := make([]float64, 0, len(intervals))
	for _, iv := range intervals {
		frameIntervals = append(frameIntervals, math.Mod(iv, 16.667))
	}
	exactFrameCount := 0
	for _, fi := range frameIntervals {
		if fi < 0.1 || (16.667-fi) < 0.1 {
			exactFrameCount++
		}
	}
	exactFramePct := float64(exactFrameCount) / float64(len(frameIntervals))
	if exactFramePct > 0.8 && len(frameIntervals) >= 5 {
		analysis.Flags = append(analysis.Flags, CheatFlag{
			Rule: "frame_perfect_inputs", Severity: "medium",
			Value: exactFramePct, Reason: "Inputs land on frame boundaries (scripted)",
		})
	}

	botScore := 0.0
	if analysis.StdDevReactionMs < 20 {
		botScore += 0.4
	} else if analysis.StdDevReactionMs < minHumanStdDevMs {
		botScore += 0.2
	}
	if sub100Pct > 0.5 {
		botScore += 0.4
	} else if sub100Pct > 0.2 {
		botScore += 0.2
	}
	if exactFramePct > 0.8 {
		botScore += 0.2
	}
	analysis.BotLikelyhood = math.Min(botScore, 1.0)

	switch {
	case analysis.BotLikelyhood >= 0.8:
		analysis.RecommendAction = "ban"
	case analysis.BotLikelyhood >= 0.5:
		analysis.RecommendAction = "review"
	case analysis.BotLikelyhood >= 0.2:
		analysis.RecommendAction = "flag"
	default:
		analysis.RecommendAction = "pass"
	}

	// The specific rule checks above only fire past fairly high individual
	// thresholds, but botScore can cross the "flag"/"review" line on partial
	// credit from several rules without any single one tripping (e.g. stddev
	// just under 30ms alone gives +0.2). Without this, those sessions would
	// get a non-"pass" RecommendAction but zero rows in Flags, so
	// ToCheatFlagModels would silently record nothing to act on.
	if analysis.RecommendAction != "pass" && len(analysis.Flags) == 0 {
		analysis.Flags = append(analysis.Flags, CheatFlag{
			Rule: "composite_bot_score", Severity: severityForAction(analysis.RecommendAction),
			Value: analysis.BotLikelyhood, Reason: "Multiple weak bot-likelihood signals combined",
		})
	}
	return analysis
}

func severityForAction(action string) string {
	switch action {
	case "ban":
		return "critical"
	case "review":
		return "high"
	default:
		return "low"
	}
}

// WalletRiskTier is the escalation state a wallet lands in under the
// shadow-flag -> harder-difficulty -> ban action ladder.
type WalletRiskTier string

const (
	TierClear    WalletRiskTier = "clear"    // no action
	TierHardened WalletRiskTier = "hardened" // shadow-flagged enough to raise difficulty
	TierBanned   WalletRiskTier = "banned"
)

// DetermineTier applies the action ladder to a wallet's recent cheat_flags
// history (action_taken values, one per past session) plus the RecommendAction
// just computed for the session being processed right now — which hasn't been
// written to history yet, so it's passed separately rather than expected to
// already be in recentActions.
//
// A single "ban"-grade session bans immediately. Two or more "review"/"ban"
// grade sessions (counting the current one) also escalate to a ban, since a
// repeat high-confidence flag is stronger evidence than one-off suspicion.
// Anything short of that but still noteworthy (one review, or three flags)
// gets hardened rather than banned — enough signal to make botting less
// profitable without banning a possibly-legitimate player on weak evidence.
func DetermineTier(recentActions []string, latestAction string) WalletRiskTier {
	if latestAction == "ban" {
		return TierBanned
	}

	reviewOrBan := 0
	flagCount := 0
	for _, a := range recentActions {
		switch a {
		case "ban", "review":
			reviewOrBan++
		case "flag":
			flagCount++
		}
	}
	switch latestAction {
	case "review":
		reviewOrBan++
	case "flag":
		flagCount++
	}

	switch {
	case reviewOrBan >= 2:
		return TierBanned
	case reviewOrBan >= 1 || flagCount >= 3:
		return TierHardened
	default:
		return TierClear
	}
}

// ShouldReject returns true if the session should be rejected.
func (a *SessionAnalysis) ShouldReject() bool {
	return a.RecommendAction == "ban" || a.RecommendAction == "review"
}

// ToCheatFlagModels converts analysis flags to DB cheat_flag rows.
func (a *SessionAnalysis) ToCheatFlagModels(sessionID, wallet string) []interface{} {
	models := make([]interface{}, 0, len(a.Flags))
	for _, f := range a.Flags {
		models = append(models, map[string]interface{}{
			"session_id":     sessionID,
			"wallet_address": wallet,
			"rule_triggered": f.Rule,
			"severity":       f.Severity,
			"action_taken":   a.RecommendAction,
		})
	}
	return models
}

// ─── Stats helpers ─────────────────────────

func avgFloat64(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range vals {
		sum += v
	}
	return sum / float64(len(vals))
}

func stdDevFloat64(vals []float64, mean float64) float64 {
	if len(vals) < 2 {
		return 0
	}
	sumSq := 0.0
	for _, v := range vals {
		d := v - mean
		sumSq += d * d
	}
	return math.Sqrt(sumSq / float64(len(vals)-1))
}

func minFloat64(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	m := vals[0]
	for _, v := range vals[1:] {
		if v < m {
			m = v
		}
	}
	return m
}
