import { Renderer } from '../../sdk/renderer.js';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  STACK_AREA_LEFT,
  STACK_AREA_RIGHT,
  STACK_AREA_WIDTH,
  BLOCK_HEIGHT,
} from './index.js';
import type { PerfectStackDisplay } from './index.js';

/**
 * Canvas renderer for Perfect Stack.
 * Draws a vertical stack of blocks with a sliding current block on top.
 */
export class PerfectStackRenderer extends Renderer {
  private bgColor: string;
  private stackColor: string;
  private currentColor: string;
  private baseColor: string;

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number = CANVAS_WIDTH,
    height: number = CANVAS_HEIGHT,
    colors?: {
      background?: string;
      stack?: string;
      current?: string;
      base?: string;
    },
  ) {
    super(ctx, width, height);
    this.bgColor = colors?.background ?? '#1a1a2e';
    this.stackColor = colors?.stack ?? '#16213e';
    this.currentColor = colors?.current ?? '#e94560';
    this.baseColor = colors?.base ?? '#0f3460';
  }

  render(state: Record<string, unknown>): void {
    const display = state as unknown as PerfectStackDisplay;
    this.clear();
    this.drawBackground(this.bgColor);

    // Stack area background
    this.fillRect(
      STACK_AREA_LEFT,
      10,
      STACK_AREA_WIDTH,
      CANVAS_HEIGHT - 20,
      'rgba(255,255,255,0.03)',
    );

    // Draw stack vertical boundaries
    this.ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 4]);
    this.ctx.strokeRect(STACK_AREA_LEFT, 10, STACK_AREA_WIDTH, CANVAS_HEIGHT - 20);
    this.ctx.setLineDash([]);

    // Draw a base platform at the bottom
    const baseY = CANVAS_HEIGHT - 10 - BLOCK_HEIGHT;
    // Base platform
    this.fillRect(STACK_AREA_LEFT, baseY, STACK_AREA_WIDTH, BLOCK_HEIGHT, this.baseColor);
    this.strokeRect(
      STACK_AREA_LEFT,
      baseY,
      STACK_AREA_WIDTH,
      BLOCK_HEIGHT,
      '#1a5276',
      1,
    );

    // Draw stacked blocks from bottom up
    for (let i = 0; i < display.stack.length; i++) {
      const block = display.stack[i];
      const yPos = baseY - (i + 1) * BLOCK_HEIGHT;
      this.drawStackedBlock(block.x, yPos, block.width, i);
    }

    // Draw current moving block
    const currentY = baseY - (display.stack.length + 1) * BLOCK_HEIGHT;
    this.drawCurrentBlock(display.currentBlock.x, currentY, display.currentBlock.width);

    // Draw score
    this.drawText(
      `Score: ${display.score}`,
      10,
      10,
      '#e0e0e0',
      20,
      'monospace',
      'left',
      'top',
    );

    // Draw speed indicator
    this.drawText(
      `Speed: ${display.currentSpeed.toFixed(1)}`,
      10,
      34,
      '#a0a0a0',
      14,
      'monospace',
      'left',
      'top',
    );

    // Draw frame
    this.drawText(
      `Frame: ${display.frame}`,
      10,
      54,
      '#a0a0a0',
      14,
      'monospace',
      'left',
      'top',
    );
  }

  private drawStackedBlock(x: number, y: number, width: number, index: number): void {
    // Gradient based on index for visual depth
    const brightness = Math.max(40, 100 - index * 3);
    const color = `rgb(15, ${brightness + 30}, 96)`;
    this.fillRect(x, y, width, BLOCK_HEIGHT, color);

    // Top highlight
    this.fillRect(x, y, width, 2, `rgba(255,255,255,${Math.max(0.05, 0.2 - index * 0.01)})`);

    // Border
    this.strokeRect(x, y, width, BLOCK_HEIGHT, '#1a5276', 1);

    // Color accent on the left edge
    this.fillRect(x, y, 3, BLOCK_HEIGHT, '#0f3460');
  }

  private drawCurrentBlock(x: number, y: number, width: number): void {
    // Draw the sliding block with a glow effect (simulated gradient via segments)
    this.fillRect(x, y, width, BLOCK_HEIGHT, '#e94560');
    // Center highlight
    this.fillRect(x + width * 0.2, y, width * 0.6, BLOCK_HEIGHT, '#ff6b81');
    // Re-apply edges on top to create gradient look
    this.fillRect(x, y, width * 0.2, BLOCK_HEIGHT, 'rgba(233,69,96,0.7)');
    this.fillRect(x + width * 0.8, y, width * 0.2, BLOCK_HEIGHT, 'rgba(233,69,96,0.7)');

    // Top highlight
    this.fillRect(x, y, width, 3, 'rgba(255,255,255,0.3)');

    // Border
    this.strokeRect(x, y, width, BLOCK_HEIGHT, '#c0392b', 1);

    // Glow shadow above
    this.fillRect(x, y - 4, width, 4, 'rgba(233,69,96,0.25)');
  }

  /** Draw a "Game Over" overlay */
  drawGameOver(score: number, won: boolean): void {
    const msg = won ? 'PERFECT STACK!' : 'STACK FELL!';
    const color = won ? 'rgba(0,100,0,0.8)' : 'rgba(0,0,0,0.7)';
    this.drawOverlay(
      `${msg}\nBlocks: ${score}`,
      color,
      '#fff',
      36,
    );
  }
}
