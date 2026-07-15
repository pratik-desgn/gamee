// App TypeScript types
export interface JackpotState {
  currentAmount: number;
  tier: 'small' | 'medium' | 'mega' | 'legend';
  vaultAddress: string;
  playersOnline: number;
  todayPlays: number;
}

export interface Ticket {
  id: string;
  status: 'unused' | 'consumed' | 'expired';
  purchasedAt: string;
  amountUsdc: number;
}

export interface GameSession {
  id: string;
  gameId: string;
  seed: string;
  difficulty: {
    level: number;
    params: Record<string, number>;
  };
  targetScore: number;
  startedAt: string;
  result: 'pending' | 'won' | 'lost' | 'rejected';
  finalScore?: number;
}

// Response shape of POST /api/v1/spin — distinct from GameSession (the
// shape /me/history returns for a *past* session). They share gameId/
// targetScore but otherwise diverge: this has sessionId+fps and no
// id/startedAt/result, so reusing GameSession's `id` field here silently
// typechecked as `undefined` and sent literal "undefined" as the session
// id to /play and /finish.
export interface SpinResult {
  sessionId: string;
  gameId: string;
  seed: string;
  difficulty: {
    level: number;
    params: Record<string, number>;
  };
  targetScore: number;
  fps: number;
}

export interface GameResult {
  sessionId: string;
  verdict: 'pending' | 'won' | 'lost' | 'rejected';
  score?: number;
  payoutTx?: string;
}

export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  gamesPlayed: number;
  wins: number;
  winRate: number;
}

export interface GameMeta {
  id: string;
  name: string;
  category: string;
  difficulty: number;
  enabled: boolean;
}

export interface GameDifficulty {
  level: number;
  params: Record<string, number>;
}

export type TimestampedInput = {
  frame: number;
  type: string;
  data: Record<string, unknown>;
  time: number;
};
