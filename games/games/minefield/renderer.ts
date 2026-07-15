import { Renderer } from '../../sdk/renderer.js';
import type { MinefieldDisplay } from './index.js';

/**
 * Canvas renderer for Minefield.
 * Draws a grid of tiles, revealing mines, numbers, flags, and game-over overlay.
 */
export class MinefieldRenderer extends Renderer {
  private revealedColor: string;
  private hiddenColor: string;
  private mineColor: string;
  private gridLineColor: string;
  private numberColors: Record<number, string>;

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number = 400,
    height: number = 400,
    colors?: {
      revealed?: string;
      hidden?: string;
      mine?: string;
      gridLine?: string;
      numberColors?: Record<number, string>;
    },
  ) {
    super(ctx, width, height);
    this.revealedColor = colors?.revealed ?? '#d4d4d4';
    this.hiddenColor = colors?.hidden ?? '#a0a0a0';
    this.mineColor = colors?.mine ?? '#e74c3c';
    this.gridLineColor = colors?.gridLine ?? '#666';
    this.numberColors = colors?.numberColors ?? {
      1: '#0000ff',
      2: '#008000',
      3: '#ff0000',
      4: '#000080',
      5: '#800000',
      6: '#008080',
      7: '#000000',
      8: '#808080',
    };
  }

  render(state: Record<string, unknown>): void {
    const display = state as unknown as MinefieldDisplay;
    this.clear();
    this.drawBackground('#2c3e50');

    // Reserved header/footer strips outside the grid's own bounds — sizing
    // the grid off the full canvas and drawing text at a fixed offset from
    // the edges (the old approach) let the "Safe: X/Y" line land on top of
    // the bottom row of tiles for larger grids.
    const headerH = 20;
    const footerH = 28;
    const gridSize = display.gridSize;
    const availH = this.height - headerH - footerH;
    const cellSize = Math.min(this.width * 0.94, availH) / gridSize;
    const marginX = (this.width - cellSize * gridSize) / 2;
    const marginY = headerH + (availH - cellSize * gridSize) / 2;

    // This is real Minesweeper logic underneath (each revealed number is
    // exactly the count of mines in its 8 neighbors — the tiles already
    // carry that information), but without saying so it's easy to miss
    // that the numbers are a solving tool and not decoration.
    this.drawText(
      'Numbers = mines in neighboring tiles',
      this.width / 2,
      2,
      '#aaa',
      11,
      'monospace',
      'center',
      'top',
    );

    // Draw each cell
    for (let idx = 0; idx < display.grid.length; idx++) {
      const tile = display.grid[idx];
      const x = idx % gridSize;
      const y = Math.floor(idx / gridSize);

      const cx = marginX + x * cellSize;
      const cy = marginY + y * cellSize;

      if (tile.revealed) {
        // Revealed tile
        this.fillRect(cx, cy, cellSize, cellSize, this.revealedColor);

        if (tile.isMine) {
          // Draw mine
          this.fillCircle(cx + cellSize / 2, cy + cellSize / 2, cellSize * 0.3, this.mineColor);
          // X mark
          const half = cellSize * 0.25;
          this.ctx.strokeStyle = '#fff';
          this.ctx.lineWidth = 2;
          this.ctx.beginPath();
          this.ctx.moveTo(cx + cellSize / 2 - half, cy + cellSize / 2 - half);
          this.ctx.lineTo(cx + cellSize / 2 + half, cy + cellSize / 2 + half);
          this.ctx.moveTo(cx + cellSize / 2 + half, cy + cellSize / 2 - half);
          this.ctx.lineTo(cx + cellSize / 2 - half, cy + cellSize / 2 + half);
          this.ctx.stroke();
        } else if (tile.adjacentMines > 0) {
          // Draw number
          const color = this.numberColors[tile.adjacentMines] ?? '#000';
          this.drawText(
            String(tile.adjacentMines),
            cx + cellSize / 2,
            cy + cellSize / 2,
            color,
            cellSize * 0.5,
            'monospace',
            'center',
            'middle',
          );
        }
      } else {
        // Hidden tile
        this.fillRect(cx, cy, cellSize, cellSize, this.hiddenColor);
        // Subtle pattern
        this.fillRect(cx + 1, cy + 1, cellSize - 2, cellSize - 2, this.hiddenColor);
      }

      // Grid lines
      this.strokeRect(cx, cy, cellSize, cellSize, this.gridLineColor, 1);
    }

    // Score, in the reserved footer strip (never overlaps the grid,
    // regardless of gridSize).
    this.drawText(
      `Safe revealed: ${display.score} / ${display.totalSafe}`,
      this.width / 2,
      this.height - footerH + 6,
      '#fff',
      15,
      'monospace',
      'center',
      'top',
    );
  }

  /** Draw a "Game Over" overlay */
  drawGameOver(score: number, won: boolean): void {
    const msg = won ? 'YOU WIN!' : 'GAME OVER';
    const color = won ? 'rgba(0,100,0,0.8)' : 'rgba(180,0,0,0.8)';
    this.drawOverlay(
      `${msg}\nSafe tiles: ${score}`,
      color,
      '#fff',
      36,
    );
  }
}
