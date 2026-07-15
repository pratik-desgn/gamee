import { Renderer } from '../../sdk/renderer.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from './index.js';
import type { SimonProDisplay } from './index.js';

/**
 * Canvas renderer for Simon Pro.
 * Draws colored buttons that flash when highlighted, score, and game-over overlay.
 */
export class SimonProRenderer extends Renderer {
  private buttonColors: string[];
  private highlightColors: string[];
  private bgColor: string;

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number = CANVAS_WIDTH,
    height: number = CANVAS_HEIGHT,
    colors?: {
      buttons?: string[];
      highlights?: string[];
      background?: string;
    },
  ) {
    super(ctx, width, height);
    this.bgColor = colors?.background ?? '#1a1a2e';
    this.buttonColors = colors?.buttons ?? [
      '#e74c3c', // red
      '#3498db', // blue
      '#2ecc71', // green
      '#f1c40f', // yellow
      '#9b59b6', // purple
      '#e67e22', // orange
    ];
    this.highlightColors = colors?.highlights ?? [
      '#ff6b6b', // bright red
      '#74b9ff', // bright blue
      '#55efc4', // bright green
      '#ffeaa7', // bright yellow
      '#a29bfe', // bright purple
      '#fdcb6e', // bright orange
    ];
  }

  render(state: Record<string, unknown>): void {
    const display = state as unknown as SimonProDisplay;
    this.clear();
    this.drawBackground(this.bgColor);

    const colors = display.colors || 4;
    const buttons = this.layoutButtons(colors);

    // Draw each button
    for (let i = 0; i < colors; i++) {
      const btn = buttons[i];
      const isHighlighted = display.highlightButton === i;
      const color = isHighlighted
        ? (this.highlightColors[i] ?? this.highlightColors[i % this.highlightColors.length])
        : (this.buttonColors[i] ?? this.buttonColors[i % this.buttonColors.length]);

      this.drawButton(btn.x, btn.y, btn.size, color, i);
    }

    // Draw score
    this.drawText(
      `Score: ${display.score}`,
      10,
      10,
      '#fff',
      20,
      'monospace',
      'left',
      'top',
    );

    // Draw phase indicator — this is the single most important thing on
    // screen (it's the whole game: memorize during WATCH, repeat during
    // YOUR TURN), so make it loud and give it a color, not just a label
    // easy to miss among the other small text.
    const phaseText = display.phase === 'showing' ? '👀 WATCH' : display.phase === 'input' ? '▶ YOUR TURN — repeat it' : 'DONE';
    const phaseColor = display.phase === 'showing' ? '#74b9ff' : display.phase === 'input' ? '#55efc4' : '#fff';
    this.drawText(
      phaseText,
      this.width / 2,
      8,
      phaseColor,
      20,
      'monospace',
      'center',
      'top',
    );

    // Draw frame counter
    this.drawText(
      `Frame: ${display.frame}`,
      10,
      34,
      '#fff',
      14,
      'monospace',
      'left',
      'top',
    );

    // Draw sequence length
    this.drawText(
      `Seq: ${display.sequence.length}`,
      this.width - 80,
      10,
      '#fff',
      14,
      'monospace',
      'left',
      'top',
    );
  }

  private layoutButtons(numColors: number): Array<{ x: number; y: number; size: number }> {
    const padding = 20;
    const gap = 10;
    const totalWidth = this.width - padding * 2;
    const totalHeight = this.height - padding * 2 - 40; // leave room for text at top

    if (numColors <= 4) {
      // 2x2 grid
      const cols = 2;
      const rows = 2;
      const cellW = (totalWidth - gap * (cols - 1)) / cols;
      const cellH = (totalHeight - gap * (rows - 1)) / rows;
      const size = Math.min(cellW, cellH);

      return [
        { x: padding, y: padding + 40, size },                        // top-left
        { x: padding + size + gap, y: padding + 40, size },            // top-right
        { x: padding, y: padding + 40 + size + gap, size },            // bottom-left
        { x: padding + size + gap, y: padding + 40 + size + gap, size }, // bottom-right
      ].slice(0, numColors);
    } else {
      // 3x2 grid or 3x3 for 6 colors
      const cols = 3;
      const rows = Math.ceil(numColors / 3);
      const cellW = (totalWidth - gap * (cols - 1)) / cols;
      const cellH = (totalHeight - gap * (rows - 1)) / rows;
      const size = Math.min(cellW, cellH);
      const startY = padding + 40;

      const result: Array<{ x: number; y: number; size: number }> = [];
      for (let i = 0; i < numColors; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        result.push({
          x: padding + col * (size + gap),
          y: startY + row * (size + gap),
          size,
        });
      }
      return result;
    }
  }

  private drawButton(x: number, y: number, size: number, color: string, index: number): void {
    const radius = 8; // rounded corners

    // Shadow
    this.ctx.shadowColor = 'rgba(0,0,0,0.3)';
    this.ctx.shadowBlur = 8;
    this.ctx.shadowOffsetY = 4;

    // Main button (rounded rect)
    this.ctx.beginPath();
    this.ctx.moveTo(x + radius, y);
    this.ctx.lineTo(x + size - radius, y);
    this.ctx.quadraticCurveTo(x + size, y, x + size, y + radius);
    this.ctx.lineTo(x + size, y + size - radius);
    this.ctx.quadraticCurveTo(x + size, y + size, x + size - radius, y + size);
    this.ctx.lineTo(x + radius, y + size);
    this.ctx.quadraticCurveTo(x, y + size, x, y + size - radius);
    this.ctx.lineTo(x, y + radius);
    this.ctx.quadraticCurveTo(x, y, x + radius, y);
    this.ctx.closePath();

    this.ctx.fillStyle = color;
    this.ctx.fill();

    // Reset shadow
    this.ctx.shadowColor = 'transparent';
    this.ctx.shadowBlur = 0;
    this.ctx.shadowOffsetY = 0;

    // Border
    this.strokeRect(x, y, size, size, 'rgba(255,255,255,0.3)', 2);

    // Label (number)
    this.drawText(
      `${index + 1}`,
      x + size / 2,
      y + size / 2,
      'rgba(255,255,255,0.8)',
      Math.max(size / 4, 14),
      'monospace',
      'center',
      'middle',
    );
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
