/**
 * vrf-switchboard.ts — Switchboard On-Demand randomness helper for GAMEE.
 *
 * Called by the Go backend (backend/internal/gamesession/switchboard.go,
 * `switchboardProvider`) once per spin, the same way
 * backend/internal/verification/worker.go shells out to games/sdk/run.js for
 * replay verification. Flow, against the devnet default Switchboard queue:
 *
 *   1. create a fresh Randomness account (commit-reveal, SGX-oracle backed)
 *   2. commit it to the next slot's hash in the same transaction as creation
 *   3. wait for the oracle to reveal (polls the gateway; the oracle needs
 *      the committed slot's hash to actually land on-chain first)
 *   4. print the revealed 32-byte value as hex, plus the commit/reveal tx
 *      signatures, as a single JSON line on stdout
 *
 * Contract with the caller: stdout gets EXACTLY one line of JSON, always,
 * win or lose — `{"ok":true,...}` or `{"ok":false,"error":"..."}` (nonzero
 * exit on failure). Everything else — progress, retries, SDK chatter — goes
 * to stderr. `console.log` is redefined at the very top for exactly this
 * reason: nothing upstream (this file or the SDK) gets to sneak a second
 * line onto stdout.
 *
 * SDK version: pinned to @switchboard-xyz/on-demand@3.10.4 (see
 * contracts/package.json) — the addresses and API here (Randomness.create,
 * ON_DEMAND_DEVNET_QUEUE, the `value`/`seedSlot`/`revealSlot` account
 * fields) were read directly out of this version's installed
 * node_modules/@switchboard-xyz/on-demand/dist, not from memory, because
 * this SDK's surface has changed across majors (2.x -> 3.x). Re-check
 * dist/types and dist/cjs if bumping the version.
 */

/* eslint-disable no-console */
const realConsoleError = console.error.bind(console);
// Force every console.log (ours or a dependency's) to stderr so stdout can
// never carry more than the one JSON line this script promises at exit.
console.log = (...args: unknown[]) => realConsoleError(...args);

import { Connection, VersionedTransaction } from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";

interface Args {
  ticket: string;
  keypair: string;
  rpc: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { rpc: "https://api.devnet.solana.com" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ticket") out.ticket = argv[++i];
    else if (a === "--keypair") out.keypair = argv[++i];
    else if (a === "--rpc") out.rpc = argv[++i];
  }
  if (!out.ticket) throw new Error("--ticket <id> is required");
  if (!out.keypair) throw new Error("--keypair <path> is required");
  return out as Args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls getSignatureStatuses instead of connection.confirmTransaction's
 * blockhash-expiry strategy — asV0Tx fetches its own recent blockhash
 * internally and doesn't hand back the lastValidBlockHeight we'd need for
 * that API, and devnet finality can be slow enough that a fixed poll with
 * its own timeout is the simpler, more robust option here.
 */
async function confirmSignature(
  connection: Connection,
  signature: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) {
        throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      }
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        return;
      }
    }
    await sleep(500);
  }
  throw new Error(`transaction ${signature} not confirmed within ${timeoutMs}ms`);
}

async function sendAndConfirm(
  connection: Connection,
  tx: VersionedTransaction,
  timeoutMs: number
): Promise<string> {
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: true,
    maxRetries: 3,
  });
  console.error(`[vrf] sent ${signature}, waiting for confirmation...`);
  await confirmSignature(connection, signature, timeoutMs);
  return signature;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.error(`[vrf] ticket=${args.ticket} rpc=${args.rpc}`);

  const connection = new Connection(args.rpc, "confirmed");
  // initWalletFromFile (public API) reads the same keypair file twice
  // (once for the Wallet, once below for `payer`) rather than reusing
  // AnchorUtils.initWalletFromKeypair, which the SDK's own .d.ts marks
  // private — calling it would only work by accident of JS not enforcing
  // TS visibility at runtime.
  const [wallet, payer] = sb.AnchorUtils.initWalletFromFile(args.keypair);
  console.error(`[vrf] payer=${payer.publicKey.toBase58()}`);

  // Pass the devnet program id explicitly rather than letting
  // loadProgramFromConnection auto-detect it from the connection's genesis
  // hash — we already know we're targeting devnet (see module doc), and
  // skipping the genesis-hash RPC round trip is one less thing that can be
  // flaky against a public devnet RPC.
  const program = await sb.AnchorUtils.loadProgramFromConnection(
    connection,
    wallet,
    sb.ON_DEMAND_DEVNET_PID
  );
  const queue = sb.ON_DEMAND_DEVNET_QUEUE;
  console.error(`[vrf] program=${program.programId.toBase58()} queue=${queue.toBase58()}`);

  // 1+2. Create the randomness account and commit it to the next slot's
  // hash, in a single transaction (createAndCommitIxs), signed by both the
  // payer and the new account's own keypair (it's being initialized, not a
  // PDA, so it must co-sign its own creation).
  const [randomness, randomnessKp, createCommitIxs] = await sb.Randomness.createAndCommitIxs(
    program,
    queue,
    payer.publicKey
  );
  console.error(`[vrf] randomness account=${randomness.pubkey.toBase58()}`);

  const commitTx = await sb.asV0Tx({
    connection,
    ixs: createCommitIxs,
    signers: [payer, randomnessKp],
    computeUnitPrice: 5_000,
    computeUnitLimitMultiple: 1.3,
  });
  const commitTxSig = await sendAndConfirm(connection, commitTx, 45_000);
  console.error(`[vrf] commit confirmed: ${commitTxSig}`);

  // Re-read the account so we have the on-chain seedSlot for the JSON
  // output and to sanity-check the commit actually landed before we start
  // polling the oracle for a reveal.
  let data = await randomness.loadData();
  if (data.seedSlot.toNumber() === 0) {
    throw new Error("commit landed but seedSlot is still 0 — commit did not take effect");
  }
  const seedSlot: number = data.seedSlot.toNumber();
  console.error(`[vrf] committed to seedSlot=${seedSlot}`);

  // 3. Wait for the oracle to be able to reveal. The oracle needs the
  // committed slot's hash to actually be available (i.e. that slot must
  // have passed) before it can sign a reveal — revealIx() itself waits 3s
  // before its first gateway call, but that's not always enough on a
  // congested devnet, so retry on top of it like the SDK's own
  // commitAndReveal() does.
  const maxRevealAttempts = 20;
  let revealIx;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRevealAttempts; attempt++) {
    try {
      revealIx = await randomness.revealIx(payer.publicKey);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      console.error(
        `[vrf] reveal not ready yet (attempt ${attempt}/${maxRevealAttempts}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      await sleep(2_000);
    }
  }
  if (!revealIx || lastErr) {
    throw new Error(
      `oracle never became ready to reveal after ${maxRevealAttempts} attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`
    );
  }

  const revealTx = await sb.asV0Tx({
    connection,
    ixs: [revealIx],
    signers: [payer],
    computeUnitPrice: 5_000,
    computeUnitLimitMultiple: 1.3,
  });
  const revealTxSig = await sendAndConfirm(connection, revealTx, 45_000);
  console.error(`[vrf] reveal confirmed: ${revealTxSig}`);

  data = await randomness.loadData();
  if (data.revealSlot.toNumber() === 0) {
    throw new Error("reveal tx confirmed but revealSlot is still 0 on-chain");
  }
  const randomnessHex = Buffer.from(data.value as Uint8Array).toString("hex");
  if (randomnessHex.length !== 64) {
    throw new Error(`unexpected revealed value length: ${randomnessHex.length} hex chars`);
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      randomness_hex: randomnessHex,
      slot: seedSlot,
      commit_tx: commitTxSig,
      reveal_tx: revealTxSig,
    }) + "\n"
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[vrf] FAILED: ${message}`);
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(1);
});
