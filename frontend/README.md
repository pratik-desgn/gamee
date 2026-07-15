# Gamee — Frontend

## Stack
- **Framework:** Next.js 15 + React 19
- **Styling:** Tailwind CSS
- **Wallet:** @solana/wallet-adapter (Phantom first)
- **State:** Zustand (lightweight)
- **WebSocket:** Native WebSocket API

## Pages

| Page | Route | Stage |
|------|-------|-------|
| Landing / Live Jackpot | / | 2 |
| Connect Wallet | /connect | 2 |
| Buy Ticket | /ticket | 2 |
| Spin Wheel | /spin | 2 |
| Game | /play/:sessionId | 2 |
| Result | /result/:sessionId | 2 |
| Leaderboard | /leaderboard | 4 |
| Profile | /profile | 4 |
| History | /history | 4 |
| Referral | /referral | 4 |
| Achievements | /achievements | 4 |

## Development

```bash
npx create-next-app@latest frontend --typescript --tailwind
cd frontend
npm run dev
```
