import * as anchor from "@coral-xyz/anchor";
import { Program, BN, web3 } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createMint,
  TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { Gamee } from "../target/types/gamee";

describe("gamee", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Gamee as Program<Gamee>;
  const wallet = provider.wallet as anchor.Wallet;

  // Test keypairs
  const admin = anchor.web3.Keypair.generate();
  const verifier = anchor.web3.Keypair.generate();
  // verifier2 is the second member of the 2-of-2 verifier_set used across
  // these tests — settle_session now requires quorum, not a single signer.
  const verifier2 = anchor.web3.Keypair.generate();
  const player = anchor.web3.Keypair.generate();
  const attacker = anchor.web3.Keypair.generate();

  // USDC mint and token accounts
  let usdcMint: web3.PublicKey;
  let buyerUsdcAccount: web3.PublicKey;
  let platformUsdcAccount: web3.PublicKey;
  let referralUsdcAccount: web3.PublicKey;
  let jackpotUsdcAccount: web3.PublicKey; // owned by the jackpot vault PDA
  let devUsdcAccount: web3.PublicKey;
  let winnerUsdcAccount: web3.PublicKey;
  let nextJackpotUsdcAccount: web3.PublicKey;

  // PDA addresses
  let platformConfigPda: web3.PublicKey;
  let verifierSetPda: web3.PublicKey;
  let ticketPda: web3.PublicKey;
  let ticketPda2: web3.PublicKey;
  let gameSessionPda: web3.PublicKey;
  let jackpotVaultPda: web3.PublicKey;
  // The "medium" tier vault is settle_session's reseed target in these
  // tests (next_jackpot_vault) — a real, admin-initialized vault distinct
  // from the "small" payout vault, exercising the same tier-agnostic vault
  // check buy_ticket already has for its own jackpot destination.
  let nextJackpotVaultPda: web3.PublicKey;
  let gameConfigPda: web3.PublicKey;

  // Constants
  const USDC_DECIMALS = 6;
  const TICKET_PRICE = new BN(1_000_000); // 1 USDC in micro-USDC
  const TIER = "small";
  const NEXT_TIER = "medium";
  const NONCE_1 = new BN(1);
  const NONCE_2 = new BN(2);
  const GAME_ID = "wing-rush";

  before(async () => {
    // Airdrop SOL to test accounts
    const airdropAmt = 10 * web3.LAMPORTS_PER_SOL;
    for (const kp of [admin, verifier, verifier2, player, attacker]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, airdropAmt);
      await provider.connection.confirmTransaction(sig);
    }

    // Create USDC mint
    usdcMint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.publicKey,
      wallet.publicKey,
      USDC_DECIMALS
    );

    // Derive PDA addresses
    [platformConfigPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("platform_config")], program.programId
    );

    [verifierSetPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("verifier_set")], program.programId
    );

    [jackpotVaultPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("jackpot"), Buffer.from(TIER)], program.programId
    );

    [nextJackpotVaultPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("jackpot"), Buffer.from(NEXT_TIER)], program.programId
    );

    [gameConfigPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("game_config"), Buffer.from(GAME_ID)], program.programId
    );

    [ticketPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), player.publicKey.toBuffer(), NONCE_1.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [ticketPda2] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), player.publicKey.toBuffer(), NONCE_2.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [gameSessionPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("game_session"), ticketPda.toBuffer()], program.programId
    );

    // Create token accounts
    buyerUsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection, wallet.payer, usdcMint, player.publicKey
      )
    ).address;

    platformUsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection, wallet.payer, usdcMint, admin.publicKey
      )
    ).address;

    // NOTE: platform/referral/dev wallets are distinct authorities in prod;
    // for tests we use separate keypair owners so ownership constraints are exercised.
    referralUsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection, wallet.payer, usdcMint, verifier.publicKey
      )
    ).address;

    devUsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection, wallet.payer, usdcMint, attacker.publicKey
      )
    ).address;

    // The jackpot vault token account is owned by the vault PDA (off-curve owner)
    jackpotUsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection, wallet.payer, usdcMint, jackpotVaultPda, true
      )
    ).address;

    winnerUsdcAccount = buyerUsdcAccount; // player's own ATA receives winnings

    // Owned by the "medium" vault PDA (off-curve owner) — this is the real
    // reseed-target vault token account settle_session's next_jackpot_vault
    // constraint requires (see NEXT_TIER above).
    nextJackpotUsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection, wallet.payer, usdcMint, nextJackpotVaultPda, true
      )
    ).address;

    // Mint 1000 USDC to player for testing
    await mintTo(provider.connection, wallet.payer, usdcMint, buyerUsdcAccount, wallet.publicKey, 1_000_000_000);
  });

  /* ──────────────────────────────────────────────
   *  INITIALIZATION
   * ────────────────────────────────────────────── */

  describe("initialize", () => {
    it("initializes platform config singleton with 80/10/5/5 split", async () => {
      await program.methods
        .initializePlatform(
          verifier.publicKey,
          admin.publicKey,    // platform_wallet
          attacker.publicKey, // dev_wallet (owner of devUsdcAccount above)
          verifier.publicKey, // referral_wallet (owner of referralUsdcAccount above)
          TICKET_PRICE,
          jackpotUsdcAccount,
        )
        .accounts({
          admin: admin.publicKey,
          platformConfig: platformConfigPda,
          usdcMint: usdcMint,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const config = await program.account.platformConfig.fetch(platformConfigPda);
      assert.equal(config.admin.toBase58(), admin.publicKey.toBase58());
      assert.equal(config.verifier.toBase58(), verifier.publicKey.toBase58());
      assert.equal(config.paused, false);
      assert.equal(config.jackpotFeeBps, 8000, "80% must go to the jackpot");
      assert.equal(config.platformFeeBps, 1000);
      assert.equal(config.referralFeeBps, 500);
      assert.equal(config.devFeeBps, 500);
      assert.equal(config.ticketPrice.toNumber(), 1_000_000);
      assert.equal(
        config.jackpotVaultTokenAccount.toBase58(),
        jackpotUsdcAccount.toBase58()
      );
    });

    it("rejects init_verifier_set from non-admin", async () => {
      try {
        await program.methods
          .initVerifierSet([verifier.publicKey, verifier2.publicKey], 2)
          .accounts({
            admin: attacker.publicKey,
            platformConfig: platformConfigPda,
            verifierSet: verifierSetPda,
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        assert.fail("Expected unauthorized error");
      } catch (err: any) {
        assert(err.toString().includes("Unauthorized") || err.toString().includes("0x1783"));
      }
    });

    it("initializes the verifier set singleton (2 members, threshold 2)", async () => {
      await program.methods
        .initVerifierSet([verifier.publicKey, verifier2.publicKey], 2)
        .accounts({
          admin: admin.publicKey,
          platformConfig: platformConfigPda,
          verifierSet: verifierSetPda,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const vs = await program.account.verifierSet.fetch(verifierSetPda);
      assert.equal(vs.verifiers.length, 2);
      assert.equal(vs.verifiers[0].toBase58(), verifier.publicKey.toBase58());
      assert.equal(vs.verifiers[1].toBase58(), verifier2.publicKey.toBase58());
      assert.equal(vs.threshold, 2);
    });

    it("initializes the jackpot vault PDA for the tier", async () => {
      await program.methods
        .initializeJackpot(TIER)
        .accounts({
          admin: admin.publicKey,
          platformConfig: platformConfigPda,
          jackpotVault: jackpotVaultPda,
          vaultTokenAccount: jackpotUsdcAccount,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const vault = await program.account.jackpotVault.fetch(jackpotVaultPda);
      assert.equal(vault.tier, TIER);
      assert.equal(vault.vaultTokenAccount.toBase58(), jackpotUsdcAccount.toBase58());
      assert.equal(vault.totalAmount.toNumber(), 0);
      assert.equal(vault.active, true);
    });

    it("initializes the medium jackpot vault PDA (settle_session's reseed target in these tests)", async () => {
      await program.methods
        .initializeJackpot(NEXT_TIER)
        .accounts({
          admin: admin.publicKey,
          platformConfig: platformConfigPda,
          jackpotVault: nextJackpotVaultPda,
          vaultTokenAccount: nextJackpotUsdcAccount,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const vault = await program.account.jackpotVault.fetch(nextJackpotVaultPda);
      assert.equal(vault.tier, NEXT_TIER);
      assert.equal(vault.vaultTokenAccount.toBase58(), nextJackpotUsdcAccount.toBase58());
    });

    it("adds a game to the wheel (admin only)", async () => {
      await program.methods
        .addGame(
          GAME_ID,
          "Wing Rush",
          "reflex",
          new BN(100),
          5, // base_difficulty
        )
        .accounts({
          admin: admin.publicKey,
          platformConfig: platformConfigPda,
          gameConfig: gameConfigPda,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const game = await program.account.gameConfig.fetch(gameConfigPda);
      assert.equal(game.gameId, GAME_ID);
      assert.equal(game.name, "Wing Rush");
      assert.equal(game.enabled, true);
      assert.equal(game.wheelWeight.toNumber(), 100);
    });

    it("rejects add_game from non-admin", async () => {
      try {
        await program.methods
          .addGame("hacked", "Hacked Game", "puzzle", new BN(1), 5)
          .accounts({
            admin: attacker.publicKey,
            platformConfig: platformConfigPda,
            gameConfig: web3.PublicKey.findProgramAddressSync(
              [Buffer.from("game_config"), Buffer.from("hacked")],
              program.programId
            )[0],
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        assert.fail("Expected unauthorized error");
      } catch (err: any) {
        assert(err.toString().includes("Unauthorized") || err.toString().includes("0x1783"));
      }
    });
  });

  /* ──────────────────────────────────────────────
   *  VERIFIER SET MANAGEMENT (update_verifier_set)
   * ────────────────────────────────────────────── */

  describe("verifier_set management", () => {
    it("rejects update_verifier_set from non-admin", async () => {
      try {
        await program.methods
          .updateVerifierSet([verifier.publicKey, verifier2.publicKey], 2)
          .accounts({
            admin: attacker.publicKey,
            platformConfig: platformConfigPda,
            verifierSet: verifierSetPda,
          })
          .signers([attacker])
          .rpc();
        assert.fail("Expected unauthorized error");
      } catch (err: any) {
        assert(err.toString().includes("Unauthorized") || err.toString().includes("0x1783"));
      }
    });

    it("rejects update_verifier_set with threshold 0", async () => {
      try {
        await program.methods
          .updateVerifierSet([verifier.publicKey, verifier2.publicKey], 0)
          .accounts({
            admin: admin.publicKey,
            platformConfig: platformConfigPda,
            verifierSet: verifierSetPda,
          })
          .signers([admin])
          .rpc();
        assert.fail("Expected InvalidVerifierSetConfig error");
      } catch (err: any) {
        assert(err.toString().includes("InvalidVerifierSetConfig"));
      }
    });

    it("rejects update_verifier_set with threshold greater than member count", async () => {
      try {
        await program.methods
          .updateVerifierSet([verifier.publicKey], 2)
          .accounts({
            admin: admin.publicKey,
            platformConfig: platformConfigPda,
            verifierSet: verifierSetPda,
          })
          .signers([admin])
          .rpc();
        assert.fail("Expected InvalidVerifierSetConfig error");
      } catch (err: any) {
        assert(err.toString().includes("InvalidVerifierSetConfig"));
      }
    });

    it("rejects update_verifier_set with duplicate members", async () => {
      try {
        await program.methods
          .updateVerifierSet([verifier.publicKey, verifier.publicKey], 2)
          .accounts({
            admin: admin.publicKey,
            platformConfig: platformConfigPda,
            verifierSet: verifierSetPda,
          })
          .signers([admin])
          .rpc();
        assert.fail("Expected InvalidVerifierSetConfig error");
      } catch (err: any) {
        assert(err.toString().includes("InvalidVerifierSetConfig"));
      }
    });

    it("updates the verifier set (round-trips back to 2 members, threshold 2)", async () => {
      // Exercise a real update — settle to a 1-member/threshold-1 config, then
      // restore 2-of-2 so every later test in this file still sees quorum 2.
      await program.methods
        .updateVerifierSet([verifier.publicKey], 1)
        .accounts({
          admin: admin.publicKey,
          platformConfig: platformConfigPda,
          verifierSet: verifierSetPda,
        })
        .signers([admin])
        .rpc();

      let vs = await program.account.verifierSet.fetch(verifierSetPda);
      assert.equal(vs.verifiers.length, 1);
      assert.equal(vs.threshold, 1);

      await program.methods
        .updateVerifierSet([verifier.publicKey, verifier2.publicKey], 2)
        .accounts({
          admin: admin.publicKey,
          platformConfig: platformConfigPda,
          verifierSet: verifierSetPda,
        })
        .signers([admin])
        .rpc();

      vs = await program.account.verifierSet.fetch(verifierSetPda);
      assert.equal(vs.verifiers.length, 2);
      assert.equal(vs.threshold, 2);
    });
  });

  /* ──────────────────────────────────────────────
   *  BUY TICKET
   * ────────────────────────────────────────────── */

  const buyTicketAccounts = () => ({
    buyer: player.publicKey,
    buyerUsdcAccount,
    usdcMint,
    platformUsdcAccount,
    referralUsdcAccount,
    jackpotUsdcAccount,
    devUsdcAccount,
    jackpotVault: jackpotVaultPda,
    platformConfig: platformConfigPda,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: web3.SystemProgram.programId,
  });

  describe("buy_ticket", () => {
    it("buys a ticket and splits 80/10/5/5 correctly", async () => {
      const buyerBefore = (await getAccount(provider.connection, buyerUsdcAccount)).amount;
      const platformBefore = (await getAccount(provider.connection, platformUsdcAccount)).amount;
      const referralBefore = (await getAccount(provider.connection, referralUsdcAccount)).amount;
      const devBefore = (await getAccount(provider.connection, devUsdcAccount)).amount;
      const jackpotBefore = (await getAccount(provider.connection, jackpotUsdcAccount)).amount;

      await program.methods
        .buyTicket(NONCE_1, TICKET_PRICE)
        .accounts({ ...buyTicketAccounts(), ticket: ticketPda })
        .signers([player])
        .rpc();

      // Verify balances
      const buyerAfter = (await getAccount(provider.connection, buyerUsdcAccount)).amount;
      const platformAfter = (await getAccount(provider.connection, platformUsdcAccount)).amount;
      const referralAfter = (await getAccount(provider.connection, referralUsdcAccount)).amount;
      const devAfter = (await getAccount(provider.connection, devUsdcAccount)).amount;
      const jackpotAfter = (await getAccount(provider.connection, jackpotUsdcAccount)).amount;

      // 80% = 800,000 → jackpot
      assert.equal(Number(jackpotAfter - jackpotBefore), 800_000, "Jackpot should receive 80%");

      // 10% = 100,000 → platform
      assert.equal(Number(platformAfter - platformBefore), 100_000, "Platform fee should be 10%");

      // 5% = 50,000 → referral
      assert.equal(Number(referralAfter - referralBefore), 50_000, "Referral fee should be 5%");

      // 5% = 50,000 → dev/operations
      assert.equal(Number(devAfter - devBefore), 50_000, "Dev fee should be 5%");

      const buyerChange = Number(buyerBefore - buyerAfter);
      assert.equal(buyerChange, 1_000_000, "Buyer should pay exactly 1 USDC");

      // Verify ticket PDA exists and has correct data
      const ticket = await program.account.ticket.fetch(ticketPda);
      assert.equal(ticket.buyer.toBase58(), player.publicKey.toBase58());
      assert.equal(ticket.nonce.toNumber(), 1);
      assert.equal(ticket.amountUsdc.toNumber(), 1_000_000);
      assert.equal(ticket.consumed, false);
      assert.isNull(ticket.gameSession);

      // Vault stats updated
      const vault = await program.account.jackpotVault.fetch(jackpotVaultPda);
      assert.equal(vault.totalAmount.toNumber(), 800_000);
      assert.equal(vault.totalPlays.toNumber(), 1);
    });

    it("rejects wrong payment amount (price is enforced on-chain)", async () => {
      const [t99Pda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), player.publicKey.toBuffer(), new BN(99).toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      try {
        await program.methods
          .buyTicket(new BN(99), new BN(1)) // 0.000001 USDC — not the ticket price
          .accounts({ ...buyTicketAccounts(), ticket: t99Pda })
          .signers([player])
          .rpc();
        assert.fail("Expected InvalidTicketPrice error");
      } catch (err: any) {
        assert(err.toString().includes("InvalidTicketPrice"));
      }
    });

    it("rejects redirected destination accounts (buyer cannot pay themselves)", async () => {
      const [t98Pda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), player.publicKey.toBuffer(), new BN(98).toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      try {
        await program.methods
          .buyTicket(new BN(98), TICKET_PRICE)
          .accounts({
            ...buyTicketAccounts(),
            ticket: t98Pda,
            // Attacker swaps the jackpot destination for their own account
            jackpotUsdcAccount: buyerUsdcAccount,
          })
          .signers([player])
          .rpc();
        assert.fail("Expected InvalidDestinationAccount error");
      } catch (err: any) {
        assert(
          err.toString().includes("InvalidDestinationAccount") ||
          err.toString().includes("ConstraintAddress") ||
          err.toString().includes("address constraint")
        );
      }
    });

    it("rejects double-spend — same ticket nonce cannot be used twice", async () => {
      try {
        await program.methods
          .buyTicket(NONCE_1, TICKET_PRICE)
          .accounts({ ...buyTicketAccounts(), ticket: ticketPda })
          .signers([player])
          .rpc();
        assert.fail("Expected error: account already in use");
      } catch (err: any) {
        assert(
          err.toString().includes("already in use") ||
          err.toString().includes("already exists") ||
          err.toString().includes("trying to init")
        );
      }
    });

    it("buys a second ticket with different nonce", async () => {
      await program.methods
        .buyTicket(NONCE_2, TICKET_PRICE)
        .accounts({ ...buyTicketAccounts(), ticket: ticketPda2 })
        .signers([player])
        .rpc();

      const ticket2 = await program.account.ticket.fetch(ticketPda2);
      assert.equal(ticket2.nonce.toNumber(), 2);
      assert.equal(ticket2.consumed, false);
    });
  });

  /* ──────────────────────────────────────────────
   *  COMMIT SPIN
   * ────────────────────────────────────────────── */

  // commit_spin only requires 1-of-N verifier_set membership (spins don't
  // move funds) — verifierSet is a fixed required account, but no quorum
  // co-signers are needed here, unlike settle_session.
  const commitSpinAccounts = () => ({
    player: player.publicKey,
    verifier: verifier.publicKey,
    platformConfig: platformConfigPda,
    verifierSet: verifierSetPda,
    systemProgram: web3.SystemProgram.programId,
  });

  // Buys a ticket at `nonce` and commits a spin for it, returning the ticket
  // and game_session PDAs. Used by settle_session tests below that need a
  // fresh pending session to settle (successfully or not).
  async function setupPendingSession(nonce: BN): Promise<{ tPda: web3.PublicKey; gsPda: web3.PublicKey }> {
    const [tPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), player.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [gsPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("game_session"), tPda.toBuffer()],
      program.programId
    );

    await program.methods
      .buyTicket(nonce, TICKET_PRICE)
      .accounts({ ...buyTicketAccounts(), ticket: tPda })
      .signers([player])
      .rpc();

    await program.methods
      .commitSpin(GAME_ID, new BN(nonce.toNumber() * 1111 + 1), `seed-${nonce.toNumber()}`)
      .accounts({ ...commitSpinAccounts(), ticket: tPda, gameSession: gsPda, gameConfig: gameConfigPda })
      .signers([player, verifier])
      .rpc();

    return { tPda, gsPda };
  }

  describe("commit_spin", () => {
    it("commits a spin (player + verifier co-sign), marks ticket consumed", async () => {
      const vrfResult = new BN("12345678901234567890");
      const seed = "derived-seed-from-vrf-12345";

      await program.methods
        .commitSpin(GAME_ID, vrfResult, seed)
        .accounts({
          ...commitSpinAccounts(),
          ticket: ticketPda,
          gameConfig: gameConfigPda,
          gameSession: gameSessionPda,
        })
        .signers([player, verifier])
        .rpc();

      // Verify ticket is consumed
      const ticket = await program.account.ticket.fetch(ticketPda);
      assert.equal(ticket.consumed, true);
      assert.equal(ticket.gameSession!.toBase58(), gameSessionPda.toBase58());

      // Verify game session exists with correct data
      const session = await program.account.gameSession.fetch(gameSessionPda);
      assert.equal(session.ticket.toBase58(), ticketPda.toBase58());
      assert.equal(session.player.toBase58(), player.publicKey.toBase58());
      assert.equal(session.gameId, GAME_ID);
      assert.equal(session.vrfResult.toString(), vrfResult.toString());
      assert.equal(session.seed, seed);
      assert.equal(session.settled, false);
      assert.equal(session.result, "pending");
    });

    it("rejects commit_spin from a verifier not in the verifier set", async () => {
      const [t97Pda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), player.publicKey.toBuffer(), new BN(97).toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      await program.methods
        .buyTicket(new BN(97), TICKET_PRICE)
        .accounts({ ...buyTicketAccounts(), ticket: t97Pda })
        .signers([player])
        .rpc();

      const [gs97Pda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("game_session"), t97Pda.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .commitSpin(GAME_ID, new BN(1), "player-chosen-seed")
          .accounts({
            ...commitSpinAccounts(),
            verifier: attacker.publicKey, // signs, but is not a verifier_set member
            ticket: t97Pda,
            gameConfig: gameConfigPda,
            gameSession: gs97Pda,
          })
          .signers([player, attacker])
          .rpc();
        assert.fail("Expected VerifierNotInSet error");
      } catch (err: any) {
        assert(err.toString().includes("VerifierNotInSet"));
      }
    });

    it("rejects consuming an already-consumed ticket (double-spend prevention)", async () => {
      const fakeSessionPda = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("game_session"), ticketPda.toBuffer()],
        program.programId
      )[0];

      try {
        await program.methods
          .commitSpin(GAME_ID, new BN(999), "fake-seed")
          .accounts({
            ...commitSpinAccounts(),
            ticket: ticketPda,
            gameConfig: gameConfigPda,
            gameSession: fakeSessionPda,
          })
          .signers([player, verifier])
          .rpc();
        assert.fail("Expected error: ticket already consumed");
      } catch (err: any) {
        assert(
          err.toString().includes("TicketAlreadyConsumed") ||
          err.toString().includes("already consumed") ||
          err.toString().includes("already in use")
        );
      }
    });
  });

  /* ──────────────────────────────────────────────
   *  SETTLE SESSION
   * ────────────────────────────────────────────── */

  // Base account set for settle_session — verifier_set threshold is 2, so
  // every successful call needs a second member signature via
  // remainingAccounts (see below). nextJackpotVault points at the "medium"
  // tier vault set up above — a real, admin-initialized vault distinct from
  // the "small" payout vault, exercising the next_jackpot_vault constraint.
  const settleSessionAccounts = () => ({
    verifier: verifier.publicKey,
    player: player.publicKey,
    platformConfig: platformConfigPda,
    verifierSet: verifierSetPda,
    jackpotVault: jackpotVaultPda,
    jackpotUsdcAccount,
    winnerUsdcAccount,
    nextJackpotUsdcAccount,
    nextJackpotVault: nextJackpotVaultPda,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: web3.SystemProgram.programId,
  });

  const verifier2AsRemainingSigner = [
    { pubkey: verifier2.publicKey, isSigner: true, isWritable: false },
  ];

  describe("settle_session", () => {
    it("settles a session with exactly threshold (2-of-2) verifier signers — win scenario, pay 95/5", async () => {
      const vaultBefore = (await getAccount(provider.connection, jackpotUsdcAccount)).amount;
      const winnerBefore = (await getAccount(provider.connection, winnerUsdcAccount)).amount;
      const nextJackpotBefore = (await getAccount(provider.connection, nextJackpotUsdcAccount)).amount;

      // Player wins: final_score >= target_score
      const finalScore = new BN(100);
      const targetScore = new BN(80);

      await program.methods
        .settleSession(finalScore, targetScore)
        .accounts({ ...settleSessionAccounts(), ticket: ticketPda, gameSession: gameSessionPda })
        .remainingAccounts(verifier2AsRemainingSigner)
        .signers([verifier, verifier2])
        .rpc();

      // Verify session is settled as "won"
      const session = await program.account.gameSession.fetch(gameSessionPda);
      assert.equal(session.settled, true);
      assert.equal(session.result, "won");
      assert.equal(session.finalScore.toNumber(), 100);
      assert.equal(session.targetScore.toNumber(), 80);
      assert.equal(session.settledBy!.toBase58(), verifier.publicKey.toBase58());

      // Verify 95/5 jackpot split
      const winnerAfter = (await getAccount(provider.connection, winnerUsdcAccount)).amount;
      const nextJackpotAfter = (await getAccount(provider.connection, nextJackpotUsdcAccount)).amount;

      const winnerReceived = Number(winnerAfter - winnerBefore);
      const nextJackpotReceived = Number(nextJackpotAfter - nextJackpotBefore);

      assert.equal(winnerReceived, Math.floor(Number(vaultBefore) * 95 / 100),
        "Winner should receive 95% of vault");
      assert.approximately(nextJackpotReceived, Math.floor(Number(vaultBefore) * 5 / 100), 1,
        "Next jackpot should receive 5%");
    });

    it("settles a session with verifier quorum — loss scenario, no payout", async () => {
      // Buy another ticket and commit a spin first
      const nonce3 = new BN(3);
      const [t3Pda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), player.publicKey.toBuffer(), nonce3.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [gs3Pda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("game_session"), t3Pda.toBuffer()],
        program.programId
      );

      // Buy ticket 3
      await program.methods
        .buyTicket(nonce3, TICKET_PRICE)
        .accounts({ ...buyTicketAccounts(), ticket: t3Pda })
        .signers([player])
        .rpc();

      // Commit spin
      await program.methods
        .commitSpin(GAME_ID, new BN(5555), "loss-test-seed")
        .accounts({ ...commitSpinAccounts(), ticket: t3Pda, gameConfig: gameConfigPda, gameSession: gs3Pda })
        .signers([player, verifier])
        .rpc();

      // Settle as loss: final_score < target_score
      await program.methods
        .settleSession(new BN(30), new BN(100))
        .accounts({ ...settleSessionAccounts(), ticket: t3Pda, gameSession: gs3Pda })
        .remainingAccounts(verifier2AsRemainingSigner)
        .signers([verifier, verifier2])
        .rpc();

      const session3 = await program.account.gameSession.fetch(gs3Pda);
      assert.equal(session3.result, "lost");
      assert.equal(session3.settled, true);
    });

    it("rejects settle from an unauthorized (non-verifier-set) sole signer", async () => {
      // Create a fresh ticket + session for this test
      const nonce4 = new BN(4);
      const [t4Pda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), player.publicKey.toBuffer(), nonce4.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [gs4Pda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("game_session"), t4Pda.toBuffer()],
        program.programId
      );

      await program.methods
        .buyTicket(nonce4, TICKET_PRICE)
        .accounts({ ...buyTicketAccounts(), ticket: t4Pda })
        .signers([player])
        .rpc();

      await program.methods
        .commitSpin(GAME_ID, new BN(7777), "unauth-test")
        .accounts({ ...commitSpinAccounts(), ticket: t4Pda, gameConfig: gameConfigPda, gameSession: gs4Pda })
        .signers([player, verifier])
        .rpc();

      // Attacker (not a verifier_set member) tries to settle alone — contributes
      // 0 to the quorum count, so this fails regardless of threshold.
      try {
        await program.methods
          .settleSession(new BN(50), new BN(50))
          .accounts({
            ...settleSessionAccounts(),
            verifier: attacker.publicKey,
            ticket: t4Pda,
            gameSession: gs4Pda,
          })
          .signers([attacker])
          .rpc();
        assert.fail("Expected VerifierQuorumNotMet error");
      } catch (err: any) {
        assert(err.toString().includes("VerifierQuorumNotMet"));
      }
    });

    it("fails with threshold-1 signers (verifier alone, no co-signer)", async () => {
      const { tPda, gsPda } = await setupPendingSession(new BN(10));

      try {
        await program.methods
          .settleSession(new BN(50), new BN(50))
          .accounts({ ...settleSessionAccounts(), ticket: tPda, gameSession: gsPda })
          .signers([verifier])
          .rpc();
        assert.fail("Expected VerifierQuorumNotMet error");
      } catch (err: any) {
        assert(err.toString().includes("VerifierQuorumNotMet"));
      }
    });

    it("fails when a non-member co-signs to pad the quorum count", async () => {
      const { tPda, gsPda } = await setupPendingSession(new BN(11));

      try {
        await program.methods
          .settleSession(new BN(50), new BN(50))
          .accounts({ ...settleSessionAccounts(), ticket: tPda, gameSession: gsPda })
          .remainingAccounts([{ pubkey: attacker.publicKey, isSigner: true, isWritable: false }])
          .signers([verifier, attacker])
          .rpc();
        assert.fail("Expected VerifierQuorumNotMet error");
      } catch (err: any) {
        assert(err.toString().includes("VerifierQuorumNotMet"));
      }
    });

    it("does not double-count a duplicate signature from the same verifier", async () => {
      const { tPda, gsPda } = await setupPendingSession(new BN(12));

      try {
        await program.methods
          .settleSession(new BN(50), new BN(50))
          .accounts({ ...settleSessionAccounts(), ticket: tPda, gameSession: gsPda })
          // Same pubkey as the primary `verifier` signer, passed again as a
          // remaining_accounts entry — must not count as a second member.
          .remainingAccounts([{ pubkey: verifier.publicKey, isSigner: true, isWritable: false }])
          .signers([verifier])
          .rpc();
        assert.fail("Expected VerifierQuorumNotMet error");
      } catch (err: any) {
        assert(err.toString().includes("VerifierQuorumNotMet"));
      }
    });

    it("rejects a next_jackpot_usdc_account not tied to a real vault", async () => {
      const { tPda, gsPda } = await setupPendingSession(new BN(14));

      try {
        await program.methods
          .settleSession(new BN(100), new BN(80))
          .accounts({
            ...settleSessionAccounts(),
            ticket: tPda,
            gameSession: gsPda,
            // devUsdcAccount is a real token account, but it is NOT the
            // "medium" vault's registered vault_token_account — the
            // next_jackpot_vault constraint must reject this pairing.
            nextJackpotUsdcAccount: devUsdcAccount,
          })
          .remainingAccounts(verifier2AsRemainingSigner)
          .signers([verifier, verifier2])
          .rpc();
        assert.fail("Expected InvalidDestinationAccount error");
      } catch (err: any) {
        assert(
          err.toString().includes("InvalidDestinationAccount") ||
          err.toString().includes("ConstraintSeeds") ||
          err.toString().includes("seeds constraint")
        );
      }

      // Session must remain unsettled — the account-validation failure
      // happens before the handler runs, so no partial state change occurs.
      const session = await program.account.gameSession.fetch(gsPda);
      assert.equal(session.settled, false);
    });
  });
});
