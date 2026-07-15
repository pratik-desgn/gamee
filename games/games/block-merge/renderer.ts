import { Renderer } from '../../sdk/renderer.js';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  TILE_GAP,
  TILE_RADIUS,
} from './index.js';
import type { BlockMergeDisplay } from './index.js';

// ─── Tile color map for powers of 2 ────────────────────────────

const TILE_COLORS: Record<number, { bg: string; fg: string }> = {
  0:     { bg: '#CDC1B4', fg: '#776E65' },
  2:     { bg: '#EEE4DA', fg: '#776E65' },
  4:     { bg: '#EDE0C8', fg: '#776E65' },
  8:     { bg: '#F2B179', fg: '#F9F6F2' },
  16:    { bg: '#F59563', fg: '#F9F6F2' },
  32:    { bg: '#F67C5F', fg: '#F9F6F2' },
  64:    { bg: '#F65E3B', fg: '#F9F6F2' },
  128:   { bg: '#EDCF72', fg: '#F9F6F2' },
  256:   { bg: '#EDCC61', fg: '#F9F6F2' },
  512:   { bg: '#EDC850', fg: '#F9F6F2' },
  1024:  { bg: '#EDC53F', fg: '#F9F6F2' },
  2048:  { bg: '#EDC22E', fg: '#F9F6F2' },
  4096:  { bg: '#3C3A32', fg: '#F9F6F2' },
  8192:  { bg: '#3C3A32', fg: '#F9F6F2' },
};

function getTileColor(value: number): { bg: string; fg: string } {
  return TILE_COLORS[value] ?? { bg: '#3C3A32', fg: '#F9F6F2' };
}

/**
 * Canvas renderer for Block Merge.
 * Draws a 2048-style grid with numbered tiles and score.
 */
export class BlockMergeRenderer extends Renderer {
  private bgColor: string;
  private gridBgColor: string;
  private cellBgColor: string;

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number = CANVAS_WIDTH,
    height: number = CANVAS_HEIGHT,
    colors?: {
      background?: string;
      gridBg?: string;
      cellBg?: string;
    },
  ) {
    super(ctx, width, height);
    this.bgColor = colors?.background ?? '#FAF8EF';
    this.gridBgColor = colors?.gridBg ?? '#BBADA0';
    this.cellBgColor = colors?.cellBg ?? '#CDC1B4';
  }

  render(state: Record<string, unknown>): void {
    const display = state as unknown as BlockMergeDisplay;
    this.clear();
    this.drawBackground(this.bgColor);

    const gridSize = display.gridSize || 4;
    const totalGap = (gridSize + 1) * TILE_GAP;
    const tileSize = (this.width - totalGap) / gridSize;

    // Draw grid background
    const gridPadding = TILE_GAP;
    const gridPixelW = gridSize * tileSize + (gridSize + 1) * TILE_GAP;
    const gridPixelH = gridSize * tileSize + (gridSize + 1) * TILE_GAP;
    const gridOffsetX = (this.width - gridPixelW) / 2;
    const gridOffsetY = 80; // leave room for score at top
    this.fillRect(gridOffsetX, gridOffsetY, gridPixelW, gridPixelH, this.gridBgColor);

    // Draw tiles
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const value = display.grid[r]?.[c] ?? 0;
        const x = gridOffsetX + TILE_GAP + c * (tileSize + TILE_GAP);
        const y = gridOffsetY + TILE_GAP + r * (tileSize + TILE_GAP);
        this.drawTile(x, y, tileSize, value);
      }
    }

    // Draw score
    this.drawText(
      `Score: ${display.score}`,
      10,
      10,
      '#776E65',
      20,
      'monospace',
      'left',
      'top',
    );

    // Draw moves remaining — the real, visible pressure: this is what
    // actually decides a loss most of the time (the board rarely fills up
    // completely before the move budget runs out). Color escalates as the
    // budget drains so "you're about to lose" reads at a glance.
    const movesLeft = display.movesRemaining ?? 0;
    const movesColor = movesLeft <= 10 ? '#F65E3B' : movesLeft <= 30 ? '#F59563' : '#776E65';
    this.drawText(
      display.finished
        ? (display.won ? 'Target reached!' : 'Out of moves')
        : `Moves left: ${movesLeft}`,
      10,
      34,
      movesColor,
      14,
      'monospace',
      'left',
      'top',
    );

    // Draw frame counter
    this.drawText(
      `Frame: ${display.frame}`,
      10,
      56,
      '#776E65',
      14,
      'monospace',
      'left',
      'top',
    );
  }

  private drawTile(x: number, y: number, size: number, value: number): void {
    const { bg, fg } = getTileColor(value);

    // Tile background (rounded via filled rect)
    this.fillRect(x, y, size, size, bg);

    // Tile border (subtle)
    this.ctx.strokeStyle = 'rgba(0,0,0,0.1)';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(x, y, size, size);

    // Tile value text
    if (value !== 0) {
      const fontSize = value < 100 ? size * 0.45 : value < 1000 ? size * 0.38 : size * 0.30;
      this.drawText(
        String(value),
        x + size / 2,
        y + size / 2,
        fg,
        fontSize,
        'monospace',
        'center',
        'middle',
      );
    }
  }

  /** Draw a "Game Over" overlay */
  drawGameOver(score: number, won: boolean): void {
    const msg = won ? 'YOU WIN!' : 'GAME OVER';
    const color = won ? 'rgba(0,100,0,0.8)' : 'rgba(0,0,0,0.7)';
    this.drawOverlay(
      `${msg}\nScore: ${score}`,
      color,
      '#fff',
      36,
    );
  }
}
