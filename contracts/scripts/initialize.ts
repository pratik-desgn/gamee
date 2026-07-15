/**
 * One-time platform initialization — run after `anchor deploy`.
 *
 *   anchor run init                          # cluster/wallet from Anchor.toml
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json npx ts-node scripts/initialize.ts
 *
 * Idempotent: every step checks on-chain state first and skips what already
 * exists, so it's safe to re-run after a partial failure.
 *
 * Env overrides (all optional — defaults are dev-friendly, NOT prod-safe):
 *   USDC_MINT        existing mint address; otherwise creates a 6-decimal
 *                    test mint with the provider wallet as authority
 *   VERIFIER_PUBKEY  backend verifier authority; defaults to provider wallet
 *   PLATFORM_WALLET / DEV_WALLET / REFERRAL_WALLET
 *                    fee destinations; default to provider wallet
 *   TICKET_PRICE     micro-USDC, default 1_000_000 ($1)
 *
 * Prints a ready-to-paste .env block when done.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN, web3 } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { Gamee } from "../target/types/gamee";

// ── verifier_set keypairs ──────────────────────────────────────
// Paths are relative to the process CWD (contracts/, same convention the
// backend uses for its own relative paths — see backend/internal/config).
// If a file doesn't exist yet (fresh localnet checkout with no devnet keys
// generated), a throwaway keypair is generated and written there so re-runs
// stay idempotent (same member pubkeys every time) instead of drifting.
const VERIFIER_KEYPAIR_PATH = process.env.VERIFIER_KEYPAIR ?? "../backend/keys/verifier-devnet.json";
const VERIFIER_COSIGNER_KEYPAIR_PATH =
  process.env.VERIFIER_COSIGNER_KEYPAIR ?? "../backend/keys/verifier-cosigner-devnet.json";

function loadOrCreateKeypair(filePath: string): web3.Keypair {
  if (fs.existsSync(filePath)) {
    const secret = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return web3.Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const kp = web3.Keypair.generate();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`  (generated new keypair at ${filePath} — none existed)`);
  return kp;
}

// Canonical catalog — MUST stay in sync with scripts/init-db.sql (games table).
const GAMES: Array<[id: string, name: string, category: string, weight: number, baseDifficulty: number]> = [
  ["wing-rush",      "Wing Rush",      "precision",  8, 6],
  ["dino-sprint",    "Dino Sprint",    "endless",    7, 6],
  ["block-merge",    "Block Merge",    "puzzle",     5, 7],
  ["simon-pro",      "Simon Pro",      "memory",     4, 7],
  ["aim-master",     "Aim Master",     "reflex",     4, 7],
  ["perfect-stack",  "Perfect Stack",  "precision",  7, 6],
  ["reaction-test",  "Reaction Test",  "reflex",     6, 6],
  ["helix-drop",     "Helix Drop",     "precision",  3, 8],
  ["minefield",      "Minefield",      "luck-skill", 2, 8],
  ["sliding-puzzle", "Sliding Puzzle", "puzzle",     4, 7],
];

// Matches the contract's accepted tiers (see initialize_jackpot docs in lib.rs).
// Settlement currently only pays from "small", but creating all four up front
// costs pennies of rent and saves a redeploy-era migration later.
const TIERS = ["small", "medium", "mega", "legend"];

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Gamee as Program<Gamee>;
  const wallet = provider.wallet as anchor.Wallet;

  console.log(`cluster:  ${provider.connection.rpcEndpoint}`);
  console.log(`wallet:   ${wallet.publicKey.toBase58()}`);
  console.log(`program:  ${program.programId.toBase58()}`);

  const balance = await provider.connection.getBalance(wallet.publicKey);
  console.log(`balance:  ${balance / web3.LAMPORTS_PER_SOL} SOL`);
  if (balance < 0.1 * web3.LAMPORTS_PER_SOL) {
    throw new Error("wallet needs at least ~0.1 SOL for account rent");
  }

  const envKey = (name: string) =>
    process.env[name] ? new web3.PublicKey(process.env[name]!) : wallet.publicKey;
  const verifier = envKey("VERIFIER_PUBKEY");
  const platformWallet = envKey("PLATFORM_WALLET");
  const devWallet = envKey("DEV_WALLET");
  const referralWallet = envKey("REFERRAL_WALLET");
  const ticketPrice = new BN(process.env.TICKET_PRICE ?? 1_000_000);

  // ── USDC mint ──────────────────────────────────────────────
  let usdcMint: web3.PublicKey;
  if (process.env.USDC_MINT) {
    usdcMint = new web3.PublicKey(process.env.USDC_MINT);
    console.log(`mint:     ${usdcMint.toBase58()} (existing)`);
  } else {
    usdcMint = await createMint(
      provider.connection, wallet.payer, wallet.publicKey, wallet.publicKey, 6
    );
    console.log(`mint:     ${usdcMint.toBase58()} (NEW test mint — dev only)`);
  }

  // ── PDAs ───────────────────────────────────────────────────
  const [platformConfigPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("platform_config")], program.programId
  );

  const [verifierSetPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_set")], program.programId
  );

  // ── Fee-destination token accounts ─────────────────────────
  const ata = async (owner: web3.PublicKey, offCurve = false) =>
    (await getOrCreateAssociatedTokenAccount(
      provider.connection, wallet.payer, usdcMint, owner, offCurve
    )).address;

  const platformUsdc = await ata(platformWallet);
  const devUsdc = await ata(devWallet);
  const referralUsdc = await ata(referralWallet);

  // The "small" tier vault ATA is what platform_config records as the
  // buy_ticket jackpot destination.
  const [smallVaultPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("jackpot"), Buffer.from("small")], program.programId
  );
  const smallVaultUsdc = await ata(smallVaultPda, true);

  // ── initialize_platform (singleton — skip if it exists) ────
  const existingConfig = await program.account.platformConfig.fetchNullable(platformConfigPda);
  if (existingConfig) {
    console.log(`platform_config already initialized (admin ${existingConfig.admin.toBase58()}) — skipping`);
  } else {
    await program.methods
      .initializePlatform(
        verifier, platformWallet, devWallet, referralWallet, ticketPrice, smallVaultUsdc
      )
      .accounts({
        admin: wallet.publicKey,
        platformConfig: platformConfigPda,
        usdcMint,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
    console.log(`platform_config initialized: ${platformConfigPda.toBase58()}`);
  }

  // ── init_verifier_set (singleton — skip if it exists) ──────
  // 2-of-2 threshold multisig: the devnet verifier (co-signs commit_spin and
  // is platform_config.verifier) plus a dedicated cosigner key. Both money-
  // moving settle_session calls now need both signatures — see
  // contracts/programs/gamee/src/instructions/settle_session.rs.
  const existingVerifierSet = await program.account.verifierSet.fetchNullable(verifierSetPda);
  if (existingVerifierSet) {
    console.log(
      `verifier_set already initialized (${existingVerifierSet.verifiers.length} members, ` +
      `threshold ${existingVerifierSet.threshold}) — skipping`
    );
  } else {
    const verifierKeypair = loadOrCreateKeypair(VERIFIER_KEYPAIR_PATH);
    const cosignerKeypair = loadOrCreateKeypair(VERIFIER_COSIGNER_KEYPAIR_PATH);
    await program.methods
      .initVerifierSet([verifierKeypair.publicKey, cosignerKeypair.publicKey], 2)
      .accounts({
        admin: wallet.publicKey,
        platformConfig: platformConfigPda,
        verifierSet: verifierSetPda,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
    console.log(
      `verifier_set initialized: ${verifierSetPda.toBase58()} ` +
      `(members: ${verifierKeypair.publicKey.toBase58()}, ${cosignerKeypair.publicKey.toBase58()}; threshold 2)`
    );
  }

  // ── initialize_jackpot per tier ────────────────────────────
  for (const tier of TIERS) {
    const [vaultPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("jackpot"), Buffer.from(tier)], program.programId
    );
    const existing = await program.account.jackpotVault.fetchNullable(vaultPda);
    if (existing) {
      console.log(`jackpot[${tier}] already initialized — skipping`);
      continue;
    }
    const vaultUsdc = tier === "small" ? smallVaultUsdc : await ata(vaultPda, true);
    await program.methods
      .initializeJackpot(tier)
      .accounts({
        admin: wallet.publicKey,
        platformConfig: platformConfigPda,
        jackpotVault: vaultPda,
        vaultTokenAccount: vaultUsdc,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
    console.log(`jackpot[${tier}] initialized: ${vaultPda.toBase58()} (vault ATA ${vaultUsdc.toBase58()})`);
  }

  // ── add_game × catalog ─────────────────────────────────────
  for (const [id, name, category, weight, baseDifficulty] of GAMES) {
    const [gameConfigPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("game_config"), Buffer.from(id)], program.programId
    );
    const existing = await program.account.gameConfig.fetchNullable(gameConfigPda);
    if (existing) {
      console.log(`game[${id}] already registered — skipping`);
      continue;
    }
    await program.methods
      .addGame(id, name, category, new BN(weight), baseDifficulty)
      .accounts({
        admin: wallet.publicKey,
        platformConfig: platformConfigPda,
        gameConfig: gameConfigPda,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
    console.log(`game[${id}] registered (weight ${weight}, base difficulty ${baseDifficulty})`);
  }

  // ── summary ────────────────────────────────────────────────
  console.log("\n── paste into backend/.env and frontend/.env.local ──");
  console.log(`PROGRAM_ID=${program.programId.toBase58()}`);
  console.log(`NEXT_PUBLIC_GAMEE_PROGRAM_ID=${program.programId.toBase58()}`);
  console.log(`USDC_MINT=${usdcMint.toBase58()}`);
  console.log(`NEXT_PUBLIC_USDC_MINT=${usdcMint.toBase58()}`);
  console.log(`NEXT_PUBLIC_PLATFORM_USDC=${platformUsdc.toBase58()}`);
  console.log(`NEXT_PUBLIC_REFERRAL_USDC=${referralUsdc.toBase58()}`);
  console.log(`NEXT_PUBLIC_DEV_USDC=${devUsdc.toBase58()}`);
  console.log(`NEXT_PUBLIC_JACKPOT_USDC=${smallVaultUsdc.toBase58()}`);
  console.log(`VERIFIER_PUBKEY=${verifier.toBase58()}`);
  console.log(`VERIFIER_KEY_PATH=${VERIFIER_KEYPAIR_PATH}`);
  console.log(`VERIFIER_COSIGNER_KEYPAIRS=${VERIFIER_COSIGNER_KEYPAIR_PATH}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
