package auth

import (
	"crypto/ed25519"
	"testing"

	pkgsolana "gamee-backend/pkg/solana"
)

// Regression test for the wallet-login signature path: a real ed25519
// signature, base58-encoded the way wallets do it, must verify. The auth
// service previously used a private base58 decoder whose carry loop
// corrupted the bytes (decoded 64-byte signatures to ~42-45 bytes), so
// every real wallet login failed with SIGNATURE_INVALID.
func TestVerifySignature_RealEd25519RoundTrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	wallet := pkgsolana.Base58Encode(pub)
	message := buildSignMessage(wallet, "test-nonce-1234")
	sig := ed25519.Sign(priv, []byte(message))

	if err := verifySignature(wallet, message, pkgsolana.Base58Encode(sig)); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}

	// Tampered message must fail.
	if err := verifySignature(wallet, message+"x", pkgsolana.Base58Encode(sig)); err == nil {
		t.Fatal("tampered message accepted")
	}
}

func TestWalletAllowlist(t *testing.T) {
	s := &Service{}

	// nil list = open registration
	if !s.walletAllowed("anyWallet") {
		t.Fatal("open mode must allow any wallet")
	}

	s.SetAllowedWallets([]string{"walletA", "walletB"})
	if !s.walletAllowed("walletA") || !s.walletAllowed("walletB") {
		t.Fatal("allowlisted wallets must pass")
	}
	if s.walletAllowed("walletC") {
		t.Fatal("non-listed wallet must be rejected")
	}

	// resetting to empty reopens
	s.SetAllowedWallets(nil)
	if !s.walletAllowed("walletC") {
		t.Fatal("clearing the list must reopen auth")
	}
}
