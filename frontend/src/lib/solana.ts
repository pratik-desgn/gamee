import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Program, BN } from '@coral-xyz/anchor';
import type { Gamee } from '@/idl/gamee';
import idlJson from '@/idl/gamee.json';
import type { JackpotTier } from '@/lib/tiers';

// The instruction is built from the committed IDL copy (src/idl/gamee.json,
// regenerated via `npm run sync-idl` after any contract change), so the
// discriminator, argument encoding, and account order can't silently drift
// from the on-chain program the way a hand-built instruction could. CI's
// anchor-test job diffs this copy against a freshly built IDL.

const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
);
const TICKET_PRICE = BigInt(process.env.NEXT_PUBLIC_TICKET_PRICE || '1000000'); // 1 USDC (6 dp)
/** Ticket price in whole USDC, for UI checks and copy. */
export const TICKET_PRICE_USDC = Number(TICKET_PRICE) / 1e6;
// Default tier when createBuyTicketTransaction is called without one — kept
// env-overridable so existing deployments/tests that rely on
// NEXT_PUBLIC_JACKPOT_TIER see no behavior change.
const DEFAULT_JACKPOT_TIER = (process.env.NEXT_PUBLIC_JACKPOT_TIER as JackpotTier) || 'small';

/**
 * Wrap a required public-key env value, throwing a clear error if unset.
 *
 * `value` must be passed in from a *static* `process.env.NEXT_PUBLIC_X`
 * reference at the call site, not looked up here via `process.env[name]`.
 * Next.js's build-time inlining only replaces literal, statically-analyzable
 * `process.env.NEXT_PUBLIC_X` property accesses with their values — a
 * dynamic bracket/computed access is invisible to that step, so it would
 * always evaluate to `undefined` in the browser (there is no real `process`
 * object at runtime) regardless of what's actually configured in
 * `.env.local`, and this would throw unconditionally for every key.
 */
function requiredKey(name: string, value: string | undefined): PublicKey {
  if (!value) throw new Error(`${name} is not configured — set it before buying a ticket`);
  return new PublicKey(value);
}

export function getConnection(): Connection {
  const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.devnet.solana.com';
  return new Connection(rpc);
}

/**
 * Solana Explorer link for a transaction signature. The cluster suffix is
 * derived from the RPC in use so payout links keep working if the app is
 * ever pointed at mainnet.
 */
export function explorerTxUrl(signature: string): string {
  const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.devnet.solana.com';
  const cluster = rpc.includes('devnet') ? '?cluster=devnet' : rpc.includes('testnet') ? '?cluster=testnet' : '';
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

/** Encode a u64 as 8 little-endian bytes. */
function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

/**
 * The GAMEE program client, bound to a connection only — sufficient for
 * building unsigned transactions; signing stays with the wallet adapter.
 * The program id comes from the env var (deploy target of record), not the
 * IDL snapshot, so a redeploy only requires an env change.
 */
function getProgram(connection: Connection, programId: PublicKey): Program<Gamee> {
  // Cast needed: the generated type literal-types `address` to the snapshot's
  // id, but the env var is the deploy target of record.
  const idl = { ...(idlJson as Gamee), address: programId.toBase58() } as Gamee;
  return new Program<Gamee>(idl, { connection });
}

/**
 * Resolve a tier's jackpot vault PDA and its USDC token account.
 *
 * Fetched on-chain via the IDL (`JackpotVault.vaultTokenAccount`) so this
 * works for any of the four tiers without a dedicated env var per tier. If
 * the fetch fails (e.g. running against an env where the vault hasn't been
 * initialized yet) we fall back to NEXT_PUBLIC_JACKPOT_USDC for the small
 * tier only, matching this module's pre-existing (env-only) behavior; any
 * other tier's fetch failure surfaces as an error instead of silently
 * routing funds to the wrong vault.
 */
async function resolveJackpotVault(
  program: Program<Gamee>,
  programId: PublicKey,
  tier: JackpotTier
): Promise<{ jackpotVaultPda: PublicKey; jackpotUsdcAccount: PublicKey }> {
  const [jackpotVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('jackpot'), Buffer.from(tier)],
    programId
  );

  try {
    const vault = await program.account.jackpotVault.fetch(jackpotVaultPda);
    return { jackpotVaultPda, jackpotUsdcAccount: vault.vaultTokenAccount };
  } catch (err) {
    if (tier === 'small') {
      return { jackpotVaultPda, jackpotUsdcAccount: requiredKey('NEXT_PUBLIC_JACKPOT_USDC', process.env.NEXT_PUBLIC_JACKPOT_USDC) };
    }
    throw new Error(
      `Could not resolve the "${tier}" jackpot vault on-chain — it may not be initialized on this deployment yet.`
    );
  }
}

/**
 * Build a buy_ticket transaction against the GAMEE Anchor program so the
 * contract performs the 80/10/5/5 split and creates the ticket PDA.
 *
 * `tier` selects which of the four jackpot vaults (small/medium/mega/legend)
 * the 80% cut is routed to; it defaults to the small tier (unqualified-safe)
 * when omitted. The backend's `/tickets/confirm` is the authority on whether
 * the caller's wallet actually qualifies for the chosen tier — this function
 * just builds the transaction against that tier's vault.
 *
 * Requires these env vars (all platform-owned USDC token accounts + the
 * deployed program id), which come from deployment (`anchor run init`
 * prints the full block):
 *   NEXT_PUBLIC_GAMEE_PROGRAM_ID, NEXT_PUBLIC_PLATFORM_USDC,
 *   NEXT_PUBLIC_REFERRAL_USDC, NEXT_PUBLIC_JACKPOT_USDC, NEXT_PUBLIC_DEV_USDC
 */
export async function createBuyTicketTransaction(
  wallet: PublicKey,
  tier: JackpotTier = DEFAULT_JACKPOT_TIER
): Promise<Transaction> {
  const connection = getConnection();

  const programId = requiredKey('NEXT_PUBLIC_GAMEE_PROGRAM_ID', process.env.NEXT_PUBLIC_GAMEE_PROGRAM_ID);
  const platformUsdc = requiredKey('NEXT_PUBLIC_PLATFORM_USDC', process.env.NEXT_PUBLIC_PLATFORM_USDC);
  const referralUsdc = requiredKey('NEXT_PUBLIC_REFERRAL_USDC', process.env.NEXT_PUBLIC_REFERRAL_USDC);
  const devUsdc = requiredKey('NEXT_PUBLIC_DEV_USDC', process.env.NEXT_PUBLIC_DEV_USDC);

  const buyerUsdc = await getAssociatedTokenAddress(USDC_MINT, wallet);

  // Unique per-purchase nonce (ms timestamp fits in u64 and avoids PDA
  // collisions on repeat buys). The ticket PDA is derived from the same nonce.
  const nonce = BigInt(Date.now());

  const [ticketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('ticket'), wallet.toBuffer(), u64le(nonce)],
    programId
  );

  const program = getProgram(connection, programId);
  const { jackpotVaultPda, jackpotUsdcAccount } = await resolveJackpotVault(program, programId, tier);

  // All accounts passed explicitly (accountsStrict) rather than relying on
  // Anchor's PDA auto-resolution — jackpot_vault's tier seed is a runtime
  // string the resolver can't infer, and explicit is easier to audit anyway.
  const tx = await program.methods
    .buyTicket(new BN(nonce.toString()), new BN(TICKET_PRICE.toString()))
    .accountsStrict({
      buyer: wallet,
      buyerUsdcAccount: buyerUsdc,
      usdcMint: USDC_MINT,
      platformUsdcAccount: platformUsdc,
      referralUsdcAccount: referralUsdc,
      jackpotUsdcAccount,
      jackpotVault: jackpotVaultPda,
      devUsdcAccount: devUsdc,
      ticket: ticketPda,
      platformConfig: PublicKey.findProgramAddressSync(
        [Buffer.from('platform_config')],
        programId
      )[0],
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet;

  return tx;
}

export async function getUsdcBalance(wallet: PublicKey): Promise<number> {
  const connection = getConnection();
  const ata = await getAssociatedTokenAddress(USDC_MINT, wallet);
  try {
    const account = await connection.getTokenAccountBalance(ata);
    return account.value.uiAmount || 0;
  } catch {
    return 0;
  }
}
