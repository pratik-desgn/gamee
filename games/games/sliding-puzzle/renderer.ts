import { Renderer } from '../../sdk/renderer.js';
import type { SlidingPuzzleDisplay } from './index.js';

/**
 * Canvas renderer for Sliding Puzzle.
 * Draws an NxN grid of numbered tiles with one empty space, move counter,
 * and game-over overlay.
 */
export class SlidingPuzzleRenderer extends Renderer {
  private tileColors: {
    background: string;
    text: string;
    empty: string;
    gridLine: string;
  };

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number = 400,
    height: number = 400,
    colors?: {
      background?: string;
      text?: string;
      empty?: string;
      gridLine?: string;
    },
  ) {
    super(ctx, width, height);
    this.tileColors = {
      background: colors?.background ?? '#3498db',
      text: colors?.text ?? '#fff',
      empty: colors?.empty ?? '#2c3e50',
      gridLine: colors?.gridLine ?? '#1a252f',
    };
  }

  render(state: Record<string, unknown>): void {
    const display = state as unknown as SlidingPuzzleDisplay;
    this.clear();
    this.drawBackground('#1a1a2e');

    // Reserve real, fixed header/footer strips OUTSIDE the grid's own
    // bounds — sizing the grid off the full canvas height and then
    // drawing text at a fixed offset from the bottom (the old approach)
    // put the move counter on top of the bottom row of tiles for larger
    // grids, since the grid's own margin shrinks as gridSize grows but the
    // text position didn't account for that.
    const headerH = 22;
    const footerH = 30;
    const gridSize = display.gridSize;
    const availH = this.height - headerH - footerH;
    const cellSize = Math.min(this.width * 0.92, availH) / gridSize;
    const marginX = (this.width - cellSize * gridSize) / 2;
    const marginY = headerH + (availH - cellSize * gridSize) / 2;

    // Goal instructions — this game's actual win condition (solve within
    // the move budget) isn't "reach a target score" like every other
    // game, so it needs to be stated plainly rather than left to a
    // generic Score/Target readout to (mis)explain.
    this.drawText(
      `Arrange 1–${gridSize * gridSize - 1} in order, left→right, top→bottom`,
      this.width / 2,
      2,
      '#aaa',
      11,
      'monospace',
      'center',
      'top',
    );

    // Draw each tile
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const value = display.grid[y][x];
        const cx = marginX + x * cellSize;
        const cy = marginY + y * cellSize;

        if (value === 0) {
          // Empty space
          this.fillRect(cx, cy, cellSize, cellSize, this.tileColors.empty);
        } else {
          // Numbered tile
          this.fillRect(cx, cy, cellSize, cellSize, this.tileColors.background);

          // Tile highlight (lighter top-left)
          this.fillRect(cx + 2, cy + 2, cellSize / 3, cellSize / 3, 'rgba(255,255,255,0.15)');

          // Number
          this.drawText(
            String(value),
            cx + cellSize / 2,
            cy + cellSize / 2,
            this.tileColors.text,
            cellSize * 0.4,
            'monospace',
            'center',
            'middle',
          );
        }

        // Grid border
        this.strokeRect(cx, cy, cellSize, cellSize, this.tileColors.gridLine, 2);
      }
    }

    // Move counter, in the reserved footer strip (never overlaps the
    // grid, regardless of gridSize) — color escalates as the budget
    // drains so "you're about to lose" reads at a glance, same convention
    // as block-merge's moves-remaining readout.
    const movesLeft = display.maxMoves - display.moves;
    const movesColor = movesLeft <= 10 ? '#F65E3B' : movesLeft <= 25 ? '#F59563' : '#fff';
    this.drawText(
      `Moves: ${display.moves} (max ${display.maxMoves})`,
      this.width / 2,
      this.height - footerH + 6,
      movesColor,
      15,
      'monospace',
      'center',
      'top',
    );
  }

  /** Draw a "Game Over" overlay */
  drawGameOver(moves: number, won: boolean): void {
    const msg = won ? 'PUZZLE SOLVED!' : 'OUT OF MOVES';
    const color = won ? 'rgba(0,100,0,0.8)' : 'rgba(180,0,0,0.8)';
    this.drawOverlay(
      `${msg}\nMoves: ${moves}`,
      color,
      '#fff',
      36,
    );
  }
}
