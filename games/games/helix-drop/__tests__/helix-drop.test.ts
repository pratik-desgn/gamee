import { HelixDropGame, isAngleInGap } from '../index.js';
import { GameLoop } from '../../../sdk/engine.js';
import type { TimestampedInput } from '../../../sdk/interface.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeDifficulty(level: number, overrides: Record<string, number> = {}) {
  return {
    seed: 'test-seed',
    level,
    params: overrides,
  };
}

function makeInput(frame: number, type: string = 'tap', data: Record<string, unknown> = {}): TimestampedInput {
  return { frame, type, data, time: frame * 16.67 };
}

function runFrames(game: HelixDropGame, count: number) {
  for (let i = 0; i < count; i++) {
    game.tick();
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe('HelixDropGame', () => {

  // 1. Determinism: same seed always produces same outcome
  test('same seed produces same outcome', () => {
    const game1 = new HelixDropGame();
    game1.init('determinism-seed', makeDifficulty(3));

    const game2 = new HelixDropGame();
    game2.init('determinism-seed', makeDifficulty(3));

    // Apply identical inputs
    const inputs: TimestampedInput[] = [
      makeInput(5, 'keydown', { key: 'ArrowRight' }),
      makeInput(15, 'keyup', { key: 'ArrowRight' }),
      makeInput(20, 'keydown', { key: 'ArrowLeft' }),
      makeInput(30, 'keyup', { key: 'ArrowLeft' }),
    ];

    for (let i = 0; i < 500; i++) {
      for (const inp of inputs) {
        if (inp.frame === i) {
          game1.onInput(inp);
          game2.onInput(inp);
        }
      }
      game1.tick();
      game2.tick();
      if (game1.isFinished() || game2.isFinished()) break;
    }

    const state1 = game1.getState();
    const state2 = game2.getState();

    expect(state1.score).toBe(state2.score);
    expect(state1.finished).toBe(state2.finished);
    expect(state1.frame).toBe(state2.frame);
    expect(state1.won).toBe(state2.won);
  });

  // 2. Different seed produces different gap positions
  test('different seeds produce different gap positions', () => {
    const game1 = new HelixDropGame();
    game1.init('seed-alpha', makeDifficulty(3));

    const game2 = new HelixDropGame();
    game2.init('seed-beta', makeDifficulty(3));

    const platforms1 = game1._getPlatforms();
    const platforms2 = game2._getPlatforms();

    // Gap angles should differ
    const same = platforms1.every((p, i) => Math.abs(p.gapAngle - platforms2[i].gapAngle) < 0.001);
    expect(same).toBe(false);
  });

  // 3. Higher difficulty (level 10) is harder than level 1
  test('higher difficulty (level 10) is harder than level 1', () => {
    const game1 = new HelixDropGame();
    game1.init('scale-test', makeDifficulty(1));
    const diff1 = game1._getDifficulty();

    const game10 = new HelixDropGame();
    game10.init('scale-test', makeDifficulty(10));
    const diff10 = game10._getDifficulty();

    // Level 10: more platforms, faster rotation, tighter gaps, faster drop, higher target
    expect(diff10.platformCount).toBeGreaterThan(diff1.platformCount);
    expect(diff10.rotationSpeed).toBeGreaterThan(diff1.rotationSpeed);
    expect(diff10.gapWidth).toBeLessThan(diff1.gapWidth);
    expect(diff10.dropSpeed).toBeGreaterThan(diff1.dropSpeed);
    expect(diff10.targetScore).toBeGreaterThan(diff1.targetScore);
  });

  // 4. Rotation input changes helix rotation
  test('rotation input changes helix rotation', () => {
    const game = new HelixDropGame();
    game.init('rotation-test', makeDifficulty(3, { rotationSpeed: 2 }));

    const initialRotation = game._getHelixRotation();
    expect(initialRotation).toBe(0);

    // Rotate right for a few frames
    game.onInput(makeInput(1, 'keydown', { key: 'ArrowRight' }));
    game.tick();
    game.tick();
    game.tick();

    const rotationAfter = game._getHelixRotation();
    expect(rotationAfter).toBeCloseTo(6, 1); // 3 frames * 2 deg/frame

    // Stop rotating
    game.onInput(makeInput(4, 'keyup', { key: 'ArrowRight' }));
    game.tick();

    const rotationStopped = game._getHelixRotation();
    // Rotation should stop changing
    game.tick();
    expect(game._getHelixRotation()).toBeCloseTo(rotationStopped, 1);
  });

  // 5. Ball drops at constant speed
  test('ball drops at constant speed', () => {
    const game = new HelixDropGame();
    game.init('drop-test', makeDifficulty(1, { dropSpeed: 2, platformCount: 5 }));

    expect(game._getBall().y).toBe(0);

    runFrames(game, 10);

    // Ball should have dropped 10 * 2 = 20 pixels
    expect(game._getBall().y).toBeCloseTo(20, 1);
  });

  // 6. Rest-then-pass: the ball rests on a solid platform and only falls
  //    through (scoring) once the player rotates the gap under it.
  test('ball rests on the platform, then falls through when the gap is rotated under it', () => {
    const game = new HelixDropGame();
    game.init('rest-pass-test', makeDifficulty(1, {
      platformCount: 1,
      gapWidth: 60,
      hazardWidth: 0, // no death zone — isolate the rest/pass mechanic
      dropSpeed: 10,
      rotationSpeed: 3,
      targetScore: 1,
    }));

    // Reach the first platform (y=60 at 10px/frame) and rest: the
    // spawn-safe layout guarantees the gap is not under the ball, so with
    // no input nothing can happen.
    runFrames(game, 20);
    expect(game.isFinished()).toBe(false);
    expect(game._getBall().y).toBe(60);
    expect(game.getState().score).toBe(0);

    // Hold rotate-right: within a full sweep the gap must pass under the
    // ball → pass, score 1, target met → win.
    game.onInput(makeInput(20, 'keydown', { key: 'ArrowRight' }));
    runFrames(game, 130); // 130 frames × 3°/frame > 360°
    expect(game.isFinished()).toBe(true);
    expect(game.getState().score).toBe(1);
    expect(game.getState().won).toBe(true);
  });

  // 6b. Zero-input runs can never score and end as a timeout loss.
  test('no-input run never scores and times out as a loss', () => {
    const game = new HelixDropGame();
    game.init('idle-test', makeDifficulty(1));
    runFrames(game, 36001); // MAX_FRAMES
    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(false);
    expect(game.getState().score).toBe(0);
  });

  // 6c. Rotating the hazard zone under a resting ball is death.
  test('rotating the hazard under the ball ends the game as a loss', () => {
    const game = new HelixDropGame();
    game.init('hazard-test', makeDifficulty(1, {
      platformCount: 1,
      gapWidth: 30,
      hazardWidth: 90,
      dropSpeed: 10,
      rotationSpeed: 3,
      targetScore: 1,
    }));

    runFrames(game, 20); // rest on the platform
    expect(game.isFinished()).toBe(false);

    // Choose the rotation direction that sweeps the hazard under the ball
    // BEFORE the gap: rotating right increases rotation, and a feature at
    // angle a arrives at the ball (0°) when rotation ≈ 360 - a.
    const p = game._getPlatforms()[0];
    const arrival = (a: number) => (360 - a + 360) % 360;
    const hazardFirstGoingRight =
      arrival(p.hazardAngle) < arrival(p.gapAngle);
    const key = hazardFirstGoingRight ? 'ArrowRight' : 'ArrowLeft';

    game.onInput(makeInput(20, 'keydown', { key }));
    runFrames(game, 130);
    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(false);
    expect(game.getState().score).toBe(0);
  });

  // 7. isAngleInGap utility function works correctly
  test('isAngleInGap correctly identifies gap regions', () => {
    // Gap centered at 0°, width 60° → covers from 330° to 30°
    expect(isAngleInGap(0, 0, 60)).toBe(true);
    expect(isAngleInGap(15, 0, 60)).toBe(true);
    expect(isAngleInGap(340, 0, 60)).toBe(true);
    expect(isAngleInGap(90, 0, 60)).toBe(false);
    expect(isAngleInGap(180, 0, 60)).toBe(false);

    // Gap centered at 180°, width 45° → covers from 157.5° to 202.5°
    expect(isAngleInGap(180, 180, 45)).toBe(true);
    expect(isAngleInGap(160, 180, 45)).toBe(true);
    expect(isAngleInGap(200, 180, 45)).toBe(true);
    expect(isAngleInGap(0, 180, 45)).toBe(false);
    expect(isAngleInGap(90, 180, 45)).toBe(false);

    // Gap centered at 270°, width 90° → covers from 225° to 315°
    expect(isAngleInGap(270, 270, 90)).toBe(true);
    expect(isAngleInGap(225, 270, 90)).toBe(true);
    expect(isAngleInGap(315, 270, 90)).toBe(true);
    expect(isAngleInGap(180, 270, 90)).toBe(false);
    expect(isAngleInGap(0, 270, 90)).toBe(false);

    // Gap centered at 350°, width 40° → wraps: covers 330° to 10°
    expect(isAngleInGap(350, 350, 40)).toBe(true);
    expect(isAngleInGap(0, 350, 40)).toBe(true);
    expect(isAngleInGap(10, 350, 40)).toBe(true);
    expect(isAngleInGap(340, 350, 40)).toBe(true);
    expect(isAngleInGap(20, 350, 40)).toBe(false);
    expect(isAngleInGap(180, 350, 40)).toBe(false);
  });

  // 8. isFinished() and finalScore() work correctly
  test('isFinished() and finalScore() work correctly', () => {
    const game = new HelixDropGame();
    // Near-full-circle gap (spawn-safe rerolling can't avoid the ball, so
    // the ball falls straight through every platform) — finishes as a win
    // at the target without any input.
    game.init('finished-test', makeDifficulty(1, {
      platformCount: 3, dropSpeed: 20, targetScore: 3, gapWidth: 359, hazardWidth: 0,
    }));

    expect(game.isFinished()).toBe(false);

    // Run until finished
    runFrames(game, 500);

    expect(game.isFinished()).toBe(true);
    const score = game.finalScore();
    expect(score).toBe(3);
    expect(score).toBe(game.getState().score);
    expect(game.getState().won).toBe(true);
  });

  // 9. Replay from input log matches original run
  test('replay from input log matches original run', () => {
    const seed = 'replay-test-seed';
    const diff = makeDifficulty(3);

    // First run
    const original = new HelixDropGame();
    original.init(seed, diff);

    const inputs: TimestampedInput[] = [
      makeInput(3, 'keydown', { key: 'ArrowRight' }),
      makeInput(8, 'keyup', { key: 'ArrowRight' }),
      makeInput(12, 'keydown', { key: 'ArrowLeft' }),
      makeInput(18, 'keyup', { key: 'ArrowLeft' }),
      makeInput(22, 'keydown', { key: 'ArrowRight' }),
      makeInput(30, 'keyup', { key: 'ArrowRight' }),
    ];

    for (let i = 0; i < 600; i++) {
      for (const inp of inputs) {
        if (inp.frame === i) {
          original.onInput(inp);
        }
      }
      original.tick();
      if (original.isFinished()) break;
    }

    const originalState = original.getState();

    // Second run: use GameLoop
    const replay = new HelixDropGame();
    const loop = new GameLoop(replay);
    loop.init(seed, diff);

    loop.runFromLog({ inputs }, 600);

    const replayState = loop.getState();

    expect(replayState.score).toBe(originalState.score);
    expect(replayState.finished).toBe(originalState.finished);
    expect(replayState.frame).toBe(originalState.frame);
    expect(replayState.won).toBe(originalState.won);
  });

  // 10. serializeState produces valid JSON
  test('serializeState produces valid JSON', () => {
    const game = new HelixDropGame();
    game.init('serialize-test', makeDifficulty(3));

    runFrames(game, 30);

    const serialized = game.serializeState();
    const parsed = JSON.parse(serialized);

    expect(parsed).toHaveProperty('platforms');
    expect(parsed).toHaveProperty('ball');
    expect(parsed).toHaveProperty('helixRotation');
    expect(parsed).toHaveProperty('score');
    expect(parsed).toHaveProperty('finished');
    expect(parsed).toHaveProperty('frame');
    expect(Array.isArray(parsed.platforms)).toBe(true);
  });

  // 11. Falling through the gap is the pass: each platform crossed
  //     increments score by exactly one.
  test('each platform fallen through increments score', () => {
    const game = new HelixDropGame();
    // Near-full-circle gaps: ball free-falls through all platforms,
    // scoring one per platform. Keep target above platformCount so the
    // run ends via "all platforms passed" rather than early win.
    game.init('pass-count-test', makeDifficulty(1, {
      platformCount: 4, gapWidth: 359, hazardWidth: 0, dropSpeed: 10, targetScore: 5,
    }));

    // Hold a rotation key: with a 359° gap, any rotation immediately puts
    // the gap under the ball even on platforms whose spawn-safe layout
    // found the one safe degree, so the ball falls through everything
    // regardless of seed.
    game.onInput(makeInput(0, 'keydown', { key: 'ArrowRight' }));
    runFrames(game, 500);
    expect(game.isFinished()).toBe(true);
    expect(game.getState().score).toBe(4); // one per platform
    expect(game.getState().won).toBe(false); // 4 < target 5
  });

  // 12. Verify that rotating the helix changes effective gap position
  test('rotation changes effective gap and affects ball outcome', () => {
    // Create two games with same seed but one rotates
    const seed = 'rotation-outcome-test';
    const diffConfig = { platformCount: 3, gapWidth: 45, dropSpeed: 5, targetScore: 3 };

    const noRotate = new HelixDropGame();
    noRotate.init(seed, makeDifficulty(1, diffConfig));

    const withRotate = new HelixDropGame();
    withRotate.init(seed, makeDifficulty(1, diffConfig));

    // Run both until they hit the first platform
    // In noRotate, just tick. In withRotate, rotate constantly. 500
    // frames at level-1 rotation speed (1°/frame) is a full sweep, so the
    // rotating game is guaranteed to bring the gap or hazard under the
    // resting ball; the non-rotating game is guaranteed to rest forever.
    for (let i = 0; i < 500; i++) {
      if (!noRotate.isFinished()) noRotate.tick();
      if (!withRotate.isFinished()) {
        // Rotate constantly
        withRotate.onInput(makeInput(i, 'keydown', { key: 'ArrowRight' }));
        withRotate.tick();
      }
    }

    // The outcomes should differ because rotation changes gap alignment
    const stateNo = noRotate.getState();
    const stateRot = withRotate.getState();

    // Either the scores differ or one finished differently than the other
    const outcomesDiffer = stateNo.finished !== stateRot.finished ||
                           stateNo.won !== stateRot.won ||
                           stateNo.score !== stateRot.score;
    expect(outcomesDiffer).toBe(true);
  });
});
