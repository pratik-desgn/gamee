package solana

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
)

func TestEncodeCompactU16(t *testing.T) {
	cases := []struct {
		n    int
		want []byte
	}{
		{0, []byte{0x00}},
		{1, []byte{0x01}},
		{127, []byte{0x7f}},
		{128, []byte{0x80, 0x01}},
		{255, []byte{0xff, 0x01}},
		{300, []byte{0xac, 0x02}},
		{16384, []byte{0x80, 0x80, 0x01}},
	}
	for _, tc := range cases {
		got := encodeCompactU16(tc.n)
		if len(got) != len(tc.want) {
			t.Errorf("encodeCompactU16(%d) = %x, want %x", tc.n, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("encodeCompactU16(%d) = %x, want %x", tc.n, got, tc.want)
				break
			}
		}
	}
}

func TestCompileMessage_FeePayerFirstAndBucketOrder(t *testing.T) {
	feePayer := "11111111111111111111111111111112" // arbitrary valid-length pubkey-shaped string won't decode; use real ones below
	_ = feePayer

	// Use real decodable pubkeys (System Program + well-known constants) so
	// DecodePubkey succeeds during compilation.
	payer := SystemProgramID
	programID := TokenProgramID
	readonlySigner := AssociatedTokenProgramID

	ix := Instruction{
		ProgramID: programID,
		Accounts: []AccountMeta{
			{Pubkey: payer, IsSigner: true, IsWritable: true},
			{Pubkey: readonlySigner, IsSigner: true, IsWritable: false},
		},
		Data: []byte{1, 2, 3},
	}

	msg, err := CompileMessage(payer, []Instruction{ix}, SystemProgramID)
	if err != nil {
		t.Fatalf("CompileMessage error: %v", err)
	}

	if len(msg.SignerOrder) != 2 {
		t.Fatalf("SignerOrder = %v, want 2 entries", msg.SignerOrder)
	}
	if msg.SignerOrder[0] != payer {
		t.Errorf("SignerOrder[0] = %s, want fee payer %s", msg.SignerOrder[0], payer)
	}
	if msg.SignerOrder[1] != readonlySigner {
		t.Errorf("SignerOrder[1] = %s, want %s", msg.SignerOrder[1], readonlySigner)
	}

	// Header: numRequiredSignatures=2, numReadonlySigned=1, numReadonlyUnsigned>=1 (programID itself).
	if msg.Bytes[0] != 2 {
		t.Errorf("numRequiredSignatures = %d, want 2", msg.Bytes[0])
	}
	if msg.Bytes[1] != 1 {
		t.Errorf("numReadonlySignedAccounts = %d, want 1", msg.Bytes[1])
	}
}

func TestCompileMessage_MissingFeePayer(t *testing.T) {
	_, err := CompileMessage("", []Instruction{}, SystemProgramID)
	if err == nil {
		t.Error("expected error for empty fee payer")
	}
}

func TestSignTransaction_RoundTrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	feePayer := Base58Encode(pub)

	ix := Instruction{
		ProgramID: SystemProgramID,
		Accounts: []AccountMeta{
			{Pubkey: feePayer, IsSigner: true, IsWritable: true},
		},
		Data: []byte{0, 0, 0, 0},
	}

	msg, err := CompileMessage(feePayer, []Instruction{ix}, SystemProgramID)
	if err != nil {
		t.Fatalf("CompileMessage error: %v", err)
	}

	tx, err := SignTransaction(msg, map[string]ed25519.PrivateKey{feePayer: priv})
	if err != nil {
		t.Fatalf("SignTransaction error: %v", err)
	}

	// Manually parse the compact-array signature count + first signature,
	// then verify it against the message bytes independently of our own
	// compact-u16 decoder (which doesn't exist) — signature count for this
	// single-signer case fits in one byte (value 1).
	if tx[0] != 1 {
		t.Fatalf("signature count byte = %d, want 1", tx[0])
	}
	sig := tx[1:65]
	messageBytes := tx[65:]
	if len(messageBytes) != len(msg.Bytes) {
		t.Fatalf("serialized message length = %d, want %d", len(messageBytes), len(msg.Bytes))
	}
	if !ed25519.Verify(pub, messageBytes, sig) {
		t.Error("signature does not verify against the serialized message")
	}
}

func TestSignTransaction_MissingSigner(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	feePayer := Base58Encode(pub)

	ix := Instruction{
		ProgramID: SystemProgramID,
		Accounts: []AccountMeta{
			{Pubkey: feePayer, IsSigner: true, IsWritable: true},
		},
	}
	msg, err := CompileMessage(feePayer, []Instruction{ix}, SystemProgramID)
	if err != nil {
		t.Fatalf("CompileMessage error: %v", err)
	}

	_, err = SignTransaction(msg, map[string]ed25519.PrivateKey{})
	if err == nil {
		t.Error("expected error when the required signer's private key is not provided")
	}
}
