package solana

import (
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"os"
)

// Keypair is a loaded Solana ed25519 signing key plus its base58 address.
type Keypair struct {
	PrivateKey ed25519.PrivateKey
	PublicKey  string // base58
}

// LoadKeypairFromFile reads a Solana CLI keypair JSON file — a JSON array of
// 64 bytes, where the first 32 are the ed25519 seed and the last 32 are the
// public key (the format written by `solana-keygen new`). It reconstructs
// the private key from the seed and cross-checks the derived public key
// against the last 32 bytes stored in the file, so a corrupt or hand-edited
// keypair file fails loudly here instead of producing silently-invalid
// signatures later.
func LoadKeypairFromFile(path string) (*Keypair, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read keypair file: %w", err)
	}

	var bytes64 []byte
	if err := json.Unmarshal(raw, &bytes64); err != nil {
		return nil, fmt.Errorf("failed to parse keypair JSON (expected array of 64 bytes): %w", err)
	}
	if len(bytes64) != 64 {
		return nil, fmt.Errorf("invalid keypair length: expected 64 bytes, got %d", len(bytes64))
	}

	seed := bytes64[:32]
	storedPubkey := bytes64[32:]

	priv := ed25519.NewKeyFromSeed(seed)
	derivedPubkey := priv.Public().(ed25519.PublicKey)

	for i := range derivedPubkey {
		if derivedPubkey[i] != storedPubkey[i] {
			return nil, fmt.Errorf("keypair file corrupt: derived public key does not match stored public key")
		}
	}

	return &Keypair{
		PrivateKey: priv,
		PublicKey:  Base58Encode(derivedPubkey),
	}, nil
}
