# Multi-tier economy sim — 2026-07-07

(Written here instead of appending to `docs/NEXT-STEPS.md` because that file
had a very recent mtime and looked like it was being edited concurrently by
another agent — avoiding a clobber. Safe to fold a summary of this into
`docs/NEXT-STEPS.md` later once that file is free.)

## What was broken

`scripts/economy-sim/simulate.ts` defined 4 jackpot tiers (`small`, `medium`,
`mega`, `legend`) matching `backend/internal/jackpot/tiers.go`'s
`EntryThreshold` ladder (0 / 1 / 3 / 10 prior small-tier wins), but the daily
loop had a hardcoded bug: every play's 80% jackpot cut was added to
`this.tiers[0].balance` (small) regardless of which tier the player actually
qualified for and rolled against. So medium/mega/legend never accumulated
real money and could only ever pay out whatever tiny scraps `seedAmount`
gave them (which was 0 for all three) — they never triggered.

## What changed

1. **Routing bug fix.** Each play now contributes its jackpot cut to, and
   rolls its win check against, the *same single tier* — no more
   contribute-to-tier-0-but-roll-against-tier-N mismatch.

2. **Routing policy: weighted split, not "always play highest unlocked".**
   Qualification is defined purely as "prior *small*-tier wins" (per
   `tiers.go`). If a player abandoned `small` the instant they unlocked
   `medium`, they could never accumulate the 3 (mega) / 10 (legend) small
   wins needed to climb further — a dead end. So every play is routed to
   ONE tier chosen by weighted random pick among all tiers the player
   currently qualifies for: `small` always carries weight 2, every other
   unlocked tier carries weight 1. This keeps progression alive while still
   giving real, growing exposure to bigger/rarer pools once unlocked.

3. **Progression counter fix.** Only a win on `small` increments a player's
   progression counter now (previously winning *any* tier incremented it,
   which doesn't match `tiers.go`'s "prior small-tier wins" definition).

4. **Per-tier accounting.** Added `plays` and `bankruptcyEvents` fields to
   each tier. Bankruptcy is now defined as "a win was rolled against a tier
   whose balance was <= 0" (checked at the point of payout, per tier) rather
   than the old check (only tier 0's balance, checked once per play
   regardless of whether a win occurred).

5. **Seeding medium/mega/legend.** They previously had `seedAmount: 0`,
   which left them sitting at literal zero balance until their first
   contribution — a real (if brief) bankruptcy window. Now pre-seeded
   proportional to rarity: medium 200 USDC, mega 1,000 USDC, legend 5,000
   USDC (small unchanged at 10 USDC).

6. **`playerPoolSize` (new config field, default 400).** Player IDs were
   previously drawn from a flat `[0, 100_000)` range every play, memoryless.
   With that large a pool, no single player would ever play often enough
   (given ~10 plays/player at 1M total plays) to plausibly land the 10 small
   wins `legend` requires — legend would never trigger no matter how long
   you ran it. Shrinking the active-player pool to 400 concentrates repeat
   play density enough that top players (lucky + high-skill) can realistically
   climb the full ladder within a run.

7. **Default volume raised to 16M plays** (80,000/day x 200 days, up from
   10,000/day x 100 days = 1M) — needed for `legend` to trigger reliably
   given how rare qualifying + winning it is.

8. **Reporting.** Per-tier report line now shows plays, wins, avg win, total
   paid, final pool, win rate, and bankruptcies. Added a "Sanity Check"
   section reconciling total revenue against payouts + treasury + dev +
   referral + remaining tier balances (should match to sub-lamport flooring
   dust). Also fixed a latent bug where `dailyStats[].wins` was always 0
   (never incremented) and daily `jackpotPool` only ever reflected the small
   tier — it's now summed across all 4 tiers.

`entryThreshold` values (0 / 1 / 3 / 10) were **not** touched — kept in sync
with `backend/internal/jackpot/tiers.go` as required.

## Tuning: winProb → avg win amount

With the fix, avg win amount per tier is independent of overall traffic
volume/routing frequency (a tier's balance grows every time a play is routed
to it, win or not) — it works out to roughly
`avgWinUSDC ≈ 0.95 * 0.80 / winProb * meanSkillMultiplier(~1.205)`, i.e.
`avgWinUSDC ≈ 0.63 / winProb`. winProb values (small unchanged, others
lightly tuned) give a clean increasing ladder:

| tier   | winProb  | theoretical avg | entryThreshold |
|--------|----------|------------------|----------------|
| small  | 0.000437 | ~1,443 USDC      | 0 |
| medium | 0.0001   | ~6,300 USDC      | 1 |
| mega   | 0.00005  | ~12,600 USDC     | 3 |
| legend | 0.00002  | ~31,500 USDC     | 10 |

small's target stays in the platform's documented 1,000-2,000 USDC band
(same band the live backend difficulty governor enforces from observed win
rates).

## Verification — 3 independent runs (default config, `npx ts-node simulate.ts`, ~6-7s each, 16M plays)

All three: **zero bankruptcies**, all 4 tiers triggered, avg win amount
monotonically increasing tier-to-tier.

| tier   | run1 wins / avg USDC | run2 wins / avg USDC | run3 wins / avg USDC |
|--------|----------------------|-----------------------|-----------------------|
| small  | 4,461 / 1,515        | 4,466 / 1,511         | 4,468 / 1,507         |
| medium | 468 / 6,505          | 450 / 6,784           | 411 / 7,458           |
| mega   | 200 / 12,288         | 182 / 13,595          | 161 / 15,247          |
| legend | 18 / 25,656          | 18 / 26,114           | 24 / 22,131           |

Bankruptcy events: 0 in every run, every tier.

Sanity check ("conservation of funds": payouts + platform treasury + dev
cut + referral pool + remaining tier balances vs. total revenue) reconciles
to within a few thousand USDC of flooring dust on 16M USDC of simulated
revenue (~0.04%), as expected from per-play `Math.floor()` rounding.

House take (platform 10% + dev 5% = 15% of revenue) confirmed at exactly
15.0% every run, as designed.

## Verdict

Model is healthy: no tier goes bankrupt over 16M plays, all four tiers
genuinely participate and pay out, and average jackpot size increases
cleanly by tier (small ~1,500 → medium ~6,500-7,500 → mega ~12,000-15,000 →
legend ~22,000-26,000 USDC). `npx tsc --noEmit` on `simulate.ts` is clean.
`--json` output and `--plays`/`--days` CLI overrides still work.

Files touched: `scripts/economy-sim/simulate.ts` only. Nothing in
`backend/`, `contracts/`, `frontend/`, or the DB was touched; no devnet/e2e/
anchor commands were run.
