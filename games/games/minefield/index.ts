import type { JackpotGame, GameState, DifficultyParams, TimestampedInput } from '../../sdk/interface.js';
import { SeededRNG } from '../../sdk/engine.js';

// ─── Constants ────────────────────────────────────────────────

export const MIN_GRID_SIZE = 4;
export const MAX_GRID_SIZE = 8;
export const MIN_MINE_PCT = 0.10;
export const MAX_MINE_PCT = 0.50;
export const MAX_FRAMES = 36000; // 10 minutes at 60fps — idle sessions end as a loss

// ─── Interfaces ───────────────────────────────────────────────

export interface MinefieldDifficulty {
  gridSize: number;   // 4–8
  mineCount: number;  // number of mines
  targetScore: number;
}

export interface Tile {
  isMine: boolean;
  revealed: boolean;
  adjacentMines: number; // 0–8, number of neighboring mines
}

export interface MinefieldDisplay {
  grid: Array<{
    revealed: boolean;
    isMine: boolean;
    adjacentMines: number;
  }>;
  gridSize: number;
  score: number;
  frame: number;
  finished: boolean;
  won: boolean;
  totalSafe: number;
}

// ─── Difficulty presets ───────────────────────────────────────

function difficultyFromParams(diff: DifficultyParams): MinefieldDifficulty {
  // Clamp: the engine normally passes 1..10, but a raw replay input file
  // may not. An unclamped level extrapolates minePct past 1.0, making
  // mineCount exceed the grid — mine placement then loops forever looking
  // for a free tile.
  const level = Math.max(1, Math.min(10, diff.level));
  // gridSize: 4 at level 1 → 8 at level 10
  const gridSize = Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE,
    Math.round(MIN_GRID_SIZE + (level - 1) * ((MAX_GRID_SIZE - MIN_GRID_SIZE) / 9))
  ));
  const totalTiles = gridSize * gridSize;
  // mine %: 10% at level 1 → 50% at level 10
  const minePct = MIN_MINE_PCT + (level - 1) * ((MAX_MINE_PCT - MIN_MINE_PCT) / 9);
  const mineCount = Math.max(1, Math.round(totalTiles * minePct));
  const targetScore = totalTiles - mineCount; // clear all safe tiles

  const d = diff.params;
  const resolvedGridSize = d.gridSize ?? gridSize;
  // Cap after param overrides too: mineCount >= total tiles would spin the
  // placement loop forever (and a board of all mines has no winnable state).
  const resolvedTiles = resolvedGridSize * resolvedGridSize;
  const resolvedMines = Math.min(d.mineCount ?? mineCount, resolvedTiles - 1);
  return {
    gridSize: resolvedGridSize,
    mineCount: resolvedMines,
    targetScore: d.targetScore ?? targetScore,
  };
}

// ─── MinefieldGame ────────────────────────────────────────────

export class MinefieldGame implements JackpotGame {
  private rng!: SeededRNG;
  private difficulty!: MinefieldDifficulty;
  private grid: Tile[][] = [];
  private gridSize: number = 0;
  private score: number = 0;
  private frame: number = 0;
  private finished: boolean = false;
  private won: boolean = false;
  private firstMove: boolean = true;

  init(seed: string, difficulty: DifficultyParams): void {
    this.rng = new SeededRNG(seed);
    this.difficulty = difficultyFromParams(difficulty);
    this.gridSize = this.difficulty.gridSize;
    this.score = 0;
    this.frame = 0;
    this.finished = false;
    this.won = false;
    this.firstMove = true;

    this.generateGrid();
  }

  private generateGrid(): void {
    // Initialize empty grid
    this.grid = [];
    for (let y = 0; y < this.gridSize; y++) {
      this.grid[y] = [];
      for (let x = 0; x < this.gridSize; x++) {
        this.grid[y][x] = {
          isMine: false,
          revealed: false,
          adjacentMines: 0,
        };
      }
    }

    // Place mines using SeededRNG
    let minesPlaced = 0;
    const totalTiles = this.gridSize * this.gridSize;
    while (minesPlaced < this.difficulty.mineCount) {
      const idx = this.rng.nextInt(0, totalTiles - 1);
      const x = idx % this.gridSize;
      const y = Math.floor(idx / this.gridSize);
      if (!this.grid[y][x].isMine) {
        this.grid[y][x].isMine = true;
        minesPlaced++;
      }
    }

    // Calculate adjacent mine counts
    for (let y = 0; y < this.gridSize; y++) {
      for (let x = 0; x < this.gridSize; x++) {
        if (!this.grid[y][x].isMine) {
          this.grid[y][x].adjacentMines = this.countAdjacentMines(x, y);
        }
      }
    }
  }

  private countAdjacentMines(x: number, y: number): number {
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < this.gridSize && ny >= 0 && ny < this.gridSize) {
          if (this.grid[ny][nx].isMine) count++;
        }
      }
    }
    return count;
  }

  onInput(input: TimestampedInput): void {
    if (this.finished) return;

    // Support click/tap with {x, y} grid coordinates
    if (input.type === 'click' || input.type === 'tap') {
      const x = input.data.x as number;
      const y = input.data.y as number;

      // Validate coordinates. Number.isInteger, not a range comparison
      // alone: NaN, strings, booleans, and fractions all sail through
      // `x < 0 || x >= size` (every comparison is false) and then index
      // grid[NaN]/grid[y][0.5] as undefined.
      if (!Number.isInteger(x) || !Number.isInteger(y)) return;
      if (x < 0 || x >= this.gridSize || y < 0 || y >= this.gridSize) return;

      // Ignore already revealed tiles
      if (this.grid[y][x].revealed) return;

      // Reveal the tile
      this.revealTile(x, y);
    }
  }

  private revealTile(x: number, y: number): void {
    const tile = this.grid[y][x];

    // Safety: prevent re-revealing
    if (tile.revealed) return;

    tile.revealed = true;

    // Hit a mine → game over (loss)
    if (tile.isMine) {
      this.finished = true;
      this.won = false;
      return;
    }

    // Safe tile revealed
    this.score++;

    // If adjacent mines is 0, flood-fill reveal neighbors
    if (tile.adjacentMines === 0) {
      this.floodReveal(x, y);
    }

    // Check win conditions
    if (this.score >= this.difficulty.targetScore) {
      this.won = true;
      this.finished = true;
    }
  }

  private floodReveal(x: number, y: number): void {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < this.gridSize && ny >= 0 && ny < this.gridSize) {
          const neighbor = this.grid[ny][nx];
          if (!neighbor.revealed && !neighbor.isMine) {
            neighbor.revealed = true;
            this.score++;
            if (neighbor.adjacentMines === 0) {
              this.floodReveal(nx, ny);
            }
          }
        }
      }
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
      score: this.score,
      finished: this.finished,
      won: this.won,
      targetScore: this.difficulty.targetScore,
      frame: this.frame,
      display: {
        grid: this.grid.flat().map(t => ({
          revealed: t.revealed,
          isMine: t.isMine,
          adjacentMines: t.adjacentMines,
        })),
        gridSize: this.gridSize,
        score: this.score,
        frame: this.frame,
        finished: this.finished,
        won: this.won,
        totalSafe: this.gridSize * this.gridSize - this.difficulty.mineCount,
      },
    };
  }

  isFinished(): boolean {
    return this.finished;
  }

  finalScore(): number {
    return this.score;
  }

  serializeState(): string {
    return JSON.stringify(this.getState());
  }

  /** Exposed for test access */
  _getGrid(): Tile[][] {
    return this.grid.map(row => row.map(t => ({ ...t })));
  }

  /** Exposed for test access */
  _getDifficulty(): MinefieldDifficulty {
    return { ...this.difficulty };
  }
}
