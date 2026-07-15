import { MinefieldGame } from '../index.js';
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

function runFrames(game: MinefieldGame, count: number) {
  for (let i = 0; i < count; i++) {
    game.tick();
  }
}

function revealAllSafeTiles(game: MinefieldGame): void {
  const grid = game._getGrid();
  const size = grid.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!grid[y][x].isMine && !grid[y][x].revealed) {
        game.onInput(makeInput(0, 'click', { x, y }));
        if (game.isFinished()) return;
      }
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe('MinefieldGame', () => {

  // 1. Determinism: same seed produces same mine layout
  test('same seed produces same mine layout', () => {
    const game1 = new MinefieldGame();
    game1.init('determinism-seed', makeDifficulty(5));

    const game2 = new MinefieldGame();
    game2.init('determinism-seed', makeDifficulty(5));

    const grid1 = game1._getGrid();
    const grid2 = game2._getGrid();

    // Both grids should have the same mine positions
    for (let y = 0; y < grid1.length; y++) {
      for (let x = 0; x < grid1[y].length; x++) {
        expect(grid1[y][x].isMine).toBe(grid2[y][x].isMine);
        expect(grid1[y][x].adjacentMines).toBe(grid2[y][x].adjacentMines);
      }
    }
  });

  // 2. Different seeds produce different mine layouts
  test('different seeds produce different mine layouts', () => {
    const game1 = new MinefieldGame();
    game1.init('seed-alpha', makeDifficulty(5));

    const game2 = new MinefieldGame();
    game2.init('seed-beta', makeDifficulty(5));

    const grid1 = game1._getGrid();
    const grid2 = game2._getGrid();

    // At least one position should differ
    let same = true;
    for (let y = 0; y < grid1.length; y++) {
      for (let x = 0; x < grid1[y].length; x++) {
        if (grid1[y][x].isMine !== grid2[y][x].isMine) {
          same = false;
        }
      }
    }
    expect(same).toBe(false);
  });

  // 3. Higher difficulty has more mines and larger grid
  test('higher difficulty has more mines and larger grid', () => {
    const game1 = new MinefieldGame();
    game1.init('scale-test', makeDifficulty(1));
    const diff1 = game1._getDifficulty();

    const game10 = new MinefieldGame();
    game10.init('scale-test', makeDifficulty(10));
    const diff10 = game10._getDifficulty();

    // Level 10 should have larger grid or more mines
    expect(diff10.gridSize).toBeGreaterThanOrEqual(diff1.gridSize);
    expect(diff10.mineCount).toBeGreaterThanOrEqual(diff1.mineCount);
    expect(diff10.targetScore).toBeGreaterThanOrEqual(diff1.targetScore);
  });

  // 4. Clicking a mine ends the game (loss)
  test('clicking a mine ends the game with loss', () => {
    const game = new MinefieldGame();
    // Use a seed and difficulty where we know mine positions
    game.init('mine-loss-test', makeDifficulty(1, { gridSize: 4, mineCount: 1, targetScore: 15 }));

    const grid = game._getGrid();
    expect(game.isFinished()).toBe(false);

    // Find and click a mine
    let mineClicked = false;
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        if (grid[y][x].isMine) {
          game.onInput(makeInput(0, 'click', { x, y }));
          mineClicked = true;
          break;
        }
      }
      if (mineClicked) break;
    }

    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(false);
    expect(game.finalScore()).toBe(0); // no safe tiles revealed
  });

  // 5. Revealing all safe tiles wins the game
  test('revealing all safe tiles wins the game', () => {
    const game = new MinefieldGame();
    game.init('win-test', makeDifficulty(1, { gridSize: 4, mineCount: 1, targetScore: 15 }));

    revealAllSafeTiles(game);

    expect(game.isFinished()).toBe(true);
    expect(game.getState().won).toBe(true);
    expect(game.finalScore()).toBe(15);
  });

  // 6. isFinished() tracking
  test('isFinished() returns correct state', () => {
    const game = new MinefieldGame();
    game.init('finished-test', makeDifficulty(1, { gridSize: 4, mineCount: 1, targetScore: 15 }));

    expect(game.isFinished()).toBe(false);

    // Click a mine
    const grid = game._getGrid();
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        if (grid[y][x].isMine) {
          game.onInput(makeInput(0, 'click', { x, y }));
          break;
        }
      }
    }

    expect(game.isFinished()).toBe(true);
    const score = game.finalScore();
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0);
  });

  // 7. Replay from input log matches original run
  test('replay from input log matches original run', () => {
    const seed = 'replay-test-seed';
    const diff = makeDifficulty(1, { gridSize: 4, mineCount: 1, targetScore: 15 });

    // First run: play manually, revealing all safe tiles
    const original = new MinefieldGame();
    original.init(seed, diff);

    const inputs: TimestampedInput[] = [];
    const grid = original._getGrid();
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        if (!grid[y][x].isMine) {
          inputs.push(makeInput(0, 'click', { x, y }));
          original.onInput(inputs[inputs.length - 1]);
          if (original.isFinished()) break;
        }
      }
      if (original.isFinished()) break;
    }

    const originalState = original.getState();

    // Second run: replay using GameLoop
    const replay = new MinefieldGame();
    const loop = new GameLoop(replay);
    loop.init(seed, diff);

    loop.runFromLog({ inputs }, 1000);

    const replayState = loop.getState();

    expect(replayState.score).toBe(originalState.score);
    expect(replayState.finished).toBe(originalState.finished);
    expect(replayState.won).toBe(originalState.won);
  });

  // 8. serializeState produces valid JSON
  test('serializeState produces valid JSON', () => {
    const game = new MinefieldGame();
    game.init('serialize-test', makeDifficulty(3));
    runFrames(game, 10);

    const serialized = game.serializeState();
    const parsed = JSON.parse(serialized);

    expect(parsed).toHaveProperty('score');
    expect(parsed).toHaveProperty('finished');
    expect(parsed).toHaveProperty('won');
    expect(parsed).toHaveProperty('targetScore');
    expect(parsed).toHaveProperty('display');
    expect(parsed.display).toHaveProperty('grid');
    expect(parsed.display).toHaveProperty('gridSize');
  });

  // 9. Clicking out of bounds does nothing
  test('out-of-bounds click does nothing', () => {
    const game = new MinefieldGame();
    game.init('bounds-test', makeDifficulty(1, { gridSize: 4, mineCount: 1 }));

    const stateBefore = game.getState();

    // Click negative coordinates and too-large coordinates
    game.onInput(makeInput(0, 'click', { x: -1, y: 0 }));
    game.onInput(makeInput(0, 'click', { x: 0, y: -1 }));
    game.onInput(makeInput(0, 'click', { x: 99, y: 0 }));
    game.onInput(makeInput(0, 'click', { x: 0, y: 99 }));

    const stateAfter = game.getState();
    expect(stateAfter.score).toBe(stateBefore.score);
    expect(stateAfter.finished).toBe(false);
  });

  // 10. Flood fill: revealing a safe tile with 0 adjacent mines reveals neighbors
  test('zero-adjacent tile flood-fill reveals neighbors', () => {
    const game = new MinefieldGame();
    // Use a large grid with very few mines to guarantee some zero-adjacent tiles
    game.init('flood-test', makeDifficulty(1, { gridSize: 6, mineCount: 2 }));

    const grid = game._getGrid();
    let revealedCount = 0;
    let floodTile: { x: number; y: number } | null = null;

    // Find a safe tile with 0 adjacent mines
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        if (!grid[y][x].isMine && grid[y][x].adjacentMines === 0) {
          floodTile = { x, y };
          break;
        }
      }
      if (floodTile) break;
    }

    if (floodTile) {
      // Click that tile — should reveal multiple tiles via flood fill
      game.onInput(makeInput(0, 'click', { x: floodTile.x, y: floodTile.y }));
      const state = game.getState();
      // More than 1 tile should be revealed
      expect(state.score).toBeGreaterThan(1);
    } else {
      // No zero-adjacent tile found (unlikely with 6x6/2 mines), skip
      // Just verify the game works
      expect(game.isFinished()).toBe(false);
    }
  });
});
