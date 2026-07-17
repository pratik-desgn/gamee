import type { JackpotGame, GameState, DifficultyParams, TimestampedInput } from '../../sdk/interface.js';
import { SeededRNG } from '../../sdk/engine.js';

// ─── Constants ────────────────────────────────────────────────

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 500;
export const TILE_GAP = 8;
export const TILE_RADIUS = 6;
export const MAX_FRAMES = 36000; // 10 minutes at 60fps

// ─── Interfaces ───────────────────────────────────────────────

export interface BlockMergeDifficulty {
  gridSize: number;      // 4–6
  targetScore: number;   // 512 / 1024 / 2048
  startTiles: number;    // 2–4
  maxMoves: number;      // move budget to build the target tile
}

export interface BlockMergeDisplay {
  grid: number[][];
  score: number;
  mergeScore: number;
  movesRemaining: number;
  frame: number;
  gridSize: number;
  finished: boolean;
  won: boolean;
}

// ─── Difficulty presets ───────────────────────────────────────

function difficultyFromParams(diff: DifficultyParams): BlockMergeDifficulty {
  const level = diff.level;
  // gridSize: 4 at low, 5 at mid, 6 at high
  const gridSize = Math.min(6, Math.max(4, Math.round(4 + (level - 1) * (2 / 9))));
  // targetScore: 512 → 1024 → 2048
  const targetScore = level <= 3 ? 512 : level <= 6 ? 1024 : 2048;
  // startTiles: 2 → 3 → 4
  const startTiles = Math.min(4, Math.max(2, Math.round(2 + (level - 1) * (2 / 9))));
  // Move budget, tiered with the target tile — without this, the only
  // ways a session could end were building the target (win) or the board
  // becoming completely full with zero legal merges (rare — a 2048-style
  // board can absorb hundreds of moves before that happens), so a session
  // that wasn't heading anywhere could run for the full 10-minute idle cap
  // before ever resolving as a loss.
  //
  // The budget must clear the value-conservation floor: every move spawns
  // exactly one tile worth at most 4, so after m moves the total value on
  // the board is at most 4*(startTiles + m) — the original 120/220/350
  // budgets capped total board value at 488/892/1416, strictly below their
  // own 512/1024/2048 targets, making every level provably unwinnable by
  // any player. With the realistic spawn mix (90% twos, expected 2.2/move)
  // the practical floor is target/2.2 moves (~233/466/931); budgets sit
  // ~40% above that so efficient play wins with real margin (a strong
  // search bot at a 1.24× budget still ran out of moves at the 1024 tile
  // half the time) while aimless play still resolves as a loss well
  // inside the 10-minute frame cap.
  const maxMoves = targetScore <= 512 ? 330 : targetScore <= 1024 ? 650 : 1300;

  const d = diff.params;
  return {
    gridSize: d.gridSize ?? gridSize,
    targetScore: d.targetScore ?? targetScore,
    startTiles: d.startTiles ?? startTiles,
    maxMoves: d.maxMoves ?? maxMoves,
  };
}

// ─── 2048-style helpers ───────────────────────────────────────

/** Slide and merge one row leftward. Returns { new row, score } */
function slideRow(row: number[]): { row: number[]; score: number } {
  // Remove zeros
  const cells = row.filter(v => v !== 0);
  let score = 0;

  // Merge adjacent equal values
  for (let i = 0; i < cells.length - 1; i++) {
    if (cells[i] === cells[i + 1]) {
      cells[i] *= 2;
      score += cells[i];
      cells.splice(i + 1, 1);
    }
  }

  // Pad with zeros
  while (cells.length < row.length) {
    cells.push(0);
  }

  return { row: cells, score };
}

/** Extract a column from the grid */
function getCol(grid: number[][], col: number): number[] {
  return grid.map(r => r[col]);
}

/** Set a column in the grid */
function setCol(grid: number[][], col: number, vals: number[]): void {
  for (let r = 0; r < grid.length; r++) {
    grid[r][col] = vals[r];
  }
}

/** Check if two grids are identical */
function gridEquals(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    if (a[r].length !== b[r].length) return false;
    for (let c = 0; c < a[r].length; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

/** Deep clone a grid */
function cloneGrid(grid: number[][]): number[][] {
  return grid.map(r => [...r]);
}

// ─── BlockMergeGame ───────────────────────────────────────────

export class BlockMergeGame implements JackpotGame {
  private rng!: SeededRNG;
  private difficulty!: BlockMergeDifficulty;
  private grid: number[][] = [];
  private score: number = 0;
  private moves: number = 0;
  private frame: number = 0;
  private finished: boolean = false;
  private won: boolean = false;

  init(seed: string, difficulty: DifficultyParams): void {
    this.rng = new SeededRNG(seed);
    this.difficulty = difficultyFromParams(difficulty);

    const size = this.difficulty.gridSize;
    this.grid = Array.from({ length: size }, () => Array(size).fill(0));
    this.score = 0;
    this.moves = 0;
    this.frame = 0;
    this.finished = false;
    this.won = false;

    // Place starting tiles
    for (let i = 0; i < this.difficulty.startTiles; i++) {
      this.spawnTile();
    }
  }

  onInput(input: TimestampedInput): void {
    if (this.finished) return;

    if (input.type === 'keydown' || input.type === 'swipe') {
      let direction: string | undefined;

      if (typeof input.data.key === 'string') {
        direction = input.data.key;
      } else if (typeof input.data.direction === 'string') {
        direction = input.data.direction;
      }

      if (!direction) return;

      const gridBefore = cloneGrid(this.grid);
      let moved = false;

      switch (direction) {
        case 'ArrowLeft':
        case 'left':
          moved = this.moveLeft();
          break;
        case 'ArrowRight':
        case 'right':
          moved = this.moveRight();
          break;
        case 'ArrowUp':
        case 'up':
          moved = this.moveUp();
          break;
        case 'ArrowDown':
        case 'down':
          moved = this.moveDown();
          break;
        default:
          return;
      }

      if (moved && !gridEquals(gridBefore, this.grid)) {
        this.moves++;
        this.spawnTile();
        // Each individual move*() direction handler already calls
        // checkWinLoss() right after merging (to catch a win the instant
        // the target tile appears), but the move-budget loss below can
        // only be evaluated here, after moves is incremented — a stalled
        // player who keeps making real moves without reaching the target
        // now loses cleanly instead of running out the 10-minute idle cap.
        if (!this.finished && this.moves >= this.difficulty.maxMoves) {
          this.finished = true;
          this.won = false;
        }
      }
    }
  }

  tick(): void {
    // Turn-based, but MAX_FRAMES must actually be enforced (it was only
    // ever declared): an idle session must terminate (as a loss) so the
    // client game ends and the replay verifier never depends on its own
    // frame cap to bail out.
    if (this.finished) return;
    this.frame++;
    if (this.frame >= MAX_FRAMES) {
      this.finished = true;
      this.won = false;
    }
  }

  // ─── Movement logic ─────────────────────────────────────────

  private moveLeft(): boolean {
    let moved = false;
    for (let r = 0; r < this.difficulty.gridSize; r++) {
      const before = [...this.grid[r]];
      const result = slideRow(this.grid[r]);
      this.grid[r] = result.row;
      this.score += result.score;
      if (!arraysEqual(before, this.grid[r])) moved = true;
    }
    this.checkWinLoss();
    return moved;
  }

  private moveRight(): boolean {
    let moved = false;
    for (let r = 0; r < this.difficulty.gridSize; r++) {
      const before = [...this.grid[r]];
      const reversed = [...this.grid[r]].reverse();
      const result = slideRow(reversed);
      this.grid[r] = result.row.reverse();
      this.score += result.score;
      if (!arraysEqual(before, this.grid[r])) moved = true;
    }
    this.checkWinLoss();
    return moved;
  }

  private moveUp(): boolean {
    let moved = false;
    for (let c = 0; c < this.difficulty.gridSize; c++) {
      const before = getCol(this.grid, c);
      const result = slideRow(before);
      setCol(this.grid, c, result.row);
      this.score += result.score;
      if (!arraysEqual(before, getCol(this.grid, c))) moved = true;
    }
    this.checkWinLoss();
    return moved;
  }

  private moveDown(): boolean {
    let moved = false;
    for (let c = 0; c < this.difficulty.gridSize; c++) {
      const before = getCol(this.grid, c);
      const reversed = before.reverse();
      const result = slideRow(reversed);
      setCol(this.grid, c, result.row.reverse());
      this.score += result.score;
      if (!arraysEqual(before, getCol(this.grid, c))) moved = true;
    }
    this.checkWinLoss();
    return moved;
  }

  // ─── Tile spawning ──────────────────────────────────────────

  private spawnTile(): void {
    const emptyCells: Array<{ r: number; c: number }> = [];
    for (let r = 0; r < this.difficulty.gridSize; r++) {
      for (let c = 0; c < this.difficulty.gridSize; c++) {
        if (this.grid[r][c] === 0) {
          emptyCells.push({ r, c });
        }
      }
    }

    if (emptyCells.length === 0) return;

    // Pick a random empty cell
    const idx = this.rng.nextInt(0, emptyCells.length - 1);
    const cell = emptyCells[idx];

    // 90% chance of 2, 10% chance of 4
    const value = this.rng.next() < 0.9 ? 2 : 4;
    this.grid[cell.r][cell.c] = value;
  }

  // ─── Game state checks ──────────────────────────────────────

  private checkWinLoss(): void {
    // Check win — on the TILE scale, not the cumulative merge score.
    // targetScore is 512/1024/2048 ("build this tile", like 2048 the
    // game); the cumulative score crosses those values long before the
    // tile exists, which made wins far too easy AND put getState().score
    // on a different scale than finalScore() (the reaction-test
    // settlement-bug class).
    if (this.maxTile() >= this.difficulty.targetScore) {
      this.won = true;
      this.finished = true;
      return;
    }

    // Check loss: grid full with no possible merges
    if (!this.hasEmptyCell() && !this.hasPossibleMerge()) {
      this.finished = true;
      this.won = false;
    }
  }

  private hasEmptyCell(): boolean {
    for (let r = 0; r < this.difficulty.gridSize; r++) {
      for (let c = 0; c < this.difficulty.gridSize; c++) {
        if (this.grid[r][c] === 0) return true;
      }
    }
    return false;
  }

  private hasPossibleMerge(): boolean {
    for (let r = 0; r < this.difficulty.gridSize; r++) {
      for (let c = 0; c < this.difficulty.gridSize; c++) {
        const val = this.grid[r][c];
        // Check right neighbor
        if (c + 1 < this.difficulty.gridSize && this.grid[r][c + 1] === val) return true;
        // Check bottom neighbor
        if (r + 1 < this.difficulty.gridSize && this.grid[r + 1][c] === val) return true;
      }
    }
    return false;
  }

  // ─── Interface implementation ───────────────────────────────

  getState(): GameState {
    return {
      // Tile scale (highest tile), matching finalScore() and the
      // targetScore values — NOT the cumulative merge score, which lives
      // on in display.mergeScore for UI flavor only.
      score: this.maxTile(),
      finished: this.finished,
      won: this.won,
      targetScore: this.difficulty.targetScore,
      frame: this.frame,
      display: {
        grid: this.grid.map(r => [...r]),
        score: this.maxTile(),
        mergeScore: this.score,
        movesRemaining: Math.max(0, this.difficulty.maxMoves - this.moves),
        frame: this.frame,
        gridSize: this.difficulty.gridSize,
        finished: this.finished,
        won: this.won,
      },
    };
  }

  isFinished(): boolean {
    return this.finished;
  }

  /** Highest tile value on the grid — the game's single scoring scale. */
  private maxTile(): number {
    let maxVal = 0;
    for (let r = 0; r < this.difficulty.gridSize; r++) {
      for (let c = 0; c < this.difficulty.gridSize; c++) {
        maxVal = Math.max(maxVal, this.grid[r][c]);
      }
    }
    return maxVal;
  }

  finalScore(): number {
    // Same scale as getState().score — the client-reported and
    // verifier-reported numbers must agree or determineVerdict flags
    // every legitimate win as a mismatch.
    return this.maxTile();
  }

  serializeState(): string {
    return JSON.stringify({
      grid: this.grid.map(r => [...r]),
      score: this.score,
    });
  }

  // ─── Test accessors ────────────────────────────────────────

  _getGrid(): number[][] {
    return this.grid.map(r => [...r]);
  }

  _getDifficulty(): BlockMergeDifficulty {
    return { ...this.difficulty };
  }

  _setGrid(grid: number[][]): void {
    this.grid = grid.map(r => [...r]);
  }
}

// ─── Utility ──────────────────────────────────────────────────

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
