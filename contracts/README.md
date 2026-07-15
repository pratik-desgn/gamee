# Gamee — Solana Contracts

## Stack
- **Framework:** Anchor
- **Network:** Solana (devnet → mainnet)
- **Randomness:** Switchboard VRF
- **Token:** USDC (to avoid SOL volatility in jackpot display)

## Core Instructions

| Instruction | Description |
|-------------|-------------|
| `buy_ticket()` | Accepts $1 USDC, splits 80/10/5/5, mints ticket PDA |
| `commit_spin(vrf_result)` | Records VRF game selection on-chain |
| `settle_session(session_id, won)` | Called by verifier authority after replay validation |
| `pay_jackpot(winner)` | Pays 95% vault → winner, 5% seeds next jackpot |

## PDAs
- `ticket` — single-use, marked consumed on commit_spin
- `jackpot_vault` — prize pool per tier
- `treasury_vault` — operations/referral funds

## Development

```bash
export RUSTUP_TOOLCHAIN=nightly-2025-01-01  # see note below
anchor build
anchor test
anchor deploy --provider.cluster devnet
```

> **Why the toolchain pin:** anchor-cli 0.30.1's IDL generation hardcodes
> `cargo +nightly …` and only honors the `RUSTUP_TOOLCHAIN` env var as an
> override (a `rust-toolchain.toml` is ignored). It needs a nightly from
> before ~2025-03: newer rustc removed `proc_macro::SourceFile`, which the
> locked `proc-macro2 1.0.86` (required by anchor-syn 0.30.1) still
> references, failing with ``cannot find type `SourceFile` ``. The pin
> becomes unnecessary once we upgrade to Anchor 0.31+. CI sets the same
> env var in `.github/workflows/ci.yml`.

## Security
- All money instructions gated by program-derived addresses
- `settle_session` restricted to backend verifier authority key
- Verifier authority → 2-of-3 multisig for >$1k payouts
