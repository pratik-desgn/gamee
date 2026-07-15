import { Renderer } from '../../sdk/renderer.js';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  GROUND_HEIGHT,
  BIRD_SIZE,
  PIPE_WIDTH,
} from './index.js';
import type { WingRushDisplay } from './index.js';

/**
 * Canvas renderer for Wing Rush.
 * Draws sky, ground, pipes, bird, score and game-over overlay.
 */
export class WingRushRenderer extends Renderer {
  private birdColor: string;
  private pipeColor: string;
  private groundColor: string;
  private skyColor: string;

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number = CANVAS_WIDTH,
    height: number = CANVAS_HEIGHT,
    colors?: {
      bird?: string;
      pipe?: string;
      ground?: string;
      sky?: string;
    },
  ) {
    super(ctx, width, height);
    this.skyColor = colors?.sky ?? '#87CEEB';
    this.groundColor = colors?.ground ?? '#8B4513';
    this.pipeColor = colors?.pipe ?? '#228B22';
    this.birdColor = colors?.bird ?? '#FFD700';
  }

  render(state: Record<string, unknown>): void {
    const display = state as unknown as WingRushDisplay;
    this.clear();
    this.drawBackground(this.skyColor);

    // Draw ground
    this.fillRect(0, display.groundY, this.width, this.height - display.groundY, this.groundColor);
    // Ground line
    this.fillRect(0, display.groundY, this.width, 3, '#5C2E00');

    // Draw pipes
    for (const pipe of display.pipes) {
      this.drawPipe(pipe.x, pipe.gapY, pipe.gapSize);
    }

    // Draw bird
    this.drawBird(display.bird.x, display.bird.y);

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
  }

  private drawPipe(x: number, gapY: number, gapSize: number): void {
    // Top pipe
    this.fillRect(x, 0, PIPE_WIDTH, gapY, this.pipeColor);
    // Top pipe lip
    this.fillRect(x - 4, gapY - 20, PIPE_WIDTH + 8, 20, '#1a6b1a');
    this.strokeRect(x - 4, gapY - 20, PIPE_WIDTH + 8, 20, '#0d4f0d', 2);

    // Bottom pipe
    const bottomPipeTop = gapY + gapSize;
    this.fillRect(x, bottomPipeTop, PIPE_WIDTH, this.height - bottomPipeTop - GROUND_HEIGHT, this.pipeColor);
    // Bottom pipe lip
    this.fillRect(x - 4, bottomPipeTop, PIPE_WIDTH + 8, 20, '#1a6b1a');
    this.strokeRect(x - 4, bottomPipeTop, PIPE_WIDTH + 8, 20, '#0d4f0d', 2);
  }

  private drawBird(x: number, y: number): void {
    const half = BIRD_SIZE / 2;
    // Body
    this.fillCircle(x + half, y + half, half, this.birdColor);
    // Outline
    this.ctx.strokeStyle = '#B8860B';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(x + half, y + half, half, 0, Math.PI * 2);
    this.ctx.stroke();
    // Eye
    this.fillCircle(x + half + 5, y + half - 3, 3, '#000');
    this.fillCircle(x + half + 6, y + half - 3, 1.5, '#fff');
    // Beak
    this.fillRect(x + half + half - 2, y + half - 2, 8, 4, '#FF6347');
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
