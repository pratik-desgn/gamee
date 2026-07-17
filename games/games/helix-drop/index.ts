import type { JackpotGame, GameState, DifficultyParams, TimestampedInput } from '../../sdk/interface.js';
import { SeededRNG } from '../../sdk/engine.js';

// ─── Constants ────────────────────────────────────────────────

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 600;
export const PLATFORM_SPACING = 60; // px between platform levels
export const BALL_RADIUS = 8;
export const HELIX_CENTER_X = CANVAS_WIDTH / 2;
export const PLATFORM_THICKNESS = 6;
export const MAX_FRAMES = 36000;

// ─── Interfaces ───────────────────────────────────────────────

export interface HelixDropDifficulty {
  platformCount: number;  // 10–100
  rotationSpeed: number;  // 1–5 deg/frame
  gapWidth: number;       // 30–90 degrees
  dropSpeed: number;      // 1–5 px/frame
  targetScore: number;    // platforms to pass to win
  hazardWidth: number;    // 30–90 degrees of deadly zone adjacent to the gap
}

export interface HelixPlatform {
  y: number;
  gapAngle: number;    // center of the gap in degrees (0–360)
  gapWidth: number;    // width of the gap in degrees
  hazardAngle: number; // center of the deadly zone (adjacent to the gap)
  hazardWidth: number; // width of the deadly zone in degrees
  checked: boolean;    // whether ball has already fallen through this platform
}

export interface Ball {
  y: number;
  angle: number;  // always 0 — ball drops straight down the front
}

export interface HelixDropDisplay {
  helixRotation: number;       // cumulative rotation (degrees)
  platforms: Array<{ y: number; gapAngle: number; gapWidth: number; hazardAngle: number; hazardWidth: number }>;
  ball: { y: number };
  score: number;
  frame: number;
  platformSpacing: number;
  helixCenterX: number;
}

// ─── Helpers ──────────────────────────────────────────────────

/** Check whether an angle (degrees) falls within the gap defined by gapCenter ± gapWidth/2 */
export function isAngleInGap(angle: number, gapCenter: number, gapWidth: number): boolean {
  const half = gapWidth / 2;
  let start = ((gapCenter - half) % 360 + 360) % 360;
  const end = (gapCenter + half) % 360;

  // Normalize angle to [0, 360)
  const a = ((angle % 360) + 360) % 360;

  if (start <= end) {
    return a >= start && a <= end;
  } else {
    // Gap wraps around 0°
    return a >= start || a <= end;
  }
}

// ─── Difficulty presets ───────────────────────────────────────

function difficultyFromParams(diff: DifficultyParams): HelixDropDifficulty {
  const level = diff.level;
  // platformCount: 10 at level 1 → 100 at level 10
  const platformCount = Math.round(10 + (level - 1) * (90 / 9));
  // rotationSpeed: 1 at level 1 → 5 at level 10 (faster rotation needed)
  const rotationSpeed = 1 + (level - 1) * (4 / 9);
  // gapWidth: 90 at level 1 → 30 at level 10 (tighter gaps at higher difficulty)
  const gapWidth = Math.round(90 - (level - 1) * (60 / 9));
  // dropSpeed: 1 at level 1 → 5 at level 10
  const dropSpeed = 1 + (level - 1) * (4 / 9);
  // targetScore: ~40% at level 1 → ~80% at level 10
  const targetScore = Math.round(platformCount * (0.4 + (level - 1) * (0.4 / 9)));
  // hazardWidth: 30° at level 1 → 50° at level 10 (bigger death zone —
  // less room for sloppy rotation). Hard-capped at 50°: after a pass the
  // ball falls PLATFORM_SPACING px while the player steers the landing
  // angle, so the reachable landing arc is rotationSpeed × (spacing /
  // dropSpeed) = 60° at every level (both knobs scale identically) minus
  // up to ~2 ticks of pass/landing quantization. The original 30→90°
  // scale let a single platform's hazard cover that whole arc — a forced
  // death no input sequence could avoid (~5% of platforms at level 8,
  // compounding to a ~6% ceiling on the win probability of PERFECT play
  // across a 57-platform target). A death zone must be dodgeable to be a
  // skill mechanic; 50° leaves ≥10° of always-reachable safe arc.
  const hazardWidth = Math.min(50, Math.round(30 + (level - 1) * (60 / 9)));

  // Allow explicit params to override
  const d = diff.params;
  return {
    platformCount: d.platformCount ?? platformCount,
    rotationSpeed: d.rotationSpeed ?? Math.round(rotationSpeed * 10) / 10,
    gapWidth: d.gapWidth ?? gapWidth,
    dropSpeed: d.dropSpeed ?? Math.round(dropSpeed * 10) / 10,
    targetScore: d.targetScore ?? targetScore,
    hazardWidth: d.hazardWidth ?? hazardWidth,
  };
}

// ─── HelixDropGame ────────────────────────────────────────────

export class HelixDropGame implements JackpotGame {
  private rng!: SeededRNG;
  private difficulty!: HelixDropDifficulty;
  private platforms: HelixPlatform[] = [];
  private ball!: Ball;
  private score: number = 0;
  private frame: number = 0;
  private finished: boolean = false;
  private won: boolean = false;
  private nextPlatformIndex: number = 0;
  private helixRotation: number = 0;
  private rotatingLeft: boolean = false;
  private rotatingRight: boolean = false;

  init(seed: string, difficulty: DifficultyParams): void {
    this.rng = new SeededRNG(seed);
    this.difficulty = difficultyFromParams(difficulty);
    this.score = 0;
    this.frame = 0;
    this.finished = false;
    this.won = false;
    this.nextPlatformIndex = 0;
    this.helixRotation = 0;
    this.rotatingLeft = false;
    this.rotatingRight = false;

    this.ball = {
      y: 0,
      angle: 0,
    };

    // Generate platforms with random gap positions. The gap and its
    // adjacent hazard are re-rolled (bounded, deterministic — same seed,
    // same layout) until neither covers the ball's angle (0°) at the
    // initial rotation: a zero-input session must neither score a single
    // platform by luck nor die on spawn — every pass and every death is
    // the result of the player's own rotation.
    this.platforms = [];
    for (let i = 0; i < this.difficulty.platformCount; i++) {
      // Stagger platform Y positions down the tower
      const y = PLATFORM_SPACING + i * PLATFORM_SPACING;
      let gapAngle = 0;
      let hazardAngle = 0;
      for (let attempt = 0; attempt < 64; attempt++) {
        gapAngle = this.rng.nextFloat(0, 360);
        // Hazard sits flush against a random side of the gap.
        const side = this.rng.nextFloat(0, 1) < 0.5 ? -1 : 1;
        hazardAngle = ((gapAngle + side * (this.difficulty.gapWidth / 2 + this.difficulty.hazardWidth / 2)) % 360 + 360) % 360;
        const spawnSafe =
          !isAngleInGap(0, gapAngle, this.difficulty.gapWidth) &&
          !isAngleInGap(0, hazardAngle, this.difficulty.hazardWidth);
        if (spawnSafe) break;
      }
      this.platforms.push({
        y,
        gapAngle,
        gapWidth: this.difficulty.gapWidth,
        hazardAngle,
        hazardWidth: this.difficulty.hazardWidth,
        checked: false,
      });
    }
  }

  onInput(input: TimestampedInput): void {
    if (this.finished) return;

    // Keyboard controls for continuous rotation
    if (input.type === 'keydown') {
      const key = input.data.key as string;
      if (key === 'ArrowLeft') {
        this.rotatingLeft = true;
      } else if (key === 'ArrowRight') {
        this.rotatingRight = true;
      }
    } else if (input.type === 'keyup') {
      const key = input.data.key as string;
      if (key === 'ArrowLeft') {
        this.rotatingLeft = false;
      } else if (key === 'ArrowRight') {
        this.rotatingRight = false;
      }
    }

    // Tap/drag controls for single rotation
    if (input.type === 'tap' || input.type === 'click') {
      const direction = input.data.direction as string;
      if (direction === 'left') {
        this.helixRotation = ((this.helixRotation - this.difficulty.rotationSpeed) % 360 + 360) % 360;
      } else if (direction === 'right') {
        this.helixRotation = ((this.helixRotation + this.difficulty.rotationSpeed) % 360 + 360) % 360;
      }
    }
  }

  tick(): void {
    if (this.finished) return;
    this.frame++;

    // 0. Idle timeout: a resting ball with no further input must still
    //    end (as a loss).
    if (this.frame >= MAX_FRAMES) {
      this.finished = true;
      this.won = false;
      return;
    }

    // 1. Apply continuous rotation
    if (this.rotatingLeft) {
      this.helixRotation = ((this.helixRotation - this.difficulty.rotationSpeed) % 360 + 360) % 360;
    }
    if (this.rotatingRight) {
      this.helixRotation = ((this.helixRotation + this.difficulty.rotationSpeed) % 360 + 360) % 360;
    }

    // 2. All platforms passed → terminal (score has already counted each)
    if (this.nextPlatformIndex >= this.platforms.length) {
      this.won = this.score >= this.difficulty.targetScore;
      this.finished = true;
      return;
    }

    // 3. Move ball downward, resting on the next platform unless the gap
    //    is under it. Skill model (genre-standard "Helix Jump"): the ball
    //    RESTS on solid platform until the player rotates the gap
    //    underneath — falling through the gap IS the pass (+1). Rotating
    //    the adjacent hazard zone under a resting ball (or dropping onto
    //    it) is death. Nothing advances without player rotation, so a
    //    zero-input run can never score (see init's spawn-safe layout) —
    //    it simply rests until the MAX_FRAMES loss above.
    const platform = this.platforms[this.nextPlatformIndex];
    const newY = this.ball.y + this.difficulty.dropSpeed;
    if (newY < platform.y) {
      // Free fall between platforms.
      this.ball.y = newY;
      return;
    }

    // Ball is at the platform (falling onto it, or resting from a
    // previous tick): evaluate the segment under the ball this frame.
    this.ball.y = platform.y;
    const effectiveGapCenter = ((platform.gapAngle + this.helixRotation) % 360 + 360) % 360;
    const effectiveHazardCenter = ((platform.hazardAngle + this.helixRotation) % 360 + 360) % 360;

    if (isAngleInGap(this.ball.angle, effectiveGapCenter, platform.gapWidth)) {
      // Gap under the ball → falls through: pass.
      platform.checked = true;
      this.nextPlatformIndex++;
      this.score++;
      if (this.score >= this.difficulty.targetScore) {
        this.won = true;
        this.finished = true;
      }
      return;
    }
    if (isAngleInGap(this.ball.angle, effectiveHazardCenter, platform.hazardWidth)) {
      // Hazard zone under the ball → death.
      this.finished = true;
      this.won = false;
      return;
    }
    // Solid platform → rest; the player must rotate the gap here without
    // sweeping the hazard past first.
  }

  getState(): GameState {
    return {
      score: this.score,
      finished: this.finished,
      won: this.won,
      targetScore: this.difficulty.targetScore,
      frame: this.frame,
      display: {
        helixRotation: this.helixRotation,
        platforms: this.platforms.map(p => ({
          y: p.y,
          gapAngle: p.gapAngle,
          gapWidth: p.gapWidth,
          hazardAngle: p.hazardAngle,
          hazardWidth: p.hazardWidth,
        })),
        ball: { y: this.ball.y },
        score: this.score,
        frame: this.frame,
        platformSpacing: PLATFORM_SPACING,
        helixCenterX: HELIX_CENTER_X,
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
      platforms: this.platforms,
      ball: this.ball,
      helixRotation: this.helixRotation,
      score: this.score,
      finished: this.finished,
      won: this.won,
      frame: this.frame,
    });
  }

  /** Exposed for test access */
  _getPlatforms(): HelixPlatform[] {
    return this.platforms.map(p => ({ ...p }));
  }

  /** Exposed for test access */
  _getBall(): Ball {
    return { ...this.ball };
  }

  /** Exposed for test access */
  _getDifficulty(): HelixDropDifficulty {
    return { ...this.difficulty };
  }

  /** Exposed for test access */
  _getHelixRotation(): number {
    return this.helixRotation;
  }
}
