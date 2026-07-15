import type { JackpotGame, GameState, DifficultyParams, TimestampedInput } from '../../sdk/interface.js';
import { SeededRNG } from '../../sdk/engine.js';

// ─── Constants ────────────────────────────────────────────────

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 400;
export const DEFAULT_MIN_WAIT_MS = 2000;
export const DEFAULT_MAX_WAIT_MS = 5000;
export const DEFAULT_ROUNDS = 5;
export const DEFAULT_TARGET_REACTION_MS = 300;
export const FRAME_MS = 16; // ~60 FPS

// ─── Interfaces ───────────────────────────────────────────────

export interface ReactionTestDifficulty {
  minWaitMs: number;    // fixed 2000ms — see difficultyFromParams
  maxWaitMs: number;    // fixed 5000ms — see difficultyFromParams
  rounds: number;       // 3–10 rounds to complete
  targetReactionMs: number; // 200–500 ms target — win if avg < this
}

export interface ReactionTestDisplay {
  state: 'waiting' | 'signal' | 'finished';
  round: number;
  totalRounds: number;
  reactionTime: number | null; // ms of last reaction (null if not yet reacted)
  lastReactionTime: number | null;
  reactionTimes: number[];
  averageReaction: number;
  waitingProgress: number; // 0-1, how far through the wait
  waitingForSignal: boolean;
  showSignal: boolean;
  won: boolean;
  frame: number;
}

// ─── Difficulty presets ───────────────────────────────────────

function difficultyFromParams(diff: DifficultyParams): ReactionTestDifficulty {
  const level = diff.level;
  // Wait before the signal: always a random 2-5s regardless of level (a
  // literal, fixed spec — not a difficulty lever). Difficulty instead
  // comes entirely from targetReactionMs (the actual skill threshold) and
  // rounds below; varying the wait window by level would just make the
  // signal's arrival time itself a predictable "tell" at some levels,
  // which undermines the whole point of a reaction test.
  const minWaitMs = DEFAULT_MIN_WAIT_MS;
  const maxWaitMs = DEFAULT_MAX_WAIT_MS;
  // rounds: 3 at level 1 → 10 at level 10
  const rounds = Math.min(10, Math.max(3, Math.round(3 + (level - 1) * (7 / 9))));
  // targetReactionMs: 500 at level 1 → 200 at level 10
  const targetReactionMs = Math.max(200, Math.round(500 - (level - 1) * (300 / 9)));

  const d = diff.params;
  return {
    minWaitMs: d.minWaitMs ?? minWaitMs,
    maxWaitMs: d.maxWaitMs ?? maxWaitMs,
    rounds: d.rounds ?? rounds,
    targetReactionMs: d.targetReactionMs ?? targetReactionMs,
  };
}

// ─── ReactionTestGame ─────────────────────────────────────────

export class ReactionTestGame implements JackpotGame {
  private rng!: SeededRNG;
  private difficulty!: ReactionTestDifficulty;

  private state: 'waiting' | 'signal' | 'finished' = 'waiting';
  private round: number = 1;
  private reactionTimes: number[] = [];
  private lastReactionTime: number | null = null;
  private frameCount: number = 0;
  private waitFrames: number = 0; // frames remaining before signal
  private signalElapsedFrames: number = 0; // frames since signal appeared
  private reactionCaptured: boolean = false;
  private finished: boolean = false;
  private won: boolean = false;
  private falseStart: boolean = false;

  // Store the target wait duration so serialization is consistent
  private currentWaitMs: number = 0;

  init(seed: string, difficulty: DifficultyParams): void {
    this.rng = new SeededRNG(seed);
    this.difficulty = difficultyFromParams(difficulty);

    this.state = 'waiting';
    this.round = 1;
    this.reactionTimes = [];
    this.lastReactionTime = null;
    this.frameCount = 0;
    this.signalElapsedFrames = 0;
    this.reactionCaptured = false;
    this.finished = false;
    this.won = false;
    this.falseStart = false;

    this.scheduleNextWait();
  }

  onInput(input: TimestampedInput): void {
    if (this.finished) return;

    const isAction =
      input.type === 'tap' || input.type === 'click' || input.type === 'keydown';
    if (!isAction) return;

    // Only respond to spacebar, or any tap/click
    if (input.type === 'keydown') {
      const key = typeof input.data.key === 'string' ? input.data.key : '';
      if (key !== ' ' && key !== 'Space') return;
    }

    if (this.state === 'waiting') {
      // False start! Player reacted before signal
      this.falseStart = true;
      this.finished = true;
      this.state = 'finished';
    } else if (this.state === 'signal') {
      if (!this.reactionCaptured) {
        const reactionMs = this.signalElapsedFrames * FRAME_MS;
        this.reactionTimes.push(reactionMs);
        this.lastReactionTime = reactionMs;
        this.reactionCaptured = true;

        // Check if we've completed all rounds
        if (this.round >= this.difficulty.rounds) {
          this.finished = true;
          this.state = 'finished';
          const avg = this.averageReactionTime();
          this.won = avg < this.difficulty.targetReactionMs;
        } else {
          // Advance to next round
          this.round++;
          this.scheduleNextWait();
        }
      }
    }
  }

  tick(): void {
    if (this.finished) return;

    this.frameCount++;

    if (this.state === 'waiting') {
      this.waitFrames--;

      if (this.waitFrames <= 0) {
        // Signal time!
        this.state = 'signal';
        this.signalElapsedFrames = 0;
        this.reactionCaptured = false;
      }
    } else if (this.state === 'signal') {
      this.signalElapsedFrames++;

      // Auto-fail if no reaction within 3 seconds (180 frames ≈ 3s)
      if (this.signalElapsedFrames > 180 && !this.reactionCaptured) {
        this.finished = true;
        this.state = 'finished';
        this.won = false;
      }
    }
  }

  private scheduleNextWait(): void {
    const waitMs = Math.round(
      this.rng.nextFloat(this.difficulty.minWaitMs, this.difficulty.maxWaitMs + 1),
    );
    this.currentWaitMs = waitMs;
    this.waitFrames = Math.max(1, Math.round(waitMs / FRAME_MS));
    this.state = 'waiting';
    this.reactionCaptured = false;
  }

  private averageReactionTime(): number {
    if (this.reactionTimes.length === 0) return Infinity;
    const sum = this.reactionTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.reactionTimes.length);
  }

  getState(): GameState {
    const avg = this.averageReactionTime();

    return {
      score: this.finished && this.won ? Math.round(this.difficulty.targetReactionMs - avg) : 0,
      finished: this.finished,
      won: this.won,
      targetScore: this.difficulty.targetReactionMs,
      frame: this.frameCount,
      display: {
        state: this.state,
        round: this.round,
        totalRounds: this.difficulty.rounds,
        reactionTime: this.lastReactionTime,
        reactionTimes: this.reactionTimes,
        averageReaction: avg,
        waitingProgress: this.state === 'waiting'
          ? 1 - (this.waitFrames * FRAME_MS / this.currentWaitMs)
          : 1,
        waitingForSignal: this.state === 'waiting',
        showSignal: this.state === 'signal',
        won: this.won,
        frame: this.frameCount,
      },
    };
  }

  isFinished(): boolean {
    return this.finished;
  }

  finalScore(): number {
    // Must match getState().score exactly — this is what the replay
    // verifier compares against the client-submitted score (worker.go's
    // determineVerdict), and every other game keeps finalScore() equal to
    // getState().score. Returning the raw average reaction time here (the
    // old behavior) used a different scale than the points-based score the
    // client reports, so every legitimate reaction-test win came back as a
    // client/server score "mismatch" and never settled.
    const avg = this.averageReactionTime();
    return this.finished && this.won ? Math.round(this.difficulty.targetReactionMs - avg) : 0;
  }

  serializeState(): string {
    return JSON.stringify({
      state: this.state,
      round: this.round,
      reactionTimes: this.reactionTimes,
      lastReactionTime: this.lastReactionTime,
      frameCount: this.frameCount,
      waitFrames: this.waitFrames,
      currentWaitMs: this.currentWaitMs,
      signalElapsedFrames: this.signalElapsedFrames,
      reactionCaptured: this.reactionCaptured,
      finished: this.finished,
      won: this.won,
      falseStart: this.falseStart,
      difficulty: this.difficulty,
    });
  }

  /** Move directly to signal state (for testing) */
  _forceSignal(): void {
    this.state = 'signal';
    this.signalElapsedFrames = 0;
    this.reactionCaptured = false;
  }

  /** Complete current round and advance to next (for testing) */
  _completeRound(): void {
    if (this.state === 'signal' && !this.reactionCaptured) {
      this.reactionCaptured = true;
      this.lastReactionTime = 150;
      this.reactionTimes.push(150);
      if (this.round >= this.difficulty.rounds) {
        this.finished = true;
        this.state = 'finished';
        const avg = this.averageReactionTime();
        this.won = avg < this.difficulty.targetReactionMs;
      } else {
        this.round++;
        this.scheduleNextWait();
      }
    }
  }

  _getState(): string {
    return this.state;
  }

  _getRound(): number {
    return this.round;
  }

  _getReactionTimes(): number[] {
    return [...this.reactionTimes];
  }

  _getDifficulty(): ReactionTestDifficulty {
    return { ...this.difficulty };
  }

  _getWaitFrames(): number {
    return this.waitFrames;
  }
}
