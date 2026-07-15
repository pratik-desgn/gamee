//go:build integration

package solana

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"testing"
	"time"
)

// This file proves the transaction serialization + signing pipeline
// (CompileMessage, SignTransaction, SendTransaction/SimulateTransaction,
// ConfirmTransaction) is byte-for-byte correct against a live Solana
// cluster — independent of whether the GAMEE program itself is deployed
// anywhere. It generates a throwaway keypair and sends a plain System
// Program transfer.
//
// Excluded from normal `go test ./...` runs (network-dependent). Run with:
//
//	go test -tags=integration ./pkg/solana/... -run TestDevnet -v -timeout 120s
func TestDevnetTransferRoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	client := NewClient("https://api.devnet.solana.com", "confirmed")

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate throwaway keypair: %v", err)
	}
	from := Base58Encode(pub)
	t.Logf("throwaway devnet keypair: %s", from)

	toPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate destination keypair: %v", err)
	}
	to := Base58Encode(toPub)

	blockhash, err := client.GetLatestBlockhash(ctx)
	if err != nil {
		t.Fatalf("failed to get latest blockhash: %v", err)
	}
	t.Logf("got real blockhash from live devnet: %s", blockhash)

	// System Program Transfer instruction: 4-byte LE instruction tag (2 =
	// Transfer) + 8-byte LE lamports.
	data := make([]byte, 12)
	binary.LittleEndian.PutUint32(data[0:4], 2)
	binary.LittleEndian.PutUint64(data[4:12], 100_000) // 0.0001 SOL

	ix := Instruction{
		ProgramID: SystemProgramID,
		Accounts: []AccountMeta{
			{Pubkey: from, IsSigner: true, IsWritable: true},
			{Pubkey: to, IsSigner: false, IsWritable: true},
		},
		Data: data,
	}

	msg, err := CompileMessage(from, []Instruction{ix}, blockhash)
	if err != nil {
		t.Fatalf("CompileMessage error: %v", err)
	}

	rawTx, err := SignTransaction(msg, map[string]ed25519.PrivateKey{from: priv})
	if err != nil {
		t.Fatalf("SignTransaction error: %v", err)
	}
	t.Logf("serialized signed transaction: %d bytes", len(rawTx))

	// Primary verification: simulateTransaction with sigVerify=true. This
	// requires the RPC node to actually decode our compact-array message
	// framing and verify our ed25519 signature against it — a bug in
	// CompileMessage/SignTransaction (wrong account ordering, wrong header
	// counts, wrong compact-u16 encoding, wrong signed bytes) would surface
	// here as a decode or "signature verification failed" error. Running
	// against an unfunded throwaway account, the expected outcome is a
	// *logic* error (insufficient funds / account not found) — proof the
	// transaction got past parsing and signature verification and into
	// actual execution.
	simResult, err := client.SimulateTransaction(ctx, rawTx, true)
	if err != nil {
		t.Fatalf("simulateTransaction RPC call failed (transaction malformed at the protocol level): %v", err)
	}
	t.Logf("simulate result: err=%v logs=%v", simResult.Err, simResult.Logs)
	if simResult.Err == nil {
		t.Fatal("expected a logic error (unfunded account), got none — did an unfunded account actually succeed?")
	}
	errStr := jsonify(simResult.Err)
	if containsAny(errStr, "invalid transaction", "failed to deserialize", "signature verification failure", "invalid signature") {
		t.Fatalf("simulation failed at the protocol/decode level (our bug), not a funds/account logic error: %s", errStr)
	}
	t.Logf("SUCCESS: transaction was correctly serialized, signed, and accepted for execution by live devnet (failed only due to the throwaway account being unfunded, as expected): %s", errStr)

	// Bonus: if a real airdrop succeeds (the public faucet is often rate
	// limited), also prove the full send+confirm path end-to-end.
	airdropRaw, err := client.call(ctx, "requestAirdrop", []interface{}{from, 1_000_000_000})
	if err != nil {
		t.Logf("airdrop unavailable (faucet likely rate-limited), skipping full send+confirm bonus check: %v", err)
		return
	}
	var airdropSig string
	if err := json.Unmarshal(airdropRaw, &airdropSig); err != nil {
		t.Logf("failed to parse airdrop signature, skipping bonus check: %v", err)
		return
	}
	if err := client.ConfirmTransaction(ctx, airdropSig, 2*time.Second); err != nil {
		t.Logf("airdrop did not confirm, skipping bonus check: %v", err)
		return
	}

	// Recompile with a fresh blockhash since time has passed.
	blockhash2, err := client.GetLatestBlockhash(ctx)
	if err != nil {
		t.Fatalf("failed to get latest blockhash for send: %v", err)
	}
	msg2, err := CompileMessage(from, []Instruction{ix}, blockhash2)
	if err != nil {
		t.Fatalf("CompileMessage (2nd) error: %v", err)
	}
	rawTx2, err := SignTransaction(msg2, map[string]ed25519.PrivateKey{from: priv})
	if err != nil {
		t.Fatalf("SignTransaction (2nd) error: %v", err)
	}

	txSig, err := client.SendTransaction(ctx, rawTx2, false)
	if err != nil {
		t.Fatalf("SendTransaction error: %v", err)
	}
	t.Logf("transfer tx: %s", txSig)

	if err := client.ConfirmTransaction(ctx, txSig, 2*time.Second); err != nil {
		t.Fatalf("transfer did not confirm: %v", err)
	}

	toBalance, err := client.GetBalance(ctx, to)
	if err != nil {
		t.Fatalf("failed to check destination balance: %v", err)
	}
	if toBalance != 100_000 {
		t.Errorf("destination balance = %d, want 100000", toBalance)
	}
	t.Logf("BONUS SUCCESS: full send+confirm landed on-chain, destination balance = %d lamports", toBalance)
}

func jsonify(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if len(sub) <= len(s) {
			for i := 0; i+len(sub) <= len(s); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
		}
	}
	return false
}
