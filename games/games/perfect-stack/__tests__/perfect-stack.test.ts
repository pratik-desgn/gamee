import { PerfectStackGame, STACK_AREA_RIGHT } from '../index.js';
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

function makeTap(frame: number = 0): TimestampedInput {
  return makeInput(frame, 'tap');
}

function runFrames(game: PerfectStackGame, count: number) {
  for (let i = 0; i < count; i++) {
    game.tick();
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe('PerfectStackGame', () => {

  // 1. Determinism: same seed always produces same outcome
  test('same seed produces same outcome', () => {
    const game1 = new PerfectStackGame();
    game1.init('determinism-seed', makeDifficulty(3));

    const game2 = new PerfectStackGame();
    game2.init('determinism-seed', makeDifficulty(3));

    // Apply the same inputs at the same frames
    for (let i = 0; i < 10; i++) {
      game1.onInput(makeTap(i * 20));
      game2.onInput(makeTap(i * 20));
    }

    // Run some ticks between taps
    for (let f = 0; f < 500; f++) {
      game1.tick();
      game2.tick();
      // Process inputs that fall on this frame
      for (let t = 0; t < 10; t++) {
        const tf = t * 20;
        if (tf === f) {
          game1.onInput(makeTap(tf));
          game2.onInput(makeTap(tf));
        }
      }
      if (game1.isFinished() || game2.isFinished()) break;
    }

    const state1 = game1.getState();
    const state2 = game2.getState();

    expect(state1.score).toBe(state2.score);
    expect(state1.finished).toBe(state2.finished);
    expect(state1.frame).toBe(state2.frame);
    expect(state1.won).toBe(state2.won);
  });

  // 2. Different seed produces different initial block positions
  test('different seeds produce different initial positions', () => {
    const game1 = new PerfectStackGame();
    game1.init('seed-alpha', makeDifficulty(3));

    const game2 = new PerfectStackGame();
    game2.init('seed-beta', makeDifficulty(3));

    const block1 = game1._getCurrentBlock();
    const block2 = game2._getCurrentBlock();

    // The starting X positions should likely differ (different RNG seeds)
    // But there's a tiny chance they could match, so we check direction too
    const sameX = block1.x === block2.x;
    const sameDir = block1.direction === block2.direction;
    // At least one of these should be different with different seeds
    expect(sameX && sameDir).toBe(false);
  });

  // 3. Difficulty params scale correctly
  test('difficulty params scale correctly', () => {
    const game1 = new PerfectStackGame();
    game1.init('scale-test', makeDifficulty(1));
    const diff1 = game1._getDifficulty();

    const game10 = new PerfectStackGame();
    game10.init('scale-test', makeDifficulty(10));
    const diff10 = game10._getDifficulty();

    // Level 10 should have: higher base speed, higher speed increase, narrower base block, higher target score
    expect(diff10.baseSpeed).toBeGreaterThan(diff1.baseSpeed);
    expect(diff10.speedIncrease).toBeGreaterThan(diff1.speedIncrease);
    expect(diff10.baseBlockWidth).toBeLessThan(diff1.baseBlockWidth);
    expect(diff10.targetScore).toBeGreaterThan(diff1.targetScore);
  });

  // 4. Tap input locks the current block and increases score
  test('tap locks block and increases score', () => {
    const game = new PerfectStackGame();
    game.init('input-test', makeDifficulty(3, { baseSpeed: 0 })); // Zero speed so block doesn't move

    expect(game.getState().score).toBe(0);

    // With zero speed, the block should be at its starting position
    const blockBefore = game._getCurrentBlock();
    game.onInput(makeTap());

    // Score should now be 1
    expect(game.getState().score).toBe(1);

    // A block should have been added to the stack
    const stack = game._getStack();
    expect(stack.length).toBe(1);
    expect(stack[0].width).toBeGreaterThan(0);
  });

  // 5. Misaligned block trims overhang (narrower block after lock)
  test('misaligned block gets trimmed', () => {
    const game = new PerfectStackGame();
    game.init('trim-test', makeDifficulty(3, { baseSpeed: 0, baseBlockWidth: 100 }));

    // Set the current block partially overlapping the base
    // The "base" is the full stack area (the implicit base platform)
    game._setCurrentBlock({ x: 60, width: 100, direction: 1 });

    // The base platform is at STACK_AREA_LEFT=40, width=STACK_AREA_WIDTH=320
    // Overlap: max(60, 40) = 60, min(160, 360) = 160, width = 100
    // So full overlap — should be 100
    
    // But let's test a partial overlap
    game._setCurrentBlock({ x: 300, width: 100, direction: 1 });
    // overlap: max(300, 40)=300, min(400, 360)=360, width=60
    game.onInput(makeTap());

    const stack = game._getStack();
    expect(stack.length).toBe(1);
    expect(stack[0].width).toBe(60); // trimmed from 100 to 60
  });

  // 6. Game ends when block width ≤ 0 (no overlap)
  test('game ends when block has no overlap', () => {
    const game = new PerfectStackGame();
    game.init('no-overlap-test', makeDifficulty(3, { baseSpeed: 0, baseBlockWidth: 100 }));

    // Position the current block completely outside the base area
    game._setCurrentBlock({ x: STACK_AREA_RIGHT + 10, width: 100, direction: 1 });
    // Wait — the base platform is at STACK_AREA_LEFT=40, STACK_AREA_RIGHT=360
    // With x=370 and width=100, block goes 370-470. Overlap with 40-360 = 0
    // Actually 370 > 360, so overlap is 0

    expect(game.isFinished()).toBe(false);

    game.onInput(makeTap());

    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(false);
  });

  // 7. Game detects win when target score is reached
  test('game detects win when score reaches target', () => {
    const game = new PerfectStackGame();
    game.init('win-test', makeDifficulty(1, { baseSpeed: 0, baseBlockWidth: 100, targetScore: 3 }));

    // Manually align each block at x=40 (left edge) so they stack perfectly
    game._setCurrentBlock({ x: 40, width: 100, direction: 1 });
    game.onInput(makeTap(0)); // score=1, locked width=100
    expect(game.isFinished()).toBe(false);

    game._setCurrentBlock({ x: 40, width: 100, direction: 1 });
    game.onInput(makeTap(1)); // score=2
    expect(game.isFinished()).toBe(false);

    game._setCurrentBlock({ x: 40, width: 100, direction: 1 });
    game.onInput(makeTap(2)); // score=3 >= targetScore → win

    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(true);
    expect(game.getState().score).toBe(3);
  });

  // 8. tick() moves the current block left-right (bouncing)
  test('tick moves current block and bounces off edges', () => {
    const game = new PerfectStackGame();
    game.init('bounce-test', makeDifficulty(3, { baseSpeed: 5, baseBlockWidth: 100 }));

    const initialX = game._getCurrentBlock().x;

    // Run ticks and check block moves
    runFrames(game, 10);

    const afterMove = game._getCurrentBlock();
    // Block should have moved
    expect(afterMove.x).not.toBe(initialX);

    // Run many frames to ensure it bounces off edges
    // Total width available = 360 - 40 = 320
    // Block width = 100, so max x = 360-100 = 260
    // Run enough frames to bounce at least twice
    for (let i = 0; i < 500; i++) {
      game.tick();
    }

    const afterBounce = game._getCurrentBlock();
    // Should always be within bounds
    expect(afterBounce.x).toBeGreaterThanOrEqual(40);
    expect(afterBounce.x + afterBounce.width).toBeLessThanOrEqual(360);
  });

  // 9. Replay from input log matches original run
  test('replay from input log matches original run', () => {
    const seed = 'replay-test-seed';
    const diff = makeDifficulty(3);

    // First run: play manually
    const original = new PerfectStackGame();
    original.init(seed, diff);

    const inputs: TimestampedInput[] = [
      makeTap(20),
      makeTap(50),
      makeTap(80),
      makeTap(120),
    ];

    // Run with inputs at the correct frame numbers
    for (let i = 0; i < 300; i++) {
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
    const replay = new PerfectStackGame();
    const loop = new GameLoop(replay);
    loop.init(seed, diff);

    loop.runFromLog({ inputs }, 300);

    const replayState = loop.getState();

    expect(replayState.score).toBe(originalState.score);
    expect(replayState.finished).toBe(originalState.finished);
    expect(replayState.frame).toBe(originalState.frame);
    expect(replayState.won).toBe(originalState.won);
  });

  // 10. serializeState produces valid JSON
  test('serializeState produces valid JSON', () => {
    const game = new PerfectStackGame();
    game.init('serialize-test', makeDifficulty(3));

    // Apply some inputs
    game.onInput(makeTap(0));
    game.onInput(makeTap(1));

    runFrames(game, 50);

    const serialized = game.serializeState();
    const parsed = JSON.parse(serialized);

    expect(parsed).toHaveProperty('stack');
    expect(parsed).toHaveProperty('currentBlock');
    expect(Array.isArray(parsed.stack)).toBe(true);
    expect(parsed.currentBlock).toHaveProperty('x');
    expect(parsed.currentBlock).toHaveProperty('width');
  });

  // 11. finalScore returns number of stacked blocks
  test('finalScore returns number of stacked blocks', () => {
    const game = new PerfectStackGame();
    game.init('final-score-test', makeDifficulty(1, { baseSpeed: 0, baseBlockWidth: 100, targetScore: 5 }));

    // Manually align blocks at x=40 so they stack perfectly
    game._setCurrentBlock({ x: 40, width: 100, direction: 1 });
    game.onInput(makeTap(0)); // score=1
    expect(game.finalScore()).toBe(1);

    game._setCurrentBlock({ x: 40, width: 100, direction: 1 });
    game.onInput(makeTap(1)); // score=2
    expect(game.finalScore()).toBe(2);

    game._setCurrentBlock({ x: 40, width: 100, direction: 1 });
    game.onInput(makeTap(2)); // score=3
    expect(game.finalScore()).toBe(3);
  });
});
