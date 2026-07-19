# GAMEE 🎮

**A skill-gaming jackpot platform on Solana — pay $1, play a replay-verified arcade game, win the growing jackpot.**

> 🏆 Built for the **Superteam Nepal Mini Hack** — a long-term project we intend to keep shipping toward the next global Colosseum hackathon.

| | |
|---|---|
| 🌐 **Live demo (devnet beta)** | https://edith.tail5956ca.ts.net |
| 🎥 **Demo video** | https://youtu.be/fz8vY7Q9VZM |
| ⛓️ **Program (Solana devnet)** | [`9ZjYdP5QQB6SHbQWRocLDtuxga519Z4ZQsVct1ESkJYa`](https://explorer.solana.com/address/9ZjYdP5QQB6SHbQWRocLDtuxga519Z4ZQsVct1ESkJYa?cluster=devnet) |
| 🧑‍💻 **Team** | Pratik Dulal (solo) |

The live beta runs on **devnet with test USDC** — a built-in faucet funds your wallet so anyone can play the full loop (buy → spin → play → verify → payout) end-to-end in under two minutes.

---

## The Problem

Casual gamers spend billions of hours on hyper-casual arcade games and earn nothing for being good at them. The prize-gaming platforms that do exist are either:

- **Luck-based (gambling)** — legally restricted, extractive, and rigged against the player, or
- **Trust-based** — the operator holds the prize pool in an opaque account, decides winners off-record, and can exit-scam at any time.

There is no platform where **provable skill** competes for a **provably held prize** with **verifiable randomness**.

## The Solution

GAMEE is a $1-entry skill contest:

1. **Buy a ticket** — $1 USDC on-chain. The smart contract splits it instantly: **80%** to the jackpot vault, **10%** to operations, **5%** to referrals, **5%** to seeding future jackpots. Every destination is validated against on-chain config; no human ever touches the funds.
2. **Spin** — verifiable randomness (Switchboard on devnet) picks which of the 10 arcade games you play. You can't grind your one best game.
3. **Play** — 60–90 seconds of pure skill: reaction, aim, memory, puzzle.
4. **Verify** — your *inputs* (not your score) are streamed to the server, which **re-simulates the entire game deterministically**. If the replay doesn't reproduce your score, the score doesn't exist.
5. **Win** — beat the difficulty-calibrated threshold and `settle_session` pays **95% of the vault straight to your wallet** in the same instruction; 5% stays behind to seed the next jackpot so it never starts from zero.

The outcome is decided entirely by skill — the randomness only selects *which game* you play, never *whether you win*.

## Why Solana

- **The jackpot is trustless.** The prize pool lives in a program-owned vault PDA anyone can inspect on the explorer. Payout is a contract instruction, not an operator's promise.
- **$1 micro-entries are viable.** Sub-cent fees and instant finality make a $1 ticket economically sensible — impossible on most chains and on card rails (fees eat 30¢+ per swipe).
- **Randomness is verifiable.** The game selection commits on-chain, so "the platform gave me the hard game on purpose" is auditably false.

---

## How the Anti-Cheat Works (the hard part)

Prize gaming dies the moment one bot wins. GAMEE's answer is **deterministic replay verification** — the server never trusts a score, only inputs:

1. **Every game is a deterministic simulation.** All 10 games are built on a shared TypeScript SDK: fixed tick rate, seeded PRNG, zero reliance on wall-clock time or browser physics. The same seed + the same inputs always produce the same score, on any machine.
2. **The browser streams inputs, not results.** During play, the client sends timestamped input events (taps, key presses) over a WebSocket. The in-browser rendering is a cosmetic preview — it is never authoritative.
3. **The server replays the whole game.** After the session, a verification worker pool spawns the same game code in Node.js (`games/sdk/run.js`) and re-simulates every tick from the recorded inputs. The replayed score is the *only* score that exists. A mismatch = automatic rejection.
4. **Behavioral heuristics catch what replay can't.** Replay proves the inputs produce the score — heuristics ask whether a *human* produced the inputs: input-rate ceilings, inter-input timing entropy (bots are too regular), and reaction-time floors.
5. **A graduated action ladder** (flag → shadow-review → reject → ban, ban gated behind an ops flag) means false positives degrade gracefully instead of nuking real players.
6. **A cosigner attests settlement.** Wins are settled on-chain by a verifier authority that only signs after replay verification passes. Payouts above a configurable threshold get an extra screening pass: an auto-reviewer clears them in under a minute when every trust signal is clean (unbanned wallet, zero cheat flags on the session and in the wallet's history), and queues anything suspicious for a human with the reasons written out.

Every new game plugs into the same SDK and inherits all of this for free — that's the moat.

## On-Chain Design (Anchor program)

| Instruction | Signer | What it does |
|-------------|--------|--------------|
| `buy_ticket` | Player | Accepts USDC at the configured ticket price, splits 80/10/5/5 into vault PDAs, mints a single-use ticket PDA |
| `commit_spin` | Backend + verifier cosign | Records the randomness result (which game was selected) and creates the game-session PDA |
| `settle_session` | Verifier authority | Decides win/loss from the verified replay and, on a win, executes the 95/5 payout split inline — winner's wallet gets paid in the same instruction |
| `initialize_platform` / `initialize_jackpot` | Admin | One-time setup: ticket price, fee splits, wallets, authorities; per-tier jackpot vaults |
| `add_game` / `update_weight` | Admin | Register games on the selection wheel and tune their weights |
| `pause_contract` / `set_authority` / `set_verifier` | Admin | Emergency pause and key rotation |

**Design rules the codebase never breaks:**

1. Money on-chain, game logic off-chain. Never mix.
2. Never trust the browser — deterministic sims + server replay from game #1.
3. Randomness resolves on the backend from a verifiable source, never in the client.
4. The jackpot never hits zero (95/5 winner/seed split).
5. No legal opinion → no mainnet launch. It's a skill contest, and we keep it that way.

**Honest limitations (devnet MVP):** the verifier is a single hot key today (multisig before real money), the win threshold is attested by the verifier rather than cross-checked on-chain, and randomness falls back to a slothash-derived seed when the Switchboard feed is unavailable. All three are tracked for the security-audit stage — see the roadmap.

## The 10 Games

All deterministic, all mobile/touch-friendly, all 60–90 seconds:

| Game | Skill tested |
|------|--------------|
| 🎯 Aim Master | Precision + speed — hit shrinking targets |
| ⚡ Reaction Test | Raw reaction time across rounds |
| 🌀 Helix Drop | Timing — drop a ball through a rotating helix tower |
| 🧱 Perfect Stack | Rhythm — stack moving blocks with pixel precision |
| 🐦 Wing Rush | Sustained control through moving gaps |
| 🦖 Dino Sprint | Endurance runner with accelerating obstacles |
| 🎨 Simon Pro | Working memory — ever-longer color sequences |
| 🔢 Block Merge | Spatial planning (2048-style) under time pressure |
| 💣 Minefield | Deduction — clear a board on logic, not luck |
| 🧩 Sliding Puzzle | Spatial reasoning against the clock |

## Architecture

```
Browser (Next.js 15 + wallet adapter)          Solana (Anchor 0.30)
  │  sign-message auth → JWT                     ├─ platform_config PDA
  │  input events ──► Go backend (single binary) ├─ ticket PDA (single-use)
  │                    ├─ session/spin service    ├─ jackpot_vault PDA (per tier)
  │                    ├─ verification pool ──►   └─ treasury_vault PDA
  │                    │    node games/sdk/run.js
  │                    │    (deterministic replay)      Switchboard randomness
  │                    ├─ anti-cheat heuristics
  │                    ├─ settlement poller ──► settle_session (cosigned)
  │                    └─ jackpot tiers · leaderboard · payout review
  └─ PostgreSQL 16 + Redis 7 (sessions, rankings, job queue, rate limits)
```

- **Backend**: one Go binary — auth, tickets, sessions, jackpot tiers (small → medium → mega → legend, unlocked by wins), public leaderboard, difficulty calibration, payout-review queue, settlement poller, and the replay-verification worker pool.
- **Games**: TypeScript monorepo — shared deterministic-sim SDK + 10 games compiled once and shipped to both the browser and the server-side verifier, so client and replay can never drift.
- **Contracts**: Anchor program with PDA vaults; e2e devnet script covers the full buy → spin → play → settle → payout loop.

## Business Case

- **Revenue:** 10% of every ticket funds operations; 5% funds referrals — sustainable at scale without ever touching the prize pool.
- **Player economics:** a $1 ticket buys a real shot at a jackpot that visibly grows with every entry — the loop that made lotteries a $300B market, but skill-based, transparent, and instant-settling.
- **Wedge:** hyper-casual games are the most-played genre on earth and need no tutorial. Nepal + South Asia have huge mobile-first casual gaming audiences underserved by prize platforms.
- **Moat:** replay-verification anti-cheat is the hard part — every new game plugs into the same SDK and inherits it.

## What's Working Today (devnet MVP)

- ✅ Anchor program deployed to devnet: ticket purchase with on-chain fee split, cosigned spin commit, verified settlement with inline 95/5 payout
- ✅ 10 playable deterministic arcade games with a shared SDK
- ✅ Full anti-cheat pipeline: input streaming → server-side deterministic replay → cosigned settlement, plus behavioral heuristics with a graduated action ladder
- ✅ Jackpot tier ladder, public leaderboard, difficulty calibration, large-payout review queue with auto-clearing for clean wins
- ✅ Next.js frontend: wallet sign-in, live jackpot, spin wheel, gameplay, result flow — mobile/touch friendly
- ✅ Self-playing demo mode: every game can play itself, so new players watch the mechanic before spending a ticket
- ✅ Devnet faucet for test USDC — anyone can run the whole loop from the live demo
- ✅ CI, devnet e2e script, one-command local beta stack

## Repo Structure

```
Gamee/
├── contracts/       # Solana Anchor program (Rust) + devnet e2e scripts
├── backend/         # Go backend: sessions, anti-cheat, settlement, jackpot
├── frontend/        # Next.js 15 app: wallet auth, spin, play, leaderboard
├── games/           # 10 deterministic arcade games + shared game SDK
├── docs/            # Architecture blueprint + stage-by-stage execution plans
├── landing-page/    # Original demand-validation page (Stage 0)
└── scripts/         # Dev tooling incl. one-command beta stack
```

## Running Locally

Prereqs: Node 20+, Go 1.22+, Rust + Anchor 0.30, PostgreSQL, Redis, a Solana devnet wallet.

```bash
# contracts (already deployed to devnet; to redeploy)
cd contracts && anchor build && anchor deploy --provider.cluster devnet

# backend — copy .env.example to backend/.env and fill in your values
cd backend && go build -o bin/server ./cmd/server && ./bin/server

# frontend
cd frontend && npm install && npm run dev

# devnet end-to-end test (buy → spin → play → settle → payout)
cd contracts && npx ts-node scripts/e2e-devnet.ts
```

No secrets ship in this repo: all keys and credentials load from gitignored `.env` files and a gitignored `backend/keys/` directory — see `.env.example` for every knob.

## Roadmap (this is a long-term build)

| Stage | What | Status |
|-------|------|--------|
| 0 | Legal & demand validation | ✅ landing-page fake-door test done |
| 1 | Architecture blueprint | ✅ |
| 2 | Core infrastructure (MVP) | ✅ devnet, live beta |
| 3 | Anti-cheat & fairness | ✅ replay verification + heuristics live |
| 4 | Game library & economy | 🔄 10 games shipped, tier economy live, more coming |
| 5 | Security audit & mainnet launch | ⏭️ next — verifier multisig, on-chain threshold commitment, audit; targeting Colosseum |
| 6 | Live ops & growth | ⏭️ |

## License & Contact

Built by **Pratik Dulal** in Kathmandu 🇳🇵 — reach me at **[pratikdulal0@gmail.com](mailto:pratikdulal0@gmail.com)** for the beta.
