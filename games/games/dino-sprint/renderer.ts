import { Renderer } from '../../sdk/renderer.js';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  GROUND_HEIGHT,
  DINO_RADIUS,
  OBSTACLE_WIDTH,
} from './index.js';
import type { DinoSprintDisplay } from './index.js';

/**
 * Canvas renderer for Dino Sprint.
 * Draws sky, ground, dinosaur, obstacles (cacti/rocks), score and game-over overlay.
 */
export class DinoSprintRenderer extends Renderer {
  private dinoColor: string;
  private obstacleColor: string;
  private groundColor: string;
  private skyColor: string;

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number = CANVAS_WIDTH,
    height: number = CANVAS_HEIGHT,
    colors?: {
      dino?: string;
      obstacle?: string;
      ground?: string;
      sky?: string;
    },
  ) {
    super(ctx, width, height);
    this.skyColor = colors?.sky ?? '#87CEEB';
    this.groundColor = colors?.ground ?? '#8B4513';
    this.obstacleColor = colors?.obstacle ?? '#2E8B57';
    this.dinoColor = colors?.dino ?? '#4CAF50';
  }

  render(state: Record<string, unknown>): void {
    const display = state as unknown as DinoSprintDisplay;
    this.clear();
    this.drawBackground(this.skyColor);

    // Draw ground
    this.fillRect(0, display.groundY, this.width, this.height - display.groundY, this.groundColor);
    // Ground line
    this.fillRect(0, display.groundY, this.width, 3, '#5C2E00');

    // Draw obstacles
    for (const obs of display.obstacles) {
      this.drawObstacle(obs.x, obs.width, obs.height);
    }

    // Draw dinosaur
    this.drawDino(display.dino.x, display.dino.y, display.dino.radius);

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

  private drawObstacle(x: number, width: number, height: number): void {
    const groundTop = CANVAS_HEIGHT - GROUND_HEIGHT;
    const obsTop = groundTop - height;

    // Main obstacle body (cactus-like)
    this.fillRect(x, obsTop, width, height, this.obstacleColor);
    // Outline
    this.strokeRect(x, obsTop, width, height, '#1a5c2a', 2);

    // Decorative spikes (small triangles along sides)
    const spikeSize = 4;
    const spikeColor = '#1a5c2a';
    // Left spike
    this.fillRect(x - spikeSize, obsTop + height * 0.3, spikeSize, spikeSize, spikeColor);
    this.fillRect(x - spikeSize, obsTop + height * 0.6, spikeSize, spikeSize, spikeColor);
    // Right spike
    this.fillRect(x + width, obsTop + height * 0.3, spikeSize, spikeSize, spikeColor);
    this.fillRect(x + width, obsTop + height * 0.6, spikeSize, spikeSize, spikeColor);
  }

  private drawDino(x: number, y: number, radius: number): void {
    // Body (circle)
    this.fillCircle(x, y, radius, this.dinoColor);
    // Outline
    this.ctx.strokeStyle = '#2E7D32';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.stroke();

    // Eye
    this.fillCircle(x + 4, y - 3, 3, '#000');
    this.fillCircle(x + 5, y - 3, 1.5, '#fff');

    // Mouth
    this.ctx.strokeStyle = '#000';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(x + 6, y + 2);
    this.ctx.lineTo(x + 10, y + 4);
    this.ctx.stroke();
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
