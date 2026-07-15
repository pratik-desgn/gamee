# GAMEE — Mainnet Launch Checklist

*Created 2026-07-10. Companion to `NEXT-STEPS.md` (current-truth build log) and
the STAGE-0…6 docs. This file tracks only what stands between the current,
fully-working devnet deployment and a real-money mainnet launch. Items are
split by who can do them: code items are done and verified; the rest need
human/business action.*

## Done in code (verified, committed)

- [x] Full money loop proven on devnet: wallet auth → on-chain buy_ticket →
      tier-verified confirm → Switchboard-VRF spin → co-signed commit_spin →
      deterministic replay verification → 2-of-2 multisig settle_session
      payout. All four jackpot tiers individually proven.
- [x] On-chain threshold verifier multisig (`VerifierSet`, quorum enforced in
      `settle_session`, membership in `commit_spin`); reseed destination
      constrained to real admin-initialized tier vaults.
- [x] Switchboard On-Demand randomness per spin (`VRF_MODE=switchboard`),
      slothash → deterministic fallback ladder.
- [x] Anti-cheat: behavioral input-timing analysis, action ladder
      (shadow-flag → harder difficulty → ban), large-payout manual review
      queue (`/admin/payout-reviews`).
- [x] Auth: real ed25519 verification, Redis-backed single-use nonces with
      TTL (multi-instance safe), JWT sessions.
- [x] WebSocket origin allowlist (`ALLOWED_ORIGINS`); server refuses to boot
      in non-development environments without one.
- [x] Economy tuned by simulation (avg small-tier win ~1,487 USDC at
      ~1-in-1,869 plays, 0 bankruptcies / 1M plays) + live closed-loop
      difficulty governor.
- [x] CI green end-to-end (lint, Go tests, 27 anchor tests, image build).

## Blocking — needs you (in rough order)

1. **Legal opinion (Stage 0 — THE launch gate).** Skill-vs-gambling
   classification for target jurisdictions. Everything else is moot without
   it. `landing-page/` is ready for waitlist validation in the meantime.
2. **Book a Solana audit (Stage 5).** OtterSec / Neodyme / Sec3, ~2 months
   lead time before intended mainnet. The contract surface is small
   (7 instructions) and stable now — good time to book. Include the Go
   settlement signer + replay verifier in scope, not just the program.
3. **Key ceremony + cosigner isolation.** The on-chain 2-of-N quorum
   machinery works, but today both verifier keys live on the one backend
   host — operationally still a single point of compromise. Before real
   money: generate fresh mainnet keys, move the cosigner signature to
   separate infrastructure (second box / HSM / different operator), and
   consider threshold 2-of-3 with a cold admin key.
   The admin/upgrade authority (`gamee-keypair.json` + deploy wallet) must
   be backed up offline and ideally moved to a multisig (e.g. Squads).
4. **Red-team week.** Two single-session passes are done (one found and
   removed a drainable `pay_jackpot` path; this week's found the reseed
   hole now closed). A dedicated adversarial week with fresh eyes — ideally
   overlapping the audit — is still owed before real funds.
5. **Mainnet deployment config.** Real USDC mint
   (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` — already the config
   default), paid RPC provider (public endpoints won't survive production
   traffic; Switchboard helper + settlement + confirm all do RPC reads),
   `ENVIRONMENT=production` + `ALLOWED_ORIGINS` set, Switchboard mainnet
   queue in `vrf-switchboard.ts` (currently devnet queue/PID), real domain +
   TLS in front of the WS endpoint.
6. **Manual Phantom pass.** The full loop is proven via script; do one
   human click-through (connect → buy → spin → play → payout) on devnet
   before launch — the only part never exercised by hand.

## Non-blocking (can land after launch)

- Referral payout distribution (5% pool accrues on-chain; per-referrer
  accounting is off-chain work, Stage 4).
- Higher-tier economy tuning: medium/mega/legend rarely trigger under
  current entry thresholds; revisit with real player data.
- Bots for the remaining 6 games so unattended e2e never strikes out.
- Bump CI actions off the Node-20 deprecation warnings.
