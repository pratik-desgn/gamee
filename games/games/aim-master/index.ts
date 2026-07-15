import type { JackpotGame, GameState, DifficultyParams, TimestampedInput } from '../../sdk/interface.js';
import { SeededRNG } from '../../sdk/engine.js';

// ─── Constants ────────────────────────────────────────────────

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 600;
export const PADDING = 50; // keep targets away from edges
export const MAX_FRAMES = 36000; // 10 minutes at 60fps

// ─── Interfaces ───────────────────────────────────────────────

export interface AimMasterDifficulty {
  targetCount: number;   // 5–20
  targetRadius: number;  // 15–40 px
  timeLimit: number;     // 10–60 seconds
  targetSpeed: number;   // 0–3 px/frame
  shrinkRate: number;    // 0–0.05 per frame
  targetScore: number;   // targets needed to win
}

export interface Target {
  x: number;
  y: number;
  radius: number;
  active: boolean;
  speedX: number;
  speedY: number;
}

export interface AimMasterDisplay {
  targets: Array<{ x: number; y: number; radius: number; active: boolean }>;
  score: number;
  timeLeft: number;
  targetsRemaining: number;
  missStreak: number;
  frame: number;
}

// ─── Difficulty presets ───────────────────────────────────────

function difficultyFromParams(diff: DifficultyParams): AimMasterDifficulty {
  const level = diff.level;
  // targetCount: 5 at level 1 → 20 at level 10
  const targetCount = Math.round(5 + (level - 1) * (15 / 9));
  // targetRadius: 40 at level 1 → 15 at level 10
  const targetRadius = Math.round(40 - (level - 1) * (25 / 9));
  // timeLimit: 60s at level 1 → 10s at level 10
  const timeLimit = Math.round(60 - (level - 1) * (50 / 9));
  // targetSpeed: 0 at level 1 → 3 at level 10
  const targetSpeed = Math.round(((level - 1) * (3 / 9)) * 100) / 100;
  // shrinkRate: 0 at level 1 → 0.05 at level 10
  const shrinkRate = Math.round(((level - 1) * (0.05 / 9)) * 1000) / 1000;
  // targetScore: ~70% of targets at level 1, ~50% at level 10
  const targetScore = Math.max(1, Math.round(targetCount * (0.7 - (level - 1) * (0.2 / 9))));

  // Allow explicit params to override
  const d = diff.params;
  return {
    targetCount: d.targetCount ?? targetCount,
    targetRadius: d.targetRadius ?? targetRadius,
    timeLimit: d.timeLimit ?? timeLimit,
    targetSpeed: d.targetSpeed ?? targetSpeed,
    shrinkRate: d.shrinkRate ?? shrinkRate,
    targetScore: d.targetScore ?? targetScore,
  };
}

// ─── AimMasterGame ────────────────────────────────────────────

export class AimMasterGame implements JackpotGame {
  private rng!: SeededRNG;
  private difficulty!: AimMasterDifficulty;
  private targets: Target[] = [];
  private score: number = 0;
  private frame: number = 0;
  private finished: boolean = false;
  private won: boolean = false;
  private maxFrames: number = 0;
  private totalTargets: number = 0;
  // Consecutive misses (clicks that hit no active target), reset to 0 on
  // any hit. Without a penalty, spamming clicks everywhere costs nothing
  // and out-aims deliberate play by brute force. Each additional
  // consecutive miss shrinks every remaining target a little more than
  // the last, so a spam burst measurably costs you targets — a slow,
  // aimed miss here and there barely matters (streak resets on the next
  // hit), but rapid blind clicking is actively self-defeating.
  private missStreak: number = 0;
  private static readonly MISS_SHRINK_PER_STREAK = 1.5;

  init(seed: string, difficulty: DifficultyParams): void {
    this.rng = new SeededRNG(seed);
    this.difficulty = difficultyFromParams(difficulty);
    this.score = 0;
    this.frame = 0;
    this.finished = false;
    this.won = false;
    this.targets = [];
    this.missStreak = 0;
    this.maxFrames = this.difficulty.timeLimit * 60; // seconds → frames (60fps)
    this.totalTargets = this.difficulty.targetCount;

    const count = this.difficulty.targetCount;
    const radius = this.difficulty.targetRadius;
    const speed = this.difficulty.targetSpeed;

    for (let i = 0; i < count; i++) {
      const x = Math.round(this.rng.nextFloat(PADDING + radius, CANVAS_WIDTH - PADDING - radius));
      const y = Math.round(this.rng.nextFloat(PADDING + radius, CANVAS_HEIGHT - PADDING - radius));

      let speedX = 0;
      let speedY = 0;
      if (speed > 0) {
        const angle = this.rng.nextFloat(0, Math.PI * 2);
        speedX = Math.cos(angle) * speed;
        speedY = Math.sin(angle) * speed;
      }

      this.targets.push({
        x, y,
        radius,
        active: true,
        speedX,
        speedY,
      });
    }
  }

  onInput(input: TimestampedInput): void {
    if (this.finished) return;

    if (input.type === 'click' || input.type === 'tap') {
      const clickX = input.data.x as number | undefined;
      const clickY = input.data.y as number | undefined;
      if (clickX == null || clickY == null) return;

      // Check targets in order — hit the first active one under cursor
      for (const target of this.targets) {
        if (!target.active) continue;
        const dx = clickX - target.x;
        const dy = clickY - target.y;
        if (dx * dx + dy * dy <= target.radius * target.radius) {
          target.active = false;
          this.score++;
          this.missStreak = 0;
          if (this.score >= this.difficulty.targetScore || this.score >= this.totalTargets) {
            this.won = true;
            this.finished = true;
          }
          return; // one hit per click
        }
      }

      // Missed every active target — escalating shrink penalty (see
      // missStreak's doc comment). Checked for a game-ending "ran out of
      // targets" state right after, same as the natural per-tick shrink.
      this.missStreak++;
      const penalty = this.missStreak * AimMasterGame.MISS_SHRINK_PER_STREAK;
      let anyActive = false;
      for (const target of this.targets) {
        if (!target.active) continue;
        target.radius -= penalty;
        if (target.radius <= 0) {
          target.active = false;
        } else {
          anyActive = true;
        }
      }
      if (!anyActive && this.score < this.difficulty.targetScore) {
        this.finished = true;
        this.won = false;
      }
    }
  }

  tick(): void {
    if (this.finished) return;
    this.frame++;

    const shrinkRate = this.difficulty.shrinkRate;
    const speed = this.difficulty.targetSpeed;

    for (const target of this.targets) {
      if (!target.active) continue;

      // Shrink
      if (shrinkRate > 0) {
        target.radius -= shrinkRate;
        if (target.radius <= 0) {
          target.active = false;
          continue;
        }
      }

      // Move
      if (speed > 0) {
        target.x += target.speedX;
        target.y += target.speedY;

        // Bounce off walls
        if (target.x - target.radius < PADDING) {
          target.x = PADDING + target.radius;
          target.speedX = Math.abs(target.speedX);
        } else if (target.x + target.radius > CANVAS_WIDTH - PADDING) {
          target.x = CANVAS_WIDTH - PADDING - target.radius;
          target.speedX = -Math.abs(target.speedX);
        }
        if (target.y - target.radius < PADDING) {
          target.y = PADDING + target.radius;
          target.speedY = Math.abs(target.speedY);
        } else if (target.y + target.radius > CANVAS_HEIGHT - PADDING) {
          target.y = CANVAS_HEIGHT - PADDING - target.radius;
          target.speedY = -Math.abs(target.speedY);
        }
      }
    }

    // Check win: all targets hit
    if (this.score >= this.totalTargets) {
      this.won = true;
      this.finished = true;
      return;
    }

    // Every target gone (all shrunk away or hit) without reaching the
    // score threshold — end immediately as a loss instead of leaving the
    // player staring at an empty field until the time limit finally runs
    // out (the target count was well short of the win threshold, so this
    // can only be a loss).
    if (this.targets.every(t => !t.active) && this.score < this.difficulty.targetScore) {
      this.finished = true;
      this.won = false;
      return;
    }

    // Check time out
    if (this.frame >= this.maxFrames) {
      this.finished = true;
      return;
    }

    // Safety: max frames
    if (this.frame >= MAX_FRAMES) {
      this.finished = true;
    }
  }

  getState(): GameState {
    const active = this.targets.filter(t => t.active).length;
    const timeLeft = Math.max(0, Math.ceil((this.maxFrames - this.frame) / 60));
    return {
      score: this.score,
      finished: this.finished,
      won: this.won,
      targetScore: this.difficulty.targetScore,
      frame: this.frame,
      display: {
        targets: this.targets.map(t => ({ x: t.x, y: t.y, radius: Math.max(0, t.radius), active: t.active })),
        score: this.score,
        timeLeft,
        targetsRemaining: active,
        missStreak: this.missStreak,
        frame: this.frame,
      },
    };
  }

  isFinished(): boolean {
    return this.finished;
  }

  finalScore(): number {
    return this.score;
  }

  serializeState(): string {
    return JSON.stringify({
      targets: this.targets.map(t => ({
        x: t.x,
        y: t.y,
        radius: Math.max(0, t.radius),
        active: t.active,
        speedX: t.speedX,
        speedY: t.speedY,
      })),
      score: this.score,
      finished: this.finished,
      won: this.won,
      frame: this.frame,
    });
  }

  /** Exposed for test access */
  _getTargets(): Target[] {
    return this.targets.map(t => ({ ...t }));
  }

  /** Exposed for test access */
  _getDifficulty(): AimMasterDifficulty {
    return { ...this.difficulty };
  }
}
