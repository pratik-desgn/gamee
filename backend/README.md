# Gamee — Backend Services

## Stack
- **Language:** Go (recommended) or Rust (Axum)
- **Database:** PostgreSQL 16 + Redis
- **Randomness:** Switchboard VRF client
- **Infra:** Docker + managed k8s / Fly.io

## Services

| Service | Role |
|---------|------|
| `auth` | Wallet sign-message → JWT |
| `ticket-service` | USDC payment watcher, ticket confirmation |
| `game-session` | WebSocket game input streaming |
| `replay-worker` | Queue-based deterministic replay verification |
| `jackpot-service` | Economy engine, VRF integration |
| `leaderboard` | Materialized views + APIs |
| `analytics` | Event pipeline |

## API Endpoints (v1)

| Method | Path | Description |
|--------|------|-------------|
| POST | /auth/nonce | Get sign-message nonce |
| POST | /auth/verify | Verify signature → JWT |
| POST | /tickets/confirm | Confirm ticket purchase |
| POST | /spin | Consume ticket, trigger VRF |
| WS | /session/:id | Game input streaming |
| POST | /session/:id/finish | Submit session for verification |
| GET | /jackpot/live | Current jackpot state |
| GET | /leaderboard/:scope | Leaderboard data |
| GET | /me/history | Player session history |
| GET | /referral/stats | Referral earnings |
