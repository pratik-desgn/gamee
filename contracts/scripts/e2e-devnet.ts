/**
 * GAMEE — Stage 2 exit demo: the full money loop against devnet + a live backend.
 *
 *   wallet auth (nonce → ed25519 sign → JWT)
 *   → on-chain buy_ticket (devnet, real 80/10/5/5 split)
 *   → POST /tickets/confirm   (backend verifies the tx on devnet RPC)
 *   → POST /spin              (weighted wheel assigns game + level)
 *   → on-chain commit_spin    (player + verifier co-sign; creates game_session PDA)
 *   → bot plays the real deterministic sim with humanlike input timing
 *   → POST /session/:id/finish → replay verification → settlement
 *   → on win: settle_session pays 95% of the jackpot vault on devnet
 *
 * Prereqs: backend running on :8080 (devnet env), program deployed+initialized,
 * player keypair funded with SOL + test USDC. Bots exist for all 10 games
 * (e2e-bots.ts — verified via bots-offline-check.ts), so every spin is
 * playable; a lost round consumes the ticket and the script buys another
 * (up to MAX_TICKETS).
 *
 * Env (defaults = 2026-07-07 devnet deployment):
 *   API_BASE, PLAYER_KEYPAIR, VERIFIER_KEYPAIR, and the address set below.
 *   TIER selects which jackpot tier to buy/fund/settle against — "small"
 *   (default, unchanged existing behavior), "medium", "mega", or "legend".
 *   The tier's vault PDA and its real on-chain USDC token account are
 *   resolved directly from the deployed JackpotVault account (same source
 *   backend/internal/ticket.Service.resolveVaultTokenAccount reads), so no
 *   redeploy or hardcoded per-tier constant is needed. The tier is also
 *   sent to /tickets/confirm, which independently verifies the buy_ticket
 *   tx actually funded that tier's vault and that the player wallet is
 *   qualified for it (jackpot.EntryThreshold) before accepting the claim.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN, web3 } from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as nacl from "tweetnacl";
import * as bs58mod from "bs58";
const b58encode: (b: Uint8Array) => string =
  (bs58mod as any).encode ?? (bs58mod as any).default.encode;
import fs from "fs";
import { Gamee } from "../target/types/gamee";

const API = process.env.API_BASE ?? "http://localhost:8080/api/v1";
const USDC_MINT = new web3.PublicKey(process.env.USDC_MINT ?? "5mVF1G85a4h8gKXDKAKBCav54DtVVsnLCd2nXt7Q4Z1H");
const PLATFORM_USDC = new web3.PublicKey(process.env.PLATFORM_USDC ?? "CXzckG7dPTGssCBSzher3TJq9a2SCkaUCa4f2wENcnu");
const JACKPOT_USDC = new web3.PublicKey(process.env.JACKPOT_USDC ?? "BdVb8vpGdCn3ADSP9Tvmaf5GnXuqtCe8bqd9PCRnDa2M");
const PLAYER_KEYPAIR = process.env.PLAYER_KEYPAIR ??
  "/tmp/claude-1000/-home-edith/4b20de78-9c1d-43a9-a20e-0191ac2b0d5a/scratchpad/player-devnet.json";
const VERIFIER_KEYPAIR = process.env.VERIFIER_KEYPAIR ?? `${__dirname}/../../backend/keys/verifier-devnet.json`;
const GAMES_DIST = `${__dirname}/../../games/dist/games`;
const MAX_TICKETS = 8;
const TICKET_PRICE = new BN(1_000_000);
const TIER = process.env.TIER ?? "small";

const loadKp = (p: string) =>
  web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));

// Public devnet RPC flakes (429s, stale blockhashes) — retry on-chain sends.
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (i >= tries) throw e;
      console.log(`  ${label}: attempt ${i} failed (${(e.message || e).toString().slice(0, 60)}…) — retrying`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

// ── humanlike bots for all 10 games ────────────────────────────────────
// Shared with the offline coverage check (bots-offline-check.ts), which
// verifies win rates, replay determinism, and anti-cheat-safe input timing
// against the same compiled game modules the replay verifier loads.
import { BOTS, playBot } from "./e2e-bots";

// ── api helpers ────────────────────────────────────────────────────────
let jwt = "";
async function api(path: string, body?: unknown, method?: string) {
  const res = await fetch(`${API}${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json as any;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Gamee as Program<Gamee>;
  const conn = provider.connection;
  const player = loadKp(PLAYER_KEYPAIR);
  const verifier = loadKp(VERIFIER_KEYPAIR);
  const wallet58 = player.publicKey.toBase58();
  console.log(`player   : ${wallet58}`);
  console.log(`tier     : ${TIER}`);

  // 1 ── wallet auth
  const { nonce, message } = await api("/auth/nonce", { wallet: wallet58 });
  const sig = nacl.sign.detached(Buffer.from(message, "utf8"), player.secretKey);
  const verify = await api("/auth/verify", { wallet: wallet58, nonce, signature: b58encode(sig) });
  jwt = verify.token;
  console.log("auth     : JWT issued");

  // shared PDAs / accounts
  const [platformConfigPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("platform_config")], program.programId);
  const [verifierSetPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("verifier_set")], program.programId);
  const [jackpotVaultPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("jackpot"), Buffer.from(TIER)], program.programId);
  const buyerUsdc = await getAssociatedTokenAddress(USDC_MINT, player.publicKey);

  // Resolve this tier's real on-chain USDC token account from the deployed
  // JackpotVault account itself — no hardcoded per-tier constant, no
  // redeploy. Mirrors backend/internal/ticket.Service.resolveVaultTokenAccount.
  const vaultAccount = await program.account.jackpotVault.fetch(jackpotVaultPda);
  const jackpotUsdc: web3.PublicKey = vaultAccount.vaultTokenAccount as web3.PublicKey;
  if (TIER === "small" && jackpotUsdc.toBase58() !== JACKPOT_USDC.toBase58()) {
    console.log(`  note: resolved small-tier vault ATA (${jackpotUsdc.toBase58()}) differs from the JACKPOT_USDC default (${JACKPOT_USDC.toBase58()}) — using the resolved on-chain value.`);
  }
  console.log(`vault    : ${jackpotVaultPda.toBase58()} (USDC account ${jackpotUsdc.toBase58()})`);

  // 2 ── buy + spin until a bot-supported game comes up
  let session: any = null;
  let ticketPda: web3.PublicKey | null = null;
  for (let i = 0; i < MAX_TICKETS && !session; i++) {
    const nonceBn = new BN(Date.now() + i);
    const [tp] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), player.publicKey.toBuffer(), nonceBn.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const txSig = await withRetry("buy_ticket", () => program.methods
      .buyTicket(nonceBn, TICKET_PRICE)
      .accountsStrict({
        buyer: player.publicKey,
        buyerUsdcAccount: buyerUsdc,
        usdcMint: USDC_MINT,
        platformUsdcAccount: PLATFORM_USDC,
        referralUsdcAccount: PLATFORM_USDC,
        jackpotUsdcAccount: jackpotUsdc,
        jackpotVault: jackpotVaultPda,
        devUsdcAccount: PLATFORM_USDC,
        ticket: tp,
        platformConfig: platformConfigPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([player])
      .rpc({ commitment: "confirmed" }));
    console.log(`ticket ${i + 1}: bought on-chain (${txSig.slice(0, 16)}…)`);

    // The backend verifies the tx on its own RPC connection at a deeper
    // commitment — wait for finalization, then retry confirm briefly.
    for (let w = 0; w < 20; w++) {
      const st = (await conn.getSignatureStatuses([txSig])).value[0];
      if (st?.confirmationStatus === "finalized") break;
      await new Promise((r) => setTimeout(r, 2500));
    }
    let confirm: any = null;
    for (let a = 0; a < 6 && !confirm; a++) {
      try {
        confirm = await api("/tickets/confirm", { tx_signature: txSig, tier: TIER });
      } catch (e) {
        if (a === 5) throw e;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    const ticketId = confirm.ticket?.id ?? confirm.ticket?.ID;
    const spin = await api("/spin", { ticket_id: ticketId });
    console.log(`  spin   : ${spin.game_id} (level ${spin.difficulty?.level}, target ${spin.target_score})`);
    if (BOTS[spin.game_id]) {
      session = spin;
      ticketPda = tp;
    } else {
      console.log("  no bot for this game — buying another ticket");
    }
  }
  if (!session || !ticketPda) throw new Error(`no bot-supported game in ${MAX_TICKETS} spins`);

  // 3 ── on-chain commit_spin (player + verifier co-sign; creates game_session PDA)
  const [gameConfigPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("game_config"), Buffer.from(session.game_id)], program.programId);
  const [gameSessionPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("game_session"), ticketPda.toBuffer()], program.programId);
  const vrfResult = new BN(session.seed.replace(/[^0-9a-f]/gi, "").slice(0, 24) || "1", 16);
  const commitSig = await withRetry("commit_spin", () => program.methods
    .commitSpin(session.game_id, vrfResult, session.seed)
    .accountsStrict({
      player: player.publicKey,
      verifier: verifier.publicKey,
      platformConfig: platformConfigPda,
      verifierSet: verifierSetPda,
      ticket: ticketPda,
      gameConfig: gameConfigPda,
      gameSession: gameSessionPda,
      systemProgram: web3.SystemProgram.programId,
    })
    .signers([player, verifier])
    .rpc({ commitment: "confirmed" }));
  console.log(`commit   : on-chain game_session created (${commitSig.slice(0, 16)}…)`);

  // 4 ── bot plays the real sim
  const bot = BOTS[session.game_id];
  const mod = require(`${GAMES_DIST}/${session.game_id}/index.js`);
  const game = new mod[bot.cls]();
  const level = session.difficulty?.level ?? 6;
  game.init(session.seed, { seed: session.seed, level, params: {} });
  const log = playBot(game, bot.makeDecide(), bot.pace);
  const finalState = game.getState();
  console.log(`play     : ${session.game_id} score ${finalState.score} won=${finalState.won} (${log.length} inputs)`);

  // 5 ── submit for verification
  const vaultBefore = (await getAccount(conn, jackpotUsdc)).amount;
  const playerBefore = (await getAccount(conn, buyerUsdc)).amount;
  await api(`/session/${session.session_id}/finish`, { input_log: log, client_score: finalState.score });
  console.log("finish   : submitted, waiting for replay verification + settlement…");

  // 6 ── poll result
  let result: any = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    result = await api(`/session/${session.session_id}/result`);
    if (result.verdict && result.verdict !== "pending") break;
    process.stdout.write(".");
  }
  console.log(`\nverdict  : ${result?.verdict} (score ${result?.score ?? "—"})`);

  if (result?.verdict === "won") {
    const payoutTx = result.payout_tx;
    const vaultAfter = (await getAccount(conn, jackpotUsdc)).amount;
    const playerAfter = (await getAccount(conn, buyerUsdc)).amount;
    console.log(`payout   : tx ${payoutTx}`);
    console.log(`tier         : ${TIER}`);
    console.log(`jackpot vault: ${vaultBefore} → ${vaultAfter} micro-USDC (${jackpotUsdc.toBase58()})`);
    console.log(`player USDC  : ${playerBefore} → ${playerAfter} (won ${playerAfter - playerBefore})`);
    console.log(`explorer: https://explorer.solana.com/tx/${payoutTx}?cluster=devnet`);
    console.log(`\n${TIER.toUpperCase()}-TIER SETTLEMENT COMPLETE — full loop settled on devnet.`);
  } else if (result?.verdict === "lost") {
    console.log("Loop completed with a verified LOSS — pipeline works; run again for a win.");
  } else {
    throw new Error(`unexpected verdict: ${JSON.stringify(result)}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
