package gamesession

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"gamee-backend/pkg/solana"
)

// SysvarSlotHashes is the address of the SlotHashes sysvar. It holds the
// (slot, blockhash) pairs for the most recent ~512 slots, newest first.
const SysvarSlotHashes = "SysvarS1otHashes111111111111111111111111111"

// RandomnessProvider derives the per-spin seed that drives game selection and
// difficulty. The seed is recorded on-chain by commit_spin (verifier
// co-signed), so whatever source is used becomes publicly auditable.
//
// Seed must never fail a spin — implementations fall back to a weaker source
// rather than return an error — so it returns only the seed string.
type RandomnessProvider interface {
	Seed(ctx context.Context, ticketID string) string
	// Name identifies the active source (for logging / provenance).
	Name() string
}

// deterministicProvider hashes the ticket id with the max ticket slot. It is
// predictable — a player knows their own ticket id and can guess the slot — so
// it is kept ONLY as an offline/test fallback, never as real randomness.
type deterministicProvider struct {
	db *pgxpool.Pool
}

func (p *deterministicProvider) Name() string { return "deterministic" }

func (p *deterministicProvider) Seed(ctx context.Context, ticketID string) string {
	slot := int64(0)
	if err := p.db.QueryRow(ctx, `SELECT MAX(slot) FROM tickets`).Scan(&slot); err != nil {
		slot = time.Now().UnixNano()
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:ticket-vrf-v1", ticketID, slot)))
	return "vrf_" + hex.EncodeToString(sum[:16])
}

// slotHashProvider derives the seed from the most recent on-chain blockhash in
// the SlotHashes sysvar. That value changes every slot and is unknown to the
// player when they buy a ticket, so — unlike the deterministic seed — a player
// cannot predict or grind the game they will be assigned.
//
// It does NOT remove trust in the verifier: the backend still co-signs whatever
// it reads. Moving randomness trust to an oracle (so even the backend can't
// bias it) is the Switchboard On-Demand step (see switchboardProvider in
// switchboard.go, VRF_MODE=switchboard) that swaps in here as the fallback
// this provider was the drop-in seam for.
type slotHashProvider struct {
	client   *solana.Client
	fallback RandomnessProvider
}

func (p *slotHashProvider) Name() string { return "slothash" }

func (p *slotHashProvider) Seed(ctx context.Context, ticketID string) string {
	data, err := p.client.GetAccountData(ctx, SysvarSlotHashes)
	if err == nil {
		var slot uint64
		var hash []byte
		slot, hash, err = parseRecentSlotHash(data)
		if err == nil {
			// The ticket id keeps concurrent spins in the same slot distinct
			// and makes the seed per-ticket; the slot number is folded in so
			// the exact SlotHashes entry used stays recomputable from on-chain
			// history for audit.
			sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%x:slothash-vrf-v1", ticketID, slot, hash)))
			return "vrf_" + hex.EncodeToString(sum[:16])
		}
	}
	log.Printf("[gamesession] slothash randomness unavailable (%v) — falling back to %s", err, p.fallback.Name())
	return p.fallback.Seed(ctx, ticketID)
}

// parseRecentSlotHash reads the newest (slot, blockhash) pair from raw
// SlotHashes sysvar data. Layout: 8-byte little-endian entry count, then each
// entry is an 8-byte little-endian slot followed by a 32-byte hash, ordered
// newest first — so the first entry is the most recent slot.
func parseRecentSlotHash(data []byte) (uint64, []byte, error) {
	const entrySize = 40 // 8-byte slot + 32-byte hash
	if len(data) < 8+entrySize {
		return 0, nil, fmt.Errorf("slot hashes sysvar too short: %d bytes", len(data))
	}
	if binary.LittleEndian.Uint64(data[0:8]) == 0 {
		return 0, nil, fmt.Errorf("slot hashes sysvar empty")
	}
	slot := binary.LittleEndian.Uint64(data[8:16])
	hash := make([]byte, 32)
	copy(hash, data[16:48])
	return slot, hash, nil
}

// NewRandomnessProvider selects the seed source from VRF_MODE. "slothash"
// (default) uses real on-chain entropy with a deterministic fallback;
// "switchboard" uses Switchboard On-Demand oracle randomness (see
// switchboard.go), falling back to slothash (which itself falls back to
// deterministic) on any error, timeout, or malformed helper output;
// "deterministic" forces the legacy hash (offline/tests). A nil solana client
// forces deterministic regardless of mode. sbCfg is only consulted when mode
// is "switchboard" — pass a zero SwitchboardConfig{} otherwise.
func NewRandomnessProvider(mode string, client *solana.Client, db *pgxpool.Pool, sbCfg SwitchboardConfig) RandomnessProvider {
	det := &deterministicProvider{db: db}
	if mode == "deterministic" || client == nil {
		return det
	}
	if mode == "switchboard" {
		fallback := NewRandomnessProvider("slothash", client, db, sbCfg)
		return &switchboardProvider{cfg: sbCfg, fallback: fallback}
	}
	return &slotHashProvider{client: client, fallback: det}
}
