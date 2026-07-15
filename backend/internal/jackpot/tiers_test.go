package jackpot

import "testing"

func TestEntryThreshold(t *testing.T) {
	cases := []struct {
		tier string
		want int
	}{
		{TierSmall, 0},
		{TierMedium, 1},
		{TierMega, 3},
		{TierLegend, 10},
		{"unknown", 0},
	}
	for _, c := range cases {
		if got := EntryThreshold(c.tier); got != c.want {
			t.Errorf("EntryThreshold(%q) = %d, want %d", c.tier, got, c.want)
		}
	}
}

func TestIsValidTier(t *testing.T) {
	cases := []struct {
		tier string
		want bool
	}{
		{TierSmall, true},
		{TierMedium, true},
		{TierMega, true},
		{TierLegend, true},
		{"unknown", false},
		{"", false},
	}
	for _, c := range cases {
		if got := IsValidTier(c.tier); got != c.want {
			t.Errorf("IsValidTier(%q) = %v, want %v", c.tier, got, c.want)
		}
	}
}

func TestMaxQualifiedTier(t *testing.T) {
	cases := []struct {
		smallWins int
		want      string
	}{
		{0, TierSmall},
		{1, TierMedium},
		{2, TierMedium},
		{3, TierMega},
		{10, TierLegend},
		{100, TierLegend},
	}
	for _, c := range cases {
		if got := MaxQualifiedTier(c.smallWins); got != c.want {
			t.Errorf("MaxQualifiedTier(%d) = %q, want %q", c.smallWins, got, c.want)
		}
	}
}
