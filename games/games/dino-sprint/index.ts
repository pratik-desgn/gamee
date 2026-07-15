import type { JackpotGame, GameState, DifficultyParams, TimestampedInput } from '../../sdk/interface.js';
import { SeededRNG } from '../../sdk/engine.js';

// ─── Constants ────────────────────────────────────────────────

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 600;
export const GROUND_HEIGHT = 50;
export const DINO_RADIUS = 12;
export const DINO_X = 80;
export const OBSTACLE_WIDTH = 24;
export const MIN_OBSTACLE_HEIGHT = 30;
export const DEFAULT_OBSTACLE_FREQUENCY = 90; // frames between obstacles
export const MAX_FRAMES = 36000; // 10 minutes at 60fps

// ─── Interfaces ───────────────────────────────────────────────

export interface DinoSprintDifficulty {
  speed: number;            // 2–5 px/frame (ground scroll speed)
  gravity: number;          // px/frame²
  jumpVelocity: number;     // px/frame (negative = up)
  obstacleFrequency: number; // frames between obstacle spawns
  obstacleMaxHeight: number; // max obstacle height (px)
  targetScore: number;      // score needed to "win"
}

export interface Obstacle {
  x: number;
  width: number;
  height: number;
  passed: boolean;
}

export interface Dino {
  x: number;
  y: number;
  velY: number;
  radius: number;
}

export interface DinoSprintDisplay {
  dino: { x: number; y: number; velY: number; radius: number };
  obstacles: Array<{ x: number; width: number; height: number }>;
  score: number;
  frame: number;
  groundY: number;
}

// ─── Difficulty presets ───────────────────────────────────────

function difficultyFromParams(diff: DifficultyParams): DinoSprintDifficulty {
  const level = diff.level;
  // Speed: 2.2 at level 1 → 6 at level 10 (more speed = less reaction
  // time — this is a difficulty lever that's safe to scale hard, since it
  // never threatens whether an obstacle is physically clearable).
  const speed = 2.2 + (level - 1) * (3.8 / 9);
  // Gravity/jumpVelocity/obstacleMaxHeight together determine whether a
  // jump can physically clear the tallest obstacle at a given level: peak
  // jump height is jumpVelocity²/(2·gravity), and it must stay above
  // obstacleMaxHeight + DINO_RADIUS (the dino needs its whole circle, not
  // just its center, above the obstacle top) with real margin — a level
  // that fails this isn't hard, it's impossible. The original formulas
  // (gravity 0.4→0.8, jumpVelocity -10→-6, obstacleMaxHeight 40→70) let
  // peak height fall from 125px to 22.5px while required clearance rose
  // from 52px to 82px — level 5+ was unwinnable by any player (see
  // games/scripts/dino-sprint-bot-check.js). A first fix flattened this to
  // a 140%→31% margin band, which then read as "too easy" — tightened
  // again here to 124%→14%, still empirically confirmed 80/80 wins across
  // all levels with the same bot, just with real timing precision required
  // at the top end instead of huge slack.
  // Gravity: 0.43 at level 1 → 0.55 at level 10
  const gravity = 0.43 + (level - 1) * (0.12 / 9);
  // Jump velocity: -10 at level 1 → -8.8 at level 10
  const jumpVelocity = -10 + (level - 1) * (1.2 / 9);
  // Obstacle frequency: 80 at level 1 → 45 at level 10 (more obstacles —
  // also a safe lever, it doesn't affect single-obstacle clearability)
  const obstacleFrequency = Math.max(45, Math.round(80 - (level - 1) * (35 / 9)));
  // Obstacle max height: 40 at level 1 → 50 at level 10
  const obstacleMaxHeight = Math.round(40 + (level - 1) * (10 / 9));
  // Target score: level * 5
  const targetScore = diff.params.targetScore ?? level * 5;

  // Allow explicit params to override
  const d = diff.params;
  return {
    speed: d.speed ?? Math.round(speed * 10) / 10,
    gravity: d.gravity ?? Math.round(gravity * 100) / 100,
    jumpVelocity: d.jumpVelocity ?? Math.round(jumpVelocity * 10) / 10,
    obstacleFrequency: d.obstacleFrequency ?? obstacleFrequency,
    obstacleMaxHeight: d.obstacleMaxHeight ?? obstacleMaxHeight,
    targetScore: d.targetScore ?? targetScore,
  };
}

// ─── DinoSprintGame ───────────────────────────────────────────

export class DinoSprintGame implements JackpotGame {
  private rng!: SeededRNG;
  private difficulty!: DinoSprintDifficulty;
  private dino!: Dino;
  private obstacles: Obstacle[] = [];
  private score: number = 0;
  private frame: number = 0;
  private finished: boolean = false;
  private won: boolean = false;
  private nextObstacleFrame: number = 0;
  // Obstacles don't start incoming until the first jump — otherwise a new
  // player dies to the first obstacle (~2.2s / 132 frames in) before
  // they've even reacted to the canvas appearing. Same convention as
  // wing-rush's `started` gate.
  private started: boolean = false;

  init(seed: string, difficulty: DifficultyParams): void {
    this.rng = new SeededRNG(seed);
    this.difficulty = difficultyFromParams(difficulty);

    const groundTop = CANVAS_HEIGHT - GROUND_HEIGHT;
    this.dino = {
      x: DINO_X,
      y: groundTop - DINO_RADIUS, // standing on ground
      velY: 0,
      radius: DINO_RADIUS,
    };

    this.obstacles = [];
    this.score = 0;
    this.frame = 0;
    this.finished = false;
    this.won = false;
    this.nextObstacleFrame = Math.round(this.difficulty.obstacleFrequency * 0.5); // first obstacle after initial delay
    this.started = false;
  }

  onInput(input: TimestampedInput): void {
    if (this.finished) return;
    // Only jump if grounded (velY == 0 means on ground)
    if ((input.type === 'tap' || input.type === 'click' || input.type === 'keydown') && this.isGrounded()) {
      this.started = true;
      this.dino.velY = this.difficulty.jumpVelocity;
    }
  }

  tick(): void {
    if (this.finished) return;

    this.frame++;
    // Hold at the start line until the first jump — see `started`'s doc
    // comment. Also re-bases the first obstacle's arrival off the real
    // start time rather than off frame 0, so waiting to start doesn't
    // eat into the reaction window before the first obstacle.
    if (!this.started) {
      this.nextObstacleFrame = this.frame + Math.round(this.difficulty.obstacleFrequency * 0.5);
      // Still subject to the idle timeout below: a session with no input
      // at all must terminate as a loss instead of running forever.
      if (this.frame >= MAX_FRAMES) {
        this.finished = true;
        this.won = false;
      }
      return;
    }

    // 1. Apply physics
    this.dino.velY += this.difficulty.gravity;
    this.dino.y += this.dino.velY;

    // 2. Check ground collision
    const groundTop = CANVAS_HEIGHT - GROUND_HEIGHT;
    const dinoBottom = this.dino.y + DINO_RADIUS;
    if (dinoBottom >= groundTop) {
      this.dino.y = groundTop - DINO_RADIUS;
      this.dino.velY = 0; // land on ground
    }

    // 3. Check ceiling (don't let dino go above canvas)
    if (this.dino.y - DINO_RADIUS < 0) {
      this.dino.y = DINO_RADIUS;
      this.dino.velY = 0;
    }

    // 4. Generate new obstacles
    if (this.frame >= this.nextObstacleFrame) {
      this.spawnObstacle();
      this.nextObstacleFrame = this.frame + this.difficulty.obstacleFrequency;
    }

    // 5. Move obstacles and check collision/score
    const dinoCenter = {
      x: this.dino.x,
      y: this.dino.y,
    };

    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const obs = this.obstacles[i];
      obs.x -= this.difficulty.speed;

      // Remove off-screen obstacles
      if (obs.x + obs.width < 0) {
        this.obstacles.splice(i, 1);
        continue;
      }

      // Check if dino passed the obstacle
      if (!obs.passed && obs.x + obs.width < this.dino.x - DINO_RADIUS) {
        obs.passed = true;
        this.score++;
        if (this.score >= this.difficulty.targetScore) {
          this.won = true;
          this.finished = true;
          return;
        }
      }

      // Collision detection: dino (circle) vs obstacle (rectangle)
      if (this.checkObstacleCollision(dinoCenter, DINO_RADIUS, obs)) {
        this.finished = true;
        return;
      }
    }

    // 6. Max time check
    if (this.frame >= MAX_FRAMES) {
      this.finished = true;
    }
  }

  /** Check if the dino is standing on the ground (used to allow jumps) */
  private isGrounded(): boolean {
    const groundTop = CANVAS_HEIGHT - GROUND_HEIGHT;
    return Math.abs(this.dino.y + DINO_RADIUS - groundTop) < 0.5 && Math.abs(this.dino.velY) < 0.5;
  }

  private spawnObstacle(): void {
    const groundTop = CANVAS_HEIGHT - GROUND_HEIGHT;
    const minHeight = MIN_OBSTACLE_HEIGHT;
    const maxHeight = this.difficulty.obstacleMaxHeight;
    const height = Math.round(this.rng.nextFloat(minHeight, maxHeight + 1));

    // Vary obstacle width slightly for visual variety (between 16 and OBSTACLE_WIDTH)
    const width = Math.round(this.rng.nextFloat(16, OBSTACLE_WIDTH + 1));

    this.obstacles.push({
      x: CANVAS_WIDTH,
      width,
      height,
      passed: false,
    });
  }

  private checkObstacleCollision(
    center: { x: number; y: number },
    radius: number,
    obs: Obstacle,
  ): boolean {
    // Obstacle rectangle sits on the ground
    const groundTop = CANVAS_HEIGHT - GROUND_HEIGHT;
    const obsLeft = obs.x;
    const obsRight = obs.x + obs.width;
    const obsTop = groundTop - obs.height;
    const obsBottom = groundTop;

    const closestX = Math.max(obsLeft, Math.min(center.x, obsRight));
    const closestY = Math.max(obsTop, Math.min(center.y, obsBottom));
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
        dino: { x: this.dino.x, y: this.dino.y, velY: this.dino.velY, radius: DINO_RADIUS },
        obstacles: this.obstacles.map(o => ({ x: o.x, width: o.width, height: o.height })),
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
  _getDino(): Dino {
    return { ...this.dino };
  }

  /** Exposed for test access */
  _getObstacles(): Obstacle[] {
    return this.obstacles.map(o => ({ ...o }));
  }

  /** Exposed for test access */
  _getDifficulty(): DinoSprintDifficulty {
    return { ...this.difficulty };
  }
}
