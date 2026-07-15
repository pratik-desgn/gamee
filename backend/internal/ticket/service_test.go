package ticket

import "testing"

// TestCheckQualified exercises the tier qualification gate in isolation
// (no DB/RPC) — mirrors jackpot.EntryThreshold's ladder: small=0,
// medium=1, mega=3, legend=10 prior small-tier wins required.
func TestCheckQualified(t *testing.T) {
	cases := []struct {
		name      string
		tier      string
		smallWins int
		wantErr   bool
	}{
		{"small always qualifies with zero wins", "small", 0, false},
		{"medium rejected with zero wins", "medium", 0, true},
		{"medium accepted at exactly the threshold", "medium", 1, false},
		{"medium accepted above the threshold", "medium", 5, false},
		{"mega rejected below threshold", "mega", 2, true},
		{"mega accepted at threshold", "mega", 3, false},
		{"legend rejected below threshold", "legend", 9, true},
		{"legend accepted at threshold", "legend", 10, false},
		{"legend accepted well above threshold", "legend", 100, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := checkQualified(c.tier, c.smallWins)
			if (err != nil) != c.wantErr {
				t.Errorf("checkQualified(%q, %d) error = %v, wantErr %v", c.tier, c.smallWins, err, c.wantErr)
			}
		})
	}
}

// TestTokenAccountDelta covers the anti-spoof balance-delta matcher used to
// confirm a claimed tier's vault was the one actually credited by a buy_ticket
// transaction.
func TestTokenAccountDelta(t *testing.T) {
	const usdcMint = "5mVF1G85a4h8gKXDKAKBCav54DtVVsnLCd2nXt7Q4Z1H"
	const vaultAccount = "VaultTokenAcct11111111111111111111111111111"
	const otherAccount = "OtherTokenAcct11111111111111111111111111111"

	keys := []accountKeyInfo{
		{Pubkey: "PayerWallet1111111111111111111111111111111", Signer: true},
		{Pubkey: vaultAccount},
		{Pubkey: otherAccount},
	}

	mkBal := func(idx int, mint, amt string) tokenBalance {
		tb := tokenBalance{AccountIndex: idx, Mint: mint}
		tb.UiTokenAmount.Amount = amt
		return tb
	}

	t.Run("positive delta on the claimed vault is detected", func(t *testing.T) {
		pre := []tokenBalance{mkBal(1, usdcMint, "1000000")}
		post := []tokenBalance{mkBal(1, usdcMint, "1800000")}
		delta, found := tokenAccountDelta(keys, pre, post, usdcMint, vaultAccount)
		if !found || delta != 800000 {
			t.Errorf("got delta=%d found=%v, want 800000/true", delta, found)
		}
	})

	t.Run("account not credited at all is not found", func(t *testing.T) {
		pre := []tokenBalance{mkBal(1, usdcMint, "1000000")}
		var post []tokenBalance
		_, found := tokenAccountDelta(keys, pre, post, usdcMint, vaultAccount)
		if found {
			t.Error("expected found=false when the account has no postTokenBalances entry")
		}
	})

	t.Run("account not present in the transaction at all", func(t *testing.T) {
		_, found := tokenAccountDelta(keys, nil, nil, usdcMint, "SomeUnrelatedAccount11111111111111111111111")
		if found {
			t.Error("expected found=false for an account absent from accountKeys")
		}
	})

	t.Run("a different account's delta does not leak into the claimed vault's", func(t *testing.T) {
		// The "medium" vault getting credited shouldn't register as a
		// positive delta for a claim against a different (e.g. "small")
		// vault account.
		pre := []tokenBalance{mkBal(2, usdcMint, "0")}
		post := []tokenBalance{mkBal(2, usdcMint, "800000")}
		delta, found := tokenAccountDelta(keys, pre, post, usdcMint, vaultAccount)
		if found || delta != 0 {
			t.Errorf("got delta=%d found=%v, want 0/false — otherAccount's credit must not attribute to vaultAccount", delta, found)
		}
	})

	t.Run("zero or negative delta on the claimed vault", func(t *testing.T) {
		pre := []tokenBalance{mkBal(1, usdcMint, "1000000")}
		post := []tokenBalance{mkBal(1, usdcMint, "1000000")}
		delta, found := tokenAccountDelta(keys, pre, post, usdcMint, vaultAccount)
		if !found || delta != 0 {
			t.Errorf("got delta=%d found=%v, want 0/true", delta, found)
		}
	})
}
