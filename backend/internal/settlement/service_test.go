package settlement

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	pkgsolana "gamee-backend/pkg/solana"
)

func TestSettleSessionDiscriminator(t *testing.T) {
	want := sha256.Sum256([]byte("global:settle_session"))
	if len(settleSessionDiscriminator) != 8 {
		t.Fatalf("discriminator length = %d, want 8", len(settleSessionDiscriminator))
	}
	for i := 0; i < 8; i++ {
		if settleSessionDiscriminator[i] != want[i] {
			t.Errorf("discriminator[%d] = %#x, want %#x", i, settleSessionDiscriminator[i], want[i])
		}
	}
}

func TestUint64LE(t *testing.T) {
	cases := []struct {
		v    uint64
		want []byte
	}{
		{0, []byte{0, 0, 0, 0, 0, 0, 0, 0}},
		{1, []byte{1, 0, 0, 0, 0, 0, 0, 0}},
		{256, []byte{0, 1, 0, 0, 0, 0, 0, 0}},
	}
	for _, tc := range cases {
		got := uint64LE(tc.v)
		if len(got) != 8 {
			t.Fatalf("uint64LE(%d) length = %d, want 8", tc.v, len(got))
		}
		for i := range tc.want {
			if got[i] != tc.want[i] {
				t.Errorf("uint64LE(%d)[%d] = %d, want %d", tc.v, i, got[i], tc.want[i])
			}
		}
	}
}

func TestHexToBase58(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	h := hex.EncodeToString(raw)
	got := hexToBase58(h)
	want := pkgsolana.Base58Encode(raw)
	if got != want {
		t.Errorf("hexToBase58(%q) = %q, want %q", h, got, want)
	}
}

func TestHexToBase58_InvalidHex(t *testing.T) {
	if got := hexToBase58("not-hex"); got != "" {
		t.Errorf("hexToBase58(invalid) = %q, want empty string", got)
	}
}

// TestOnChainTargetScore covers the games whose off-chain target_score is on
// a different scale than the on-chain "final_score >= target_score" check
// expects (reaction-test, sliding-puzzle — both lower-is-better display
// scores), plus a normal higher-is-better game to confirm those pass through
// unchanged.
func TestOnChainTargetScore(t *testing.T) {
	cases := []struct {
		gameID      string
		targetScore int
		want        int
	}{
		{"reaction-test", 300, 0},
		{"reaction-test", 0, 0},
		{"sliding-puzzle", 40, 0},
		{"aim-master", 250, 250},
		{"wing-rush", 300, 300},
	}
	for _, tc := range cases {
		if got := onChainTargetScore(tc.gameID, tc.targetScore); got != tc.want {
			t.Errorf("onChainTargetScore(%q, %d) = %d, want %d", tc.gameID, tc.targetScore, got, tc.want)
		}
	}
}

// writeTestKeypairFile generates a fresh ed25519 keypair and writes it in
// the Solana CLI's 64-byte-array JSON format (seed || pubkey) — mirrors
// pkg/solana/keypair_test.go's helper of the same shape (unexported there,
// so re-declared here for this package's tests).
func writeTestKeypairFile(t *testing.T, dir, name string) (path string, wantPub ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate test keypair: %v", err)
	}
	bytes64 := make([]int, 64)
	for i, b := range priv {
		bytes64[i] = int(b)
	}
	data, err := json.Marshal(bytes64)
	if err != nil {
		t.Fatalf("failed to marshal test keypair: %v", err)
	}
	path = filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatalf("failed to write test keypair file: %v", err)
	}
	return path, pub
}

// TestLoadCosignerKeypairs_Empty covers the "no cosigners configured" case
// (VERIFIER_COSIGNER_KEYPAIRS unset/empty, e.g. a threshold-1 verifier_set)
// — settlement must still be able to sign with just the primary verifier.
func TestLoadCosignerKeypairs_Empty(t *testing.T) {
	s := &Service{}
	cosigners, err := s.loadCosignerKeypairs()
	if err != nil {
		t.Fatalf("loadCosignerKeypairs() error = %v, want nil", err)
	}
	if len(cosigners) != 0 {
		t.Errorf("loadCosignerKeypairs() = %d keypairs, want 0", len(cosigners))
	}
}

// TestLoadCosignerKeypairs_Multiple covers the real multisig case: several
// cosigner keypair files, loaded and cached in path order, each with the
// correct public key (same cross-check pkgsolana.LoadKeypairFromFile does
// for the primary verifier — see keypair.go).
func TestLoadCosignerKeypairs_Multiple(t *testing.T) {
	dir := t.TempDir()
	path1, pub1 := writeTestKeypairFile(t, dir, "cosigner-1.json")
	path2, pub2 := writeTestKeypairFile(t, dir, "cosigner-2.json")

	s := &Service{cosignerKeyPaths: []string{path1, path2}}
	cosigners, err := s.loadCosignerKeypairs()
	if err != nil {
		t.Fatalf("loadCosignerKeypairs() error = %v, want nil", err)
	}
	if len(cosigners) != 2 {
		t.Fatalf("loadCosignerKeypairs() = %d keypairs, want 2", len(cosigners))
	}
	if want := pkgsolana.Base58Encode(pub1); cosigners[0].PublicKey != want {
		t.Errorf("cosigners[0].PublicKey = %q, want %q", cosigners[0].PublicKey, want)
	}
	if want := pkgsolana.Base58Encode(pub2); cosigners[1].PublicKey != want {
		t.Errorf("cosigners[1].PublicKey = %q, want %q", cosigners[1].PublicKey, want)
	}

	// sync.Once caching: a second call must return the same slice without
	// re-reading the files (deleting them and calling again should still
	// succeed, proving the cache was used, not a fresh read).
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("failed to remove test keypair dir: %v", err)
	}
	cosignersAgain, err := s.loadCosignerKeypairs()
	if err != nil {
		t.Fatalf("loadCosignerKeypairs() (cached) error = %v, want nil", err)
	}
	if len(cosignersAgain) != 2 {
		t.Fatalf("loadCosignerKeypairs() (cached) = %d keypairs, want 2", len(cosignersAgain))
	}
}

// TestLoadCosignerKeypairs_Error covers a misconfigured cosigner path (e.g.
// a typo in VERIFIER_COSIGNER_KEYPAIRS) failing loudly at load time rather
// than silently settling with fewer signatures than intended.
func TestLoadCosignerKeypairs_Error(t *testing.T) {
	dir := t.TempDir()
	s := &Service{cosignerKeyPaths: []string{filepath.Join(dir, "does-not-exist.json")}}
	if _, err := s.loadCosignerKeypairs(); err == nil {
		t.Error("loadCosignerKeypairs() error = nil, want error for missing cosigner file")
	}
}
