import type { JackpotGame, TimestampedInput } from './interface.js';

/**
 * A seeded pseudo-random number generator (mulberry32).
 * Deterministic — same seed always produces the same sequence.
 */
export class SeededRNG {
  private state: number;

  constructor(seed: string) {
    // Hash the string seed into a 32-bit integer
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    }
    this.state = h >>> 0;
  }

  /** Returns a float in [0, 1) */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an integer in [min, max] inclusive */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Returns a float in [min, max) */
  nextFloat(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }
}

/**
 * Input Log — collection of timestamped inputs for a session.
 */
export interface InputLog {
  inputs: TimestampedInput[];
}

/**
 * Deterministic game loop with fixed timestep (60 FPS).
 *
 * Processes inputs and advances the game frame-by-frame.
 * Supports fast-forward for server-side replay verification.
 */
export class GameLoop {
  readonly game: JackpotGame;
  private inputQueue: TimestampedInput[];
  private frameIndex: number;

  constructor(game: JackpotGame) {
    this.game = game;
    this.inputQueue = [];
    this.frameIndex = 0;
  }

  /** Seed and initialize the underlying game. */
  init(seed: string, difficultyParams: {
    seed: string;
    level: number;
    params: Record<string, number>;
  }): void {
    this.inputQueue = [];
    this.frameIndex = 0;
    this.game.init(seed, difficultyParams);
  }

  /** Queue an input event for processing on its target frame. */
  enqueueInput(input: TimestampedInput): void {
    this.inputQueue.push(input);
  }

  /** Queue multiple inputs at once. */
  enqueueInputs(inputs: TimestampedInput[]): void {
    for (const input of inputs) {
      this.inputQueue.push(input);
    }
  }

  /**
   * Advance exactly one frame (1/60 s).
   * Processes any inputs queued for the current frame before calling tick().
   */
  stepForward(): void {
    // Process all inputs targeted at (or before) the current frame
    const remaining: TimestampedInput[] = [];
    for (const input of this.inputQueue) {
      if (input.frame <= this.frameIndex) {
        this.game.onInput(input);
      } else {
        remaining.push(input);
      }
    }
    this.inputQueue = remaining;
    this.game.tick();
    this.frameIndex++;
  }

  /**
   * Run the game for a specified number of frames.
   * Processes all queued inputs that fall within the run.
   */
  runFrames(count: number): void {
    const targetFrame = this.frameIndex + count;
    while (this.frameIndex < targetFrame && !this.game.isFinished()) {
      this.stepForward();
    }
  }

  /**
   * Run the game until it finishes or maxFrames is reached.
   * Returns the number of frames actually simulated.
   */
  runUntilFinished(maxFrames: number = 60_000): number {
    const startFrame = this.frameIndex;
    while (!this.game.isFinished() && (this.frameIndex - startFrame) < maxFrames) {
      this.stepForward();
    }
    return this.frameIndex - startFrame;
  }

  /**
   * Run the entire game from a full input log.
   * Processes inputs in order, running frames between inputs as needed.
   * Returns the total number of frames simulated.
   */
  runFromLog(inputLog: InputLog, maxFrames: number = 60_000): number {
    this.enqueueInputs(inputLog.inputs);
    return this.runUntilFinished(maxFrames);
  }

  /** Current frame index. */
  get frame(): number {
    return this.frameIndex;
  }

  /** Whether the underlying game has finished. */
  isFinished(): boolean {
    return this.game.isFinished();
  }

  /** Current game state. */
  getState() {
    return this.game.getState();
  }

  /** Final score (valid only after finished). */
  finalScore(): number {
    return this.game.finalScore();
  }
}
