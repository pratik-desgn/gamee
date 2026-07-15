import type { JackpotGame, GameState, DifficultyParams, TimestampedInput } from '../../sdk/interface.js';
import { SeededRNG } from '../../sdk/engine.js';

// ─── Constants ────────────────────────────────────────────────

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 600;
export const GROUND_HEIGHT = 50;
export const BIRD_SIZE = 20;
export const BIRD_X = 80;
export const PIPE_WIDTH = 60;
export const DEFAULT_PIPE_FREQUENCY = 100; // frames between pipes
export const MAX_FRAMES = 36000; // 10 minutes at 60fps

// ─── Interfaces ───────────────────────────────────────────────

export interface WingRushDifficulty {
  gapSize: number;       // 100–200 px
  speed: number;         // 2–5 px/frame
  gravity: number;       // px/frame²
  flapVelocity: number;  // px/frame (negative = up)
  pipeFrequency: number; // frames between pipes
  targetScore: number;   // score needed to "win"
}

export interface Pipe {
  x: number;
  gapY: number;       // top of the gap opening
  gapSize: number;
  passed: boolean;
}

export interface Bird {
  x: number;
  y: number;
  velY: number;
}

export interface WingRushDisplay {
  bird: { x: number; y: number; velY: number };
  pipes: Array<{ x: number; gapY: number; gapSize: number }>;
  score: number;
  frame: number;
  groundY: number;
}

// ─── Difficulty presets ───────────────────────────────────────

function difficultyFromParams(diff: DifficultyParams): WingRushDifficulty {
  const level = diff.level;
  // Tightened across the board (2026-07-11, second pass — "too easy"):
  // the original curve (gap 200→100, gravity 0.4→0.6, pipes every
  // 100→60 frames) was too forgiving at every level. Unlike dino-sprint's
  // fixed jump arc (a hard physical clearance limit — see that file),
  // this is a continuous-control game: the bird has full-authority
  // vertical control via repeated flaps, so any gap position is always
  // reachable in principle from any prior state given enough flaps —
  // there is no discrete "impossible" threshold to accidentally cross,
  // only "requires better piloting." Re-verified after tightening with a
  // deliberately simple bot (flap whenever below the gap center — see
  // games/scripts/wing-rush-bot-check.js; fancier lookahead/prediction
  // logic tried first scored *worse*, a reminder that a naive bot's
  // failure isn't proof of unfairness for this kind of game): 100%
  // (12/12) through level 7, 92% at level 8, dropping to a real but
  // still-nonzero 42%/25% at levels 9-10 — a genuine difficulty curve,
  // not a wall.
  // gapSize: 155 at level 1 → 88 at level 10 (was 200→100)
  const gapSize = Math.max(88, Math.round(155 - (level - 1) * (67 / 9)));
  // Speed: 2 at level 1 → 5 at level 10 (unchanged)
  const speed = 2 + (level - 1) * (3 / 9);
  // Gravity: 0.5 at level 1 → 0.78 at level 10 (was 0.4→0.6)
  const gravity = 0.5 + (level - 1) * (0.28 / 9);
  // Flap: -8 at level 1 → -6.5 at level 10 (was -8→-7 — weaker at the top end)
  const flapVelocity = -8 + (level - 1) * (1.5 / 9);
  // Pipe frequency: 80 at level 1 → 48 at level 10 (was 100→60)
  const pipeFrequency = Math.max(48, Math.round(80 - (level - 1) * (32 / 9)));

  // Allow explicit params to override
  const d = diff.params;
  return {
    gapSize: d.gapSize ?? gapSize,
    speed: d.speed ?? Math.round(speed * 10) / 10,
    gravity: d.gravity ?? Math.round(gravity * 100) / 100,
    flapVelocity: d.flapVelocity ?? Math.round(flapVelocity * 10) / 10,
    pipeFrequency: d.pipeFrequency ?? pipeFrequency,
    targetScore: d.targetScore ?? level * 5,
  };
}

// ─── WingRushGame ─────────────────────────────────────────────

export class WingRushGame implements JackpotGame {
  private rng!: SeededRNG;
  private difficulty!: WingRushDifficulty;
  private bird!: Bird;
  private pipes: Pipe[] = [];
  private score: number = 0;
  private frame: number = 0;
  private finished: boolean = false;
  private won: boolean = false;
  private nextPipeFrame: number = 0;
  // Gravity and pipes don't move until the first flap — otherwise the bird
  // free-falls from spawn and hits the ground in ~0.5s (31 frames) before a
  // new player has even registered the canvas loaded, let alone reacted.
  // Standard genre convention (every real Flappy Bird clone does this).
  private started: boolean = false;

  init(seed: string, difficulty: DifficultyParams): void {
    this.rng = new SeededRNG(seed);
    this.difficulty = difficultyFromParams(difficulty);
    this.bird = {
      x: BIRD_X,
      y: CANVAS_HEIGHT / 2,
      velY: 0,
    };
    this.pipes = [];
    this.score = 0;
    this.frame = 0;
    this.finished = false;
    this.won = false;
    this.nextPipeFrame = this.difficulty.pipeFrequency; // first pipe after initial delay
    this.started = false;
  }

  onInput(input: TimestampedInput): void {
    if (this.finished) return;
    if (input.type === 'tap' || input.type === 'click' || input.type === 'keydown') {
      this.started = true;
      // Flap: set upward velocity
      this.bird.velY = this.difficulty.flapVelocity;
    }
  }

  tick(): void {
    if (this.finished) return;

    this.frame++;
    // Hold at spawn until the first flap — see `started`'s doc comment.
    // Still subject to the idle timeout below: a session with no input at
    // all must terminate as a loss instead of running forever.
    if (!this.started) {
      if (this.frame >= MAX_FRAMES) {
        this.finished = true;
        this.won = false;
      }
      return;
    }

    // 1. Apply physics
    this.bird.velY += this.difficulty.gravity;
    this.bird.y += this.bird.velY;

    // 2. Check ground / ceiling collision
    const floorY = CANVAS_HEIGHT - GROUND_HEIGHT - BIRD_SIZE;
    if (this.bird.y >= floorY) {
      this.bird.y = floorY;
      this.finished = true;
      return;
    }
    if (this.bird.y <= -BIRD_SIZE) {
      this.bird.y = -BIRD_SIZE;
      this.finished = true;
      return;
    }

    // 3. Generate new pipes
    if (this.frame >= this.nextPipeFrame) {
      this.spawnPipe();
      this.nextPipeFrame = this.frame + this.difficulty.pipeFrequency;
    }

    // 4. Move pipes
    const birdCenter = {
      x: this.bird.x + BIRD_SIZE / 2,
      y: this.bird.y + BIRD_SIZE / 2,
    };
    const birdRadius = BIRD_SIZE / 2;

    for (let i = this.pipes.length - 1; i >= 0; i--) {
      const pipe = this.pipes[i];
      pipe.x -= this.difficulty.speed;

      // Remove off-screen pipes
      if (pipe.x + PIPE_WIDTH < 0) {
        this.pipes.splice(i, 1);
        continue;
      }

      // Check if bird passed the pipe
      if (!pipe.passed && pipe.x + PIPE_WIDTH < this.bird.x) {
        pipe.passed = true;
        this.score++;
        if (this.score >= this.difficulty.targetScore) {
          this.won = true;
          this.finished = true;
          return;
        }
      }

      // Collision detection: bird (circle) vs pipe (two rectangles)
      if (this.checkPipeCollision(birdCenter, birdRadius, pipe)) {
        this.finished = true;
        return;
      }
    }

    // 5. Max time check
    if (this.frame >= MAX_FRAMES) {
      this.finished = true;
    }
  }

  private spawnPipe(): void {
    const minGapY = 80; // top pipe min height
    const maxGapY = CANVAS_HEIGHT - GROUND_HEIGHT - this.difficulty.gapSize - 80; // bottom pipe min height
    const gapY = Math.round(this.rng.nextFloat(minGapY, maxGapY));

    this.pipes.push({
      x: CANVAS_WIDTH,
      gapY,
      gapSize: this.difficulty.gapSize,
      passed: false,
    });
  }

  private checkPipeCollision(
    center: { x: number; y: number },
    radius: number,
    pipe: Pipe,
  ): boolean {
    const pipeLeft = pipe.x;
    const pipeRight = pipe.x + PIPE_WIDTH;

    // Top pipe rectangle
    const topPipeBottom = pipe.gapY;
    // Bottom pipe rectangle
    const bottomPipeTop = pipe.gapY + pipe.gapSize;

    // Check collision with top pipe
    if (this.circleRectCollision(center, radius, pipeLeft, 0, PIPE_WIDTH, topPipeBottom)) {
      return true;
    }
    // Check collision with bottom pipe
    if (this.circleRectCollision(center, radius, pipeLeft, bottomPipeTop, PIPE_WIDTH, CANVAS_HEIGHT - GROUND_HEIGHT - bottomPipeTop)) {
      return true;
    }

    return false;
  }

  private circleRectCollision(
    center: { x: number; y: number },
    radius: number,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
  ): boolean {
    const closestX = Math.max(rx, Math.min(center.x, rx + rw));
    const closestY = Math.max(ry, Math.min(center.y, ry + rh));
    const dx = center.x - closestX;
    const dy = center.y - closestY;
    return dx * dx + dy * dy < radius * radius;
  }

  getState(): GameState {
    return {
      score: this.score,
      finished: this.finished,
      won: this.won,
      targetScore: this.difficulty.targetScore,
      frame: this.frame,
      display: {
        bird: { x: this.bird.x, y: this.bird.y, velY: this.bird.velY },
        pipes: this.pipes.map(p => ({ x: p.x, gapY: p.gapY, gapSize: p.gapSize })),
        score: this.score,
        frame: this.frame,
        groundY: CANVAS_HEIGHT - GROUND_HEIGHT,
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
    return JSON.stringify(this.getState());
  }

  /** Exposed for test access */
  _getBird(): Bird {
    return { ...this.bird };
  }

  /** Exposed for test access */
  _getPipes(): Pipe[] {
    return this.pipes.map(p => ({ ...p }));
  }

  /** Exposed for test access */
  _getDifficulty(): WingRushDifficulty {
    return { ...this.difficulty };
  }
}
