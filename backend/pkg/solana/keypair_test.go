package solana

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// writeTestKeypairFile generates a fresh ed25519 keypair and writes it in
// the Solana CLI's 64-byte-array JSON format (seed || pubkey).
func writeTestKeypairFile(t *testing.T, dir string) (path string, wantPub ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate test keypair: %v", err)
	}
	// priv is seed(32) || pubkey(32) already, per Go's ed25519 convention —
	// exactly the Solana CLI file format.
	bytes64 := make([]int, 64)
	for i, b := range priv {
		bytes64[i] = int(b)
	}
	data, err := json.Marshal(bytes64)
	if err != nil {
		t.Fatalf("failed to marshal test keypair: %v", err)
	}
	path = filepath.Join(dir, "test-keypair.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatalf("failed to write test keypair file: %v", err)
	}
	return path, pub
}

func TestLoadKeypairFromFile(t *testing.T) {
	dir := t.TempDir()
	path, wantPub := writeTestKeypairFile(t, dir)

	kp, err := LoadKeypairFromFile(path)
	if err != nil {
		t.Fatalf("LoadKeypairFromFile error: %v", err)
	}

	wantAddr := Base58Encode(wantPub)
	if kp.PublicKey != wantAddr {
		t.Errorf("PublicKey = %q, want %q", kp.PublicKey, wantAddr)
	}

	// Sign/verify round-trip proves the reconstructed private key is usable.
	msg := []byte("gamee settlement test message")
	sig := ed25519.Sign(kp.PrivateKey, msg)
	if !ed25519.Verify(wantPub, msg, sig) {
		t.Error("signature from loaded keypair failed verification against the original public key")
	}
}

func TestLoadKeypairFromFile_CorruptFile(t *testing.T) {
	dir := t.TempDir()

	// Wrong length.
	shortPath := filepath.Join(dir, "short.json")
	os.WriteFile(shortPath, []byte("[1,2,3]"), 0600)
	if _, err := LoadKeypairFromFile(shortPath); err == nil {
		t.Error("expected error for wrong-length keypair file")
	}

	// Right length, but tampered public key half (mismatched with derived key).
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_ = pub
	bytes64 := make([]int, 64)
	for i, b := range priv {
		bytes64[i] = int(b)
	}
	bytes64[63] ^= 0xFF // corrupt one byte of the stored public key half
	data, _ := json.Marshal(bytes64)
	tamperedPath := filepath.Join(dir, "tampered.json")
	os.WriteFile(tamperedPath, data, 0600)
	if _, err := LoadKeypairFromFile(tamperedPath); err == nil {
		t.Error("expected error for tampered keypair file (pubkey mismatch)")
	}

	// Not valid JSON.
	invalidPath := filepath.Join(dir, "invalid.json")
	os.WriteFile(invalidPath, []byte("not json"), 0600)
	if _, err := LoadKeypairFromFile(invalidPath); err == nil {
		t.Error("expected error for invalid JSON")
	}

	// Missing file.
	if _, err := LoadKeypairFromFile(filepath.Join(dir, "missing.json")); err == nil {
		t.Error("expected error for missing file")
	}
}
