import { DinoSprintGame } from '../index.js';
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

function runFrames(game: DinoSprintGame, count: number) {
  for (let i = 0; i < count; i++) {
    game.tick();
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe('DinoSprintGame', () => {

  // 1. Determinism: same seed always produces same outcome
  test('same seed produces same outcome', () => {
    const game1 = new DinoSprintGame();
    game1.init('determinism-seed', makeDifficulty(3));

    const game2 = new DinoSprintGame();
    game2.init('determinism-seed', makeDifficulty(3));

    // Run 500 frames with the same inputs
    const inputs: TimestampedInput[] = [
      makeInput(10, 'tap'),
      makeInput(30, 'tap'),
      makeInput(60, 'tap'),
      makeInput(100, 'tap'),
      makeInput(150, 'tap'),
    ];

    for (const inp of inputs) {
      game1.onInput(inp);
      game2.onInput(inp);
    }

    for (let i = 0; i < 500; i++) {
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

  // 2. Different seed produces different obstacle layout
  test('different seeds produce different obstacle layouts', () => {
    const game1 = new DinoSprintGame();
    game1.init('seed-alpha', makeDifficulty(3));

    const game2 = new DinoSprintGame();
    game2.init('seed-beta', makeDifficulty(3));

    // One jump each to start the run (the dino holds at the start line
    // until the first jump — see DinoSprintGame's `started` gate), then
    // run enough frames to spawn obstacles
    game1.onInput(makeInput(0, 'tap'));
    game2.onInput(makeInput(0, 'tap'));
    for (let i = 0; i < 400; i++) {
      game1.tick();
      game2.tick();
      if (game1.isFinished() || game2.isFinished()) break;
    }

    // The obstacle heights should differ (different seeds → different RNG)
    const obs1 = game1._getObstacles();
    const obs2 = game2._getObstacles();

    // At least the first obstacle should have a different height
    if (obs1.length > 0 && obs2.length > 0) {
      expect(obs1[0].height).not.toBe(obs2[0].height);
    } else {
      // If no obstacles yet, check scores differ
      expect(game1.getState().score).not.toBe(game2.getState().score);
    }
  });

  // 3. Higher difficulty (level 10) is harder than level 1
  test('higher difficulty (level 10) is harder than level 1', () => {
    // Verify the difficulty parameters scale correctly
    const game1 = new DinoSprintGame();
    game1.init('scale-test', makeDifficulty(1));
    const diff1 = game1._getDifficulty();

    const game10 = new DinoSprintGame();
    game10.init('scale-test', makeDifficulty(10));
    const diff10 = game10._getDifficulty();

    // Level 10 should have: higher speed, higher gravity, weaker jump, more frequent obstacles, taller obstacles
    expect(diff10.speed).toBeGreaterThan(diff1.speed);
    expect(diff10.gravity).toBeGreaterThan(diff1.gravity);
    expect(diff10.jumpVelocity).toBeGreaterThan(diff1.jumpVelocity); // less negative = weaker jump
    expect(diff10.obstacleFrequency).toBeLessThan(diff1.obstacleFrequency); // obstacles spawn more often
    expect(diff10.obstacleMaxHeight).toBeGreaterThan(diff1.obstacleMaxHeight);
    expect(diff10.targetScore).toBeGreaterThan(diff1.targetScore);

    // Now verify the difficulty affects gameplay: one jump each to start the
    // run (see `started`'s doc comment), then no more jumps — the dino at
    // level 10 should hit an obstacle sooner (higher speed, taller obstacles)
    const fastDeath1 = new DinoSprintGame();
    fastDeath1.init('death-test', makeDifficulty(1));
    fastDeath1.onInput(makeInput(0, 'tap'));
    const fastDeath10 = new DinoSprintGame();
    fastDeath10.init('death-test', makeDifficulty(10));
    fastDeath10.onInput(makeInput(0, 'tap'));

    // Run until each finishes, counting frames
    let frames1 = 0;
    let frames10 = 0;
    for (let i = 0; i < 1000; i++) {
      if (!fastDeath1.isFinished()) { fastDeath1.tick(); frames1++; }
      if (!fastDeath10.isFinished()) { fastDeath10.tick(); frames10++; }
    }

    // Level 10 has higher speed, taller obstacles, so dino should die sooner
    expect(frames10).toBeLessThan(frames1);
  });

  // 4. Jump input changes dino Y position
  test('jump input changes dino Y position', () => {
    const game = new DinoSprintGame();
    game.init('input-test', makeDifficulty(3));

    // Get initial position (dino should be on ground)
    const dinoBefore = game._getDino();
    const groundTop = 600 - 50; // CANVAS_HEIGHT - GROUND_HEIGHT
    expect(dinoBefore.y).toBe(groundTop - 12); // standing on ground

    // Apply a jump
    game.onInput(makeInput(1, 'tap'));

    const dinoAfterJump = game._getDino();
    const diff = game._getDifficulty();
    expect(dinoAfterJump.velY).toBe(diff.jumpVelocity);
    expect(dinoAfterJump.velY).toBeLessThan(0); // upward

    // Tick a few frames and check y has changed
    game.tick();
    game.tick();
    game.tick();

    const dinoAfterPhysics = game._getDino();
    // Y should be less (higher up) than starting position due to upward velocity
    // But gravity should have slowed it down
    const expectedVelAfter3Frames = diff.jumpVelocity + diff.gravity * 3;
    expect(dinoAfterPhysics.velY).toBeCloseTo(expectedVelAfter3Frames, 1);
    // Y position should have changed from initial
    expect(dinoAfterPhysics.y).toBeLessThan(dinoBefore.y);
  });

  // 5. Game ends on obstacle collision
  test('game ends on obstacle collision', () => {
    const game = new DinoSprintGame();
    // Use high difficulty to ensure obstacles appear quickly
    game.init('collision-test', makeDifficulty(10, { obstacleFrequency: 30, speed: 5 }));
    game.onInput(makeInput(0, 'tap')); // one jump to start the run

    // No more jumps — dino should collide with an obstacle
    for (let i = 0; i < 1000; i++) {
      game.tick();
      if (game.isFinished()) break;
    }

    expect(game.isFinished()).toBe(true);
    // Should have lost (not won)
    expect(game.getState().won).toBe(false);
  });

  // 6. isFinished() returns true after collision
  test('isFinished() returns true after collision', () => {
    const game = new DinoSprintGame();
    game.init('finished-test', makeDifficulty(10, { obstacleFrequency: 30, speed: 5 }));
    game.onInput(makeInput(0, 'tap')); // one jump to start the run

    expect(game.isFinished()).toBe(false);

    // Run until collision
    for (let i = 0; i < 1000; i++) {
      game.tick();
      if (game.isFinished()) break;
    }

    expect(game.isFinished()).toBe(true);

    // finalScore() should be callable
    const score = game.finalScore();
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0);
  });

  // 7. Replay from input log matches original run
  test('replay from input log matches original run', () => {
    const seed = 'replay-test-seed';
    const diff = makeDifficulty(3);

    // First run: play the game, processing inputs at the right frame numbers
    const original = new DinoSprintGame();
    original.init(seed, diff);

    const inputs: TimestampedInput[] = [
      makeInput(10, 'tap'),
      makeInput(35, 'tap'),
      makeInput(60, 'tap'),
      makeInput(90, 'tap'),
      makeInput(130, 'tap'),
      makeInput(180, 'tap'),
      makeInput(240, 'tap'),
    ];

    // Run with inputs at the correct frame numbers
    for (let i = 0; i < 600; i++) {
      // Process any inputs targeted at this frame
      for (const inp of inputs) {
        if (inp.frame === i) {
          original.onInput(inp);
        }
      }
      original.tick();
      if (original.isFinished()) break;
    }

    const originalState = original.getState();

    // Second run: use GameLoop with the input log
    const replay = new DinoSprintGame();
    const loop = new GameLoop(replay);
    loop.init(seed, diff);

    loop.runFromLog({ inputs }, 600);

    const replayState = loop.getState();

    expect(replayState.score).toBe(originalState.score);
    expect(replayState.finished).toBe(originalState.finished);
    expect(replayState.frame).toBe(originalState.frame);
    expect(replayState.won).toBe(originalState.won);
  });

  // 8. serializeState produces valid JSON
  test('serializeState produces valid JSON', () => {
    const game = new DinoSprintGame();
    game.init('serialize-test', makeDifficulty(3));

    runFrames(game, 100);

    const serialized = game.serializeState();
    const parsed = JSON.parse(serialized);

    expect(parsed).toHaveProperty('score');
    expect(parsed).toHaveProperty('finished');
    expect(parsed).toHaveProperty('frame');
    expect(parsed).toHaveProperty('display');
  });

  // 9. Dino lands back on ground after jumping (gravity pulls it down)
  test('dino returns to ground after jump', () => {
    const game = new DinoSprintGame();
    game.init('ground-test', makeDifficulty(1, { gravity: 1, jumpVelocity: -8 }));

    const groundTop = 600 - 50;
    expect(game._getDino().y).toBe(groundTop - 12);

    // Jump
    game.onInput(makeInput(0, 'tap'));

    // Run enough frames to complete the jump arc
    for (let i = 0; i < 100; i++) {
      game.tick();
    }

    // Dino should be back on ground
    const dino = game._getDino();
    expect(dino.y).toBeCloseTo(groundTop - 12, 0);
    expect(Math.abs(dino.velY)).toBeLessThan(0.5);
  });
});
