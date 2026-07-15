import { GameLoop, type InputLog } from './engine.js';
import type { JackpotGame } from './interface.js';

export interface VerifyResult {
  verified_score: number;
  /**
   * The sim's own win verdict — authoritative for settlement. Each game
   * decides `won` under its own semantics (score thresholds, par counts,
   * reaction-time averages…), so a platform-level "score >= target"
   * comparison cannot substitute for it: score scales differ per game and
   * sliding-puzzle's is inverted (lower is better).
   */
  won: boolean;
  verdict: 'valid' | 'invalid' | 'timeout';
  duration_ms: number;
}

/**
 * Server-side replay runner.
 *
 * Takes an input log + seed + difficulty params and replays
 * the game at high speed to verify the score.
 */
export function replay(
  game: JackpotGame,
  inputLog: InputLog,
  seed: string,
  difficultyParams: {
    seed: string;
    level: number;
    params: Record<string, number>;
  },
  options?: {
    /** Max frames to simulate before timing out (default: 60000 = ~16 min at 60fps) */
    maxFrames?: number;
    /** Speed multiplier for progress reporting (default: 10x) */
    speedMultiplier?: number;
  },
): VerifyResult {
  const maxFrames = options?.maxFrames ?? 60_000;
  const startTime = performance.now();

  const loop = new GameLoop(game);
  loop.init(seed, difficultyParams);
  loop.enqueueInputs(inputLog.inputs);
  const framesRun = loop.runUntilFinished(maxFrames);

  const endTime = performance.now();
  const duration_ms = endTime - startTime;

  // Determine verdict
  let verdict: VerifyResult['verdict'];
  if (!loop.isFinished()) {
    verdict = 'timeout';
  } else {
    verdict = 'valid';
  }

  const verified_score = loop.isFinished() ? loop.finalScore() : 0;
  const won = loop.isFinished() ? loop.getState().won === true : false;

  return {
    verified_score,
    won,
    verdict,
    duration_ms,
  };
}
