# GAMEE — Next Steps

*Refreshed 2026-07-07 (multi-session update). Companion to `Gamee_Master_Plan.md` (Desktop) and the STAGE-0…6 docs in this folder. Prior detailed session logs live in [RECENT-BUILD-SUMMARY.md](RECENT-BUILD-SUMMARY.md) — that file is a point-in-time history, this one is the current-truth summary.*

---

## Where the project stands

Stage-2 scaffold, well past "scaffold" at this point: Anchor program (compiles + builds to SBF), Go backend (10 services, all building/testing green), a 10-game deterministic TS games SDK, a Next.js frontend, Postgres schema, Docker, CI, and a local in-browser playground for playtesting the games directly.

### Verified green right now
| Layer | Check | Result |
|---|---|---|
| Backend | `go vet ./...`, `go build ./...`, `go test ./...` | All pass (Go 1.26), incl. a golden PDA-derivation test against `@solana/web3.js` |
| Games | `tsc --noEmit`, `jest` | Clean, **116/116 tests** across 10 games |
| Frontend | `next build` | 8 routes, no errors |
| Contract | `cargo check`, `cargo build-sbf` | Clean; produces deployable `gamee.so` (see toolchain note below) |
| Contract | `anchor test` (local **and** CI) | **15/15 passing** — init, buy_ticket 80/10/5/5 split, commit_spin co-sign, settle_session win/loss/unauthorized |
| CI | full pipeline on `main` | **All green as of 2026-07-07** (run 28833497337) — Lint, Test, Anchor Tests, Build & Push |
| Games playground | manual click/keyboard test via browser automation | Wing Rush (flap/collision), Minefield (grid click), Block Merge (arrow-key merge) all confirmed working against the real sim |

### Toolchain note — Anchor IDL generation needs a pinned old nightly (2026-07-07)
`anchor build`/`anchor test` (anchor-cli 0.30.1) hardcode `cargo +nightly` for
IDL generation and only honor the `RUSTUP_TOOLCHAIN` env var as an override —
`rust-toolchain.toml` is bypassed (this is why every earlier CI fix attempt
failed). Current nightlies removed `proc_macro::SourceFile`, which the locked
`proc-macro2 1.0.86` (required by anchor-syn 0.30.1) still references. So:
```
RUSTUP_TOOLCHAIN=nightly-2025-01-01 anchor test    # or anchor build
```
CI sets the same env var (`.github/workflows/ci.yml`, anchor-test job). The pin
becomes unnecessary on upgrade to Anchor 0.31+. Details: contracts/README.md.
(The old Windows tarball workflow is obsolete — this machine is Linux now, with
anchor-cli 0.30.1 via avm and Solana CLI 1.18.17 installed.)

---

## Stage 2 exit demo — real devnet payout achieved (2026-07-07, fourth pass)

`contracts/scripts/e2e-devnet.ts` ran the full money loop against devnet end
to end and produced a **real, independently-verified `settle_session` USDC
payout**: wallet auth → on-chain `buy_ticket` → `/tickets/confirm` → `/spin`
→ on-chain `commit_spin` → deterministic bot play (minefield) →
`/session/:id/finish` → replay verification (`verdict=match, won=true`) →
on-chain settlement. Payout tx
[`54GE6GL…mpsqc`](https://explorer.solana.com/tx/54GE6GLrRCm7w6WTcTVx4XvGJ5vjLjerw55KLzkodfT5WTMQFd7PLtjseQMSDSXuZ8qksLCAiEkvdjJTVPxmpsqc?cluster=devnet):
jackpot vault (small tier) `BdVb8vp…` 10.72 → 0.536 USDC, player
`D8CbDsX…` 5.08 → 15.264 USDC (+10.184, the 95% winner share; the 5%
reseed landed back in the same vault since only one tier is wired up).
Confirmed against `getTransaction` pre/post token balances directly via RPC,
not just the script's own before/after reads.

Two real bugs surfaced and were fixed along the way — both are latent
correctness bugs in code paths that existed before this session, not demo
scaffolding issues:

1. **`reaction-test`'s `finalScore()` used a different scale than
   `getState().score`** ([games/games/reaction-test/index.ts](../games/games/reaction-test/index.ts)).
   Every other game keeps `finalScore()` (what the replay verifier reports
   as `verified_score`) equal to `getState().score` (what the client
   reports as `client_score`) — reaction-test's `finalScore()` returned the
   raw average reaction time in ms while `getState().score` returned a
   points value (`targetReactionMs - avg`). Same play, two different
   numbers, so `worker.go`'s client/server score-match check
   (`determineVerdict`) flagged every legitimate reaction-test win as a
   `mismatch` and it never reached settlement. Fixed `finalScore()` to
   mirror the points formula; updated the one unit test that encoded the
   old raw-ms sentinel (`9999` → `0` on a loss, matching
   `getState().score`'s convention). All 116 games tests still pass.
2. **On-chain `settle_session` re-derives "won" on a scale that doesn't
   exist for reaction-test** ([backend/internal/settlement/service.go](../backend/internal/settlement/service.go)).
   Even after fix #1, the backend was still passing `game_sessions.target_score`
   (documented as **display-only** since the second-pass changelog entry
   below — a raw ms threshold for reaction-test) as the on-chain
   `target_score` argument, alongside the now-points-scale `verified_score`.
   The contract's `final_score >= target_score` check
   (`contracts/programs/gamee/src/instructions/settle_session.rs`) can
   never be satisfied that way — reaction-test's points score is
   `target - avg`, strictly less than any raw ms target, so a real win
   would run `SettleSession` successfully (no error) but transfer **zero**
   tokens. Caught by decoding `preTokenBalances`/`postTokenBalances` on a
   "successful" settle tx and seeing no delta. Fixed with a small
   `onChainTargetScore(gameID, targetScore)` helper: since `settle()` only
   ever calls the on-chain path for sessions the off-chain replay worker
   already declared `won=true` (`processPending`'s `r.won = TRUE` filter),
   the on-chain check is defense-in-depth, not a fresh decision — it just
   needs both numbers on the same scale. reaction-test's points win
   threshold is always 0, so that's what goes on-chain instead of the
   display value. `sliding-puzzle` has the same inverted-scale
   `target_score` column but no bot yet and has never reached settlement;
   flagged in the helper's comment rather than guessed at, so it gets the
   same fix before it's ever wired up.

Also rebuilt the Go backend from current source (the standing instance
predated both fixes above and today's other settlement/win-logic work) and
freed 7.2G of `/tmp` tmpfs that a stray, unrelated `solana-test-validator`
process (leftover from earlier localnet work, holding a full ledger dir) was
using — it was blocking the Go linker (`no space left on device`) and had
nothing to do with the devnet task, so it was stopped and its ledger
deleted. Topped up the player wallet (deploy-wallet SOL transfer + test USDC
mint — the deploy wallet is the mint authority) after burning through the
starting balance on unsupported-game spins across three earlier runs; the
public devnet SOL faucet was rate-limited so used a direct transfer from the
already-funded deploy wallet instead.

**Remaining from this pass:** the `leaderboard_daily`/`leaderboard_weekly`
materialized views still fail to create under Postgres 18
(`round(double precision, integer)` needs a `::numeric` cast in
`scripts/init-db.sql`) — not hit during this run since the 5-minute refresh
loop didn't fire against real data mid-session, still off the money-loop
path, still unfixed. `sliding-puzzle` needs the same on-chain-target-score
treatment as reaction-test before it's ever given a bot.

---

## Post-demo cleanup (2026-07-07, fifth pass)

Three follow-ups after the Stage-2 payout, all verified:

1. **`sliding-puzzle` on-chain target scale — fixed.** `onChainTargetScore`
   ([backend/internal/settlement/service.go](../backend/internal/settlement/service.go))
   now handles `sliding-puzzle` alongside `reaction-test` (both inverted,
   lower-is-better `target_score` columns), so it settles correctly whenever
   it's given a bot. Go build + tests pass, games suite stays 116/116, backend
   rebuilt from source and restarted.
2. **Postgres-18 leaderboard views — fixed.** `scripts/init-db.sql`'s five
   `leaderboard_*` matviews used `ROUND(<float8>, 2)`, which PG18 rejects
   (`round(double precision, integer)` doesn't exist). Changed the `::FLOAT`
   cast to `::NUMERIC`; created the views in the running dev db and confirmed
   `refresh_leaderboards()` runs clean — the backend's periodic refresh no
   longer spams `relation "leaderboard_daily" does not exist`.
3. **Frontend `buy_ticket` was already IDL-driven** — stubbed-item 5 / step
   4.3 below are **stale**. `frontend/src/lib/solana.ts` already builds the
   instruction via `program.methods.buyTicket(...).accountsStrict(...)` from
   the committed IDL (`frontend/src/idl/gamee.json`, byte-for-byte equal to
   `contracts/target/idl/gamee.json`), same 12-account list as the working
   e2e script. Frontend `tsc --noEmit` is clean. What remains is only a live
   Phantom click against the deployed program (can't be done headlessly).

Next substantive milestone is unchanged: **Switchboard VRF (item 4.2)**.

---

## VRF hardening — on-chain SlotHashes entropy (2026-07-07, sixth pass)

Replaced the predictable per-spin seed with real on-chain entropy, behind a
pluggable seam so the eventual Switchboard swap is a one-file change.

- **New `RandomnessProvider` interface**
  ([backend/internal/gamesession/randomness.go](../backend/internal/gamesession/randomness.go)):
  `slotHashProvider` (default) reads the newest `(slot, blockhash)` pair from
  the **SlotHashes sysvar** (`SysvarS1otHashes111…`, verified on devnet at
  20488 bytes = 8-byte count + 512×40-byte entries) and derives
  `seed = "vrf_" + sha256(ticketID : slot : blockhash)[:16]`. That blockhash is
  unknown when the player buys the ticket, so the old grinding/prediction
  vector on `SHA-256(ticketID + MAX(slot))` is gone. `deterministicProvider`
  (legacy hash) stays as the fallback and as `VRF_MODE=deterministic` for
  offline/tests; a nil Solana client also forces it. Selected by `VRF_MODE`
  (config default `slothash`), wired in `main.go` with the existing
  `solClient`. The seed is still recorded on-chain by `commit_spin`, so the
  source is publicly auditable.
- **Trust boundary (honest):** this removes *player* predictability, not
  *verifier* trust — the backend still co-signs whatever it reads, and a
  block-producer has marginal influence over one slot's hash. Switchboard
  On-Demand (item 4.2) is what removes verifier trust; `slotHashProvider` is
  the drop-in seam for it.
- **Verified:** `go build`/`go vet`/`go test ./...` green (7 pkgs), new unit
  tests for the sysvar parser + provider selection
  ([randomness_test.go](../backend/internal/gamesession/randomness_test.go)),
  and a full **devnet e2e re-run settled a real payout with zero fallback
  warnings** (slothash path exercised live): aim-master lvl 9, won,
  [`5iXKtpg…7dbdQ`](https://explorer.solana.com/tx/5iXKtpgfBioJr3psxqZzQhddFm3mWQaTAnoTQDf3UzCZdJANvB8ZD8LfdcAgnC2BcSZziQEZcRHYof68eej7dbdQ?cluster=devnet),
  player +1.2692 USDC, vault 1.336 → 0.0668. `/spin` gained ~0.4s for the
  sysvar RPC read.

---

## Jackpot tiers — increment 1 (2026-07-07)

First slice of the multi-tier jackpot system from `scripts/economy-sim/simulate.ts`'s
qualification ladder (small/medium/mega/legend, entry thresholds 0/1/3/10 prior
small-tier wins). This increment makes the money path **tier-parametric** without
changing any real behavior — everything still defaults to `small`, since the
frontend/e2e only ever fund the small vault today. Full multi-tier UX (tier
selection at buy, per-tier odds) is deliberately out of scope here.

- **Schema:** `tickets.tier` and `game_sessions.tier`
  (`VARCHAR(20) NOT NULL DEFAULT 'small'`, `CHECK (tier IN ('small','medium','mega','legend'))`)
  added via the idempotent `ADD COLUMN IF NOT EXISTS` pattern in
  `scripts/init-db.sql`, applied to the running dev DB and verified with `\d`.
- **Qualification helper:** new `backend/internal/jackpot/tiers.go` — tier
  constants, `Tiers` (ascending order), `EntryThreshold(tier) int`, and
  `MaxQualifiedTier(smallWins int) string`. Pure functions, no DB access.
  Table-driven tests in `tiers_test.go`. Nothing calls `MaxQualifiedTier` yet —
  qualification enforcement (checking a player's small-win count before
  letting them fund a higher vault) is a later increment; this just lands the
  reusable logic ahead of it.
- **Ticket confirm** (`backend/internal/ticket/service.go`): `verifyAndConfirm`
  now inserts `tier = jackpot.TierSmall` on every ticket. `models.Ticket`
  gained a `Tier` field; the by-tx and by-wallet ticket queries select it too.
- **Spin** (`backend/internal/gamesession/service.go`): `HandleSpin`'s atomic
  ticket-claim `UPDATE ... RETURNING tier` reads the ticket's tier in the same
  statement (no race window, no extra round trip) and writes it onto the new
  `game_sessions` row.
- **Settlement** (`backend/internal/settlement/service.go`): `PendingSession`
  gained a `Tier` field (populated by `processPending`'s query, which now
  joins in `gs.tier`); a `jackpotTier()` helper falls back to
  `defaultJackpotTier` only if a session's tier is empty (shouldn't happen —
  the column is `NOT NULL DEFAULT 'small'` — but keeps a bogus empty-string
  vault PDA from ever being derived). `estimatePayout` and the
  `[b"jackpot", tier]` vault PDA derivation in `submitSettleTransaction` both
  now read the session's own tier instead of the hardcoded constant.

**Design note / known gap (flagging, not fixing here):** the on-chain contract
does **not** enforce qualification — `buy_ticket` routes the jackpot cut to
whatever vault PDA the caller passes, and nothing checks the buyer has the
required small-tier wins first. A determined buyer could hand-construct a
transaction funding the medium/mega/legend vault today without ever having
qualified. This is harmless right now only because nothing in the real app
(frontend, e2e script) ever funds anything but the small vault — the gate is
currently a client-side omission, not a contract-level one. Real enforcement
(deriving tier from the buy tx + an on-chain or backend-side qualification
check before accepting it) is exactly the "don't derive tier from the buy
tx yet" boundary this increment was scoped to stop at, and should land
together with frontend tier selection in the next increment.

**Verified:** `go build ./...`, `go vet ./...`, `go test ./...` green (8 pkgs
now, up from 7 — the new `jackpot` package tests). Backend rebuilt and
restarted cleanly against the real `.env` (devMode=false). Ran
`contracts/scripts/e2e-devnet.ts` against devnet end to end: reaction-test
win, real `settle_session` payout
([`3E5N3M3…rb9nKoA`](https://explorer.solana.com/tx/3E5N3M37mk9aiKxE8fojhkr9uQNNmMreTGj8J7hDfhBJLbptdBgT1dfowHPHrHhhX1711fzdFUv891etqrb9nKoA?cluster=devnet)),
jackpot vault 866800 → 43340 micro-USDC, player USDC 14533200 → 15356660
(+823460 micro-USDC, ~0.823 USDC). DB spot-check after the run: the new
`game_sessions` row and its ticket both show `tier='small'`, confirming the
plumbing routes through the column rather than a hardcoded value while still
settling the same small vault as before.

---

## Jackpot tiers — increment 2 (2026-07-07)

Second slice: enforce tier selection securely at ticket-confirm, and prove a
real non-small-tier payout. **DONE and proven end-to-end.** The backend half
plus a real, previously-undocumented contract bug (`buy_ticket` hard-pinned
`jackpot_usdc_account` to the small vault via `address = platform_config.
jackpot_vault_token_account`, so any non-small tier failed on-chain with
`ConstraintAddress`/`InvalidDestinationAccount`). Fixed by removing that pin
and relying on the pre-existing `jackpot_vault.vault_token_account ==
jackpot_usdc_account.key()` constraint (which correctly ties the destination
to whichever tier PDA is passed — funds still can't be redirected to an
arbitrary account). `anchor test` 15/15, IDL resynced.

**Devnet upgrade deployed + medium-tier payout proven (2026-07-07):** the fix
was deployed as an in-place program upgrade (same id `9ZjYdP…`, slot
474636974, buffer rent refunded). A `TIER=medium` e2e then settled a real
medium-tier win: minefield lvl 10, score 32, payout tx
[`4GC1gT5…hXQXp`](https://explorer.solana.com/tx/4GC1gT5fiUfYsUhwMbynpPsEksC5Pu2yZfg8xkCn2oBzo8VcbnbZexe7SdmCXYxsfwwAod3E9sBVyigH1JxhXQXp?cluster=devnet)
— **medium** jackpot vault `8HADt2Nn…` 7.2 → 0.36 USDC (95% out, 5% reseed),
player +6.84 USDC, confirmed on-chain.

**All four tiers now proven end-to-end on devnet (2026-07-07).** After medium,
the same `TIER=<t>` e2e path settled real payouts from each tier's own vault
(qualification enforced at confirm — the player accumulated the required
small-tier wins, 3 for mega and 10 for legend, before each was allowed):
- **mega** — reaction-test, vault `byBfwzY…` 0.8 → 0.04 USDC, player +0.76, tx `2TVztSf…dkMoF`
- **legend** — simon-pro, vault `5ssTn97j…` 7.24 → 0.362 USDC, player +6.878, tx `3MhKNcm…xvLsLsd`

DB confirms won+paid sessions per tier: small, medium, mega, legend.

Note on reproducing: the e2e's bots only cover 4/10 games (~32% of wheel
weight), so a run can strike out on unsupported spins; the proofs above
temporarily set the 6 non-bot games' `wheel_weight` to 0 in the dev DB then
restored it (total back to 50; `selectGame` reads weights live per spin). That
skew was fragile (a race once left non-bot games selectable) — **the follow-up
widens e2e bot coverage to all 10 games so the skew is no longer needed.**

**Ticket confirm is now the tier security boundary**
(`backend/internal/ticket/service.go`). `ConfirmRequest` gained an optional
`tier` field (default `"small"`, unchanged behavior for every existing
caller). `verifyAndConfirm` now:
1. Rejects unknown tiers outright (`jackpot.IsValidTier`, new).
2. **Anti-spoof:** resolves the claimed tier's real on-chain vault token
   account (`resolveVaultTokenAccount` — derives `[b"jackpot", tier]`,
   fetches the account, decodes it via the existing
   `pkgsolana.DeserializeJackpotVault`, caches per tier for the life of the
   process) and confirms *this exact transaction* credited it, by matching
   the vault token account's address against the parsed tx's account keys
   and reading its `accountIndex`-matched pre/postTokenBalances delta
   (`tokenAccountDelta`, pure function). A tx that funded a different tier's
   vault (or funded nothing) is rejected regardless of what tier the caller
   claims.
3. **Qualification:** counts the wallet's prior won small-tier sessions
   (`countSmallWins` — joins `game_sessions` through `tickets`, since
   `game_sessions` has no wallet column) and requires
   `smallWins >= jackpot.EntryThreshold(tier)` (`checkQualified`, pure
   function, unit tested). A wallet with 0 small wins claiming `medium` is
   rejected with a clear error.
4. Stores the validated tier on the ticket — replacing increment 1's
   hardcoded `jackpot.TierSmall`. Session inherits it unchanged (increment
   1's `HandleSpin` plumbing).

New tests: `internal/jackpot/tiers_test.go` gained `TestIsValidTier`;
new `internal/ticket/service_test.go` covers `checkQualified` (all four
tier boundaries, including the required "medium rejected at 0 wins"
negative case) and `tokenAccountDelta` (positive delta detected, absent
account, uncredited account, and — the actual anti-spoof property — that
one account's credit doesn't leak into another account's reported delta).
`go build ./...`, `go vet ./...`, `go test ./...` green, **9 packages now**
(up from 8 — new `ticket` package tests). Backend rebuilt and restarted;
`/health` ok, `devMode=false`.

**e2e script made tier-driven** (`contracts/scripts/e2e-devnet.ts`): new
`TIER` env var (default `"small"`, so existing invocations are unchanged).
Derives `[b"jackpot", TIER]`, fetches the live `JackpotVault` account via
Anchor to read its real `vaultTokenAccount` (same source the backend
resolves — no hardcoded per-tier constant), uses it for `buy_ticket`'s
`jackpotUsdcAccount`/`jackpotVault` accounts and for its own
before/after balance reads, and sends `tier` to `/tickets/confirm`.

**Small-tier re-run (no regression) — proven, independently confirmed:**
tx [`3epde9V…sjHzG`](https://explorer.solana.com/tx/3epde9VnLVYxk7GZrGj6cBsftjRPqkmVBE2MpH6VLfJ9o2RmwuD97w32kDCHTZYbBaVQHBVU6bMrNGkPqQQsjHzG?cluster=devnet)
(reaction-test win). `getTransaction` read directly via RPC (not just the
script's prints) confirms: small vault
(`A8TtqDt4AwM8svUFguTmGBiXfy1sQ6dS8iHAEMKPR8ho`'s token account
`BdVb8vp…Da2M`) 843340 → 42167 micro-USDC, player
`D8CbDsX…dhi2H` 14356660 → 15157833 (+801173, ~95% of the pre-payout
vault). DB spot-check: the new ticket and session both show `tier='small'`
— and this run went through the *new* claimed-tier + anti-spoof +
qualification path (the e2e script now explicitly sends `tier: "small"`),
so it's a positive proof the new confirm logic works, not just an
unaffected old path.

**All 4 tier vaults already exist on-chain** — confirmed by deriving each
`[b"jackpot", tier]` PDA and querying it directly: small
(`A8TtqDt4…R8ho`), medium (`HwbZ8BTq…Hen4f`, vault ATA
`8HADt2Nn…gkAQd`), mega (`DukZiK8t…Ld16b`), legend
(`3uPVKBcv…SZfBW`) — all 93 bytes, all previously created by a prior
`anchor run init` (increment 1's initialize.ts already loops over all four
tiers). No init step was needed this increment.

**Real bug found, not previously documented: `buy_ticket` was never
actually tier-agnostic.** The increment 1 write-up above states "buy_ticket
routes the jackpot cut to whatever vault PDA the caller passes" — reading
the deployed contract source
(`contracts/programs/gamee/src/instructions/buy_ticket.rs`) shows that
claim was wrong. `jackpot_usdc_account` carried a hard
`address = platform_config.jackpot_vault_token_account` constraint — a
*single* pubkey fixed once at `initialize_platform` time (the small vault's
ATA, per `initialize.ts`). Confirmed empirically: running
`TIER=medium contracts/scripts/e2e-devnet.ts` against the then-deployed
program failed every `buy_ticket` attempt with an
`InvalidDestinationAccount`/`ConstraintAddress` Anchor error. So today
(before the fix below is deployed), buy_ticket can only ever fund the small
vault — there was no way to reach a real medium-tier payout without a
contract change, contrary to this increment's brief.

**Fix prepared and locally verified, not yet deployed to devnet.** Removed
the fixed-address constraint on `jackpot_usdc_account`, keeping only
`token::mint = usdc_mint` for type safety. Security is preserved by the
*already-present* `jackpot_vault` account constraint
(`jackpot_vault.vault_token_account == jackpot_usdc_account.key()`) —
`jackpot_vault`'s own `seeds` are derived from its own stored `tier` field,
so it must be a real, previously admin-initialized `JackpotVault` (a forged
or uninitialized account can't deserialize into that type), and its
recorded token account must equal what was passed. Net effect: a caller can
route the 80% cut to any of the four real admin-created tier vaults, never
an arbitrary account — exactly the intended tier-agnostic design, with no
weaker guarantee than before (the existing "rejects redirected destination
accounts" test, which swaps in the buyer's own USDC account, still fails
as expected — now caught by the vault-key equality check instead of the
fixed address). Verified: `cargo check` clean, `anchor test` **15/15
passing** on localnet (no regressions), IDL/types regenerated and resynced
byte-for-byte to `frontend/src/idl/gamee.{json,ts}` (frontend
`tsc --noEmit` still clean).

**Blocked: devnet redeploy needs explicit approval.** `platform_config`'s
admin/upgrade authority is the deploy wallet (`~/.config/solana/id.json` /
`H3WCWhmLQDRFaX4x1zhgpUSABvX5Q6YVC6ABwxpCGMM1`, confirmed via
`solana program show`, 1.49 SOL balance — plenty for the upgrade), so the
deploy itself is mechanically ready (`solana program deploy
target/deploy/gamee.so --program-id target/deploy/gamee-keypair.json`,
same program ID, in-place upgrade). The harness's auto-mode permission
classifier denied the `solana program deploy` command as a sensitive
infrastructure action requiring explicit user sign-off before this session
could run it. **Until that upgrade ships, `TIER=medium|mega|legend`
against devnet will keep failing on-chain** with the pre-existing
`ConstraintAddress` error — only `small` settles today, unchanged from
increment 1. Once approved and deployed, the medium-tier proof is a single
`TIER=medium contracts/scripts/e2e-devnet.ts` run away (this wallet already
has 6 confirmed small-tier wins in the dev DB, well above the medium
threshold of 1) — no further code changes needed on either side.

---

## Stage 2 + Stage 3 closed out (2026-07-10, seventh pass)

Both remaining substantive milestones — **Switchboard On-Demand VRF** (Stage 2
item 4.2) and the **threshold verifier multisig** (Stage 3's "verifier is a
single hot key" item) — are implemented, deployed to devnet, and proven
end-to-end in one live run.

**On-chain verifier set (threshold multisig).** New `VerifierSet` singleton
PDA (`[b"verifier_set"]`, `state/verifier_set.rs`): up to 5 member pubkeys +
a threshold, admin-managed via new `init_verifier_set`/`update_verifier_set`
instructions (invariants: 1 ≤ threshold ≤ len ≤ 5, no duplicates).
`settle_session` now requires **threshold distinct member signatures** —
`verifier` (fee payer) plus co-signers passed as `remaining_accounts`; the
handler counts distinct members among actual signers, so non-members and
duplicate signatures can't pad quorum. `commit_spin` requires 1-of-N
membership (no funds move there). Also closed the deliberately-deferred
reseed hole: `settle_session` gained a `next_jackpot_vault` account tying
`next_jackpot_usdc_account` to a real admin-initialized tier vault — a
compromised verifier can no longer redirect the 5% reseed to an arbitrary
account. `anchor test`: **27/27 passing** (12 new tests: verifier-set
management validation, quorum met/not-met, non-member padding, duplicate
signature, unconstrained-reseed rejection). IDL resynced byte-for-byte to
`frontend/src/idl/`.

**Backend multi-signer settlement.** `VERIFIER_COSIGNER_KEYPAIRS`
(comma-separated keypair paths; `config.go`) → `settlement.Service` loads and
caches them (`loadCosignerKeypairs`, same fail-loud keypair validation as the
primary) and appends them as signers + remaining_accounts in
`submitSettleTransaction` (13-account list cross-checked against the new
struct order). Devnet runs 2-of-2: `verifier-devnet.json` +
`verifier-cosigner-devnet.json` (both in gitignored `backend/keys/`).

**Switchboard On-Demand VRF (removes verifier trust in the seed).** New
`switchboardProvider` (`gamesession/switchboard.go`, `VRF_MODE=switchboard`)
shells out per-spin to `contracts/scripts/vrf-switchboard.ts` (pinned
`@switchboard-xyz/on-demand@3.10.4`): creates a randomness account on the
devnet queue, commits, waits for the SGX-enclave oracle reveal, and returns
the revealed 32 bytes; seed = `vrf_` + sha256(ticketID:randomness)[:16].
Falls back to slothash (then deterministic) on any error/timeout
(`VRF_TIMEOUT_SECONDS`, default 20 — devnet runs 90; observed helper latency
~15s/spin, which is the cost of real commit-reveal randomness on /spin).

**Deployed + proven live on devnet (2026-07-10).** Program upgraded in-place
(slot 475283335; needed `solana program extend +60000` — the binary outgrew
the old allocation) and `verifier_set` initialized: members `7xUnW75Y…`
(existing verifier) + `8EXkqrmy…` (new cosigner), **threshold 2**. Full e2e
then settled a real payout through both new systems at once — aim-master
lvl 7, won, payout tx
[`5NNhyGCC…dPPdwh`](https://explorer.solana.com/tx/5NNhyGCCkteoFvV6W6DfWtMh2NXa1hvnmFppUfqN4dxjdqQqyMELYdXp67EsCNFqBAXxTprxLuE6n6THb6dPPdwh?cluster=devnet):
small vault 802311 → 40116 micro-USDC, player +762195. Independently
confirmed via raw `getTransaction`: **exactly 2 signatures, both verifier-set
members**, correct token deltas. The spin's seed came from a live oracle
reveal (backend log: `switchboard randomness ok … reveal_tx=kvK6GVnY…`,
zero fallback warnings).

Environment/bug notes from this pass:
- **Fixed: wallet-length validation rejected valid pubkeys.** Auth's
  `len=44` binding (plus a duplicate hand-rolled check in `HandleNonce`)
  405'd any wallet whose base58 form is shorter than 44 chars — base58
  32-byte keys are 32–44 chars (leading zero bytes shorten them). The new
  e2e player wallet happened to be 43 chars and couldn't even get a nonce.
  Now `min=32,max=44`; the real check remains the ed25519 decode at verify.
- e2e script updated for the new `verifier_set` account in `commit_spin`.
- Local dev services: Postgres runs user-level from `~/.gamee-dev/pg`
  (**port 5433**, `pg_ctl -D ~/.gamee-dev/pg start`), Redis on **6390**
  (`~/.local/bin/redis-server --port 6390`). The dev DB was recreated fresh
  on 2026-07-08 (prior session history rows are gone; schema + games seed
  intact). Durable devnet player wallet now at
  `backend/keys/player-devnet.json` (`FSBuXa9H…`) — earlier one lived in a
  wiped tmpfs scratchpad.

**What this still isn't:** the backend still *runs* both cosigner keys on one
host, so operationally it's one box holding two keys — the on-chain quorum
machinery is what mainnet needs to split those keys across isolated signers
(second box / HSM / different operator). That split, plus the red-team week
and the Stage-5 audit booking, are the remaining pre-mainnet security items.

---

## Games hardening pass — invariant harness + real bugs fixed (2026-07-11, eighth pass)

Built `games/scripts/invariant-check.js`, a cross-game fuzz/invariant harness
that drives every compiled game through the replay verifier's own `GameLoop`
and asserts the properties the money path depends on: termination within the
verifier's frame budget, **no zero-input wins**, `finalScore() ===
getState().score` (the reaction-test settlement-bug class), replay
determinism, garbage-input safety (NaN/±Infinity/strings/objects in every
field, non-monotonic and absurd frame numbers), and out-of-range difficulty
levels. **750 invariant groups, all passing** — after fixing what it caught:

1. **block-merge could never pay a win** (latent reaction-test class):
   `finalScore()` returned the highest tile while `getState().score` was the
   cumulative merge score — client/verifier scores could never match. Worse,
   the win check used the *cumulative* score against tile-scale targets
   (512/1024/2048), so "wins" triggered far too early. Everything now lives
   on the tile scale (win = build the target tile, like 2048); the cumulative
   score survives as `display.mergeScore`. Go's display formula already used
   the tile scale — no backend change needed.
2. **helix-drop was never a functioning game**: (a) zero-input runs *won* ~32%
   of the time at level 1 (the ball rained through platforms, "landing" was a
   free pass-through), and (b) an off-screen check ended the game at y≈700
   while towers extend to platformCount×60 — any target above ~11 platforms
   was mathematically unwinnable (i.e. every production-level session).
   Rebuilt on the genre-standard skill model: the ball **rests** on solid
   platform; the player rotates the gap under it (falling through IS the
   pass); a seeded hazard zone adjacent to the gap kills if swept under the
   ball first; platform layouts are spawn-safe (neither gap nor hazard under
   the ball at rotation 0), so **zero-input runs can never score** — they
   idle out as a loss at MAX_FRAMES. Renderer updated (camera scroll for tall
   towers + red hazard arcs), playground hint updated, tests rewritten.
3. **minefield's mine placement looped forever** at out-of-range difficulty
   levels (unclamped level extrapolated mine% past 100%, placement could
   never find a free tile) — this was hanging the whole harness. Level is
   clamped to 1..10 and mineCount capped at tiles−1 (both also after
   explicit param overrides).
4. **minefield + sliding-puzzle crashed on malformed input**: range guards
   like `x < 0 || x >= size` pass NaN/strings/booleans/fractions (every
   comparison is false), then `grid[NaN]` / `grid[y][0.5]` threw — and in
   sliding-puzzle junk could corrupt `emptyX/emptyY` before crashing. Both
   now require `Number.isInteger`. (Verifier fails closed on crash, so this
   wasn't exploitable — but a stray fractional client coordinate could kill
   a legitimate session.)
5. **Idle sessions never terminated** in the four input-driven games
   (block-merge declared MAX_FRAMES but never enforced it; minefield,
   simon-pro, sliding-puzzle had no cap at all). All four now end as a loss
   at 36000 frames, matching wing-rush/perfect-stack.

Games suite is now **118 tests** (was 116), all passing; `npx tsc` clean.
Economy note: block-merge wins got strictly harder (real tile targets) and
helix-drop went from unwinnable-or-luck to real skill — the live difficulty
governor will re-tune `base_difficulty` from observed win rates; no manual
retune needed before devnet play.

---

## e2e bots for all 10 games + four real bugs found (2026-07-17, ninth pass)

Closed the standing follow-up from increment 2: **the devnet e2e now has a
winning bot for every game** (was 4/10, which forced fragile wheel-weight
skewing to prove payouts). Bots moved to a shared module
(`contracts/scripts/e2e-bots.ts`, imported by `e2e-devnet.ts`) with per-bot
input pacing that stays inside the anti-cheat envelope, plus an offline
coverage harness (`contracts/scripts/bots-offline-check.ts`, `npx ts-node`
from `contracts/`) that runs every bot against the same compiled game
modules the replay verifier loads and asserts: win rate at production base
difficulty AND at the hardened (+3) level, replay determinism of the
produced input log, `finalScore() === getState().score`, and that the log's
timing passes a mirror of the analyzer's rules. Result: **8–10/10 wins at
base difficulty for all ten games** (hardened is weaker for
wing-rush/perfect-stack/sliding-puzzle — poll-granularity physics, accepted).
New bots: wing-rush (empirically tuned flap controller — fancier MPC scored
worse, same lesson as the bot-check script), dino-sprint (ascent-window
jump), perfect-stack (adaptive alignment tolerance budgeted across remaining
locks), helix-drop (gap-first direction planning + a falling controller that
steers the landing angle out of the hazard), block-merge (depth-2
adversarial-spawn search with a snake heuristic), sliding-puzzle
(constructive ring reduction + IDA* 3×3 finish).

Writing bots that *should* win exposed that four things made winning
impossible — all real product bugs, all fixed and verified:

1. **block-merge was provably unwinnable at every level** (value
   conservation): each move spawns one tile worth ≤4, so after m moves the
   board holds ≤ 4·(startTiles+m) total value — the 120/220/350 budgets
   capped total value at 488/892/1416, strictly below the 512/1024/2048
   targets. No player could ever have won since the tile-scale fix. Budgets
   are now 330/650/1300 (~1.4× the expected-spawn floor of target/2.2;
   1.24× still ran a strong search bot out of moves half the time).
2. **sliding-puzzle generated unsolvable 4×4 boards — always.** The game's
   `isSolvable` used the inverted parity rule for even grid widths
   (required inversions+blank-row sum EVEN; the solved state itself has sum
   1). Legally-shuffled boards (always solvable, sum odd) "failed" the
   check, so the repair path swapped two adjacent tiles and made every
   generated 4×4 genuinely unsolvable — production base difficulty 7 is a
   4×4, so the game was unwinnable in production. Caught by BFS-proving a
   ring-reduced 3×3 subgrid unreachable.
3. **helix-drop had forced-death platforms.** The landing window after a
   pass is rotationSpeed × (spacing/dropSpeed) = 60° at every level (the
   knobs cancel), but hazardWidth scaled to 90° — a hazard covering the
   whole window is a death no input sequence avoids (~5% of platforms at
   level 8, compounding to a ~6% win-probability ceiling for PERFECT play
   at the production base). hazardWidth now caps at 50°.
4. **Anti-cheat's `frame_perfect_inputs` flagged every session of every
   wallet** (`backend/internal/anticheat/analyzer.go`): it checked
   frame-derived intervals (`frameDiff × 16.667`) against the 16.667ms
   grid — vacuously true 100% of the time, human or bot. Every session got
   botScore +0.2 → "flag", silently walking every wallet up the escalation
   ladder into hardened (+3) difficulty (the e2e wallet had accrued 4 such
   flags and was being served max-difficulty sessions). The rule now checks
   the client's **wall-clock** `time` field against the frame grid — which
   is what actually distinguishes a fabricated log (`time = frame×16.667`)
   from a real client's Date.now() stamps. `InputEvent.Time` became
   `float64` (the old `time.Duration` decoded JSON ms as ns, and would have
   rejected fractional timestamps outright). The pre-existing
   `TestAnalyzeInputTiming_CompositeFlagFallback` had *encoded* the broken
   behavior as expected; rewritten, plus a positive/negative test pair for
   the fixed rule. Bogus `frame_perfect_inputs` rows deleted from the dev DB.

**Verified:** games suite 122/122 + invariant harness 750 groups all green
after the three game fixes; `go build/vet/test ./...` green (analyzer tests
updated); frontend gamesdk copy refreshed, `tsc --noEmit` clean. Live
devnet: two full-loop settlements after the changes — simon-pro win
(`3uT3smPZ…b6Jq6j`, +12.20 USDC) and, after the anti-cheat fix removed the
wallet's bogus hardening, a **perfect-stack** (new bot) win at real level 6:
[`2PWHMXYu…riHMfd`](https://explorer.solana.com/tx/2PWHMXYu6fe5hbH99DU8jfcFYwSfA5emAQ3nVNSQQAwGhhvFLepwu49X486aa1dCcLggBe7YzNuGMdWvKCriHMfd?cluster=devnet),
small vault 3.042 → 0.152 USDC, player +2.89 USDC, plus a verified
wing-rush loss (loss pipeline exercised too).

Economy note: the three game fixes turn two never-winnable games into
winnable ones and soften helix-drop's top end — observed win rates will
rise and the difficulty governor will re-tune `base_difficulty` live; no
manual retune needed. The wheel-weight skew workaround in the tier proofs
above is now obsolete.

---

## What's actually done (cumulative, across all sessions)

**Contract correctness & security** — fee split fixed to the real 80/10/5/5 (jackpot/platform/referral/dev), `buy_ticket` validates every destination account + enforces the exact ticket price on-chain, `pay_jackpot` requires the verifier authority (was drainable by anyone), `commit_spin` requires verifier co-signature (players couldn't pick their own game), `initialize_jackpot` added (vault PDAs previously had no creation path), jackpot accounting reads the real post-payout token balance instead of underflowing on first win. Contract now compiles and builds to SBF; three separate compile bugs were fixed along the way (unqualified `Context<>` types, a borrow-check ordering issue, and boxing the 12-account `buy_ticket` struct that overflowed the 4KB SBF stack frame).

**Backend correctness & security** — real ed25519 signature verification (was hardcoded to always return `true`), single-use nonces with TTL, WS input protocol fixed (envelope `action` vs. game-specific `input_type`, previously collided), ticket confirmation does real Solana RPC verification (tx succeeded, called our program, **signed by the claiming wallet**, USDC delta matches — previously anyone could credit anyone else's tx to themselves), ticket PDA is now **derived on-chain-correctly** from the nonce in the instruction data (byte-for-byte verified against `@solana/web3.js` via a golden test — the base58 decoder, curve-membership test, and PDA hash preimage all had real bugs, now fixed), missing replay sim fails closed to `unverified` rather than trusting the client score, settlement worker polls `replays` for `match` verdicts and marks sessions won (dev-mode off-chain; on-chain path is stubbed pending a deployed program + verifier key), behavioral anti-cheat (input-timing analysis) is wired into the verification pipeline and flags/rejects bot-like input patterns.

**Runtime-fatal DB bugs fixed** — session IDs are real UUIDs now (were string-cast, so `game_sessions` rows silently never persisted), `replays.valid_verdict` CHECK constraint expanded to allow `pending/unverified/timeout/rejected` (every non-`match` write was failing and infinitely re-queuing), settlement's query was joining to a nonexistent `game_sessions.wallet` column (fixed to join through `tickets`), anti-cheat was inserting `cheat_flags` with an empty wallet (NOT NULL FK violation).

**Docker/CI** — the backend Dockerfile referenced `backend/verifier` and `backend/keys` directories that **never existed**, and the build context (`./backend`) couldn't even see `games/` — meaning the replay verifier could never be bundled into any deployed backend image, so anti-cheat would silently never function outside local dev. Fixed: Dockerfile now has a `games-builder` stage that compiles the games SDK and bundles `dist/` + `sdk/run.js` + deps into the final image; `docker-compose.yml` and CI's image-build step now use the repo root as build context. Also removed the now-orphaned `games/Dockerfile.worker` and the CI step publishing an unused `replay-worker` image (verification runs in-process in the backend, not as a separate service). `Anchor.toml` had `cluster = "devnet"` as its default — meaning `anchor test` was never going to spin up a local validator, it'd try to hit real Solana devnet and need a funded real wallet. Fixed to `localnet`. CI's Anchor job was silently no-op'd (`continue-on-error: true` on everything, plus a `--skip-deploy` flag that would break tests on a fresh validator with nothing deployed) — split into its own job (`anchor-test`) so it doesn't block the Go/Games tests, fixed the `--skip-deploy` bug, added wallet keypair generation and dependency install steps. Also fixed a Go test env var mismatch (`DB_URL` vs. the `DATABASE_URL` config.go actually reads) that meant the Go test suite's Postgres connection string was silently defaulting.

**Games & playground** — 10 games total (Wing Rush, Dino Sprint, Reaction Test, Aim Master, Perfect Stack, Helix Drop, Block Merge, Simon Pro, Minefield, Sliding Puzzle), all deterministic, all replay-verifiable, 116 unit tests. Added `games/playground` (Vite, `npm run playground --prefix games`, port 5183) — loads the real game + renderer modules directly in-browser with no wallet/backend, for fast playtesting during development. Verified interactively (flap/collision in Wing Rush, grid clicks in Minefield, arrow-key merges in Block Merge all drive the real sim correctly).

**Win decision, difficulty & economy (2026-07-07)** — the win pipeline previously compared raw replay scores against a generic `target_score = 100 + level*50` (250 for every session), which was nonsense across per-game score scales (simon-pro tops out ~20 → unwinnable; block-merge's minimum win is 512 → auto-win; sliding-puzzle and reaction-test are lower-is-better). Now the sim's own `won` flag — each game's internal win rules — flows through the replay verifier (`games/sdk/verifier.ts` → `run.js` → `replays.won`) and settlement pays on `r.won = TRUE`. Along the way, two more real bugs: **run.js could never load any game module** (`default || first-export` grabbed a tuning constant — every real verification would have failed closed as "unverified", so no win could ever be paid; now it selects the export implementing the game interface, verified against all 10 compiled games) and **losing sessions stayed `pending` forever** (nothing ever wrote `result='lost'`; the verification worker now does). Difficulty is now per-game: session level comes from `games.base_difficulty` (raised across the board, e.g. wing-rush 4→6, minefield 7→8 — see init-db.sql for the rationale comment), clamped to `[min,max]`, `+3` for anti-cheat-hardened wallets; `game_sessions.target_score` is display-only (formulas mirrored in Go, authority is the sim). A **closed-loop difficulty governor** (`backend/internal/difficulty`, hourly) nudges `base_difficulty` one step at a time from observed verified win rates to hold the global rate in **1/1300..1/2600 wins/play**, which is what makes the average jackpot land in the target **1,000-2,000 USDC** (avg win ≈ 0.95 × 0.80 × plays-per-win). Economy sim retuned to the same band and re-run: **avg small-tier win 1,487 USDC at 1-in-1,869 plays, 0 bankruptcies over 1M plays**. Verified end-to-end at the SDK level: a scripted bot won aim-master at level 7 and the deterministic replay reproduced the win (`won:true`, exact score); an empty-input wing-rush replay produced `won:false`.

**Economy** — a Monte Carlo simulator exists at `scripts/economy-sim` (not yet run against the final 10-game set + real difficulty curves — see next steps).

**Frontend was never actually authenticated (fixed this session)** — `apiClient.setToken()` was never called from anywhere in the app. Connecting a wallet never ran the nonce→sign→verify flow, so every protected API call (tickets, spin, session finish, history) has always 401'd silently. Added `useAuthSession()` (`frontend/src/lib/useAuthSession.ts`), wired into `Providers.tsx`, which signs the challenge message on wallet connect and caches the JWT (sessionStorage, keyed to the connecting wallet). Also found and fixed: the Go API returns snake_case JSON (`games_played`, `current_amount`) while every frontend type is camelCase — nothing was reconciling this, so every underscore field rendered as `undefined` across the jackpot display, ticket history, and leaderboard. Fixed with one generic recursive transform in `api.ts`'s `request()`, rather than patching every type/model pair. The profile page also bypassed `apiClient` entirely with raw relative `fetch('/api/v1/...')` calls — no auth header, wrong base URL outside same-origin setups, no case transform; switched to `apiClient.getUserHistory()`/`getMyTickets()`.

**The result page had no real backend integration at all (fixed this session)** — it called a `GET /session/:id/result` endpoint that didn't exist, and its catch-fallback **fabricated a random win/loss client-side** (`Math.random() > 0.6 ? 'won' : 'lost'`) with a made-up payout amount. Added a real `HandleResult` endpoint (ownership-checked, reads the actual `game_sessions.result`/`final_score`/`payout_tx`) and rewired the frontend to poll it via `apiClient`, with `pending` as a real intermediate state — no fabricated fallback remains.

**The WS tick loop was racing against and silently defeating real settlement (fixed this session, most serious bug found this session)** — the WebSocket handler ran a placeholder simulation that decided win/loss itself and wrote `game_sessions.result` directly. Since the real settlement service only pays sessions still `result = 'pending'`, this fake path — which always runs synchronously before the client's later `/finish` call even lands — permanently flipped that status before the actual verified verdict was ever computed. In effect, **no legitimately verified win could ever have been paid**, because the placeholder loop always claimed the "pending" state first. Fixed: the tick loop now only sends a cosmetic preview message to the client; only the verification worker + settlement service can ever set `game_sessions.result`. This also uncovered a second bug: `HandleFinish` checked session existence via the in-memory session map, which the tick loop deletes as part of its own cleanup — a race that could 404 a legitimate finish call depending on timing, and would 404 *every* finish call after a backend restart (the map is empty on boot). Fixed by having `HandleFinish` (and the new `HandleResult`) check Postgres directly, which is also how it now verifies the caller's wallet owns the session (previously unchecked — any authenticated user could submit a fake score for someone else's session id).

**Ticket-claim race in `/spin` (fixed this session)** — `HandleSpin` read the ticket's status, then separately wrote `status = 'consumed'` — two concurrent requests for the same ticket could both pass the read before either write landed, letting one paid ticket spin twice off-chain (bounded — the on-chain ticket PDA is separately, atomically enforced by the contract, so this couldn't double-pay, but it could double-play). Fixed with a single atomic `UPDATE ... WHERE status = 'unused'`, checking `RowsAffected()`.

**Leaderboard was non-functional (fixed this session)** — three separate bugs: (1) the `leaderboard_country_*` materialized views referenced in code didn't exist anywhere in the schema, so every country-scoped request 500'd and the refresh function aborted on the first missing one, silently also preventing the base daily/weekly/monthly/alltime views from ever being refreshed by that same call; (2) the country code was interpolated directly into a `FROM %s` SQL clause — a narrow but real injection surface; (3) Redis caching called `.Set()` on a raw Go map, which isn't marshalable, so every cache write silently failed and caching never worked at all. Fixed: replaced 8 hardcoded per-country views with one parameterized `leaderboard_country` view (closing the injection surface at the architecture level, not just validating input), added the missing `wins` column the frontend expected, JSON-marshal before caching, and wired the previously-dead `RefreshMaterializedViews` into an actual periodic background loop (it existed but was never called from anywhere).

**On-chain settlement is now real (was a stub; the biggest Stage 2 gap — implemented this session)** — `submitSettleTransaction` used to build a 16-byte instruction payload (missing the 8-byte discriminator entirely) and return an error unconditionally. It's now a complete, from-scratch Solana transaction pipeline built without a Go SDK (the earlier `solana-go` dependency was removed for broken transitive deps — see prior sessions), all added under `backend/pkg/solana/`:
- `address.go` — base58 + PDA derivation (already existed, golden-tested), plus newly added Associated Token Account derivation and the well-known System/Token/Associated-Token program IDs. **The System Program ID constant was wrong when first typed from memory** (extra characters) — caught by computing `Base58Encode(32 zero bytes)` directly and asserting the constant matches, rather than trusting it; now a permanent golden test (`TestSystemProgramID_RoundTrips`).
- `keypair.go` — loads a Solana CLI keypair JSON file (ed25519 seed + stored pubkey), cross-checking the derived public key against the file so a corrupted/hand-edited key fails loudly at load time instead of producing silently-invalid signatures.
- `accounts.go` — a minimal hand-rolled deserializer for the on-chain `JackpotVault` account (need its real token account address, which isn't tracked in Postgres — only on-chain).
- `transaction.go` — legacy transaction message compilation (account deduplication/ordering into the four required signer/writable buckets, fee payer pinned first, compact-u16 shortvec encoding) and ed25519 signing.
- `client.go` — added `GetAccountData`, `SendTransaction`, `SimulateTransaction`, `GetSignatureStatuses`, `ConfirmTransaction`.

**This was verified against live Solana devnet, not just unit-tested** — `backend/pkg/solana/integration_test.go` (build-tag `integration`, excluded from normal `go test ./...` and from CI: it depends on a public faucet that's frequently rate-limited, which would make CI flaky for reasons unrelated to code correctness) builds a real signed transaction and submits it via `simulateTransaction`. Devnet's response was `AccountNotFound` — a downstream *execution* check, not a decode or signature-verification failure — which proves the message framing and ed25519 signature are byte-correct and accepted by the real Solana runtime, independent of whether the GAMEE program itself is deployed anywhere yet. Run it yourself with:
```
cd backend
go test -tags=integration ./pkg/solana/... -run TestDevnetTransferRoundTrip -v -timeout 120s
```
`submitSettleTransaction` now: loads the verifier keypair (cached after first use), derives `game_session`/`platform_config`/`jackpot_vault` PDAs, fetches the jackpot vault's real token account from on-chain, derives the winner's Associated Token Account, builds the exact 11-account `settle_session` instruction (order and mutability cross-checked line-by-line against `contracts/programs/gamee/src/instructions/settle_session.rs`), signs, sends, and polls for confirmation. **Still can't be tested end-to-end** without a deployed program — that's the next real milestone, tracked below. One simplification worth knowing: it always settles against the `"small"` jackpot tier, since nothing yet tracks which tier a given session's jackpot belongs to (the contract and schema already support multiple tiers via `initialize_jackpot`; per-session tier tracking is Stage 4 work).

---

## What's actually unverified or still stubbed

1. ~~`anchor test` has never run~~ — **resolved 2026-07-07**: passes 15/15 locally and in CI (see toolchain note above for the nightly pin that unblocked it).
2. ~~Randomness is on-chain SlotHashes entropy, not yet an oracle~~ —
   **resolved 2026-07-10 (seventh pass)**: `VRF_MODE=switchboard` runs
   Switchboard On-Demand commit-reveal randomness per spin, proven live on
   devnet with zero fallbacks. slothash remains the fallback tier. Original
   note kept below for history:
   **Randomness is on-chain SlotHashes entropy, not yet an oracle** ([backend/internal/gamesession/randomness.go](../backend/internal/gamesession/randomness.go)) — as of the sixth pass, the per-spin seed derives from the newest blockhash in the SlotHashes sysvar (`RandomnessProvider`, `VRF_MODE=slothash` default), so a player can no longer predict or grind their assigned game the way the old `SHA-256(ticketID+MAX(slot))` seed allowed. It does **not** remove trust in the verifier (the backend co-signs whatever it reads) and a block-producer has marginal influence over a single slot's hash — removing verifier trust via **Switchboard On-Demand** is still the mainnet requirement (the provider is the drop-in seam for it). The legacy deterministic seed remains as `VRF_MODE=deterministic` for offline/tests.
3. **On-chain settlement is implemented but never exercised against a deployed program** ([backend/internal/settlement/service.go](../backend/internal/settlement/service.go)) — see the write-up above. The transaction-building pipeline is verified against live devnet at the protocol level (decode + signature verification), but `submitSettleTransaction` as a whole has never run against the actual GAMEE program, since nothing is deployed yet. Always settles the `"small"` tier (no per-session tier tracking yet).
4. **Live game session tick loop is a placeholder preview only (now correctly non-authoritative)** — the backend fakes score progression for the client-facing WS stream during play instead of running the real sim server-side. This used to also decide and persist the final win/loss verdict, which conflicted with real settlement (see fixes above) — that's fixed, the loop is now cosmetic-only as intended. Still no live server-authoritative state mid-game; the replay worker remains the sole source of truth, resolved only after `/finish`.
5. **Frontend `buy_ticket` is a hand-built instruction** ([frontend/src/lib/solana.ts](../frontend/src/lib/solana.ts)) — correct-by-construction (real discriminator, 8-byte nonce, full account list) but never executed against a deployed program, and should be replaced with the generated IDL + `@coral-xyz/anchor` now that `anchor build` produces one (`target/idl/gamee.json`, `target/types/gamee.ts`) — hand-built instructions are exactly the kind of thing that silently drifts from the contract.
6. ~~`declare_id!` placeholder~~ — **resolved 2026-07-07**: real program ID `9ZjYdP5QQB6SHbQWRocLDtuxga519Z4ZQsVct1ESkJYa` (from `target/deploy/gamee-keypair.json`) is in `declare_id!`, `Anchor.toml`, and the generated IDL. **That keypair file is the upgrade authority seed — it is gitignored; back it up somewhere safe before mainnet.**
7. Auth nonce store is in-memory (single backend instance only); WebSocket origin check accepts all origins (fine for dev, needs an allowlist before public deployment).

---

## Immediate next steps (ordered)

### 1. ~~Push to GitHub and watch the first CI run~~ — done
Remote is `github.com/pratik-desgn/gamee`; CI went fully green for the first time on 2026-07-07 (run 28833497337) after fixing the anchor-test toolchain (see toolchain note) and the Lint breakage from the abandoned `rust-toolchain.toml` approach.

### 2. ~~Get the IDL, set the real program ID~~ — done
`anchor build` emits `target/idl/gamee.json` + `target/types/gamee.ts`; real id `9ZjYdP5QQB6SHbQWRocLDtuxga519Z4ZQsVct1ESkJYa` is in `declare_id!` and `Anchor.toml`. Frontend/backend still read theirs from env (`NEXT_PUBLIC_GAMEE_PROGRAM_ID` / `PROGRAM_ID`) — `anchor run init` prints the full paste-ready block.

### 3. ~~Deploy to devnet & initialize~~ — done (2026-07-07)
Program live on devnet at `9ZjYdP5QQB6SHbQWRocLDtuxga519Z4ZQsVct1ESkJYa`; `anchor run init` completed and read back verified: verifier authority `7xUnW75YiDr3dxRmsNpGiYKjRgTdLLEbbQkyzW2cMXh5` (keypair at `backend/keys/verifier-devnet.json`, gitignored, funded 0.3 SOL for settle fees), $1 ticket, 80/10/5/5 split, 10 games registered, all 4 jackpot vaults created. Test USDC mint `5mVF1G85a4h8gKXDKAKBCav54DtVVsnLCd2nXt7Q4Z1H` (deploy wallet is mint authority). Full address set written to `backend/.env` and `frontend/.env.local` (both gitignored). Deploy wallet `H3WCW…` holds the program upgrade authority — back up `contracts/target/deploy/gamee-keypair.json` and `~/.config/solana/id.json`.

### 4. Close the remaining backend gaps, in priority order
1. ~~On-chain settlement~~ — done; `submitSettleTransaction` is a real, devnet-verified transaction pipeline (see above). What's left is exercising it against an actually-deployed program (step 3).
2. ~~Switchboard VRF~~ — **done 2026-07-10 (seventh pass)**:
   `switchboardProvider` behind the same `RandomnessProvider` interface,
   proven live on devnet (see the Stage 2+3 close-out section above).
3. **Regenerate `solana.ts`'s buy_ticket from the IDL** — swap the hand-built instruction for `program.methods.buyTicket(...)`.

### 5. ~~Run the economy simulator~~ — done at the parameter level (2026-07-07)
Retuned to the 1,000-2,000 USDC average-jackpot target and re-run (1M plays: avg win 1,487 USDC, 0 bankruptcies). What no simulation can provide is the real human win rate against each game's level curve — that's what the difficulty governor handles live. Remaining tuning question for later: medium/mega/legend tiers never trigger under current entry thresholds (small-tier-only economy today).

### 6. End-to-end devnet demo (Stage 2 exit criterion)
Connect Phantom → buy ticket (devnet USDC via the program) → spin (VRF) → play a game (use the playground to rehearse first) → replay verified → `settle_session` pays the jackpot on a win. Record it working.

---

## After the MVP loop works (from the master plan)

- **Stage 3 — Anti-cheat hardening:** behavioral detection is wired in. Added this session: a manual review queue for large payouts (`backend/internal/payoutreview`, staff-only `/admin/payout-reviews` routes) and a real action ladder — `anticheat.DetermineTier` (shadow-flag → harder difficulty → ban), escalation serialized per-wallet via a Postgres advisory lock (`verification.Worker.recordAndEscalate`), enforced at ticket confirm + spin (`wallets.is_banned`, previously never written anywhere) and at difficulty selection. Also found and fixed during a red-team pass: the standalone `pay_jackpot` instruction let anyone holding the verifier key drain the *entire* jackpot vault to an arbitrary account with zero link to any actual game session (no session reference, no winner-ownership check) — unlike `settle_session`, which scopes payout to one specific already-settled, player-owned session. It wasn't called from anywhere in the real app flow, so it was removed rather than constrained. Still want a red-team week beyond this single pass, and the verifier-multisig item below remains open.
- **Stage 4 — Games & economy:** 10 games done; difficulty tuning + the economy sim run is the remaining piece.
- **Stage 0 in parallel — Legal:** the skill-vs-gambling legal opinion remains the launch gate. `landing-page/` is ready for waitlist validation.
- **Stage 5 — Audit:** book a Solana auditor (OtterSec/Neodyme/Sec3) ~2 months before intended mainnet.

## Deliberately deferred decisions
- ~~`settle_session`'s `next_jackpot_usdc_account` is verifier-trusted~~ — **closed 2026-07-10**: the reseed destination is now constrained to a real admin-initialized tier vault via the `next_jackpot_vault` account.
- ~~Verifier is a single hot key~~ — **on-chain threshold multisig landed 2026-07-10** (`VerifierSet`, 2-of-2 live on devnet). Remaining operational work: split the cosigner key onto isolated infrastructure before real money — the contract already enforces quorum.
- Referral payout accounting — the 5% pool exists on-chain; per-referrer distribution is off-chain work, Stage 4.
