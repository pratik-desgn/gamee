package solana

import (
	"encoding/binary"
	"testing"
)

// buildJackpotVaultBytes constructs raw account bytes matching the on-chain
// layout, for testing the deserializer without needing a live RPC call.
func buildJackpotVaultBytes(tier string, vaultTokenAccount [32]byte, totalAmount, totalPaidOut, totalPlays uint64, lastWonAt int64, active bool) []byte {
	buf := make([]byte, 0, 128)
	buf = append(buf, make([]byte, discriminatorLen)...) // discriminator (value irrelevant for parsing)

	tierLen := make([]byte, 4)
	binary.LittleEndian.PutUint32(tierLen, uint32(len(tier)))
	buf = append(buf, tierLen...)
	buf = append(buf, []byte(tier)...)

	buf = append(buf, vaultTokenAccount[:]...)

	u64buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(u64buf, totalAmount)
	buf = append(buf, u64buf...)
	binary.LittleEndian.PutUint64(u64buf, totalPaidOut)
	buf = append(buf, u64buf...)
	binary.LittleEndian.PutUint64(u64buf, totalPlays)
	buf = append(buf, u64buf...)
	binary.LittleEndian.PutUint64(u64buf, uint64(lastWonAt))
	buf = append(buf, u64buf...)

	if active {
		buf = append(buf, 1)
	} else {
		buf = append(buf, 0)
	}
	return buf
}

func TestDeserializeJackpotVault(t *testing.T) {
	var tokenAccountBytes [32]byte
	for i := range tokenAccountBytes {
		tokenAccountBytes[i] = byte(i + 1)
	}
	expectedTokenAccount := Base58Encode(tokenAccountBytes[:])

	data := buildJackpotVaultBytes("small", tokenAccountBytes, 800_000_000, 200_000_000, 42, 1735689600, true)

	vault, err := DeserializeJackpotVault(data)
	if err != nil {
		t.Fatalf("DeserializeJackpotVault error: %v", err)
	}
	if vault.Tier != "small" {
		t.Errorf("Tier = %q, want %q", vault.Tier, "small")
	}
	if vault.VaultTokenAccount != expectedTokenAccount {
		t.Errorf("VaultTokenAccount = %q, want %q", vault.VaultTokenAccount, expectedTokenAccount)
	}
	if vault.TotalAmount != 800_000_000 {
		t.Errorf("TotalAmount = %d, want %d", vault.TotalAmount, 800_000_000)
	}
	if vault.TotalPaidOut != 200_000_000 {
		t.Errorf("TotalPaidOut = %d, want %d", vault.TotalPaidOut, 200_000_000)
	}
	if vault.TotalPlays != 42 {
		t.Errorf("TotalPlays = %d, want %d", vault.TotalPlays, 42)
	}
	if vault.LastWonAt != 1735689600 {
		t.Errorf("LastWonAt = %d, want %d", vault.LastWonAt, 1735689600)
	}
	if !vault.Active {
		t.Errorf("Active = false, want true")
	}
}

func TestDeserializeJackpotVault_DifferentTierLengths(t *testing.T) {
	var tokenAccountBytes [32]byte
	for _, tier := range []string{"small", "medium", "mega", "legend"} {
		data := buildJackpotVaultBytes(tier, tokenAccountBytes, 0, 0, 0, 0, false)
		vault, err := DeserializeJackpotVault(data)
		if err != nil {
			t.Fatalf("tier %q: DeserializeJackpotVault error: %v", tier, err)
		}
		if vault.Tier != tier {
			t.Errorf("tier %q: got %q", tier, vault.Tier)
		}
	}
}

func TestDeserializeJackpotVault_TooShort(t *testing.T) {
	_, err := DeserializeJackpotVault([]byte{1, 2, 3})
	if err == nil {
		t.Error("expected error for too-short account data")
	}

	// Discriminator + tier length prefix claiming more bytes than present.
	data := make([]byte, discriminatorLen+4)
	binary.LittleEndian.PutUint32(data[discriminatorLen:], 100) // claims 100-byte tier string
	_, err = DeserializeJackpotVault(data)
	if err == nil {
		t.Error("expected error when tier length exceeds available data")
	}
}
