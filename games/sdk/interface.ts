/**
 * GAMEE — Game SDK Interface
 *
 * Every game on the platform implements this interface.
 * Deterministic by construction: fixed timestep, seeded RNG.
 * The server replays the entire input log to verify scores.
 */

export interface DifficultyParams {
  /** Seed derived from VRF result for deterministic RNG */
  seed: string;
  /** Base difficulty level (1=easiest, 10=hardest) */
  level: number;
  /** Game-specific tuning parameters (e.g., gap size, speed multiplier) */
  params: Record<string, number>;
}

export interface TimestampedInput {
  /** Frame number when this input was recorded */
  frame: number;
  /** Input type (e.g., 'tap', 'swipe', 'click', 'keydown', 'keyup') */
  type: string;
  /** Input data (e.g., { x: 120, y: 300 } for click, { key: 'ArrowUp' } for keyboard) */
  data: Record<string, unknown>;
  /** Timestamp relative to session start (ms) */
  time: number;
}

export interface GameState {
  /** Current score */
  score: number;
  /** Whether the game has ended (win, loss, or timeout) */
  finished: boolean;
  /** Whether the player won (beat the target) */
  won: boolean;
  /** Target score for this session */
  targetScore: number;
  /** Current game frame */
  frame: number;
  /** Human-readable game state (for rendering) */
  display: Record<string, unknown>;
}

export interface JackpotGame {
  /**
   * Initialize the game with difficulty parameters.
   * Called once before the game starts.
   * The seed is derived from the VRF output — all randomness flows from this.
   */
  init(seed: string, difficulty: DifficultyParams): void;

  /**
   * Process a single input from the player.
   * Called for every input event during the game session.
   */
  onInput(input: TimestampedInput): void;

  /**
   * Advance the simulation by one frame.
   * Should be called at a fixed timestep (e.g., 60 FPS).
   */
  tick(): void;

  /**
   * Get the current game state.
   */
  getState(): GameState;

  /**
   * Whether the game has reached a terminal state.
   */
  isFinished(): boolean;

  /**
   * Get the final score. Only valid when isFinished() returns true.
   */
  finalScore(): number;

  /**
   * Serialize the full game state for rendering.
   * Used by the frontend to render the game frame without
   * sharing proprietary logic.
   */
  serializeState(): string;
}

/**
 * Game metadata — registered in the games table.
 */
export interface GameMeta {
  id: string;
  name: string;
  category: 'precision' | 'memory' | 'puzzle' | 'reflex' | 'timing' | 'luck-skill' | 'endless' | 'strategy';
  description: string;
  /** Wheel weight (higher = more common) */
  weight: number;
  /** Base difficulty level */
  baseDifficulty: number;
  /** Min difficulty the engine can assign */
  minDifficulty: number;
  /** Max difficulty the engine can assign */
  maxDifficulty: number;
  /** Whether the game is enabled in the wheel */
  enabled: boolean;
  /** Average play duration in seconds (for UX) */
  avgPlayDuration: number;
}
