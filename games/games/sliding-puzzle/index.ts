import type { JackpotGame, GameState, DifficultyParams, TimestampedInput } from '../../sdk/interface.js';
import { SeededRNG } from '../../sdk/engine.js';

// ─── Constants ────────────────────────────────────────────────

export const MIN_GRID_SIZE = 3;
export const MAX_GRID_SIZE = 5;
export const MAX_FRAMES = 36000; // 10 minutes at 60fps — idle sessions end as a loss

// ─── Interfaces ───────────────────────────────────────────────

export interface SlidingPuzzleDifficulty {
  gridSize: number;  // 3–5
  maxMoves: number;  // 30–200
  targetScore: number; // par (lower is better)
}

export interface SlidingPuzzleDisplay {
  grid: number[][];   // 2D array, 0 = empty space
  gridSize: number;
  emptyX: number;
  emptyY: number;
  moves: number;
  finished: boolean;
  won: boolean;
  maxMoves: number;
}

// ─── Helpers ──────────────────────────────────────────────────

function getGoalGrid(size: number): number[][] {
  const grid: number[][] = [];
  let val = 1;
  for (let y = 0; y < size; y++) {
    grid[y] = [];
    for (let x = 0; x < size; x++) {
      grid[y][x] = val;
      val++;
    }
  }
  grid[size - 1][size - 1] = 0; // empty space
  return grid;
}

function gridsEqual(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++) {
    if (a[y].length !== b[y].length) return false;
    for (let x = 0; x < a[y].length; x++) {
      if (a[y][x] !== b[y][x]) return false;
    }
  }
  return true;
}

function copyGrid(grid: number[][]): number[][] {
  return grid.map(row => [...row]);
}

/**
 * Count inversions in a flattened 1D representation of the puzzle.
 * Used to check solvability.
 */
function countInversions(grid: number[][]): number {
  const flat = grid.flat().filter(v => v !== 0);
  let inversions = 0;
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[i] > flat[j]) inversions++;
    }
  }
  return inversions;
}

/**
 * Check if a puzzle state is solvable.
 * For odd grid sizes: inversions must be even.
 * For even grid sizes: (inversions + row of empty from bottom, 1-based)
 * must be ODD — the solved state itself is the proof: 0 inversions, empty
 * on the bottom row (1 from bottom), sum 1. This branch previously
 * required the sum to be EVEN, which inverted the test for every
 * even-width grid: legally-shuffled boards (always solvable, sum odd)
 * "failed" it, so generateSolvablePuzzle's repair swap then made every
 * generated 4×4 puzzle genuinely unsolvable — no level that produced a
 * 4×4 board (levels ~4–7, including the production base difficulty) could
 * ever be won.
 */
function isSolvable(grid: number[][]): boolean {
  const size = grid.length;
  const inversions = countInversions(grid);

  if (size % 2 === 1) {
    // Odd grid: inversions must be even
    return inversions % 2 === 0;
  } else {
    // Even grid: find empty row from bottom
    let emptyRowFromBottom = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (grid[y][x] === 0) {
          emptyRowFromBottom = size - y;
        }
      }
    }
    return (inversions + emptyRowFromBottom) % 2 === 1;
  }
}

// ─── Difficulty presets ───────────────────────────────────────

function difficultyFromParams(diff: DifficultyParams): SlidingPuzzleDifficulty {
  const level = diff.level;
  // gridSize: 3 at level 1 → 5 at level 10
  const gridSize = Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE,
    Math.round(MIN_GRID_SIZE + (level - 1) * ((MAX_GRID_SIZE - MIN_GRID_SIZE) / 9))
  ));

  const totalTiles = gridSize * gridSize - 1;
  // maxMoves: 30 at level 1 → 200 at level 10 (proportional to grid size)
  const baseMoves = totalTiles * 5;
  const maxMoves = Math.max(30, Math.min(200,
    Math.round(baseMoves + (level - 1) * ((200 - baseMoves) / 9))
  ));
  // targetScore (par): totalTiles * 2 at level 1 → totalTiles at level 10 (tighter par)
  const targetScore = Math.max(10, Math.round(
    (totalTiles * 2) - (level - 1) * ((totalTiles) / 9)
  ));

  const d = diff.params;
  return {
    gridSize: d.gridSize ?? gridSize,
    maxMoves: d.maxMoves ?? maxMoves,
    targetScore: d.targetScore ?? targetScore,
  };
}

// ─── SlidingPuzzleGame ────────────────────────────────────────

export class SlidingPuzzleGame implements JackpotGame {
  private rng!: SeededRNG;
  private difficulty!: SlidingPuzzleDifficulty;
  private grid: number[][] = [];
  private goalGrid: number[][] = [];
  private emptyX: number = 0;
  private emptyY: number = 0;
  private moves: number = 0;
  private frame: number = 0;
  private finished: boolean = false;
  private won: boolean = false;

  init(seed: string, difficulty: DifficultyParams): void {
    this.rng = new SeededRNG(seed);
    this.difficulty = difficultyFromParams(difficulty);
    this.moves = 0;
    this.frame = 0;
    this.finished = false;
    this.won = false;

    const size = this.difficulty.gridSize;
    this.goalGrid = getGoalGrid(size);

    // Generate a solvable shuffled puzzle
    this.grid = this.generateSolvablePuzzle(size);
  }

  private generateSolvablePuzzle(size: number): number[][] {
    // Start from goal state
    const grid = getGoalGrid(size);
    this.emptyX = size - 1;
    this.emptyY = size - 1;

    // Make a large number of random moves to shuffle (using RNG for determinism)
    const shuffleMoves = size * size * 20; // enough to thoroughly shuffle
    const directions = [
      { dx: 0, dy: -1 }, // up
      { dx: 0, dy: 1 },  // down
      { dx: -1, dy: 0 }, // left
      { dx: 1, dy: 0 },  // right
    ];

    let lastDir = -1;
    for (let i = 0; i < shuffleMoves; i++) {
      // Pick a random direction
      const dirIdx = this.rng.nextInt(0, 3);
      // Avoid going back and forth (prevents trivial shuffling)
      if ((lastDir === 0 && dirIdx === 1) ||
          (lastDir === 1 && dirIdx === 0) ||
          (lastDir === 2 && dirIdx === 3) ||
          (lastDir === 3 && dirIdx === 2)) {
        continue;
      }

      const dir = directions[dirIdx];
      const nx = this.emptyX + dir.dx;
      const ny = this.emptyY + dir.dy;

      if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
        // Swap empty with tile
        grid[this.emptyY][this.emptyX] = grid[ny][nx];
        grid[ny][nx] = 0;
        this.emptyX = nx;
        this.emptyY = ny;
        lastDir = dirIdx;
      }
    }

    // Verify solvability (should always be solvable since we started from goal and made legal moves)
    if (!isSolvable(grid)) {
      // Extremely unlikely, but if we somehow get an unsolvable puzzle, swap two adjacent non-empty tiles
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size - 1; x++) {
          if (grid[y][x] !== 0 && grid[y][x + 1] !== 0) {
            const tmp = grid[y][x];
            grid[y][x] = grid[y][x + 1];
            grid[y][x + 1] = tmp;
            break;
          }
        }
        if (isSolvable(grid)) break;
      }
    }

    return grid;
  }

  onInput(input: TimestampedInput): void {
    if (this.finished) return;

    if (input.type === 'keydown') {
      const key = input.data.key as string;
      this.handleMoveByKey(key);
    } else if (input.type === 'click' || input.type === 'tap') {
      // Tap adjacent to empty: slide that tile into the empty space
      const x = input.data.x as number;
      const y = input.data.y as number;
      // Number.isInteger, not a range comparison alone: NaN, strings,
      // booleans, and fractions all pass `x < 0 || x >= size` (every
      // comparison is false) and would corrupt the grid/empty-cell state
      // via slideTile before crashing on an undefined row.
      if (!Number.isInteger(x) || !Number.isInteger(y)) return;
      if (x < 0 || x >= this.difficulty.gridSize || y < 0 || y >= this.difficulty.gridSize) return;

      // Check if tapped tile is adjacent to empty space
      const dx = Math.abs(x - this.emptyX);
      const dy = Math.abs(y - this.emptyY);
      if ((dx === 1 && dy === 0) || (dx === 0 && dy === 1)) {
        this.slideTile(x, y);
      }
    }
  }

  private handleMoveByKey(key: string): void {
    let dx = 0;
    let dy = 0;

    switch (key) {
      case 'ArrowUp':
        dx = 0; dy = -1; break;
      case 'ArrowDown':
        dx = 0; dy = 1; break;
      case 'ArrowLeft':
        dx = -1; dy = 0; break;
      case 'ArrowRight':
        dx = 1; dy = 0; break;
      default:
        return; // unknown key
    }

    // The tile that slides into the empty space is opposite to the arrow direction
    // ArrowUp means tile below the empty space slides up into it
    const tileX = this.emptyX + dx;
    const tileY = this.emptyY + dy;

    if (tileX >= 0 && tileX < this.difficulty.gridSize &&
        tileY >= 0 && tileY < this.difficulty.gridSize) {
      this.slideTile(tileX, tileY);
    }
  }

  private slideTile(tileX: number, tileY: number): void {
    // Swap the tile with the empty space
    this.grid[this.emptyY][this.emptyX] = this.grid[tileY][tileX];
    this.grid[tileY][tileX] = 0;
    this.emptyX = tileX;
    this.emptyY = tileY;
    this.moves++;

    // Check win condition
    if (gridsEqual(this.grid, this.goalGrid)) {
      this.won = true;
      this.finished = true;
      return;
    }

    // Check loss condition (exceeded max moves)
    if (this.moves >= this.difficulty.maxMoves) {
      this.finished = true;
      this.won = false;
    }
  }

  tick(): void {
    // Turn-based, but not unbounded: an idle session must still terminate
    // (as a loss) so the client game ends and the replay verifier never
    // depends on its own frame cap to bail out.
    if (this.finished) return;
    this.frame++;
    if (this.frame >= MAX_FRAMES) {
      this.finished = true;
      this.won = false;
    }
  }

  getState(): GameState {
    return {
      score: this.moves,
      finished: this.finished,
      won: this.won,
      targetScore: this.difficulty.targetScore,
      frame: this.frame,
      display: {
        grid: copyGrid(this.grid),
        gridSize: this.difficulty.gridSize,
        emptyX: this.emptyX,
        emptyY: this.emptyY,
        moves: this.moves,
        finished: this.finished,
        won: this.won,
        maxMoves: this.difficulty.maxMoves,
      },
    };
  }

  isFinished(): boolean {
    return this.finished;
  }

  finalScore(): number {
    return this.moves;
  }

  serializeState(): string {
    return JSON.stringify(this.getState());
  }

  /** Exposed for test access */
  _getGrid(): number[][] {
    return copyGrid(this.grid);
  }

  /** Exposed for test access */
  _getDifficulty(): SlidingPuzzleDifficulty {
    return { ...this.difficulty };
  }

  /** Exposed for test access */
  _getGoalGrid(): number[][] {
    return copyGrid(this.goalGrid);
  }
}
