package faucet

import (
	"encoding/binary"
	"testing"

	pkgsolana "gamee-backend/pkg/solana"
)

// Encoding goldens: the three instruction builders must produce exactly the
// wire bytes the target programs expect — an off-by-one here fails on-chain
// with an opaque "invalid instruction data".

func TestTransferSOLInstruction(t *testing.T) {
	ix := transferSOLInstruction("A", "B", 123_456_789)
	if ix.ProgramID != pkgsolana.SystemProgramID {
		t.Fatalf("program = %q", ix.ProgramID)
	}
	if len(ix.Data) != 12 {
		t.Fatalf("data len = %d, want 12", len(ix.Data))
	}
	if idx := binary.LittleEndian.Uint32(ix.Data[0:4]); idx != 2 {
		t.Fatalf("instruction index = %d, want 2 (Transfer)", idx)
	}
	if amt := binary.LittleEndian.Uint64(ix.Data[4:12]); amt != 123_456_789 {
		t.Fatalf("lamports = %d", amt)
	}
	if !ix.Accounts[0].IsSigner || !ix.Accounts[0].IsWritable {
		t.Fatal("from must be signer+writable")
	}
	if ix.Accounts[1].IsSigner || !ix.Accounts[1].IsWritable {
		t.Fatal("to must be non-signer writable")
	}
}

func TestCreateIdempotentATAInstruction(t *testing.T) {
	ix := createIdempotentATAInstruction("payer", "ata", "owner", "mint")
	if ix.ProgramID != pkgsolana.AssociatedTokenProgramID {
		t.Fatalf("program = %q", ix.ProgramID)
	}
	if len(ix.Data) != 1 || ix.Data[0] != 1 {
		t.Fatalf("data = %v, want [1] (CreateIdempotent)", ix.Data)
	}
	wantOrder := []string{"payer", "ata", "owner", "mint", pkgsolana.SystemProgramID, pkgsolana.TokenProgramID}
	if len(ix.Accounts) != len(wantOrder) {
		t.Fatalf("accounts = %d, want %d", len(ix.Accounts), len(wantOrder))
	}
	for i, want := range wantOrder {
		if ix.Accounts[i].Pubkey != want {
			t.Fatalf("account[%d] = %q, want %q", i, ix.Accounts[i].Pubkey, want)
		}
	}
	if !ix.Accounts[0].IsSigner {
		t.Fatal("payer must sign")
	}
}

func TestMintToInstruction(t *testing.T) {
	ix := mintToInstruction("mint", "dest", "auth", 20_000_000)
	if ix.ProgramID != pkgsolana.TokenProgramID {
		t.Fatalf("program = %q", ix.ProgramID)
	}
	if len(ix.Data) != 9 || ix.Data[0] != 7 {
		t.Fatalf("data = %v, want leading 7 (MintTo) + u64", ix.Data)
	}
	if amt := binary.LittleEndian.Uint64(ix.Data[1:9]); amt != 20_000_000 {
		t.Fatalf("amount = %d", amt)
	}
	if !ix.Accounts[2].IsSigner {
		t.Fatal("mint authority must sign")
	}
	if !ix.Accounts[0].IsWritable || !ix.Accounts[1].IsWritable {
		t.Fatal("mint and dest must be writable")
	}
}
