import type { JackpotState, GameSession, SpinResult, Ticket, LeaderboardEntry, GameResult, GameMeta } from '@/types';
import type { JackpotTier } from '@/lib/tiers';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

/**
 * The Go backend's JSON responses are snake_case throughout (e.g.
 * `games_played`, `current_amount`) while the frontend types are camelCase
 * (e.g. `gamesPlayed`, `currentAmount`) — every response needs converting,
 * or every underscore field renders as `undefined`. Applied once here
 * instead of reconciling field names in every type/model pair.
 */
function snakeToCamelDeep<T>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map((item) => snakeToCamelDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      result[camelKey] = snakeToCamelDeep(val);
    }
    return result as T;
  }
  return value as T;
}

const TOKEN_STORAGE_KEY = 'gamee_jwt';
const TOKEN_WALLET_STORAGE_KEY = 'gamee_jwt_wallet';

class ApiClient {
  // Seeded from sessionStorage so a page refresh doesn't force re-signing;
  // sessionStorage (not localStorage) so the JWT doesn't outlive the tab.
  private token: string | null =
    typeof window !== 'undefined' ? sessionStorage.getItem(TOKEN_STORAGE_KEY) : null;

  setToken(token: string, wallet: string) {
    this.token = token;
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      sessionStorage.setItem(TOKEN_WALLET_STORAGE_KEY, wallet);
    }
  }

  clearToken() {
    this.token = null;
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      sessionStorage.removeItem(TOKEN_WALLET_STORAGE_KEY);
    }
  }

  /** Returns the wallet address the cached token (if any) was issued for. */
  getTokenWallet(): string | null {
    return typeof window !== 'undefined' ? sessionStorage.getItem(TOKEN_WALLET_STORAGE_KEY) : null;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  /**
   * Returns the current JWT for callers that need to authenticate a raw
   * WebSocket connection (the browser WebSocket API can't set an
   * Authorization header, so it must go as a `?token=` query param instead
   * — the backend's AuthMiddleware already accepts that fallback).
   */
  getToken(): string | null {
    return this.token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${res.status}: ${err}`);
    }
    return snakeToCamelDeep<T>(await res.json());
  }

  // Auth
  async getNonce(wallet: string): Promise<{ nonce: string; message: string }> {
    return this.request('/api/v1/auth/nonce', {
      method: 'POST',
      body: JSON.stringify({ wallet }),
    });
  }

  async verifySignature(wallet: string, signature: string, nonce: string): Promise<{ token: string; user: { id: string } }> {
    return this.request('/api/v1/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ wallet, signature, nonce }),
    });
  }

  // Tickets
  // `tier` is optional and defaults to small server-side when omitted (see
  // backend/internal/jackpot/tiers.go) — only sent when the caller picked a
  // non-default tier so callers that don't know about tiers keep working.
  async confirmTicket(txSignature: string, tier?: JackpotTier): Promise<{ ticket: Ticket }> {
    return this.request('/api/v1/tickets/confirm', {
      method: 'POST',
      body: JSON.stringify({ tx_signature: txSignature, ...(tier ? { tier } : {}) }),
    });
  }

  // Beta only: asks the devnet faucet to fund the authed wallet with test
  // SOL + USDC. 404s unless the backend runs with BETA_FAUCET=true.
  async requestFaucet(): Promise<{ tx: string; sol: number; usdc: number }> {
    return this.request('/api/v1/beta/faucet', { method: 'POST' });
  }

  async getMyTickets(status?: string): Promise<{ tickets: Ticket[]; total: number }> {
    const params = status ? `?status=${status}` : '';
    return this.request(`/api/v1/tickets/mine${params}`);
  }

  // Game Sessions
  async spin(ticketId: string): Promise<SpinResult> {
    return this.request('/api/v1/spin', {
      method: 'POST',
      body: JSON.stringify({ ticket_id: ticketId }),
    });
  }

  async finishSession(sessionId: string, inputLog: unknown[], clientScore: number): Promise<{ verdict: string; queued: boolean }> {
    return this.request(`/api/v1/session/${sessionId}/finish`, {
      method: 'POST',
      body: JSON.stringify({ input_log: inputLog, client_score: clientScore }),
    });
  }

  async getSessionResult(sessionId: string): Promise<GameResult> {
    return this.request(`/api/v1/session/${sessionId}/result`);
  }

  // Jackpot
  async getJackpot(): Promise<JackpotState> {
    // request() already camelizes the backend's snake_case response — only
    // the unit conversion is left to do here: current_amount arrives in
    // micro-USDC and the UI only ever sees whole USDC. (This method used
    // to read raw.current_amount / raw.today_plays etc. off the
    // already-camelized object — every field came back undefined and the
    // homepage crashed on todayPlays.toLocaleString() during hydration.)
    const raw = await this.request<JackpotState>('/api/v1/live');
    return {
      ...raw,
      currentAmount: (raw.currentAmount ?? 0) / 1_000_000,
      playersOnline: raw.playersOnline ?? 0,
      todayPlays: raw.todayPlays ?? 0,
    };
  }

  // Leaderboard
  async getLeaderboard(scope: string = 'alltime', limit: number = 100): Promise<{ entries: LeaderboardEntry[] }> {
    return this.request(`/api/v1/leaderboard/${scope}?limit=${limit}`);
  }

  // Games
  async getGames(): Promise<{ games: GameMeta[] }> {
    return this.request('/api/v1/games');
  }

  // User
  async getUserHistory(): Promise<{ sessions: GameSession[] }> {
    return this.request('/api/v1/me/history');
  }

  async getUserStats(): Promise<{ stats: unknown }> {
    return this.request('/api/v1/me/stats');
  }
}

export const apiClient = new ApiClient();
