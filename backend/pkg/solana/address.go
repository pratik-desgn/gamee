package solana

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"

	"filippo.io/edwards25519"
)

// FindProgramAddress replicates Solana's find_program_address: it derives a
// PDA by hashing the seeds + program id + a "bump seed", iterating the bump
// from 255 downward, and returning the first hash that is NOT on the ed25519
// curve (the "canonical" bump). The exact on-curve test matters — using the
// wrong test selects a different bump and yields a different address than
// what the on-chain program (or @solana/web3.js) derives for the same seeds.
//
// Returns the 32-byte PDA as a hex string plus the bump seed used.
func FindProgramAddress(seeds [][]byte, programID []byte) (string, uint8, error) {
	// Solana's find_program_address appends the bump as the final seed, so
	// create_program_address hashes, in order:
	//   seed_1 || seed_2 || … || [bump] || program_id || "ProgramDerivedAddress"
	// Seeds are concatenated RAW (no length prefix); the bump byte comes BEFORE
	// the program id, and the PDA marker is APPENDED last. Bump descends 255→0;
	// the first off-curve hash is canonical.
	const pdaMarker = "ProgramDerivedAddress"
	for bump := 255; bump >= 0; bump-- {
		var buf []byte
		for _, s := range seeds {
			buf = append(buf, s...)
		}
		buf = append(buf, byte(bump))
		buf = append(buf, programID...)
		buf = append(buf, []byte(pdaMarker)...)
		hash := sha256.Sum256(buf)

		// A point is a valid PDA only if it is OFF the ed25519 curve.
		if !isOnEdwardsCurve(hash[:]) {
			return hex.EncodeToString(hash[:]), uint8(bump), nil
		}
	}
	return "", 0, fmt.Errorf("unable to find valid PDA")
}

// edwardsP is the Edwards25519 field prime, p = 2^255 - 19.
var edwardsP = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))

// isOnEdwardsCurve reports whether the 32-byte value is a valid compressed
// Edwards25519 point. Solana's find_program_address rejects on-curve hashes
// for PDA use (it calls curve25519-dalek's CompressedEdwardsY::decompress),
// so this returning false is what makes a hash usable as a PDA.
//
// Two conditions, both required to match Solana/@solana/web3.js exactly:
//  1. Canonical encoding: y (little-endian, sign bit cleared) must be < p.
//     edwards25519.SetBytes silently reduces non-canonical encodings, but
//     Solana treats y >= p as off-curve, so we enforce it explicitly.
//  2. The bytes decompress to a real curve point (x^2 is a quadratic residue),
//     delegated to filippo.io/edwards25519 — the vetted implementation the Go
//     standard library's crypto/ed25519 is built on.
func isOnEdwardsCurve(b []byte) bool {
	if len(b) != 32 {
		return false
	}
	// Canonical check: interpret y as little-endian with the sign bit cleared.
	le := make([]byte, 32)
	copy(le, b)
	le[31] &= 0x7f
	for i, j := 0, 31; i < j; i, j = i+1, j-1 {
		le[i], le[j] = le[j], le[i] // reverse → big-endian for big.Int
	}
	if new(big.Int).SetBytes(le).Cmp(edwardsP) >= 0 {
		return false
	}
	_, err := new(edwards25519.Point).SetBytes(b)
	return err == nil
}

// Base58Encode encodes bytes to a base58 string (Solana-compatible).
func Base58Encode(input []byte) string {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	if len(input) == 0 {
		return ""
	}
	// Count leading zeros.
	zeros := 0
	for _, b := range input {
		if b == 0 {
			zeros++
		} else {
			break
		}
	}
	// Convert to base58.
	idx := len(input)*138/100 + 1
	buf := make([]byte, idx)
	carry := 0
	for _, b := range input {
		carry = int(b)
		i := idx
		for ; carry > 0 || i > 0; i-- {
			carry += int(buf[i-1]) * 256
			buf[i-1] = byte(carry % 58)
			carry /= 58
		}
	}
	// Map to alphabet, skip leading zeros from buffer.
	result := make([]byte, zeros)
	for i := 0; i < zeros; i++ {
		result[i] = '1'
	}
	for _, b := range buf {
		if b != 0 || len(result) > zeros {
			result = append(result, alphabet[b])
		}
	}
	return string(result)
}

// Base58Decode decodes a base58 string to bytes (Solana-compatible).
// Standard big-endian accumulator algorithm: for each digit d, the running
// byte array is multiplied by 58 and d is added, carrying across all bytes.
// Leading '1' characters map to leading zero bytes.
func Base58Decode(input string) ([]byte, error) {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	if len(input) == 0 {
		return nil, fmt.Errorf("empty input")
	}
	// Count leading '1's (each is a leading zero byte).
	zeros := 0
	for i := 0; i < len(input) && input[i] == '1'; i++ {
		zeros++
	}

	// b holds the big-endian magnitude, grown as needed.
	b := make([]byte, 0, len(input))
	for i := 0; i < len(input); i++ {
		val := -1
		for j := 0; j < len(alphabet); j++ {
			if alphabet[j] == input[i] {
				val = j
				break
			}
		}
		if val < 0 {
			return nil, fmt.Errorf("invalid character: %c", input[i])
		}
		// Multiply existing bytes by 58 and add the new digit.
		carry := val
		for k := len(b) - 1; k >= 0; k-- {
			carry += int(b[k]) * 58
			b[k] = byte(carry & 0xFF)
			carry >>= 8
		}
		// Spill any remaining carry into new high-order bytes.
		for carry > 0 {
			b = append([]byte{byte(carry & 0xFF)}, b...)
			carry >>= 8
		}
	}

	result := make([]byte, zeros+len(b))
	copy(result[zeros:], b)
	return result, nil
}

// DecodePubkey decodes a base58 Solana pubkey to 32 raw bytes.
func DecodePubkey(addr string) ([]byte, error) {
	b, err := Base58Decode(addr)
	if err != nil {
		return nil, err
	}
	if len(b) != 32 {
		return nil, fmt.Errorf("invalid pubkey length: expected 32, got %d", len(b))
	}
	return b, nil
}

// Well-known Solana program addresses, used across ticket confirmation,
// settlement, and ATA derivation. SystemProgramID is the base58 encoding of
// 32 zero bytes — verified by round-tripping through Base58Encode/Decode
// rather than trusted from memory (see the address_test.go golden test).
const (
	SystemProgramID          = "11111111111111111111111111111111"
	TokenProgramID           = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
	AssociatedTokenProgramID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
)

// DeriveAssociatedTokenAddress computes the Associated Token Account (ATA)
// address for (wallet, mint) — the PDA seeds are [wallet, token_program,
// mint] under the Associated Token Program, per the SPL spec.
func DeriveAssociatedTokenAddress(wallet, mint string) (string, error) {
	walletBytes, err := DecodePubkey(wallet)
	if err != nil {
		return "", fmt.Errorf("invalid wallet address: %w", err)
	}
	mintBytes, err := DecodePubkey(mint)
	if err != nil {
		return "", fmt.Errorf("invalid mint address: %w", err)
	}
	tokenProgramBytes, err := DecodePubkey(TokenProgramID)
	if err != nil {
		return "", fmt.Errorf("invalid token program id: %w", err)
	}
	associatedProgramBytes, err := DecodePubkey(AssociatedTokenProgramID)
	if err != nil {
		return "", fmt.Errorf("invalid associated token program id: %w", err)
	}

	pdaHex, _, err := FindProgramAddress(
		[][]byte{walletBytes, tokenProgramBytes, mintBytes},
		associatedProgramBytes,
	)
	if err != nil {
		return "", fmt.Errorf("failed to derive ATA: %w", err)
	}
	raw, err := hex.DecodeString(pdaHex)
	if err != nil {
		return "", fmt.Errorf("failed to decode derived ATA: %w", err)
	}
	return Base58Encode(raw), nil
}
