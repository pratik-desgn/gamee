import type { JackpotGame, GameState, DifficultyParams, TimestampedInput } from '../../sdk/interface.js';
import { SeededRNG } from '../../sdk/engine.js';

// ─── Constants ────────────────────────────────────────────────

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 600;
export const STACK_AREA_LEFT = 40;
export const STACK_AREA_RIGHT = 360;
export const STACK_AREA_WIDTH = STACK_AREA_RIGHT - STACK_AREA_LEFT;
export const BLOCK_HEIGHT = 30;
export const MAX_FRAMES = 36000; // 10 minutes at 60fps

// ─── Interfaces ───────────────────────────────────────────────

export interface PerfectStackDifficulty {
  baseSpeed: number;         // 2–6 px/frame
  speedIncrease: number;     // 0.1–0.5 per stack
  baseBlockWidth: number;    // 40–80 px
  targetScore: number;       // score needed to win
}

export interface StackBlock {
  x: number;        // left edge
  width: number;     // block width
}

export interface CurrentBlock {
  x: number;         // left edge
  width: number;     // current block width
  direction: number; // 1 = moving right, -1 = moving left
}

export interface PerfectStackDisplay {
  stack: Array<{ x: number; width: number }>;
  currentBlock: { x: number; width: number };
  score: number;
  frame: number;
  currentSpeed: number;
  finished: boolean;
  won: boolean;
}

// ─── Difficulty presets ───────────────────────────────────────

function difficultyFromParams(diff: DifficultyParams): PerfectStackDifficulty {
  const level = diff.level;
  // baseSpeed: 2 at level 1 → 6 at level 10
  const baseSpeed = 2 + (level - 1) * (4 / 9);
  // speedIncrease: 0.1 at level 1 → 0.5 at level 10
  const speedIncrease = 0.1 + (level - 1) * (0.4 / 9);
  // baseBlockWidth: 80 at level 1 → 40 at level 10
  const baseBlockWidth = Math.round(80 - (level - 1) * (40 / 9));
  // targetScore: level * 3
  const targetScore = diff.params.targetScore ?? level * 3;

  const d = diff.params;
  return {
    baseSpeed: d.baseSpeed ?? Math.round(baseSpeed * 10) / 10,
    speedIncrease: d.speedIncrease ?? Math.round(speedIncrease * 100) / 100,
    baseBlockWidth: d.baseBlockWidth ?? baseBlockWidth,
    targetScore: d.targetScore ?? targetScore,
  };
}

// ─── PerfectStackGame ─────────────────────────────────────────

export class PerfectStackGame implements JackpotGame {
  private rng!: SeededRNG;
  private difficulty!: PerfectStackDifficulty;
  private stack: StackBlock[] = [];
  private currentBlock!: CurrentBlock;
  private score: number = 0;
  private frame: number = 0;
  private finished: boolean = false;
  private won: boolean = false;
  private currentSpeed: number = 0;
  private prevWidth: number = 0;

  init(seed: string, difficulty: DifficultyParams): void {
    this.rng = new SeededRNG(seed);
    this.difficulty = difficultyFromParams(difficulty);

    this.stack = [];
    this.score = 0;
    this.frame = 0;
    this.finished = false;
    this.won = false;
    this.currentSpeed = this.difficulty.baseSpeed;

    // The "base" of the stack is the full width at the bottom
    this.prevWidth = this.difficulty.baseBlockWidth;

    // Spawn the first moving block
    this.spawnCurrentBlock();
  }

  onInput(input: TimestampedInput): void {
    if (this.finished) return;

    if (
      input.type === 'tap' ||
      input.type === 'click' ||
      (input.type === 'keydown' && input.data && (input.data as Record<string, unknown>).key === ' ')
    ) {
      this.lockBlock();
    }
  }

  tick(): void {
    if (this.finished) return;

    this.frame++;

    // Move the current block left-right
    this.currentBlock.x += this.currentSpeed * this.currentBlock.direction;

    // Bounce off the edges of the stack area
    if (this.currentBlock.x + this.currentBlock.width > STACK_AREA_RIGHT) {
      this.currentBlock.x = STACK_AREA_RIGHT - this.currentBlock.width;
      this.currentBlock.direction = -1;
    }
    if (this.currentBlock.x < STACK_AREA_LEFT) {
      this.currentBlock.x = STACK_AREA_LEFT;
      this.currentBlock.direction = 1;
    }

    // Max time check
    if (this.frame >= MAX_FRAMES) {
      this.finished = true;
    }
  }

  // ─── Core mechanics ─────────────────────────────────────────

  private spawnCurrentBlock(): void {
    // Random starting position within the stack area
    const maxX = STACK_AREA_RIGHT - this.prevWidth;
    const minX = STACK_AREA_LEFT;
    const startX = Math.round(this.rng.nextFloat(minX, maxX + 1));

    this.currentBlock = {
      x: startX,
      width: this.prevWidth,
      direction: this.rng.next() < 0.5 ? 1 : -1,
    };
  }

  private lockBlock(): void {
    // Get the top block of the stack (or the base reference if empty)
    const prevBlock = this.stack.length > 0
      ? this.stack[this.stack.length - 1]
      : { x: STACK_AREA_LEFT, width: STACK_AREA_WIDTH };

    // Calculate overlap between current block and previous block
    const overlapLeft = Math.max(this.currentBlock.x, prevBlock.x);
    const overlapRight = Math.min(
      this.currentBlock.x + this.currentBlock.width,
      prevBlock.x + prevBlock.width,
    );
    const overlapWidth = overlapRight - overlapLeft;

    // If no overlap, block width goes to 0 → game over
    if (overlapWidth <= 0) {
      this.finished = true;
      this.won = false;
      return;
    }

    // Lock the block at the overlap position
    const lockedBlock: StackBlock = {
      x: overlapLeft,
      width: overlapWidth,
    };
    this.stack.push(lockedBlock);
    this.score++;

    // Check win condition
    if (this.score >= this.difficulty.targetScore) {
      this.won = true;
      this.finished = true;
      return;
    }

    // Update speed for next block
    this.currentSpeed = this.difficulty.baseSpeed + this.score * this.difficulty.speedIncrease;

    // The next block starts with the current locked block's width
    this.prevWidth = overlapWidth;

    // If block width becomes too small, game over
    if (this.prevWidth <= 0) {
      this.finished = true;
      return;
    }

    // Spawn the next sliding block
    this.spawnCurrentBlock();
  }

  // ─── Interface implementation ───────────────────────────────

  getState(): GameState {
    return {
      score: this.score,
      finished: this.finished,
      won: this.won,
      targetScore: this.difficulty.targetScore,
      frame: this.frame,
      display: {
        stack: this.stack.map(b => ({ x: b.x, width: b.width })),
        currentBlock: { x: this.currentBlock.x, width: this.currentBlock.width },
        score: this.score,
        frame: this.frame,
        currentSpeed: this.currentSpeed,
        finished: this.finished,
        won: this.won,
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
      stack: this.stack.map(b => ({ x: b.x, width: b.width })),
      currentBlock: { x: this.currentBlock.x, width: this.currentBlock.width },
    });
  }

  // ─── Test accessors ────────────────────────────────────────

  _getStack(): StackBlock[] {
    return this.stack.map(b => ({ ...b }));
  }

  _getCurrentBlock(): CurrentBlock {
    return { ...this.currentBlock };
  }

  _getDifficulty(): PerfectStackDifficulty {
    return { ...this.difficulty };
  }

  _setStack(stack: StackBlock[]): void {
    this.stack = stack.map(b => ({ ...b }));
  }

  _setCurrentBlock(block: CurrentBlock): void {
    this.currentBlock = { ...block };
  }

  _setScore(score: number): void {
    this.score = score;
  }
}
