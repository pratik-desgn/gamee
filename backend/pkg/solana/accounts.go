package solana

import (
	"encoding/binary"
	"fmt"
)

// discriminatorLen is the 8-byte Anchor account discriminator prefixing
// every account's data (sha256("account:<TypeName>")[:8]).
const discriminatorLen = 8

// JackpotVaultAccount mirrors the on-chain layout of the contract's
// JackpotVault struct (contracts/programs/gamee/src/state/jackpot.rs):
//
//	discriminator(8) + tier(4-byte LE len + bytes) + vault_token_account(32)
//	+ total_amount(8) + total_paid_out(8) + total_plays(8) + last_won_at(8)
//	+ active(1)
//
// Settlement needs vault_token_account — the actual SPL token account
// holding the jackpot's USDC — which isn't tracked anywhere in Postgres, so
// it's fetched and parsed directly from the chain.
type JackpotVaultAccount struct {
	Tier              string
	VaultTokenAccount string // base58
	TotalAmount       uint64
	TotalPaidOut      uint64
	TotalPlays        uint64
	LastWonAt         int64
	Active            bool
}

// DeserializeJackpotVault parses raw account data (as returned by
// getAccountInfo) into a JackpotVaultAccount. A minimal hand-rolled decoder
// rather than a full Borsh library — the layout is small, fixed except for
// the one variable-length string field, and stable (defined by our own
// contract).
func DeserializeJackpotVault(data []byte) (*JackpotVaultAccount, error) {
	if len(data) < discriminatorLen+4 {
		return nil, fmt.Errorf("account data too short: %d bytes", len(data))
	}
	offset := discriminatorLen

	tierLen := int(binary.LittleEndian.Uint32(data[offset : offset+4]))
	offset += 4
	if offset+tierLen > len(data) {
		return nil, fmt.Errorf("account data too short for tier string of length %d", tierLen)
	}
	tier := string(data[offset : offset+tierLen])
	offset += tierLen

	const remainingLen = 32 + 8 + 8 + 8 + 8 + 1
	if offset+remainingLen > len(data) {
		return nil, fmt.Errorf("account data too short: need %d more bytes after tier, have %d", remainingLen, len(data)-offset)
	}

	vaultTokenAccount := Base58Encode(data[offset : offset+32])
	offset += 32

	totalAmount := binary.LittleEndian.Uint64(data[offset : offset+8])
	offset += 8
	totalPaidOut := binary.LittleEndian.Uint64(data[offset : offset+8])
	offset += 8
	totalPlays := binary.LittleEndian.Uint64(data[offset : offset+8])
	offset += 8
	lastWonAt := int64(binary.LittleEndian.Uint64(data[offset : offset+8]))
	offset += 8
	active := data[offset] != 0

	return &JackpotVaultAccount{
		Tier:              tier,
		VaultTokenAccount: vaultTokenAccount,
		TotalAmount:       totalAmount,
		TotalPaidOut:      totalPaidOut,
		TotalPlays:        totalPlays,
		LastWonAt:         lastWonAt,
		Active:            active,
	}, nil
}
