package faucet

import (
	"context"
	"crypto/ed25519"
	"encoding/binary"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	pkgsolana "gamee-backend/pkg/solana"
)

// Service is the devnet beta faucet: it funds an authenticated tester's
// wallet with a little SOL (tx fees) and freshly-minted test USDC so a
// small beta group can play without anyone touching the deploy wallet by
// hand. It is a BETA/DEVNET tool only: it must never be enabled against a
// real mint (the keypair it loads is the mint authority — on mainnet that
// authority should live in cold storage, making this endpoint impossible
// to run by construction).
type Service struct {
	rdb        *redis.Client
	solana     *pkgsolana.Client
	usdcMint   string
	keyPath    string
	solLamports int64
	usdcMicro  int64
	perDay     int

	keypairOnce sync.Once
	keypair     *pkgsolana.Keypair
	keypairErr  error

	// serializes sends so concurrent faucet calls don't race the same
	// recent-blockhash/nonce window from one hot keypair.
	sendMu sync.Mutex
}

// NewService creates a faucet. Callers should only register its routes when
// the beta faucet is enabled in config.
func NewService(rdb *redis.Client, solanaRPC, usdcMint, keyPath string, solLamports, usdcMicro int64, perDay int) *Service {
	if perDay <= 0 {
		perDay = 1
	}
	return &Service{
		rdb:         rdb,
		solana:      pkgsolana.NewClient(solanaRPC, "confirmed"),
		usdcMint:    usdcMint,
		keyPath:     keyPath,
		solLamports: solLamports,
		usdcMicro:   usdcMicro,
		perDay:      perDay,
	}
}

// RegisterRoutes registers the faucet route on an authenticated group.
func (s *Service) RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/beta/faucet", s.HandleFaucet)
}

func (s *Service) loadKeypair() (*pkgsolana.Keypair, error) {
	s.keypairOnce.Do(func() {
		s.keypair, s.keypairErr = pkgsolana.LoadKeypairFromFile(s.keyPath)
	})
	return s.keypair, s.keypairErr
}

// HandleFaucet funds the calling wallet. Auth middleware has already
// verified the JWT and stashed the wallet address in the context.
func (s *Service) HandleFaucet(c *gin.Context) {
	walletVal, ok := c.Get("wallet")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated", "code": "UNAUTHORIZED"})
		return
	}
	wallet := walletVal.(string)
	ctx := c.Request.Context()

	// Rate limit: perDay grants per wallet per UTC day.
	day := time.Now().UTC().Format("2006-01-02")
	key := fmt.Sprintf("faucet:%s:%s", wallet, day)
	count, err := s.rdb.Incr(ctx, key).Result()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "rate limiter unavailable", "code": "INTERNAL_ERROR"})
		return
	}
	if count == 1 {
		s.rdb.Expire(ctx, key, 25*time.Hour)
	}
	if count > int64(s.perDay) {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"error": fmt.Sprintf("faucet limit reached (%d per day) — try again tomorrow", s.perDay),
			"code":  "RATE_LIMITED",
		})
		return
	}

	sig, err := s.fund(ctx, wallet)
	if err != nil {
		// Refund the rate-limit slot on failure so a flaky RPC doesn't
		// burn the tester's daily grant.
		s.rdb.Decr(ctx, key)
		log.Printf("[faucet] funding %s failed: %v", wallet, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "faucet transaction failed, try again", "code": "FAUCET_FAILED"})
		return
	}

	log.Printf("[faucet] funded %s (%d lamports, %d micro-USDC) tx=%s", wallet, s.solLamports, s.usdcMicro, sig)
	c.JSON(http.StatusOK, gin.H{
		"tx":         sig,
		"sol":        float64(s.solLamports) / 1e9,
		"usdc":       float64(s.usdcMicro) / 1e6,
		"usdc_mint":  s.usdcMint,
	})
}

// fund builds, signs, and confirms one transaction carrying:
//  1. SystemProgram.Transfer(faucet → wallet, solLamports)
//  2. AssociatedTokenProgram.CreateIdempotent(wallet's USDC ATA)
//  3. Token.MintTo(mint, ATA, authority=faucet, usdcMicro)
func (s *Service) fund(ctx context.Context, wallet string) (string, error) {
	kp, err := s.loadKeypair()
	if err != nil {
		return "", fmt.Errorf("faucet keypair: %w", err)
	}
	// Sanity: the destination must be a real pubkey — decode before
	// building instructions so a garbage wallet fails cleanly here.
	if _, err := pkgsolana.DecodePubkey(wallet); err != nil {
		return "", fmt.Errorf("invalid wallet: %w", err)
	}

	ata, err := pkgsolana.DeriveAssociatedTokenAddress(wallet, s.usdcMint)
	if err != nil {
		return "", fmt.Errorf("derive ATA: %w", err)
	}

	ixs := []pkgsolana.Instruction{
		transferSOLInstruction(kp.PublicKey, wallet, uint64(s.solLamports)),
		createIdempotentATAInstruction(kp.PublicKey, ata, wallet, s.usdcMint),
		mintToInstruction(s.usdcMint, ata, kp.PublicKey, uint64(s.usdcMicro)),
	}

	s.sendMu.Lock()
	defer s.sendMu.Unlock()

	blockhash, err := s.solana.GetLatestBlockhash(ctx)
	if err != nil {
		return "", fmt.Errorf("blockhash: %w", err)
	}
	msg, err := pkgsolana.CompileMessage(kp.PublicKey, ixs, blockhash)
	if err != nil {
		return "", fmt.Errorf("compile: %w", err)
	}
	rawTx, err := pkgsolana.SignTransaction(msg, map[string]ed25519.PrivateKey{kp.PublicKey: kp.PrivateKey})
	if err != nil {
		return "", fmt.Errorf("sign: %w", err)
	}
	sig, err := s.solana.SendTransaction(ctx, rawTx, false)
	if err != nil {
		return "", fmt.Errorf("send: %w", err)
	}
	confirmCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := s.solana.ConfirmTransaction(confirmCtx, sig, 2*time.Second); err != nil {
		return "", fmt.Errorf("tx %s did not confirm: %w", sig, err)
	}
	return sig, nil
}

// transferSOLInstruction encodes SystemProgram::Transfer — u32 LE
// instruction index 2, then lamports u64 LE.
func transferSOLInstruction(from, to string, lamports uint64) pkgsolana.Instruction {
	data := make([]byte, 12)
	binary.LittleEndian.PutUint32(data[0:4], 2)
	binary.LittleEndian.PutUint64(data[4:12], lamports)
	return pkgsolana.Instruction{
		ProgramID: pkgsolana.SystemProgramID,
		Accounts: []pkgsolana.AccountMeta{
			{Pubkey: from, IsSigner: true, IsWritable: true},
			{Pubkey: to, IsSigner: false, IsWritable: true},
		},
		Data: data,
	}
}

// createIdempotentATAInstruction encodes the Associated Token Account
// program's CreateIdempotent (discriminator byte 1) — creates the ATA if
// missing, no-ops if it already exists. Account order per the ATA program:
// payer, ata, owner, mint, system program, token program.
func createIdempotentATAInstruction(payer, ata, owner, mint string) pkgsolana.Instruction {
	return pkgsolana.Instruction{
		ProgramID: pkgsolana.AssociatedTokenProgramID,
		Accounts: []pkgsolana.AccountMeta{
			{Pubkey: payer, IsSigner: true, IsWritable: true},
			{Pubkey: ata, IsSigner: false, IsWritable: true},
			{Pubkey: owner, IsSigner: false, IsWritable: false},
			{Pubkey: mint, IsSigner: false, IsWritable: false},
			{Pubkey: pkgsolana.SystemProgramID, IsSigner: false, IsWritable: false},
			{Pubkey: pkgsolana.TokenProgramID, IsSigner: false, IsWritable: false},
		},
		Data: []byte{1},
	}
}

// mintToInstruction encodes SPL Token MintTo — single-byte instruction
// index 7, then amount u64 LE. Accounts: mint (writable), destination
// token account (writable), mint authority (signer).
func mintToInstruction(mint, dest, authority string, amount uint64) pkgsolana.Instruction {
	data := make([]byte, 9)
	data[0] = 7
	binary.LittleEndian.PutUint64(data[1:9], amount)
	return pkgsolana.Instruction{
		ProgramID: pkgsolana.TokenProgramID,
		Accounts: []pkgsolana.AccountMeta{
			{Pubkey: mint, IsSigner: false, IsWritable: true},
			{Pubkey: dest, IsSigner: false, IsWritable: true},
			{Pubkey: authority, IsSigner: true, IsWritable: false},
		},
		Data: data,
	}
}
