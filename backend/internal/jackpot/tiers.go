package jackpot

// Tier constants for the jackpot qualification ladder. A player unlocks a
// tier by accumulating enough small-tier wins (see EntryThreshold below).
// Mirrors scripts/economy-sim/simulate.ts's tiers config — keep the ordering
// and thresholds in sync if that sim's parameters change.
const (
	TierSmall  = "small"
	TierMedium = "medium"
	TierMega   = "mega"
	TierLegend = "legend"
)

// Tiers lists every tier in ascending qualification order (lowest entry
// threshold first). Small is always index 0.
var Tiers = []string{TierSmall, TierMedium, TierMega, TierLegend}

// entryThresholds holds the number of prior small-tier wins required to
// unlock each tier, mirroring simulate.ts's `entryThreshold` field.
var entryThresholds = map[string]int{
	TierSmall:  0,
	TierMedium: 1,
	TierMega:   3,
	TierLegend: 10,
}

// EntryThreshold returns the number of prior small-tier wins required to
// qualify for tier. Unknown tiers return 0 (i.e. no gate), matching the
// permissive default already used elsewhere for an empty/unset tier.
func EntryThreshold(tier string) int {
	if t, ok := entryThresholds[tier]; ok {
		return t
	}
	return 0
}

// IsValidTier reports whether tier is one of the four known jackpot tiers.
// Used by ticket confirmation to reject an unrecognized tier claim before
// ever deriving a vault PDA for it.
func IsValidTier(tier string) bool {
	_, ok := entryThresholds[tier]
	return ok
}

// MaxQualifiedTier returns the highest tier a player with smallWins prior
// small-tier wins qualifies for — the highest tier in Tiers whose
// EntryThreshold is <= smallWins. Tiers is ordered ascending by threshold,
// so this is a simple forward scan keeping the last tier that still
// qualifies.
func MaxQualifiedTier(smallWins int) string {
	qualified := TierSmall
	for _, t := range Tiers {
		if smallWins >= EntryThreshold(t) {
			qualified = t
		}
	}
	return qualified
}
