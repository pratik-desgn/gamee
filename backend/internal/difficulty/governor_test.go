package difficulty

import "testing"

func TestDecide(t *testing.T) {
	cases := []struct {
		name                     string
		current, min, max        int
		wins, total              int
		want                     int
	}{
		// Below the sample floor nothing moves, whatever the rate looks like.
		{"insufficient sample, zero wins", 6, 1, 10, 0, 499, 6},
		{"insufficient sample, all wins", 6, 1, 10, 499, 499, 6},

		// Inside the band (1/2600 .. 1/1300): hold.
		{"in band holds", 6, 1, 10, 1, 1900, 6},
		{"exactly high edge holds", 6, 1, 10, 1, 1300, 6},
		{"exactly low edge holds", 6, 1, 10, 1, 2600, 6},

		// Too many wins → one step harder.
		{"too many wins steps up", 6, 1, 10, 5, 1000, 7},
		{"way too many wins still one step", 6, 1, 10, 500, 1000, 7},

		// Too few wins → one step easier.
		{"zero wins steps down", 6, 1, 10, 0, 5000, 5},
		{"rare wins step down", 6, 1, 10, 1, 10000, 5},

		// Clamped to the game's own band.
		{"clamped at max", 8, 4, 8, 5, 1000, 8},
		{"clamped at min", 4, 4, 8, 0, 5000, 4},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Decide(c.current, c.min, c.max, c.wins, c.total)
			if got != c.want {
				t.Errorf("Decide(%d,[%d..%d], %d/%d) = %d, want %d",
					c.current, c.min, c.max, c.wins, c.total, got, c.want)
			}
		})
	}
}
