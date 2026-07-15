import { BlockMergeGame } from '../index.js';
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

function makeInput(frame: number, type: string = 'keydown', data: Record<string, unknown> = {}): TimestampedInput {
  return { frame, type, data, time: frame * 16.67 };
}

function makeSwipe(dir: string, frame: number = 0): TimestampedInput {
  return makeInput(frame, 'keydown', { key: dir });
}

function runFrames(game: BlockMergeGame, count: number) {
  for (let i = 0; i < count; i++) {
    game.tick();
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe('BlockMergeGame', () => {

  // 1. Determinism: same seed always produces same outcome
  test('same seed produces same outcome', () => {
    const game1 = new BlockMergeGame();
    game1.init('determinism-seed', makeDifficulty(3));

    const game2 = new BlockMergeGame();
    game2.init('determinism-seed', makeDifficulty(3));

    // Apply the same sequence of moves
    const moves = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'];
    for (const dir of moves) {
      game1.onInput(makeSwipe(dir));
      game2.onInput(makeSwipe(dir));
    }

    const state1 = game1.getState();
    const state2 = game2.getState();

    expect(state1.score).toBe(state2.score);
    expect(state1.finished).toBe(state2.finished);
    expect(state1.frame).toBe(state2.frame);
    expect(state1.won).toBe(state2.won);
    expect(state1.display).toEqual(state2.display);
  });

  // 2. Different seed produces different initial tile positions
  test('different seeds produce different initial layouts', () => {
    const game1 = new BlockMergeGame();
    game1.init('seed-alpha', makeDifficulty(3));

    const game2 = new BlockMergeGame();
    game2.init('seed-beta', makeDifficulty(3));

    const grid1 = game1._getGrid();
    const grid2 = game2._getGrid();

    // Count non-zero tiles (should be same count)
    const count1 = grid1.flat().filter(v => v !== 0).length;
    const count2 = grid2.flat().filter(v => v !== 0).length;
    expect(count1).toBe(count2);
    expect(count1).toBeGreaterThanOrEqual(2);

    // Positions should differ (very unlikely to be identical)
    // Flatten and compare
    const flat1 = grid1.flat().join(',');
    const flat2 = grid2.flat().join(',');
    expect(flat1).not.toBe(flat2);
  });

  // 3. Difficulty params scale correctly
  test('difficulty params scale correctly', () => {
    const game1 = new BlockMergeGame();
    game1.init('scale-test', makeDifficulty(1));
    const diff1 = game1._getDifficulty();

    const game10 = new BlockMergeGame();
    game10.init('scale-test', makeDifficulty(10));
    const diff10 = game10._getDifficulty();

    // Higher level = larger grid, higher target, more start tiles
    expect(diff10.gridSize).toBeGreaterThanOrEqual(diff1.gridSize);
    expect(diff10.targetScore).toBeGreaterThanOrEqual(diff1.targetScore);
    expect(diff10.startTiles).toBeGreaterThanOrEqual(diff1.startTiles);
  });

  // 4. Swipe input moves tiles
  test('swipe left moves tiles to the left', () => {
    const game = new BlockMergeGame();
    // Use explicit small grid for testing
    game.init('move-test', makeDifficulty(1, { gridSize: 4, startTiles: 0 }));

    // Manually set grid with a tile at right edge
    const grid = [
      [0, 0, 0, 2],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    game._setGrid(grid);

    // Swipe left
    game.onInput(makeSwipe('ArrowLeft'));

    const newGrid = game._getGrid();
    // The 2 should now be at column 0
    expect(newGrid[0][0]).toBe(2);
    expect(newGrid[0][3]).toBe(0);
  });

  // 5. Merging equal tiles adds to score and creates higher tile
  test('merging equal tiles adds to score', () => {
    const game = new BlockMergeGame();
    game.init('merge-test', makeDifficulty(1, { gridSize: 4, startTiles: 0 }));

    // Set up two adjacent tiles of same value
    const grid = [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    game._setGrid(grid);

    // score is the highest tile on the grid
    expect(game.getState().score).toBe(2);

    // Swipe left — should merge the two 2s into a 4
    game.onInput(makeSwipe('ArrowLeft'));

    const newGrid = game._getGrid();
    expect(newGrid[0][0]).toBe(4);
    expect(newGrid[0][1]).toBe(0);
    // Highest tile is now the merged 4
    expect(game.getState().score).toBe(4);
  });

  // 6. Game detects loss when grid is full with no possible merges
  test('game detects loss on full grid with no merges', () => {
    const game = new BlockMergeGame();
    game.init('loss-test', makeDifficulty(1, { gridSize: 4, targetScore: 999999, startTiles: 0 }));

    // Set up a grid that's full with no possible merges
    const grid: number[][] = [];
    let val = 2;
    for (let r = 0; r < 4; r++) {
      const row: number[] = [];
      for (let c = 0; c < 4; c++) {
        row.push(val);
        val *= 2;
      }
      grid.push(row);
    }
    // Make sure no adjacent tiles are equal in either direction
    // 2  4  8  16
    // 32 64 128 256
    // 512 1024 2048 4096
    // 8192 16384 32768 65536
    game._setGrid(grid);

    // Tick just to update frame
    game.tick();

    // Try to move — should detect no possible moves
    game.onInput(makeSwipe('ArrowLeft'));

    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(false);
  });

  // 6b. Game detects loss when the move budget runs out, even with a wide
  // open board — without this, a stalled session with plenty of empty
  // cells could run past its move budget indefinitely, since "board full"
  // is a much rarer condition than "ran out of moves".
  test('game detects loss when move budget is exhausted', () => {
    const game = new BlockMergeGame();
    game.init('move-budget-test', makeDifficulty(1, { gridSize: 4, targetScore: 999999, maxMoves: 3 }));

    // Alternate directions so each swipe actually changes the grid (a
    // no-op swipe wouldn't consume a move) — board is nearly empty, so
    // every one of these should shift tiles.
    const dirs = ['ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowLeft'];
    for (const dir of dirs) {
      if (game.isFinished()) break;
      game.onInput(makeSwipe(dir));
    }

    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(false);
  });

  // 7. Game detects win when target score is reached
  test('game detects win when score reaches target', () => {
    const game = new BlockMergeGame();
    game.init('win-test', makeDifficulty(1, { gridSize: 4, targetScore: 4, startTiles: 0 }));

    // Set up a mergeable pair
    const grid = [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    game._setGrid(grid);

    expect(game.isFinished()).toBe(false);

    // Merge them — score goes to 4 which meets target
    game.onInput(makeSwipe('ArrowLeft'));

    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(true);
    expect(game.getState().score).toBeGreaterThanOrEqual(4);
  });

  // 8. Replay from input log matches original run
  test('replay from input log matches original run', () => {
    const seed = 'replay-test-seed';
    const diff = makeDifficulty(3);

    // First run: play manually
    const original = new BlockMergeGame();
    original.init(seed, diff);

    const inputs: TimestampedInput[] = [
      makeSwipe('ArrowLeft', 0),
      makeSwipe('ArrowDown', 1),
      makeSwipe('ArrowRight', 2),
      makeSwipe('ArrowUp', 3),
      makeSwipe('ArrowLeft', 4),
      makeSwipe('ArrowDown', 5),
      makeSwipe('ArrowRight', 6),
    ];

    for (const inp of inputs) {
      original.onInput(inp);
    }

    const originalState = original.getState();

    // Second run: use GameLoop with the input log
    const replay = new BlockMergeGame();
    const loop = new GameLoop(replay);
    loop.init(seed, diff);

    loop.runFromLog({ inputs }, 100);

    const replayState = loop.getState();

    expect(replayState.score).toBe(originalState.score);
    expect(replayState.finished).toBe(originalState.finished);
    // frame intentionally differs: the manual run never ticks (frame 0)
    // while the loop ticks once per frame (tick now counts frames to
    // enforce MAX_FRAMES). The loop ran its full budget of 100 frames.
    expect(replayState.frame).toBe(100);
    expect(replayState.won).toBe(originalState.won);
  });

  // 9. serializeState produces valid JSON
  test('serializeState produces valid JSON', () => {
    const game = new BlockMergeGame();
    game.init('serialize-test', makeDifficulty(3));

    // Apply some moves
    game.onInput(makeSwipe('ArrowLeft'));
    game.onInput(makeSwipe('ArrowDown'));

    const serialized = game.serializeState();
    const parsed = JSON.parse(serialized);

    expect(parsed).toHaveProperty('grid');
    expect(parsed).toHaveProperty('score');
    expect(Array.isArray(parsed.grid)).toBe(true);
    expect(typeof parsed.score).toBe('number');
  });

  // 10. finalScore returns highest tile value
  test('finalScore returns highest tile value', () => {
    const game = new BlockMergeGame();
    game.init('final-score-test', makeDifficulty(1, { gridSize: 4, targetScore: 16, startTiles: 0 }));

    const grid = [
      [2, 2, 4, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    game._setGrid(grid);

    // Merge 2+2=4 then merge 4+4=8
    game.onInput(makeSwipe('ArrowLeft')); // row becomes [4, 4, 0, 0]

    const scoreAfter1 = game.finalScore();
    expect(scoreAfter1).toBeGreaterThanOrEqual(4);

    // Merge 4+4=8
    game.onInput(makeSwipe('ArrowLeft')); // row becomes [8, 0, 0, 0]

    const scoreAfter2 = game.finalScore();
    expect(scoreAfter2).toBe(8);
  });
});
