# GAMEE Devnet Beta — Tester Guide & Operator Runbook

*Created 2026-07-11. The beta runs entirely on Solana **devnet** with a test
USDC mint — no real money anywhere.*

---

## For testers

### One-time setup (~3 minutes)

1. **Install [Phantom](https://phantom.app)** (browser extension) and create
   a wallet. You do NOT need to buy anything.
2. **Switch Phantom to devnet:** Settings → Developer Settings → enable
   Testnet Mode, select **Solana Devnet**.
3. **Send your wallet address to the GAMEE team** (the `ABC…xyz` address at
   the top of Phantom). The beta is invite-only — you can't log in until
   your address is added.
4. Open the beta URL (the team will send it), click **Select Wallet**,
   approve the connection, and **sign the login message** when Phantom asks
   (it's a free signature, not a transaction).

### Getting play money

On the **Buy Ticket** page, use the **“Get test funds”** button — it sends
you test SOL (for transaction fees) and 20 test USDC (for tickets), twice
per day. Everything you win or lose is this test USDC.

### Playing

1. **Buy Ticket** ($1 test USDC; pick a jackpot tier — higher tiers unlock
   after small-tier wins).
2. **Spin** — the wheel assigns you one of 10 games at a difficulty level.
   The assignment comes from oracle randomness; you can't pick.
3. **Play.** Every game is skill-based and deterministic; your inputs are
   recorded and replayed server-side to verify your score. Wins pay 95% of
   that tier's jackpot vault straight to your wallet on-chain.
4. **Result page** shows the verified outcome; **Profile** shows history;
   **Leaderboard** ranks scores.

### What we need from you

- Play a lot. Try to break things.
- Report: anything that hangs, any score that looks wrong, any win that
  didn't pay, any game that feels unfair or too easy — with your wallet
  address and roughly when it happened (we can trace every session).
- Expect rough edges: devnet RPC can be slow (spins take a few seconds —
  that's real oracle randomness being committed and revealed on-chain).

---

## For the operator (running the beta)

### Services

```bash
# Postgres (user-level cluster, port 5433)
pg_ctl -D ~/.gamee-dev/pg -l ~/.gamee-dev/pg.log start
# Redis (port 6390)
~/.local/bin/redis-server --daemonize yes --port 6390
# Backend (from backend/, .env holds the devnet address set)
go build -o bin/server ./cmd/server
set -a && source .env && set +a && ./bin/server
# Frontend (from frontend/)
npm run build && npm start        # or `npm run dev` while iterating
```

### Beta-specific env (backend/.env)

| Var | Value for beta | Notes |
|---|---|---|
| `BETA_FAUCET` | `true` | Enables `POST /api/v1/beta/faucet` |
| `FAUCET_KEYPAIR` | path to the test-mint authority keypair | Deploy wallet on this machine. **Devnet only — never point at a real mint.** |
| `FAUCET_SOL_LAMPORTS` / `FAUCET_USDC_MICRO` / `FAUCET_PER_DAY` | defaults: 0.05 SOL / 20 USDC / 2 per day | |
| `BETA_ALLOWED_WALLETS` | comma-separated tester addresses | Empty = open to anyone. Add each tester's address, then restart the backend. |
| `ALLOWED_ORIGINS` | the beta frontend's public origin | Required if `ENVIRONMENT` isn't `development` |

Frontend: set `NEXT_PUBLIC_BETA=true` in `frontend/.env.local` to show the
faucet button, and `NEXT_PUBLIC_API_URL` to the backend's public URL.

### Exposure

The stack binds locally (`:8080` backend, `:3000` frontend). For a small
remote group, put both behind one HTTPS reverse proxy / tunnel
(Caddy, nginx + certbot, or a Cloudflare Tunnel), set
`NEXT_PUBLIC_API_URL` + `ALLOWED_ORIGINS` to the public hostnames, and
share the frontend URL with testers.

### Keeping an eye on it

- Backend log: settlement lines (`[settlement] session … settled on-chain
  tx=…`), faucet grants (`[faucet] funded …`), switchboard latency per spin.
- DB: `game_sessions` (per-session result/score/tier), `replays` (verdicts),
  `cheat_flags` (anti-cheat hits), `leaderboard_*` views.
- Payout review: wins above the large-payout threshold hold for manual
  approval at `/api/v1/admin/payout-reviews` (X-Admin-Key header).
- Vault balances: each tier's vault must hold test USDC to pay wins — top
  up by buying tickets into it or minting to the vault ATA with the deploy
  wallet (`spl-token mint <MINT> <amount> <vault-ata> --url devnet`).
- The difficulty governor re-tunes per-game `base_difficulty` hourly from
  observed win rates (bounds live in the `games` table).

### Known beta limitations

- Spins take ~5–20 s (live Switchboard commit-reveal on devnet).
- Devnet RPC rate limits can make buys/settles retry; the e2e-tested paths
  all retry internally.
- The verifier + cosigner keys and the faucet authority all live on the
  beta host — fine for test money, part of the mainnet key ceremony to fix
  (see MAINNET-CHECKLIST.md).
