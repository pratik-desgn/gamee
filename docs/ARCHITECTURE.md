# GAMEE — Architecture Blueprint (Stage 1)

*Reconciled against the actual codebase — see Changelog at the bottom. This document distinguishes **Built** (exists and runs today, verified by reading the code) from **Planned** (intended, not yet implemented). Changes after this reconciliation still require a written reason, logged in the Changelog.*

---

## 1. System Overview

The backend is **one Go binary** (`backend/cmd/server`, the `api-gateway` container) with Auth/Ticket/GameSession/Games/Jackpot/Leaderboard/PayoutReview as internal packages sharing one Postgres pool and one Redis client — not separately deployed microservices. Two background loops run as goroutines inside that same process: a settlement poller and a verification worker pool. The worker pool's "replay verification" is not in-process JS — each job shells out to a **Node.js child process** (`exec.Command`) running `games/sdk/run.js` once per session, then reads its stdout.

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Traefik (reverse proxy,                     │
│                           TLS via Let's Encrypt)                     │
└──────────────────────────────┬───────────────────────────────────────┘
                                │
                     ┌──────────▼───────────┐
                     │   api-gateway          │   single Go binary
                     │   (Gin HTTP + WS)      │
                     │  ┌──────────────────┐  │
                     │  │ Auth             │  │
                     │  │ Ticket           │  │
                     │  │ GameSession (WS) │  │
                     │  │ Games/Difficulty │  │
                     │  │ Jackpot          │  │
                     │  │ Leaderboard      │  │
                     │  │ PayoutReview     │  │
                     │  └──────────────────┘  │
                     │  ┌──────────────────┐  │
                     │  │ Settlement poller │  │  in-process goroutines,
                     │  │ Verification pool │  │  not separate containers
                     │  └────────┬─────────┘  │
                     └───────────┼────────────┘
                                 │ exec.Command, one child process per job
                        ┌────────▼────────┐
                        │  node games/sdk/ │
                        │     run.js       │  deterministic replay verifier
                        └──────────────────┘

  api-gateway also talks to:  PostgreSQL 16  ·  Redis 7  ·  Solana RPC

                     ┌─────────────────────┐
                     │   Solana Network    │
                     │  ┌───────────────┐  │
                     │  │ Gamee Program │  │  Anchor 0.30.1 / Solana 1.18.26
                     │  │  (Anchor)     │  │
                     │  └───────────────┘  │
                     │  ┌───────────────┐  │
                     │  │  USDC Token   │  │  SPL, devnet mint by default
                     │  │  (SPL)        │  │
                     │  └───────────────┘  │
                     └─────────────────────┘
```

**Planned, not built:** Switchboard VRF oracle (game selection currently uses a deterministic `SHA-256(ticketID + slot)` seed — fine for testing, not for real money, not a chance oracle at all). ClickHouse/analytics pipeline. pgvector (extension is not installed; Postgres runs plain `postgres:16-alpine`).

## 2. On-Chain / Off-Chain Split

**Golden rule: everything involving money goes on-chain. All game logic stays off-chain.**

### On-Chain (Solana Anchor Program) — current instruction set

| Instruction | Authority | Description |
|-------------|-----------|-------------|
| `buy_ticket` | Any user | Accept USDC at `platform_config.ticket_price`, split 80/10/5/5, mint ticket PDA. Every destination account is validated against `PlatformConfig`. |
| `commit_spin` | Backend + verifier co-sign | Record VRF-or-seed result → which game was selected; creates the `GameSession` PDA with `target_score = 0` (see note below). |
| `settle_session` | Verifier authority | Reads `final_score`/`target_score` **as arguments the verifier passes in** (not derived on-chain from anything commit_spin stored — see Security Model), decides win/loss, and inline-executes the 95/5 payout split if won. |
| `initialize_platform` | Bootstrap (first caller becomes admin) | One-time: sets ticket price, fee splits, wallets, verifier/admin pubkeys. |
| `initialize_jackpot` | Admin | Creates a jackpot vault PDA for a tier string (only `"small"` is ever actually used by the backend today). |
| `add_game` | Admin | Register a game + wheel weight. |
| `update_weight` | Admin | Adjust a game's wheel weight. |
| `pause_contract` | Admin | Emergency pause flag, checked by `buy_ticket`. |
| `set_authority` | Admin | Rotate the admin pubkey. |
| `set_verifier` | Admin | Rotate the verifier pubkey. |

`admin` and `verifier` are each a **single Solana keypair** today (`PlatformConfig.admin` / `PlatformConfig.verifier`) — there is no multisig on either, anywhere in the current program.

> **Removed this reconciliation:** a `pay_jackpot` instruction used to exist as a *second*, separately callable public entry point. Unlike `settle_session`, it had no link to any specific game session and no ownership check on the destination account — it let anyone holding the verifier key drain the entire vault balance to an arbitrary account in one call. It was never invoked anywhere in the real app (settle_session has its own inline payout logic; nothing CPIs into it despite an old comment claiming otherwise). Deleted rather than constrained, since nothing depended on it. See Changelog.

> **Known gap, not fixed in this pass:** `commit_spin` always sets `game_session.target_score = 0`; the real target score only exists as a `settle_session` instruction argument supplied by the (trusted) verifier at settlement time, with no on-chain record to check it against. Win/loss is currently 100% attested by the backend's verifier key, with zero on-chain cross-check. This is consistent with the project's already-documented "verifier is a single hot key, move to multisig before real money" risk — flagging it here so the architecture doc doesn't imply more on-chain enforcement than exists.

### Off-Chain (Go backend — internal packages, not separate services)

| Package | Responsibility |
|---------|----------------|
| `auth` | Nonce-based Solana sign-message auth → JWT. Creates the `wallets` row on first verify. |
| `ticket` | Confirms on-chain ticket purchase via Solana RPC (parses the tx, checks signer/mint/amount), lists a wallet's tickets. |
| `gamesession` | `/spin` (VRF-or-seed game selection + difficulty), the WebSocket play loop (cosmetic preview only, not authoritative), `/finish`, `/result`. |
| `games` | Game metadata + difficulty-parameter calculation. |
| `jackpot` | Cached current jackpot amount, history; tier qualification ladder (`tiers.go`, not yet wired into any request path). |
| `leaderboard` | Materialized-view-backed daily/weekly/monthly/all-time/country rankings. |
| `payoutreview` | Manual staff approval queue for payouts above `LARGE_PAYOUT_REVIEW_THRESHOLD`. |
| `verification` | Worker pool: spawns the Node.js replay verifier per session, runs behavioral anti-cheat analysis, writes cheat_flags, escalates the action ladder. |
| `settlement` | Polls for verified wins, builds/signs/submits the `settle_session` Solana transaction (or dev-mode off-chain marking). |
| `anticheat` | Pure logic: input-timing bot detection, action-ladder tier decision. No DB access. |

**Planned, not built:** a separate Analytics Pipeline / ClickHouse service — no analytics ingestion exists anywhere in the codebase today.

## 3. Stack (Actual Versions, Verified)

| Layer | Technology | Version |
|-------|-----------|---------|
| **Smart Contracts** | Rust + Anchor | Anchor 0.30.1, Solana 1.18.26 (pinned in `Anchor.toml`) |
| **Backend** | Go | 1.25 (`backend/go.mod`) |
| **Database** | PostgreSQL + Redis | `postgres:16-alpine`, `redis:7-alpine` (docker-compose) |
| **Randomness** | *Planned:* Switchboard VRF | **Not integrated.** Current: deterministic `SHA-256(ticketID+slot)` seed in `gamesession.generateVRFSeed` |
| **Frontend** | Next.js + React + Tailwind | Next.js 15.0.0, React 19.0.0 |
| **Wallet** | `@solana/wallet-adapter-phantom` | 0.9.24. Phantom only — no Backpack adapter is installed |
| **Game Runtime** | TypeScript (shared SDK) | Node.js 22 (Docker images pin `node:22-alpine`). Bun is not used anywhere in this repo |
| **Infra** | Docker + Docker Compose | Traefik v3.1, Prometheus v2.53, Grafana 11.1 — all four containers are real and running in `docker-compose.yml` |
| **Event Bus** | *Planned:* Redis Pub/Sub or NATS | **Not used as a bus today.** Redis currently only backs the rate limiter's token buckets, `jackpot:players_online` counters, and the verification job queue (a plain `BLPop`/`RPush` list, not pub/sub) |

## 4. Database Schema

### `users`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| created_at | TIMESTAMPTZ | |
| country | VARCHAR(5) | ISO 3166-1 alpha-2 |
| status | VARCHAR(20) | active / suspended / banned — **not currently read or written by any Go code**; the action ladder writes to `wallets.is_banned` instead, not this column |
| last_active | TIMESTAMPTZ | |

### `wallets`
| Column | Type | Notes |
|--------|------|-------|
| address | VARCHAR(44) | PK, Solana pubkey |
| user_id | UUID | FK → users |
| first_seen | TIMESTAMPTZ | |
| is_banned | BOOLEAN | Default false. Written by `verification.Worker.recordAndEscalate` when the anti-cheat action ladder escalates to a ban; read by `ticket`/`gamesession` before allowing confirm/spin |
| ban_reason | TEXT | |

### `tickets`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| wallet_address | VARCHAR(44) | |
| tx_signature | VARCHAR(88) | Solana tx signature |
| purchased_at | TIMESTAMPTZ | |
| consumed_at | TIMESTAMPTZ | Nullable |
| status | VARCHAR(20) | unused / consumed / expired |
| on_chain_ticket_pda | VARCHAR(44) | PDA address |
| amount_usdc | BIGINT | In USDC base units (1 USDC = 10^6) |

### `game_sessions`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| ticket_id | UUID | FK → tickets |
| user_id | UUID | FK → users |
| game_id | VARCHAR(32) | FK → games |
| vrf_request | VARCHAR(88) | Column exists; unpopulated today (no VRF oracle wired up) |
| vrf_result | BIGINT | Same — reserved for when VRF lands |
| difficulty_params | JSONB | `{level, gap_size, speed, seed, game_id}` — `calculateDifficulty` is currently a stub: base level 3 always, ignoring each game's actual `min_difficulty`/`max_difficulty` range, except when the action ladder hardens a wallet (level 8) |
| seed | VARCHAR(64) | Derived from the (currently non-VRF) seed |
| started_at | TIMESTAMPTZ | |
| ended_at | TIMESTAMPTZ | Column exists; not currently set by any code path |
| result | VARCHAR(20) | `pending` / `won` / `lost` / `rejected` / `review_hold` (the last value added this session, for the payout-review queue) |
| target_score | INT | Score needed to win |
| final_score | INT | Actual score |
| payout_tx | VARCHAR(88) | Nullable, if won |

### `replays`
| Column | Type | Notes |
|--------|------|-------|
| session_id | UUID | PK, FK → game_sessions |
| input_log | JSONB | Array of `{frame, type, data, time}` |
| client_score | INT | Score reported by client |
| verified_score | INT | Score from server replay |
| verdict | VARCHAR(20) | `pending` / `match` / `mismatch` / `suspicious` / `unverified` / `timeout` / `rejected` |
| verifier_version | VARCHAR(20) | Semver of verifier code |
| verified_at | TIMESTAMPTZ | |
| duration_ms | INT | Replay duration |

### `games`
| Column | Type | Notes |
|--------|------|-------|
| id | VARCHAR(32) | PK, slug (e.g., 'wing-rush') |
| name | VARCHAR(64) | Display name |
| category | VARCHAR(32) | precision / memory / puzzle / reflex / timing / luck-skill / endless / strategy |
| description | TEXT | |
| base_difficulty | INT | 1-10 |
| min_difficulty | INT | Min the difficulty engine can assign — **not actually consulted by `calculateDifficulty` today** |
| max_difficulty | INT | Max — same caveat |
| wheel_weight | INT | Higher = more common; used by `selectGame`'s weighted RNG |
| avg_play_duration | INT | Seconds |
| enabled | BOOLEAN | |
| sdk_version | VARCHAR(10) | Semver of game SDK |
| created_at | TIMESTAMPTZ | |

10 rows seeded today: Wing Rush, Dino Sprint, Reaction Test, Aim Master, Perfect Stack, Helix Drop, Block Merge, Simon Pro, Minefield, Sliding Puzzle. (Stage 4's target is 10–15; the game-count target is met, the 40+ figure in old planning docs was aspirational, not a near-term target.)

### `jackpots`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| tier | VARCHAR(20) | small / medium / mega / legend — **only `"small"` is ever created or read by any Go code today** |
| vault_address | VARCHAR(44) | Solana PDA |
| current_amount | BIGINT | In USDC base units |
| seeded_from | UUID | FK → jackpots |
| created_at | TIMESTAMPTZ | |
| last_won_at | TIMESTAMPTZ | |
| total_plays | BIGINT | Accumulator |

### `payout_reviews` *(added this session — not in the pre-reconciliation doc)*
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| session_id | UUID | FK → game_sessions, UNIQUE |
| wallet_address | VARCHAR(44) | |
| game_id | VARCHAR(32) | FK → games |
| payout_estimate | BIGINT | USDC base units |
| status | VARCHAR(20) | pending / approved / rejected |
| reviewed_by | VARCHAR(64) | Nullable |
| reviewed_at | TIMESTAMPTZ | Nullable |
| notes | TEXT | Nullable |
| created_at | TIMESTAMPTZ | |

### Schema exists, zero Go code reads or writes it (verified by grep — genuinely dead today, not wired into any service)
- `transactions`
- `referrals`
- `achievements` / `user_achievements`
- `daily_stats`

These are legitimate Stage 4 targets (referral payouts, achievements, daily analytics) — the DDL was drafted ahead of the feature work, which hasn't started.

### `cheat_flags`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| wallet_address | VARCHAR(44) | FK → wallets |
| session_id | UUID | FK → game_sessions |
| rule_triggered | VARCHAR(64) | e.g., `sub_100ms_reaction`, `metronomic_timing`, `frame_perfect_inputs`, `composite_bot_score` |
| severity | VARCHAR(16) | low / medium / high / critical |
| action_taken | VARCHAR(64) | `pass` is never written; `flag` / `review` / `ban` are, as of this session's action-ladder fix (previously only rejected sessions wrote any row at all) |
| created_at | TIMESTAMPTZ | |

## 5. API Surface (v1) — actual registered routes

### Auth (no JWT required)
```
POST   /api/v1/auth/nonce      { wallet } → { nonce, message }
POST   /api/v1/auth/verify     { wallet, signature, nonce } → { token, user }
```

### Tickets (JWT required)
```
POST   /api/v1/tickets/confirm   { tx_signature } → { ticket }   — 403 if wallet.is_banned
GET    /api/v1/tickets/mine      ?status=&limit=&offset= → { tickets, total }
```

### Games
```
GET    /api/v1/games                    → { games }
GET    /api/v1/games/:id                → game metadata
GET    /api/v1/games/:id/difficulty     ?level= → calculated difficulty params
```

### Game Sessions (JWT required)
```
POST   /api/v1/spin                          { ticket_id } → { session_id, game_id, seed, difficulty, target_score, fps }
                                              — 403 if wallet.is_banned
WS     /api/v1/session/:id/play              JSON envelope: client sends {action:"input"|"ping", frame, input_type, data, time};
                                              server sends {type:"init"|"state"|"result"|"pong"}. See §6 — protocol details
                                              were previously undocumented/incorrect.
POST   /api/v1/session/:id/finish            { input_log, client_score } → { verdict: "pending", queued: true }
GET    /api/v1/session/:id/result            → real result from game_sessions (result/final_score/payout_tx)
```

### Jackpot (JWT required — "read-only, but JWT for rate limiting consistency" per source comment; not actually public despite no auth documented previously)
```
GET    /api/v1/jackpot/live       → { current_amount, tier, vault_address, players_online, today_plays }
GET    /api/v1/jackpot/history    → { history }
```

### Leaderboard (JWT required)
```
GET    /api/v1/leaderboard/:scope    scope: daily|weekly|monthly|alltime|country/:code
```

### Admin (gated by static `X-Admin-Key` header, not JWT — added this session)
```
GET    /api/v1/admin/payout-reviews?status=pending
POST   /api/v1/admin/payout-reviews/:id/approve   { reviewed_by, notes }
POST   /api/v1/admin/payout-reviews/:id/reject    { reviewed_by, notes }
```

### `GET /api/v1/me/history` — implemented this session
```
GET    /api/v1/me/history    → { sessions: [{id, game_id, seed, started_at, result, final_score, target_score}] }
```
The frontend profile page (`frontend/src/app/profile/page.tsx`) has called this since it was written; no backend route ever existed for it (a silent 404, swallowed by the page's `.catch(() => {})`, so the game-history tab just always rendered empty). Now implemented in `gamesession.HandleUserHistory`.

### Still documented previously, but genuinely unimplemented — not live bugs, since nothing in the UI calls them
```
GET    /api/v1/me/stats          — defined in frontend/src/lib/api.ts, never called from any page (dead client code)
GET    /api/v1/referral/stats    — not called by frontend; no backend route, no referral logic anywhere (Stage 4)
GET    /api/v1/achievements      — not called by frontend; the profile page's Achievements tab is a static "coming soon" placeholder (Stage 4)
```

## 6. WebSocket Protocol (Game Play) — corrected to match `gamesession.HandleWebSocket`

### Connection
```
wss://api.gamee.io/api/v1/session/:id/play?token=<jwt>
```

### Client → Server (envelope field is `action`, not `type` — this was fixed in code but the doc previously still showed the old, incompatible shape)
```typescript
{ action: "input", frame: number, input_type: string, data: {...}, time: number }
{ action: "ping" }
```

### Server → Client
```typescript
{ type: "init", session_id, game_id, seed, difficulty, target_score, fps: 60 }
{ type: "state", frame, score, hp?, finished: boolean, state?: {...} }
{ type: "result", frame, verdict: "won"|"lost", score, finalized_score, payout_tx? }
{ type: "pong" }   // reply to client "ping" — previously undocumented
```
There is **no `{type:"error"}` message** in the current implementation — the doc previously claimed one existed (`SESSION_EXPIRED`, `INVALID_INPUT` codes); no code path sends it today.

**Important semantic note, previously missing from this doc:** the WS `"result"` message is a **cosmetic preview only** — the tick loop that produces it runs a placeholder simulation (`score += 1` per tick, `+10` per tap) and explicitly must never decide or persist `game_sessions.result`. The real, authoritative result comes from `POST /session/:id/finish` → the verification worker's deterministic replay → `settlement.Service`, polled by the client via `GET /session/:id/result`. A prior bug (fixed before this reconciliation) had the tick loop deciding the real verdict, which silently defeated real settlement for every session — see `docs/NEXT-STEPS.md` for that history.

## 7. Security Model

### Key Management (corrected — several rows described a target state, not the current one)

| Key | Type | Storage today | Access |
|-----|------|---------|--------|
| Verifier Authority | Solana keypair | **A local JSON file** (`./keys/verifier.json` by default; in Docker, a mounted secret at `/run/secrets/verifier_key`, backed by `./secrets/verifier-keypair.json` on the host). **Not an HSM.** AWS KMS/GCP HSM is a planned hardening step, not yet implemented | Backend process only |
| Admin (on-chain) | Solana keypair | Whatever wallet initialized the platform; single EOA, no multisig | Whoever holds that one keypair |
| Admin (off-chain, payout review) | Static shared secret | `ADMIN_API_KEY` env var, checked via `X-Admin-Key` header, constant-time compared. Explicitly a stopgap (documented in code) — replace with real staff accounts + roles before public launch | Anyone with the env var |
| Treasury Multisig | *Planned:* 3-of-5 Squads | **Does not exist** — no entities are incorporated yet (Stage 0), so there is no treasury multisig to set up | N/A |
| JWT Secret | 256-bit random | Env variable (`JWT_SECRET`) | Auth service only |

### Rate Limits (corrected — actual implementation is one global limiter, not per-endpoint)

`middleware.RateLimit` applies a single per-client-IP token bucket (`RATE_LIMIT_PER_SECOND` / `RATE_LIMIT_BURST`, default 10 rps / burst 20) to **every** `/api/v1/*` route uniformly. There is no per-endpoint differentiation (no separate tighter limit on `/auth/nonce` or `/spin`) in the code today, unlike what the pre-reconciliation table implied.

### Payout Thresholds (corrected to match what's actually built this session)

| Amount | Flow |
|--------|------|
| < `LARGE_PAYOUT_REVIEW_THRESHOLD` (default 1,000 USDC) | Automatic — settlement worker signs and pays without review |
| ≥ threshold | Held (`game_sessions.result = 'review_hold'`); staff must call `/admin/payout-reviews/:id/approve` (single admin key, not a multisig) before it settles |

The previously documented "2-of-3 multisig for >$1,000" does not exist — today it's one static key.

### Action Ladder (new section — didn't exist in the pre-reconciliation doc)

Behavioral anti-cheat (`anticheat.AnalyzeInputTiming`) recommends `pass` / `flag` / `review` / `ban` per session. `verification.Worker.recordAndEscalate` writes the session's flags and applies `anticheat.DetermineTier` against the wallet's 30-day flag history, serialized per-wallet via a Postgres advisory lock (`pg_advisory_xact_lock(hashtext(wallet))`) so concurrent verification workers can't under-escalate the same wallet. Outcomes:
- **Clear** — no action.
- **Hardened** — next `/spin` gets bumped to difficulty level 8 (of the 1–10 range), instead of the flat level 3 everyone else gets.
- **Banned** — `wallets.is_banned = true`; enforced at `/tickets/confirm` and `/spin` (both 403).

## 8. Deployment Architecture (matches `docker-compose.yml`)

```
┌────────────────────────────────────────────┐
│              Docker Compose                │
│  ┌─────────┐   ┌──────────────┐            │
│  │ Traefik │   │  PostgreSQL   │            │
│  │  v3.1   │   │ 16-alpine     │            │
│  └────┬────┘   └──────────────┘            │
│       │        ┌──────────────┐            │
│  ┌────▼─────┐  │ Redis 7-alpine│            │
│  │api-gateway│ └──────────────┘            │
│  │(the whole │  ┌──────────────┐            │
│  │Go backend,│  │ Prometheus   │            │
│  │ one image,│  │  v2.53       │  containers │
│  │one process│  └──────────────┘  run; no   │
│  │)          │  ┌──────────────┐  custom     │
│  └───────────┘  │  Grafana     │  metrics    │
│  ┌───────────┐  │  11.1        │  are        │
│  │ Next.js   │  └──────────────┘  emitted    │
│  │ Frontend  │                    yet (see   │
│  └───────────┘                    §9)        │
│  secret: verifier_key (file-mounted)         │
│  volumes: postgres_data, redis_data,         │
│           prometheus_data, grafana_data,     │
│           letsencrypt                        │
└────────────────────────────────────────────┘
```

## 9. Monitoring & Alerting

Prometheus and Grafana containers run in `docker-compose.yml` today. **However**, no metrics are actually instrumented anywhere in the Go backend — grepping for Prometheus client-library usage or any of the named metrics below returns nothing. The containers are provisioned; nothing feeds them yet. Treat everything below as the **target**, not current state:

### Metrics (Prometheus) — planned, not instrumented
- `gamee_tickets_sold_total`
- `gamee_sessions_total{result="won"|"lost"|"rejected"}`
- `gamee_verification_duration_ms`
- `gamee_jackpot_amount`
- `gamee_players_online` (today this figure only exists as a Redis counter, `jackpot:players_online`, incremented/decremented directly — not exported as a Prometheus metric)
- `gamee_cheat_flags_total{severity}`

### Alerts (PagerDuty / Slack) — planned, no alerting integration exists
| Condition | Severity | Action |
|-----------|----------|--------|
| Verification latency > 30s p95 | Warning | Investigate worker scaling |
| Win-rate deviation > 2σ from sim | Critical | Pause game, review difficulty |
| Cheat-flag rate > 5% | Warning | Review anti-cheat rules |
| Vault balance anomaly | Critical | Pause payouts |
| API error rate > 1% | Warning | Check service health |
| Replay mismatch > 5% of sessions | Critical | Disable game, investigate |

## 10. Game SDK Architecture (corrected to the actual tree)

```
games/
├── sdk/
│   ├── index.ts       # public entry point
│   ├── interface.ts   # JackpotGame interface
│   ├── engine.ts       # deterministic fixed-timestep loop
│   ├── renderer.ts     # shared canvas renderer helpers
│   ├── verifier.ts     # server-side replay runner
│   └── run.js          # CLI entry the Go backend actually invokes
│                        # (config.VerifierScriptPath, default ../games/sdk/run.js)
├── games/
│   ├── wing-rush/{index.ts, renderer.ts, __tests__/}
│   ├── dino-sprint/...
│   ├── reaction-test/...
│   ├── aim-master/...
│   ├── perfect-stack/...
│   ├── helix-drop/...
│   ├── block-merge/...
│   ├── simon-pro/...
│   ├── minefield/...
│   └── sliding-puzzle/...   # 10 games total today, not "40+"
└── playground/          # Vite dev harness for playtesting games directly
                          # in-browser, no wallet/backend required
```

Each game today is just `index.ts` + `renderer.ts` (+ tests) — simpler than the earlier planning doc's example tree, which showed separate `physics.ts`/`obstacles.ts` files per game; that split hasn't been needed in practice.

## 11. Development Workflow (corrected to what's actually configured)

### Branch Strategy — actual: a single `main` branch
A remote is configured (`github.com/pratik-desgn/gamee`) and `main` is pushed and current. No `staging`, `dev`, `feat/*`, `fix/*`, or `game/*` branches exist yet — the multi-branch model below is the intended target for when the team grows past a solo contributor, not current practice.
```
main        — production-ready, audited     (only branch that currently exists)
├── staging — pre-production testing        (planned)
├── dev     — integration branch             (planned)
│   ├── feat/*    — feature branches         (planned)
│   ├── fix/*     — bug fixes                (planned)
│   └── game/*    — new game submissions     (planned)
```

### CI Pipeline (`.github/workflows/ci.yml`) — actual jobs
```
lint → test → anchor-test → build → deploy-staging (if branch=staging) → deploy-production (if branch=main)
```
`deploy-staging` and `deploy-production` are currently **placeholder echo statements** — no real deploy command is wired in yet. There is **no Playwright/E2E job** — the previously documented "PR → ... → E2E tests (Playwright)" step doesn't exist; Playwright isn't installed as a test runner anywhere (it only appears as an incidental transitive lockfile entry).

## 12. Key Design Decisions

1. **Deterministic games from day one** — every game uses fixed-timestep simulation with seeded RNG. No wall-clock timing for physics. Still true and load-bearing — this is what makes server-side replay verification possible at all.

2. **Input streaming, not score submission** — inputs are sent to the server during gameplay (well, sent at `/finish` as a full log — see below), not just the final score. Still true in spirit; in practice today the full input log is submitted once at `/session/:id/finish` rather than streamed incrementally during play, since the WS tick loop is a client-facing preview only and doesn't yet consume inputs as the source of truth mid-game.

3. **Wheel weights on backend only** — the frontend never knows the game pool or weights ahead of time. Still true.

4. **Jackpot never hits zero** — 95% to winner, 5% seeds next jackpot. Still true in `settle_session`'s payout logic.

5. **Separate entities (OpCo / Treasury Co)** — **purely planned.** No entities are incorporated (Stage 0 is ~5% complete); there is no treasury multisig, no legal structure. Don't read this section as describing anything that exists today.

6. **On-chain money, off-chain logic** — every financial operation touches the Solana program; game logic/matchmaking/leaderboards are off-chain. Still true, though see §2's note on `settle_session` trusting verifier-supplied scores with no on-chain cross-check — "on-chain" here means "the token transfer is on-chain," not "the win condition is independently verified on-chain."

---

## Changelog

- *2026-07-07 (jackpot tiers — increment 2):* Ticket confirmation
  (`backend/internal/ticket/service.go`) is now the security boundary for
  tier selection: `POST /tickets/confirm` accepts an optional `tier`
  (default `small`), cross-checks it against which vault the transaction
  *actually* credited (`resolveVaultTokenAccount` + `tokenAccountDelta`,
  anti-spoof), enforces the qualification ladder
  (`jackpot.EntryThreshold` via a new `checkQualified`), and only then
  stores it — replacing increment 1's hardcoded `"small"`. New
  `jackpot.IsValidTier`. 9 backend packages green (new `ticket` tests).
  **Found and fixed a real contract bug while cross-checking**: `buy_ticket`
  (`contracts/programs/gamee/src/instructions/buy_ticket.rs`) hard-pinned
  `jackpot_usdc_account` to a single fixed address
  (`platform_config.jackpot_vault_token_account`, set once at
  `initialize_platform` to the small vault) — despite increment 1's write-up
  claiming it already routed to "whatever vault PDA the caller passes."
  It didn't: any non-small tier failed on-chain with
  `InvalidDestinationAccount`. Fixed by removing that constraint and relying
  on the already-present `jackpot_vault.vault_token_account ==
  jackpot_usdc_account.key()` check (tied to the specific, already
  admin-initialized tier PDA passed in) — same security property, now
  actually tier-agnostic. `anchor test` 15/15 passing locally, IDL/types
  resynced to `frontend/src/idl/`. **Not yet deployed to devnet** — the
  upgrade command was blocked by the harness's permission system pending
  explicit user approval, so medium/mega/legend `buy_ticket` calls still
  fail on the currently-deployed program; small-tier re-verified end to end
  with no regression (real payout, independently confirmed via
  `getTransaction`). Full write-up: `docs/NEXT-STEPS.md`.
- *2026-07-07 (jackpot tiers — increment 1):* Made the money path tier-parametric instead of hardcoded, defaulting to `small` so behavior is unchanged. `tickets.tier` and `game_sessions.tier` columns added (`scripts/init-db.sql`, applied to the dev DB); `ticket.verifyAndConfirm` records `tier='small'` on every ticket; `gamesession.HandleSpin`'s atomic ticket-claim `UPDATE ... RETURNING tier` copies it onto the session; `settlement.Service` now reads the session's own tier for both the jackpot pool-amount lookup and the `[b"jackpot", tier]` vault PDA derivation, keeping the old `defaultJackpotTier` constant only as an empty-tier fallback. New `backend/internal/jackpot/tiers.go` holds the qualification ladder from `scripts/economy-sim/simulate.ts` (`EntryThreshold`, `MaxQualifiedTier`) — not called from any request path yet, just landed ahead of the increment that will use it. **Known gap:** the contract doesn't enforce qualification — `buy_ticket` will route to whatever vault PDA it's given, so a hand-built transaction could fund a higher tier without qualifying. Harmless today since nothing in the real app funds anything but the small vault; real enforcement is scoped to the next increment alongside frontend tier selection. Verified: full backend suite green (8 pkgs, new `jackpot` package tests) and a fresh devnet e2e run settled a real payout (reaction-test win, player +0.823 USDC) with the new session/ticket rows both reading `tier='small'`. Full write-up: `docs/NEXT-STEPS.md`.
- *2026-07-07 (sixth pass — VRF hardening):* Per-spin randomness moved from a predictable `SHA-256(ticketID + MAX(slot))` seed to real on-chain entropy: a new `RandomnessProvider` interface (`backend/internal/gamesession/randomness.go`) whose default `slotHashProvider` reads the newest `(slot, blockhash)` from the SlotHashes sysvar and derives `seed = sha256(ticketID:slot:blockhash)`. Removes the player-side prediction/grinding vector (the blockhash is unknown at ticket-buy time); does **not** remove verifier trust (the backend still co-signs what it reads) — that's the remaining Switchboard On-Demand step, for which this provider is the drop-in seam. Selected by `VRF_MODE` (default `slothash`; `deterministic` kept for offline/tests; nil client forces deterministic). Seed is still recorded on-chain by `commit_spin`, so the source is auditable. Verified: full backend test suite green + new sysvar-parser unit tests, and a devnet e2e re-run settled a real payout with zero fallback warnings (aim-master win, player +1.2692 USDC, tx `5iXKtpg…7dbdQ`). `/spin` gained ~0.4s for the sysvar RPC read. Full write-up: `docs/NEXT-STEPS.md`.
- *2026-07-07 (fifth pass — post-demo cleanup):* `sliding-puzzle` given the same `onChainTargetScore` treatment as reaction-test (both inverted-scale targets) in `backend/internal/settlement/service.go`; the five `leaderboard_*` materialized views fixed for Postgres 18 (`ROUND(<float8>,2)` → `::NUMERIC` cast in `scripts/init-db.sql`), stopping the backend's periodic refresh error; confirmed the frontend `buy_ticket` was already IDL-driven (the "hand-built instruction" note was stale). See `docs/NEXT-STEPS.md`.
- *2026-07-07 (fourth pass — Stage 2 exit demo, real payout):* `contracts/scripts/e2e-devnet.ts` ran end to end against devnet and produced a real `settle_session` USDC payout (minefield win, jackpot vault 10.72→0.536 USDC, player +10.184 USDC), independently confirmed via `getTransaction` pre/post token balances, not just the script's own reads. Two real bugs fixed along the way, both pre-existing (not demo scaffolding): (1) `reaction-test`'s `finalScore()` (`games/games/reaction-test/index.ts`) returned a raw average-reaction-ms value while `getState().score` — what every other game's `finalScore()` matches, and what the client reports — returned a points value (`targetReactionMs - avg`); every legitimate reaction-test win therefore read as a client/server score `mismatch` and never reached settlement. (2) Even after that fix, `submitSettleTransaction` (`backend/internal/settlement/service.go`) still passed `game_sessions.target_score` — documented as display-only in the second-pass entry below — as the on-chain `target_score` arg alongside the now-points-scale `verified_score`; `settle_session`'s `final_score >= target_score` check is structurally unsatisfiable on that mismatched scale for reaction-test, so the instruction succeeded but transferred zero tokens. Added `onChainTargetScore()`: since `settle()` only calls the on-chain path for sessions the replay worker already declared `won=true`, the on-chain check is defense-in-depth and just needs both numbers on the same scale, so reaction-test now sends target=0 (its points win-threshold) instead of the raw ms display value. `sliding-puzzle` has the same latent issue and no bot yet — flagged, not fixed blind. Full write-up: `docs/NEXT-STEPS.md`.
- *2026-07-07 (third pass — devnet):* **Deployed.** Program live on devnet at the real ID; platform initialized (verifier = dedicated backend keypair, 10 games, 4 vaults) and read back on-chain to confirm. Env files written; `backend/keys/` and `*-keypair.json` added to .gitignore.
- *2026-07-07 (second pass — games/economy):* **Sim-authoritative wins, per-game difficulty, closed-loop tuning.** Settlement previously paid on `verified_score >= game_sessions.target_score` with a generic target (250) that was wrong for every game's score scale (simon-pro unwinnable, block-merge auto-win, sliding-puzzle/reaction-test inverted). The replay verifier now surfaces the sim's own `won` flag (new `replays.won` column) and settlement pays on that; verified losses are now recorded (`result='lost'` — previously never written). Fixed a fatal pre-existing bug found while testing: `sdk/run.js` selected `default || first export` as the game class, which grabbed a tuning constant for all 10 games — every real replay verification would have returned "unverified" (fail-closed), meaning no win could ever settle. Difficulty: session level now comes from `games.base_difficulty` clamped to `[min,max]` (bases raised, +3 for hardened wallets); a new hourly governor (`backend/internal/difficulty`) adjusts `base_difficulty` from observed win rates toward a 1/1300..1/2600 wins-per-play band, targeting the 1,000-2,000 USDC average jackpot. Economy sim retuned to the same band (1M-play run: avg win 1,487 USDC, 0 bankruptcies). `game_sessions.target_score` is display-only now.
- *2026-07-07:* **CI green for the first time; real program ID; init script.** Root-caused the perpetually failing anchor-test job: anchor-cli 0.30.1's IDL generation hardcodes `cargo +nightly` (only overridable via the `RUSTUP_TOOLCHAIN` env var — `rust-toolchain.toml` is bypassed, which is why the earlier pin attempt failed and also broke Lint); CI and local builds now pin `nightly-2025-01-01`, the last nightly era with `proc_macro::SourceFile` that the locked proc-macro2 1.0.86 needs. First successful `anchor build` produced the IDL; the placeholder `GAMEE1111…` program ID is replaced everywhere with the keypair-derived `9ZjYdP5QQB6SHbQWRocLDtuxga519Z4ZQsVct1ESkJYa`. Added `contracts/scripts/initialize.ts` (`anchor run init`) — idempotent platform/jackpot/game-catalog initialization, verified against a local validator. `anchor test` passes 15/15 locally and in CI. Devnet deploy remains blocked on faucet SOL.
- **This reconciliation** (see conversation that produced it): rewrote every section against the actual code rather than the original planning draft. Concrete corrections: removed the `pay_jackpot` instruction (dead + unconstrained attack surface, deleted from the contract and its test); corrected VRF from "integrated" to "planned, deterministic seed today"; corrected verifier key storage from "HSM" to "local file/Docker secret"; corrected payout threshold multisig claim to the actual single-admin-key implementation; corrected WS protocol (client envelope field `action` not `type`, added `pong`, removed a nonexistent `error` message type); corrected API surface to match actually-registered routes, found `/me/history` was called by the live frontend profile page but never implemented server-side (silent 404, empty game-history tab) and implemented it (`gamesession.HandleUserHistory`); confirmed `/me/stats`, `/referral/stats`, `/achievements` are unimplemented but not live bugs, since nothing in the UI calls them; corrected the system diagram from an implied microservice split to the actual single-Go-binary-plus-subprocess-verifier shape; corrected monitoring section (containers exist, no metrics instrumented); corrected game SDK tree and game count (10, not 40+); corrected branch/CI documentation to the actual single-branch, placeholder-deploy state; documented the new `payout_reviews` table and the action ladder; flagged `referrals`/`achievements`/`daily_stats`/`transactions` as schema-only, zero backend logic.
- *2025-07-02:* original architecture doc drafted (Stage 1).
