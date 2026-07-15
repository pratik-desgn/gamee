package solana

import (
	"encoding/binary"
	"encoding/hex"
	"testing"
)

func TestBase58Encode_KnownValues(t *testing.T) {
	tests := []struct {
		input    []byte
		expected string
	}{
		{[]byte{}, ""},
		{[]byte{0}, "1"},
		{[]byte{0, 0}, "11"},
		{[]byte{1}, "2"},
		{[]byte{255}, "5Q"},
		{[]byte{0, 1}, "12"},
	}

	for _, tt := range tests {
		got := Base58Encode(tt.input)
		if got != tt.expected {
			t.Errorf("Base58Encode(%x) = %q, want %q", tt.input, got, tt.expected)
		}
	}
}

func TestBase58Decode_KnownValues(t *testing.T) {
	tests := []struct {
		input    string
		expected []byte
	}{
		{"1", []byte{0}},
		{"11", []byte{0, 0}},
		{"2", []byte{1}},
		{"5Q", []byte{255}},
		{"12", []byte{0, 1}},
	}

	for _, tt := range tests {
		got, err := Base58Decode(tt.input)
		if err != nil {
			t.Errorf("Base58Decode(%q) returned error: %v", tt.input, err)
			continue
		}
		if len(got) != len(tt.expected) {
			t.Errorf("Base58Decode(%q) length = %d, want %d", tt.input, len(got), len(tt.expected))
			continue
		}
		for i := range tt.expected {
			if got[i] != tt.expected[i] {
				t.Errorf("Base58Decode(%q)[%d] = %02x, want %02x", tt.input, i, got[i], tt.expected[i])
			}
		}
	}
}

func TestBase58Decode_InvalidChars(t *testing.T) {
	_, err := Base58Decode("0")
	if err == nil {
		t.Error("expected error for invalid base58 char '0'")
	}
	_, err = Base58Decode("O")
	if err == nil {
		t.Error("expected error for invalid base58 char 'O'")
	}
	_, err = Base58Decode("l")
	if err == nil {
		t.Error("expected error for invalid base58 char 'l'")
	}
}

func TestDecodePubkey_WrongLength(t *testing.T) {
	_, err := DecodePubkey("")
	if err == nil {
		t.Error("expected error for empty pubkey")
	}
}

func TestFindProgramAddress_DifferentNonces(t *testing.T) {
	programID := make([]byte, 32)
	copy(programID, []byte{0x4e, 0x7f, 0x3e, 0x6b, 0x1c, 0x8a, 0x2d, 0x5f})
	wallet := make([]byte, 32)
	copy(wallet, []byte{0x9a, 0x2b, 0x7c, 0x3d, 0x8e, 0x1f, 0x6a, 0x4b})

	nonce1 := []byte{1, 0, 0, 0, 0, 0, 0, 0}
	nonce2 := []byte{2, 0, 0, 0, 0, 0, 0, 0}

	addr1, _, err1 := FindProgramAddress([][]byte{[]byte("ticket"), wallet, nonce1}, programID)
	if err1 != nil {
		t.Skip("first PDA failed (hash all on-curve with test inputs)")
	}
	addr2, _, err2 := FindProgramAddress([][]byte{[]byte("ticket"), wallet, nonce2}, programID)
	if err2 != nil {
		t.Skip("second PDA failed (hash all on-curve with test inputs)")
	}

	if addr1 == addr2 {
		t.Error("different nonces should produce different PDAs")
	}
}

// TestFindProgramAddress_GoldenValues is the load-bearing test for PDA
// derivation: it compares our pure-Go find_program_address (curve math +
// base58) byte-for-byte against values produced by @solana/web3.js's
// PublicKey.findProgramAddressSync. If the Edwards25519 on-curve test picks
// the wrong bump, the derived address diverges from the real on-chain ticket
// PDA and settlement can never bind a winner to their session.
//
// Reference generated with (seeds: "ticket", wallet, nonce as u64 LE):
//
//	programId = TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
//	wallet    = So11111111111111111111111111111111111111112
func TestFindProgramAddress_GoldenValues(t *testing.T) {
	programID, err := DecodePubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
	if err != nil {
		t.Fatalf("decode programID: %v", err)
	}
	wallet, err := DecodePubkey("So11111111111111111111111111111111111111112")
	if err != nil {
		t.Fatalf("decode wallet: %v", err)
	}

	cases := []struct {
		nonce    uint64
		wantAddr string
		wantBump uint8
	}{
		{1, "8az52nHmWYrgLs8VfucdxrdivGY1eNEHZbLfjKfCXBvx", 255},
		{2, "B1p8x1tDf7HVVN34ndzRQinmXQ6TYijqS8LEtBqiTYGr", 254},
		{255, "3xn6KY8RYA66EAnMtJ97yADcX95JsUhAc8XTq5g7KHY4", 255},
		{1000, "F2XGRgbX9n9F3X98eyH3Ce43cZRaMSYvDj2VQ7qf8Q8E", 255},
	}

	for _, tc := range cases {
		nb := make([]byte, 8)
		binary.LittleEndian.PutUint64(nb, tc.nonce)
		pdaHex, bump, err := FindProgramAddress(
			[][]byte{[]byte("ticket"), wallet, nb}, programID)
		if err != nil {
			t.Fatalf("nonce %d: FindProgramAddress error: %v", tc.nonce, err)
		}
		raw, _ := hex.DecodeString(pdaHex)
		gotAddr := Base58Encode(raw)
		if gotAddr != tc.wantAddr {
			t.Errorf("nonce %d: PDA = %s, want %s", tc.nonce, gotAddr, tc.wantAddr)
		}
		if bump != tc.wantBump {
			t.Errorf("nonce %d: bump = %d, want %d", tc.nonce, bump, tc.wantBump)
		}
	}
}

func TestIsOnEdwardsCurve(t *testing.T) {
	zeros := make([]byte, 32)
	if !isOnEdwardsCurve(zeros) {
		t.Error("all zeros should be on the curve")
	}

	if isOnEdwardsCurve([]byte{0, 0, 0}) {
		t.Error("short input should return false")
	}

	// All-0xFF bytes after clearing sign bit → >= p, off-curve
	high := make([]byte, 32)
	for i := range high {
		high[i] = 0xFF
	}
	if isOnEdwardsCurve(high) {
		t.Error("all-0xFF after sign mask should be off-curve")
	}
}

// TestSystemProgramID_RoundTrips verifies the SystemProgramID constant is
// the correct base58 encoding of 32 zero bytes, rather than trusting it from
// memory — a wrong well-known constant here would silently break every
// transaction that references the System Program.
func TestSystemProgramID_RoundTrips(t *testing.T) {
	zero32 := make([]byte, 32)
	computed := Base58Encode(zero32)
	if computed != SystemProgramID {
		t.Fatalf("SystemProgramID constant = %q, but Base58Encode(32 zero bytes) = %q", SystemProgramID, computed)
	}
	decoded, err := DecodePubkey(SystemProgramID)
	if err != nil {
		t.Fatalf("DecodePubkey(SystemProgramID) error: %v", err)
	}
	for i, b := range decoded {
		if b != 0 {
			t.Fatalf("decoded SystemProgramID byte %d = %#x, want 0", i, b)
		}
	}
}

func TestWellKnownProgramIDs_DecodeTo32Bytes(t *testing.T) {
	for _, addr := range []string{TokenProgramID, AssociatedTokenProgramID} {
		b, err := DecodePubkey(addr)
		if err != nil {
			t.Errorf("DecodePubkey(%q) error: %v", addr, err)
			continue
		}
		if len(b) != 32 {
			t.Errorf("DecodePubkey(%q) length = %d, want 32", addr, len(b))
		}
	}
}
