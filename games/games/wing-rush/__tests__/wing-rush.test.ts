import { WingRushGame } from '../index.js';
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

function runFrames(game: WingRushGame, count: number) {
  for (let i = 0; i < count; i++) {
    game.tick();
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe('WingRushGame', () => {

  // 1. Determinism: same seed always produces same outcome
  test('same seed produces same outcome', () => {
    const game1 = new WingRushGame();
    game1.init('determinism-seed', makeDifficulty(3));

    const game2 = new WingRushGame();
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

  // 2. Different seed produces different outcome
  test('different seeds produce different outcomes', () => {
    const game1 = new WingRushGame();
    game1.init('seed-alpha', makeDifficulty(3));

    const game2 = new WingRushGame();
    game2.init('seed-beta', makeDifficulty(3));

    // Keep birds alive by tapping periodically
    for (let i = 0; i < 500; i++) {
      if (i % 20 === 10) {
        game1.onInput(makeInput(i, 'tap'));
        game2.onInput(makeInput(i, 'tap'));
      }
      game1.tick();
      game2.tick();
      if (game1.isFinished() || game2.isFinished()) break;
    }

    // The pipe gap Y positions should differ (different seeds → different RNG)
    const pipes1 = game1._getPipes();
    const pipes2 = game2._getPipes();

    // At least the first pipe should have a different gapY
    if (pipes1.length > 0 && pipes2.length > 0) {
      expect(pipes1[0].gapY).not.toBe(pipes2[0].gapY);
    } else {
      // If no pipes yet, check scores differ
      expect(game1.getState().score).not.toBe(game2.getState().score);
    }
  });

  // 3. Higher difficulty (level 10) is harder than level 1
  test('higher difficulty (level 10) is harder than level 1', () => {
    // Verify the difficulty parameters scale correctly
    const game1 = new WingRushGame();
    game1.init('scale-test', makeDifficulty(1));
    const diff1 = game1._getDifficulty();

    const game10 = new WingRushGame();
    game10.init('scale-test', makeDifficulty(10));
    const diff10 = game10._getDifficulty();

    // Level 10 should have: smaller gap, higher speed, higher gravity
    expect(diff10.gapSize).toBeLessThan(diff1.gapSize);
    expect(diff10.speed).toBeGreaterThan(diff1.speed);
    expect(diff10.gravity).toBeGreaterThan(diff1.gravity);
    expect(diff10.flapVelocity).toBeGreaterThan(diff1.flapVelocity); // less negative = weaker flap
    expect(diff10.pipeFrequency).toBeLessThan(diff1.pipeFrequency); // pipes spawn more often
    expect(diff10.targetScore).toBeGreaterThan(diff1.targetScore);

    // Now verify the difficulty affects gameplay: one flap to start gravity
    // (the bird holds at spawn until the first flap — see WingRushGame's
    // `started` gate), then no more taps — the bird on level 10 should hit
    // the ground faster (higher gravity)
    const fastDeath1 = new WingRushGame();
    fastDeath1.init('death-test', makeDifficulty(1));
    fastDeath1.onInput(makeInput(0, 'tap'));
    const fastDeath10 = new WingRushGame();
    fastDeath10.init('death-test', makeDifficulty(10));
    fastDeath10.onInput(makeInput(0, 'tap'));

    // Run until each finishes, counting frames
    let frames1 = 0;
    let frames10 = 0;
    for (let i = 0; i < 200; i++) {
      if (!fastDeath1.isFinished()) { fastDeath1.tick(); frames1++; }
      if (!fastDeath10.isFinished()) { fastDeath10.tick(); frames10++; }
    }

    // Level 10 has higher gravity, so bird should hit the ground in fewer frames
    expect(frames10).toBeLessThan(frames1);
  });

  // 4. Input tap causes upward velocity
  test('tap input causes upward velocity', () => {
    const game = new WingRushGame();
    game.init('input-test', makeDifficulty(3));

    // Get initial velocity
    const birdBefore = game._getBird();
    expect(birdBefore.velY).toBe(0);

    // Apply a tap
    game.onInput(makeInput(1, 'tap'));

    const birdAfter = game._getBird();
    // Velocity should be set to flapVelocity (negative = upward)
    const diff = game._getDifficulty();
    expect(birdAfter.velY).toBe(diff.flapVelocity);
    expect(birdAfter.velY).toBeLessThan(0); // upward
  });

  // 5. Game ends on collision (ground)
  test('game ends on ground collision', () => {
    const game = new WingRushGame();
    game.init('ground-collision', makeDifficulty(1, { gravity: 2 })); // High gravity to force ground hit
    game.onInput(makeInput(0, 'tap')); // one flap to start gravity

    // No more flaps — bird should fall straight to ground
    for (let i = 0; i < 600; i++) {
      game.tick();
      if (game.isFinished()) break;
    }

    expect(game.isFinished()).toBe(true);
    // Bird should be at or below ground level
    const bird = game._getBird();
    const floorY = 600 - 50 - 20; // CANVAS_HEIGHT - GROUND_HEIGHT - BIRD_SIZE
    expect(bird.y).toBeGreaterThanOrEqual(floorY - 10); // allow small tolerance
  });

  // 6. isFinished() returns true after collision
  test('isFinished() returns true after collision', () => {
    const game = new WingRushGame();
    game.init('finished-test', makeDifficulty(1, { gravity: 2 }));
    game.onInput(makeInput(0, 'tap')); // one flap to start gravity

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
    const original = new WingRushGame();
    original.init(seed, diff);

    const inputs: TimestampedInput[] = [
      makeInput(10, 'tap'),
      makeInput(25, 'tap'),
      makeInput(50, 'tap'),
      makeInput(80, 'tap'),
      makeInput(120, 'tap'),
      makeInput(170, 'tap'),
      makeInput(220, 'tap'),
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
    const replay = new WingRushGame();
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
    const game = new WingRushGame();
    game.init('serialize-test', makeDifficulty(3));

    runFrames(game, 100);

    const serialized = game.serializeState();
    const parsed = JSON.parse(serialized);

    expect(parsed).toHaveProperty('score');
    expect(parsed).toHaveProperty('finished');
    expect(parsed).toHaveProperty('frame');
    expect(parsed).toHaveProperty('display');
  });
});
