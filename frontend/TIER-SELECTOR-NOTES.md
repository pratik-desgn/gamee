# Increment 3a — Frontend Jackpot-Tier Selector

Frontend-only change. Lets a player pick which jackpot tier (small / medium /
mega / legend) their ticket purchase funds, builds the buy tx against that
tier's vault, and sends the choice to `/tickets/confirm`. The backend
(`backend/internal/jackpot/tiers.go`) remains the sole authority on whether a
wallet actually qualifies — this UI does not gate selection, it just surfaces
the backend's rejection if the pick was invalid.

## Files changed

- **`src/lib/tiers.ts`** (new) — shared `JackpotTier` type, the 4-tier list,
  and `TIER_ENTRY_THRESHOLDS` mirroring `backend/internal/jackpot/tiers.go`
  (small 0, medium 1, mega 3, legend 10 prior small-tier wins). Also exports
  `tierRequirementLabel()` for the UI copy. Update this file's thresholds if
  `tiers.go` ever changes.

- **`src/lib/solana.ts`** — `createBuyTicketTransaction(wallet, tier = <default>)`
  now takes an optional `tier` param (defaults to the pre-existing
  `NEXT_PUBLIC_JACKPOT_TIER` env var, or `'small'`, so the no-arg call path
  is unchanged). Added `resolveJackpotVault()`: derives the tier's vault PDA
  (`[b"jackpot", tier]`) and fetches its `vaultTokenAccount` on-chain via
  `program.account.jackpotVault.fetch(pda)` (the IDL already has this in
  `src/idl/gamee.json`/`gamee.ts`, field `vaultTokenAccount`). If that fetch
  fails **and** the tier is `small`, it falls back to
  `NEXT_PUBLIC_JACKPOT_USDC` (the old, only, behavior) — any other tier's
  fetch failure throws a clear error instead of silently misrouting funds.
  Both `jackpotVault` and `jackpotUsdcAccount` are passed into
  `accountsStrict` as before.

- **`src/lib/api.ts`** — `confirmTicket(txSignature, tier?)` now optionally
  includes `tier` in the POST body to `/api/v1/tickets/confirm`. Omitted
  when not passed, so any other caller is unaffected.

- **`src/app/ticket/page.tsx`** — added a 2x2 tier-picker grid above the fee
  breakdown, showing each tier's label and `tierRequirementLabel()` (e.g.
  "Medium — Unlock with 1 win"). Selection defaults to `small`, is disabled
  mid-purchase, and is threaded into both `createBuyTicketTransaction` and
  `confirmTicket`. Existing error banner (`{error}`) surfaces whatever the
  backend rejects with (unqualified tier / vault mismatch), no new error UI
  needed — the fetch/response path already throws `Error` with the backend's
  message text and the catch block already renders it.

## Why no live qualification check

`/me/history` (`backend/internal/gamesession/service.go` `HandleUserHistory`)
returns game sessions with a `result` (`won`/`lost`/`rejected`) but no tier
field and no jackpot-win flag — a game "won" (beat the target score) isn't
the same thing as a jackpot win, and there's no endpoint that reports a
wallet's small-tier jackpot win count. Estimating qualification from existing
data would mean guessing at semantics that don't exist yet, so per the task's
guidance I skipped it rather than build something misleading. Locked tiers
are shown with their requirement text but are still selectable; an
unqualified pick is caught by the backend on confirm and shown via the
existing error banner.

## Verify

```
cd frontend
npx tsc --noEmit   # clean, no output
npm run build      # succeeds, /ticket route compiles (60.8 kB / 250 kB First Load JS)
```

Not testable headlessly: an actual Phantom-signed buy against a live program
for a non-small tier (needs the vault PDA initialized on-chain and a real
`program.account.jackpotVault.fetch` to resolve `vaultTokenAccount`). That
depends on the deploy + qualification data being live, which is out of scope
here per the task's instructions (no devnet/anchor/solana commands run).
