package solana

import (
	"crypto/ed25519"
	"fmt"
)

// AccountMeta describes one account reference within an instruction.
type AccountMeta struct {
	Pubkey     string // base58
	IsSigner   bool
	IsWritable bool
}

// Instruction is a single instruction to include in a transaction.
type Instruction struct {
	ProgramID string
	Accounts  []AccountMeta
	Data      []byte
}

// accountEntry accumulates the signer/writable flags for one pubkey across
// every instruction it appears in — Solana transactions carry one flat
// account-keys array, not one per instruction, so an account referenced as
// writable in one instruction and readonly in another must be writable in
// the compiled message (flags are a union, not per-instruction).
type accountEntry struct {
	pubkey     string
	isSigner   bool
	isWritable bool
}

// CompiledMessage is a serialized legacy transaction message plus the
// ordered list of pubkeys that must sign it (bucket order: signers come
// first, fee payer always first among them — required by the wire format).
type CompiledMessage struct {
	Bytes       []byte
	SignerOrder []string // base58 pubkeys, in the order their signatures must appear
}

// CompileMessage builds a legacy Solana transaction message: it deduplicates
// accounts across all instructions (unioning signer/writable flags), orders
// them into the four required buckets (signer+writable, signer+readonly,
// non-signer+writable, non-signer+readonly) with feePayer pinned first,
// and serializes the header + account keys + blockhash + instructions.
func CompileMessage(feePayer string, instructions []Instruction, recentBlockhash string) (*CompiledMessage, error) {
	if feePayer == "" {
		return nil, fmt.Errorf("fee payer is required")
	}

	order := []string{feePayer}
	entries := map[string]*accountEntry{
		feePayer: {pubkey: feePayer, isSigner: true, isWritable: true},
	}

	touch := func(pubkey string, isSigner, isWritable bool) {
		e, ok := entries[pubkey]
		if !ok {
			e = &accountEntry{pubkey: pubkey}
			entries[pubkey] = e
			order = append(order, pubkey)
		}
		e.isSigner = e.isSigner || isSigner
		e.isWritable = e.isWritable || isWritable
	}

	for _, ix := range instructions {
		touch(ix.ProgramID, false, false)
		for _, a := range ix.Accounts {
			touch(a.Pubkey, a.IsSigner, a.IsWritable)
		}
	}

	// Bucket into the four groups the wire format requires, preserving
	// first-seen order within each bucket. Fee payer is forced into bucket 1
	// and must land at index 0 — guaranteed since it's the first entry
	// touched above and this loop preserves first-seen order per bucket.
	var bucket1, bucket2, bucket3, bucket4 []*accountEntry // signer+writable, signer+readonly, writable, readonly
	for _, pubkey := range order {
		e := entries[pubkey]
		switch {
		case e.isSigner && e.isWritable:
			bucket1 = append(bucket1, e)
		case e.isSigner && !e.isWritable:
			bucket2 = append(bucket2, e)
		case !e.isSigner && e.isWritable:
			bucket3 = append(bucket3, e)
		default:
			bucket4 = append(bucket4, e)
		}
	}
	if len(bucket1) == 0 || bucket1[0].pubkey != feePayer {
		return nil, fmt.Errorf("internal error: fee payer did not land at index 0")
	}

	var accountKeys []string
	var signerOrder []string
	for _, e := range bucket1 {
		accountKeys = append(accountKeys, e.pubkey)
		signerOrder = append(signerOrder, e.pubkey)
	}
	for _, e := range bucket2 {
		accountKeys = append(accountKeys, e.pubkey)
		signerOrder = append(signerOrder, e.pubkey)
	}
	for _, e := range bucket3 {
		accountKeys = append(accountKeys, e.pubkey)
	}
	for _, e := range bucket4 {
		accountKeys = append(accountKeys, e.pubkey)
	}

	if len(accountKeys) > 255 {
		return nil, fmt.Errorf("too many accounts: %d (max 255)", len(accountKeys))
	}

	indexOf := make(map[string]byte, len(accountKeys))
	for i, k := range accountKeys {
		indexOf[k] = byte(i)
	}

	var msg []byte
	// Message header.
	msg = append(msg, byte(len(bucket1)+len(bucket2))) // numRequiredSignatures
	msg = append(msg, byte(len(bucket2)))               // numReadonlySignedAccounts
	msg = append(msg, byte(len(bucket4)))               // numReadonlyUnsignedAccounts

	// Account keys (compact-array of 32-byte pubkeys).
	msg = append(msg, encodeCompactU16(len(accountKeys))...)
	for _, k := range accountKeys {
		kb, err := DecodePubkey(k)
		if err != nil {
			return nil, fmt.Errorf("invalid account pubkey %q: %w", k, err)
		}
		msg = append(msg, kb...)
	}

	// Recent blockhash (32 raw bytes, base58-encoded in RPC responses).
	bh, err := Base58Decode(recentBlockhash)
	if err != nil {
		return nil, fmt.Errorf("invalid blockhash: %w", err)
	}
	if len(bh) != 32 {
		return nil, fmt.Errorf("invalid blockhash length: expected 32, got %d", len(bh))
	}
	msg = append(msg, bh...)

	// Instructions (compact-array).
	msg = append(msg, encodeCompactU16(len(instructions))...)
	for _, ix := range instructions {
		programIdx, ok := indexOf[ix.ProgramID]
		if !ok {
			return nil, fmt.Errorf("internal error: program id %q missing from account keys", ix.ProgramID)
		}
		msg = append(msg, programIdx)

		msg = append(msg, encodeCompactU16(len(ix.Accounts))...)
		for _, a := range ix.Accounts {
			idx, ok := indexOf[a.Pubkey]
			if !ok {
				return nil, fmt.Errorf("internal error: account %q missing from account keys", a.Pubkey)
			}
			msg = append(msg, idx)
		}

		msg = append(msg, encodeCompactU16(len(ix.Data))...)
		msg = append(msg, ix.Data...)
	}

	return &CompiledMessage{Bytes: msg, SignerOrder: signerOrder}, nil
}

// encodeCompactU16 encodes a length using Solana's "compact-u16" shortvec
// format — LEB128-style: 7 bits per byte, continuation bit set on all but
// the last byte. Used for every length-prefixed array in the wire format.
func encodeCompactU16(n int) []byte {
	var out []byte
	for {
		b := byte(n & 0x7f)
		n >>= 7
		if n != 0 {
			out = append(out, b|0x80)
		} else {
			out = append(out, b)
			break
		}
	}
	return out
}

// SignTransaction signs a compiled message with the given keypairs and
// serializes the full transaction: compact-array of signatures + message
// bytes. signers must contain a private key for every pubkey in
// msg.SignerOrder — if the message requires a signature from an account not
// present in signers (e.g. a keypair the caller doesn't hold), this returns
// an error rather than producing an invalid transaction.
func SignTransaction(msg *CompiledMessage, signers map[string]ed25519.PrivateKey) ([]byte, error) {
	var sigs [][]byte
	for _, pubkey := range msg.SignerOrder {
		priv, ok := signers[pubkey]
		if !ok {
			return nil, fmt.Errorf("missing private key for required signer %s", pubkey)
		}
		sigs = append(sigs, ed25519.Sign(priv, msg.Bytes))
	}

	var tx []byte
	tx = append(tx, encodeCompactU16(len(sigs))...)
	for _, s := range sigs {
		tx = append(tx, s...)
	}
	tx = append(tx, msg.Bytes...)
	return tx, nil
}
