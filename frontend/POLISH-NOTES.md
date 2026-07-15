# Frontend Visual/UX Polish Pass

Scope: `frontend/` only. Style, markup, and layout changes — no functional
rewiring. See "Functional verification" below for confirmation.

## Design direction

- **Palette**: kept the existing dark (`#0a0a0f`) glassmorphism theme —
  purple (`#a855f7`) → cyan (`#06b6d4`) gradient as the primary accent.
- **Tier identity**: added a shared, reusable accent system per jackpot tier
  (small = cyan, medium = purple, mega = pink/rose, legend = amber/gold),
  plus an emoji glyph per tier (🥈🥇💎👑). Defined once in
  `src/lib/tiers.ts` as `TIER_ICONS` / `TIER_ACCENT` (pure additions —
  every pre-existing export in that file is untouched) so the jackpot
  ladder and the ticket picker read as one consistent system instead of
  each component inventing its own colors.
- **Typography/spacing**: consistent `tabular-nums` on all numeric
  stats (scores, counts, balances) so they don't jitter, consistent glass
  card padding, and unified button/shadow treatment (`shadow-lg
  shadow-purple-500/20` → stronger on hover) across primary CTAs.

## What changed, per page/component

- **`components/JackpotDisplay.tsx`** (hero, priority 1): added a live
  pulse indicator, a current-tier badge, an ambient glow blob, a
  glow-pulse animation on the amount, and — the main addition — a **tier
  ladder strip** showing all 4 tiers (icon + label), highlighting the
  live tier and dimming the others. Ladder is driven entirely by
  `JACKPOT_TIERS` / `TIER_LABELS` / `tierRequirementLabel` from
  `lib/tiers.ts` (thresholds shown via `title` tooltip) — nothing
  hardcoded. The `useState`/`useEffect` data-fetching logic (including the
  simulated-growth fallback) is byte-identical; only the returned JSX
  changed.
- **`components/Wheel.tsx`**: this was dead decorative markup — a
  `<canvas id="wheel-canvas">` that nothing ever drew to and a
  `#wheel-spin-btn` with no attached listener (not used by the real
  `/spin` flow, which is ticket-driven via `apiClient.spin` and has its
  own UI). Rebuilt it as a self-contained CSS/SVG conic-gradient wheel
  with a working spin animation and a "landed on X" result line, purely
  for hero visual appeal. No wallet/API/auth logic involved.
- **`src/app/page.tsx`** (home): tightened hero spacing, added a trust-bar
  row ("Provably fair / Instant payouts / On-chain vaults"), added
  `scroll-mt-20` to anchor sections so the fixed navbar doesn't cover them
  on jump-to, added an ambient glow to the final CTA card. Content/links
  unchanged.
- **`src/app/ticket/page.tsx`** (priority 2): restyled the 2×2 tier grid
  with per-tier icon, per-tier accent color when selected, a 🔒 badge on
  tiers with a non-zero win requirement, and an "active" dot indicator.
  Collapsed the four separate wallet/balance/fee glass boxes into one
  divided card for a cleaner look. **Functional wiring is untouched**:
  `selectedTier` state (default `'small'`), `setSelectedTier(tier)` on
  click, `disabled={buying || !!txSignature}`, and the calls
  `createBuyTicketTransaction(publicKey, selectedTier)` /
  `apiClient.confirmTicket(sig, selectedTier)` are byte-identical to
  before — confirmed via diff/grep.
- **`components/Navbar.tsx`**: added a real mobile menu (hamburger toggle
  + dropdown) since the previous version just hid the nav links below
  `md` with no fallback; added a Profile link. Wallet button styling
  unchanged (still `WalletMultiButton` from the adapter, just responsive
  padding).
- **`src/app/spin/page.tsx`**: polished ticket list cards, spinner icon
  animates while spinning, better empty state. `handleSpin`/`apiClient.spin`
  logic untouched.
- **`src/app/leaderboard/page.tsx`**: added a loading skeleton (rows
  pulse while fetching) and a proper empty state; rank medals for top 3.
  Added one `loading` state that wraps the *existing* `getLeaderboard`
  call (no change to the request itself).
- **`src/app/profile/page.tsx`**: polished stat tiles, tabs, history
  table (result rows now show an icon), responsive table overflow wrapper.
- **`src/app/play/[sessionId]/page.tsx`** and
  **`src/app/result/[sessionId]/page.tsx`**: light restyle of wrapper
  JSX only (padding, shadows, connecting-state label). The WebSocket
  session logic, canvas draw calls, `handleInput`, `finishGame`, and the
  result-polling `useEffect` are all untouched — only surrounding markup
  changed. The canvas's `onClick`/`onKeyDown` handlers (which call
  `handleInput`) are preserved exactly.
- **`src/app/globals.css`**: added two purely additive keyframes/utility
  classes (`.jackpot-glow`, `.float-blob`) used by the above. No existing
  rule modified.
- **`tailwind.config.ts`**: added `./src/lib/**/*.{js,ts,jsx,tsx,mdx}` to
  `content` so Tailwind's JIT scanner picks up the new `TIER_ACCENT` class
  strings defined in `lib/tiers.ts` (otherwise those literal class names
  would never be scanned and would get purged from the production CSS).
  Verified post-build: `bg-cyan-300`, `text-amber-300`, `border-pink-400`,
  etc. are all present in the compiled CSS.

## Functional verification

- Wallet connect/auth (`useAuthSession.ts`), `lib/solana.ts`,
  `lib/api.ts` — **not modified**.
- `lib/tiers.ts` — only additive exports (`TIER_ICONS`, `TIER_ACCENT`);
  every pre-existing export (`JACKPOT_TIERS`, `TIER_ENTRY_THRESHOLDS`,
  `TIER_LABELS`, `tierRequirementLabel`) is byte-identical.
- Ticket page: `createBuyTicketTransaction(wallet, tier)` and
  `confirmTicket(txSignature, tier)` call sites, args, and surrounding
  logic (balance check, error handling, redirect timing) are unchanged —
  re-read and grep-diffed against the original.
- No devnet/anchor/solana/e2e commands were run; no services restarted;
  no backend/contract/db files touched.

## Build verification

```
$ npx tsc --noEmit
(clean, no output)

$ npm run build
✓ Compiled successfully in 7.1s
✓ Generating static pages (8/8)

Route (app)                                 Size  First Load JS
┌ ○ /                                    5.49 kB         111 kB
├ ○ /_not-found                            998 B         103 kB
├ ○ /leaderboard                         2.41 kB         108 kB
├ ƒ /play/[sessionId]                    2.75 kB         105 kB
├ ○ /profile                             2.84 kB         109 kB
├ ƒ /result/[sessionId]                  2.17 kB         108 kB
├ ○ /spin                                2.87 kB         109 kB
└ ○ /ticket                              61.3 kB         251 kB
+ First Load JS shared by all             102 kB
```

(`/ticket`'s larger bundle is pre-existing — it's the page that pulls in
`@coral-xyz/anchor` + the IDL for `createBuyTicketTransaction`, not a
result of this polish pass.)

## Known limitation

Visual quality (does it actually *look* good — spacing rhythm, contrast,
animation feel) could not be verified headlessly in this environment; only
compile/build correctness was verified. A manual look via `npm run dev`
in a browser is recommended before demoing.
