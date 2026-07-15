import { Renderer } from '../../sdk/renderer.js';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  PADDING,
} from './index.js';
import type { AimMasterDisplay } from './index.js';

/**
 * Canvas renderer for Aim Master.
 * Draws targets as colored circles, score, timer, and game-over overlay.
 * Different colors for active vs hit targets for visual feedback.
 */
export class AimMasterRenderer extends Renderer {
  private targetColor: string;
  private targetHitColor: string;
  private backgroundColor: string;
  private accentColor: string;

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number = CANVAS_WIDTH,
    height: number = CANVAS_HEIGHT,
    colors?: {
      target?: string;
      targetHit?: string;
      background?: string;
      accent?: string;
    },
  ) {
    super(ctx, width, height);
    this.backgroundColor = colors?.background ?? '#1a1a2e';
    this.targetColor = colors?.target ?? '#e94560';
    this.targetHitColor = colors?.targetHit ?? '#16213e';
    this.accentColor = colors?.accent ?? '#0f3460';
  }

  render(state: Record<string, unknown>): void {
    const display = state as unknown as AimMasterDisplay;
    this.clear();
    this.drawBackground(this.backgroundColor);

    // Draw crosshair / grid lines for visual reference
    this.ctx.strokeStyle = this.accentColor;
    this.ctx.lineWidth = 1;
    this.ctx.globalAlpha = 0.15;
    // Vertical center line
    this.ctx.beginPath();
    this.ctx.moveTo(this.width / 2, 0);
    this.ctx.lineTo(this.width / 2, this.height);
    this.ctx.stroke();
    // Horizontal center line
    this.ctx.beginPath();
    this.ctx.moveTo(0, this.height / 2);
    this.ctx.lineTo(this.width, this.height / 2);
    this.ctx.stroke();
    this.ctx.globalAlpha = 1;

    // Draw targets (inactive ones get a faded look)
    for (const target of display.targets) {
      if (target.active) {
        this.drawActiveTarget(target.x, target.y, target.radius);
      } else {
        this.drawInactiveTarget(target.x, target.y, target.radius);
      }
    }

    // Draw score and timer
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

    this.drawText(
      `Time: ${display.timeLeft}s`,
      this.width - 10,
      10,
      '#fff',
      20,
      'monospace',
      'right',
      'top',
    );

    this.drawText(
      `Remaining: ${display.targetsRemaining}`,
      10,
      34,
      '#aaa',
      14,
      'monospace',
      'left',
      'top',
    );

    this.drawText(
      `Frame: ${display.frame}`,
      this.width - 10,
      34,
      '#aaa',
      14,
      'monospace',
      'right',
      'top',
    );

    // Miss-streak warning — misses shrink every remaining target, faster
    // with each consecutive miss (see AimMasterGame's missStreak doc
    // comment), specifically so blind spam-clicking is self-defeating
    // rather than free. Without surfacing it, a player has no way to know
    // why their targets just got smaller.
    if (display.missStreak >= 2) {
      this.drawText(
        `⚠ ${display.missStreak} misses in a row — targets shrinking faster!`,
        this.width / 2,
        56,
        '#ff6b6b',
        13,
        'monospace',
        'center',
        'top',
      );
    }
  }

  private drawActiveTarget(x: number, y: number, radius: number): void {
    // Outer glow
    this.ctx.shadowColor = this.targetColor;
    this.ctx.shadowBlur = 15;
    this.fillCircle(x, y, radius, this.targetColor);
    this.ctx.shadowBlur = 0;

    // Inner ring (bullseye)
    this.fillCircle(x, y, radius * 0.6, '#fff');
    this.fillCircle(x, y, radius * 0.3, this.targetColor);

    // Outline
    this.ctx.strokeStyle = '#fff';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.stroke();
  }

  private drawInactiveTarget(x: number, y: number, radius: number): void {
    // Faded circle for hit targets
    this.ctx.globalAlpha = 0.2;
    this.fillCircle(x, y, radius, '#666');
    this.ctx.strokeStyle = '#888';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.stroke();
    this.ctx.globalAlpha = 1;
  }

  /** Draw a "Game Over" overlay */
  drawGameOver(score: number, won: boolean): void {
    // Loss can now come from either running out of time or running out of
    // targets (all hit or shrunk away) before reaching the score
    // threshold — a fixed "TIME UP!" was wrong for the latter, and now
    // more common cause.
    const msg = won ? 'YOU WIN!' : 'OUT OF TARGETS';
    const color = won ? 'rgba(0,80,0,0.8)' : 'rgba(0,0,0,0.7)';
    this.drawOverlay(
      `${msg}\nScore: ${score}`,
      color,
      '#fff',
      36,
    );
  }
}
