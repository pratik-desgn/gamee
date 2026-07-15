import { AimMasterGame } from '../index.js';
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

function makeClickInput(frame: number, x: number, y: number, type: string = 'click'): TimestampedInput {
  return { frame, type, data: { x, y }, time: frame * 16.67 };
}

function makeInput(frame: number, type: string = 'tap', data: Record<string, unknown> = {}): TimestampedInput {
  return { frame, type, data, time: frame * 16.67 };
}

function runFrames(game: AimMasterGame, count: number) {
  for (let i = 0; i < count; i++) {
    game.tick();
  }
}

/** Helper: find an active target's position and return its center */
function getFirstActiveTarget(game: AimMasterGame): { x: number; y: number } | null {
  const targets = game._getTargets();
  for (const t of targets) {
    if (t.active) return { x: t.x, y: t.y };
  }
  return null;
}

// ─── Tests ───────────────────────────────────────────────────

describe('AimMasterGame', () => {

  // 1. Determinism: same seed always produces same outcome
  test('same seed produces same outcome', () => {
    const game1 = new AimMasterGame();
    game1.init('determinism-seed', makeDifficulty(3));

    const game2 = new AimMasterGame();
    game2.init('determinism-seed', makeDifficulty(3));

    // Apply identical set of clicks
    const inputs: TimestampedInput[] = [
      makeClickInput(5, 50, 50),
      makeClickInput(10, 100, 100),
      makeClickInput(15, 150, 150),
    ];

    for (const inp of inputs) {
      game1.onInput(inp);
      game2.onInput(inp);
    }

    for (let i = 0; i < 200; i++) {
      game1.tick();
      game2.tick();
    }

    const state1 = game1.getState();
    const state2 = game2.getState();

    expect(state1.score).toBe(state2.score);
    expect(state1.finished).toBe(state2.finished);
    expect(state1.frame).toBe(state2.frame);
    expect(state1.won).toBe(state2.won);
  });

  // 2. Different seed produces different target layout
  test('different seeds produce different target layouts', () => {
    const game1 = new AimMasterGame();
    game1.init('seed-alpha', makeDifficulty(3));

    const game2 = new AimMasterGame();
    game2.init('seed-beta', makeDifficulty(3));

    const targets1 = game1._getTargets();
    const targets2 = game2._getTargets();

    // At least some targets should differ in position
    const same = targets1.every((t, i) => t.x === targets2[i].x && t.y === targets2[i].y);
    expect(same).toBe(false);
  });

  // 3. Higher difficulty (level 10) is harder than level 1
  test('higher difficulty (level 10) is harder than level 1', () => {
    const game1 = new AimMasterGame();
    game1.init('scale-test', makeDifficulty(1));
    const diff1 = game1._getDifficulty();

    const game10 = new AimMasterGame();
    game10.init('scale-test', makeDifficulty(10));
    const diff10 = game10._getDifficulty();

    // Level 10 should have: more targets, smaller radius, less time, faster speed, higher shrink
    expect(diff10.targetCount).toBeGreaterThan(diff1.targetCount);
    expect(diff10.targetRadius).toBeLessThan(diff1.targetRadius);
    expect(diff10.timeLimit).toBeLessThan(diff1.timeLimit);
    expect(diff10.targetSpeed).toBeGreaterThanOrEqual(diff1.targetSpeed);
    expect(diff10.shrinkRate).toBeGreaterThanOrEqual(diff1.shrinkRate);
  });

  // 4. Click on a target deactivates it and increments score
  test('click on target deactivates it and increments score', () => {
    const game = new AimMasterGame();
    game.init('hit-test', makeDifficulty(1, { targetCount: 5, targetRadius: 40 }));

    const target = getFirstActiveTarget(game);
    expect(target).not.toBeNull();

    // Click exactly on the target center
    game.onInput(makeClickInput(1, target!.x, target!.y));

    // The target should now be inactive and score should be 1
    const targets = game._getTargets();
    const hitTarget = targets.find(t => t.x === target!.x && t.y === target!.y);
    expect(hitTarget?.active).toBe(false);
    expect(game.getState().score).toBe(1);
  });

  // 5. Targets shrink over time and become inactive when radius <= 0
  test('targets shrink and disappear when radius reaches 0', () => {
    const game = new AimMasterGame();
    // High shrink rate so we see it happen quickly
    game.init('shrink-test', makeDifficulty(1, { targetCount: 3, targetRadius: 30, shrinkRate: 1 }));

    // After 30 frames, all targets should have shrunk to 0
    runFrames(game, 35);

    const targets = game._getTargets();
    for (const t of targets) {
      expect(t.active).toBe(false);
      expect(t.radius).toBeLessThanOrEqual(0);
    }
  });

  // 6. Game ends when all targets are hit
  test('game wins when all targets are hit', () => {
    const game = new AimMasterGame();
    game.init('all-hit-test', makeDifficulty(1, { targetCount: 3, targetRadius: 40, timeLimit: 60, targetScore: 1 }));

    // Hit target 1
    const t1 = getFirstActiveTarget(game);
    game.onInput(makeClickInput(1, t1!.x, t1!.y));
    // Should have won already because targetScore = 1
    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(true);
  });

  // 7. Game ends when time runs out
  test('game ends when time runs out', () => {
    const game = new AimMasterGame();
    // timeLimit = 1 second = 60 frames at 60fps
    game.init('timeout-test', makeDifficulty(1, { targetCount: 10, targetRadius: 30, timeLimit: 1, targetScore: 10 }));

    // Don't hit any targets — let time expire
    runFrames(game, 65);

    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(false);
  });

  // 8. isFinished() returns true and finalScore() is callable
  test('isFinished() and finalScore() work correctly', () => {
    const game = new AimMasterGame();
    game.init('finished-test', makeDifficulty(1, { targetCount: 2, targetRadius: 40, timeLimit: 5, targetScore: 5 }));

    expect(game.isFinished()).toBe(false);

    // Hit both targets
    const t1 = getFirstActiveTarget(game);
    if (t1) game.onInput(makeClickInput(1, t1.x, t1.y));

    // Need to hit one more (targetScore = 5, but only 2 targets, so win when all hit)
    const targets = game._getTargets();
    const remaining = targets.find(t => t.active);
    if (remaining) game.onInput(makeClickInput(2, remaining.x, remaining.y));

    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(true);

    const score = game.finalScore();
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0);
  });

  // 9. Replay from input log matches original run
  test('replay from input log matches original run', () => {
    const seed = 'replay-test-seed';
    const diff = makeDifficulty(3);

    // First run: play the game manually
    const original = new AimMasterGame();
    original.init(seed, diff);

    // Get target positions and click them
    const targets = original._getTargets();
    const inputs: TimestampedInput[] = targets.map((t, i) =>
      makeClickInput(i * 10 + 5, t.x, t.y)
    );

    for (let i = 0; i < 200; i++) {
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
    const replay = new AimMasterGame();
    const loop = new GameLoop(replay);
    loop.init(seed, diff);

    loop.runFromLog({ inputs }, 200);

    const replayState = loop.getState();

    expect(replayState.score).toBe(originalState.score);
    expect(replayState.finished).toBe(originalState.finished);
    expect(replayState.frame).toBe(originalState.frame);
    expect(replayState.won).toBe(originalState.won);
  });

  // 10. serializeState produces valid JSON
  test('serializeState produces valid JSON', () => {
    const game = new AimMasterGame();
    game.init('serialize-test', makeDifficulty(3));

    runFrames(game, 30);

    const serialized = game.serializeState();
    const parsed = JSON.parse(serialized);

    expect(parsed).toHaveProperty('targets');
    expect(parsed).toHaveProperty('score');
    expect(parsed).toHaveProperty('finished');
    expect(parsed).toHaveProperty('frame');
    expect(Array.isArray(parsed.targets)).toBe(true);
  });

  // 11. Missed click does not affect score
  test('missed click does not affect score', () => {
    const game = new AimMasterGame();
    game.init('miss-test', makeDifficulty(1, { targetCount: 3, targetRadius: 15 }));

    // Click far away from any target (0,0 is top-left, targets are away from edges)
    game.onInput(makeClickInput(1, 0, 0));

    expect(game.getState().score).toBe(0);

    // No targets should have been deactivated
    const targets = game._getTargets();
    const allActive = targets.every(t => t.active);
    expect(allActive).toBe(true);
  });

  // 11b. Repeated misses escalate — each consecutive miss shrinks targets
  // more than the last, so spam-clicking empty space is self-defeating.
  test('consecutive misses shrink targets by an escalating amount', () => {
    const game = new AimMasterGame();
    game.init('miss-streak-test', makeDifficulty(1, { targetCount: 3, targetRadius: 40 }));

    game.onInput(makeClickInput(0, 0, 0)); // miss #1
    const afterOneMiss = 40 - game._getTargets()[0].radius;

    game.onInput(makeClickInput(1, 0, 0)); // miss #2 (streak)
    const totalAfterTwoMisses = 40 - game._getTargets()[0].radius;
    const secondMissShrink = totalAfterTwoMisses - afterOneMiss;

    // Second consecutive miss must cost more radius than the first.
    expect(secondMissShrink).toBeGreaterThan(afterOneMiss);
  });

  // 11c. A hit resets the miss streak, so alternating hit/miss never
  // escalates the way a run of misses does.
  test('a hit resets the miss streak', () => {
    const game = new AimMasterGame();
    game.init('miss-reset-test', makeDifficulty(1, { targetCount: 3, targetRadius: 40 }));

    game.onInput(makeClickInput(0, 0, 0)); // miss #1
    const target = getFirstActiveTarget(game)!;
    game.onInput(makeClickInput(1, target.x, target.y)); // hit — resets streak
    const radiusAfterHit = game._getTargets().find(t => t.active)!.radius;

    game.onInput(makeClickInput(2, 0, 0)); // miss — should cost like a *first* miss again
    const shrinkAfterReset = radiusAfterHit - game._getTargets().find(t => t.active)!.radius;

    const fresh = new AimMasterGame();
    fresh.init('miss-reset-baseline', makeDifficulty(1, { targetCount: 3, targetRadius: 40 }));
    fresh.onInput(makeClickInput(0, 0, 0)); // a single, first-ever miss
    const shrinkFromFreshFirstMiss = 40 - fresh._getTargets()[0].radius;

    expect(shrinkAfterReset).toBeCloseTo(shrinkFromFreshFirstMiss, 5);
  });

  // 11d. Running out of targets (all shrunk/hit away) before reaching the
  // score threshold ends the session immediately as a loss — it must not
  // wait out the full time limit while the player stares at an empty field.
  test('game ends immediately when all targets are gone, not at timeout', () => {
    const game = new AimMasterGame();
    // Small radius + a miss streak will exhaust targets in a handful of
    // clicks; a long timeLimit proves the end isn't just the timeout.
    game.init('exhaust-test', makeDifficulty(1, {
      targetCount: 2, targetRadius: 5, timeLimit: 600, targetScore: 5,
    }));

    for (let i = 0; i < 20 && !game.isFinished(); i++) {
      game.onInput(makeClickInput(i, 0, 0)); // miss every time
      game.tick();
    }

    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(false);
    expect(game.getState().frame).toBeLessThan(600 * 60);
  });

  // 12. Targets move and bounce off walls
  test('targets move and bounce off walls when speed > 0', () => {
    const game = new AimMasterGame();
    // High speed to ensure movement
    game.init('move-test', makeDifficulty(5, { targetCount: 2, targetRadius: 20, targetSpeed: 3 }));

    const targetsBefore = game._getTargets();
    const posBefore = targetsBefore.map(t => ({ x: t.x, y: t.y }));

    runFrames(game, 20);

    const targetsAfter = game._getTargets();

    // At least one target should have moved
    const moved = targetsAfter.some((t, i) => t.x !== posBefore[i].x || t.y !== posBefore[i].y);
    expect(moved).toBe(true);

    // All targets should still be within bounds
    for (const t of targetsAfter) {
      if (!t.active) continue;
      expect(t.x - t.radius).toBeGreaterThanOrEqual(0);
      expect(t.x + t.radius).toBeLessThanOrEqual(400);
      expect(t.y - t.radius).toBeGreaterThanOrEqual(0);
      expect(t.y + t.radius).toBeLessThanOrEqual(600);
    }
  });
});
