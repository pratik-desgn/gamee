import { Renderer } from '../../sdk/renderer.js';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  PLATFORM_SPACING,
  BALL_RADIUS,
  HELIX_CENTER_X,
  PLATFORM_THICKNESS,
} from './index.js';
import type { HelixDropDisplay } from './index.js';

/**
 * Canvas renderer for Helix Drop.
 * Draws a cylindrical tower viewed from a slight angle.
 * Platforms appear as ellipses (rings) with gaps.
 * The ball drops through the center.
 */
export class HelixDropRenderer extends Renderer {
  private platformColor: string;
  private gapColor: string;
  private ballColor: string;
  private backgroundColor: string;
  private towerColor: string;

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number = CANVAS_WIDTH,
    height: number = CANVAS_HEIGHT,
    colors?: {
      platform?: string;
      gap?: string;
      ball?: string;
      background?: string;
      tower?: string;
    },
  ) {
    super(ctx, width, height);
    this.backgroundColor = colors?.background ?? '#0a0a1a';
    this.platformColor = colors?.platform ?? '#ff6b35';
    this.gapColor = colors?.gap ?? '#1a1a3e';
    this.ballColor = colors?.ball ?? '#00d4ff';
    this.towerColor = colors?.tower ?? '#1a1a3e';
  }

  render(state: Record<string, unknown>): void {
    const display = state as unknown as HelixDropDisplay;
    this.clear();
    this.drawBackground(this.backgroundColor);

    // Draw tower background (subtle column)
    this.drawTowerBackground(display);

    // Camera: keep the ball in the upper third — towers are far taller
    // than the canvas (platformCount × spacing), so everything is drawn
    // relative to this scroll offset.
    const cameraY = Math.max(0, display.ball.y - CANVAS_HEIGHT / 3);

    // Determine which platforms are visible (near the ball's Y)
    const visibleRange = 8;
    const ballPlatformIndex = Math.floor(display.ball.y / display.platformSpacing);

    // Draw platforms from back to front (sorted by Y)
    for (let i = 0; i < display.platforms.length; i++) {
      const p = display.platforms[i];
      const distFromBall = Math.abs(i - ballPlatformIndex);

      // Skip platforms far from the ball for performance
      if (distFromBall > visibleRange) continue;

      // Determine if this platform is below, at, or above the ball
      const isAtBall = i === ballPlatformIndex;

      // Draw the platform ring
      this.drawPlatformRing(
        p.y - cameraY,
        p.gapAngle,
        p.gapWidth,
        p.hazardAngle,
        p.hazardWidth,
        display.helixRotation,
        isAtBall,
      );
    }

    // Draw the ball
    this.drawBall(display.ball.y - cameraY);

    // The mechanic (ball rests until you rotate a gap underneath it, but
    // an adjacent hazard zone kills if it arrives first) is not
    // self-explanatory from the visual alone — every other reference
    // point (score, a ball, some rings) reads as generic without this.
    this.drawText(
      '◄ ► Rotate to bring the GREEN gap under the ball — avoid RED',
      this.width / 2,
      2,
      '#ccc',
      11,
      'monospace',
      'center',
      'top',
    );

    // Draw score
    this.drawText(
      `Platforms passed: ${display.score}`,
      10,
      20,
      '#fff',
      18,
      'monospace',
      'left',
      'top',
    );
  }

  private drawTowerBackground(display: HelixDropDisplay): void {
    // Subtle vertical lines for tower edges
    const towerWidth = 160;
    const leftEdge = HELIX_CENTER_X - towerWidth / 2;
    const rightEdge = HELIX_CENTER_X + towerWidth / 2;

    this.ctx.strokeStyle = this.towerColor;
    this.ctx.lineWidth = 1;
    this.ctx.globalAlpha = 0.3;

    // Left edge
    this.ctx.beginPath();
    this.ctx.moveTo(leftEdge, 0);
    this.ctx.lineTo(leftEdge, this.height);
    this.ctx.stroke();

    // Right edge
    this.ctx.beginPath();
    this.ctx.moveTo(rightEdge, 0);
    this.ctx.lineTo(rightEdge, this.height);
    this.ctx.stroke();

    this.ctx.globalAlpha = 1;
  }

  /**
   * Draw a platform as an elliptical ring with a gap.
   * The platform is rendered as a horizontal arc.
   */
  private drawPlatformRing(
    y: number,
    gapAngle: number,
    gapWidth: number,
    hazardAngle: number,
    hazardWidth: number,
    helixRotation: number,
    isAtBall: boolean,
  ): void {
    const effectiveGap = ((gapAngle + helixRotation) % 360 + 360) % 360;
    const half = gapWidth / 2;
    const platformStartDeg = effectiveGap + half; // start of platform after gap
    const platformEndDeg = effectiveGap - half + 360; // end of platform before gap
    const platformArcDeg = 360 - gapWidth;

    // Only draw if within visible area
    if (y < -PLATFORM_SPACING || y > CANVAS_HEIGHT + PLATFORM_SPACING) return;

    const rx = 70; // horizontal radius of ellipse
    const ry = 16; // vertical radius of ellipse (perspective foreshortening)
    const cx = HELIX_CENTER_X;

    // Platform fill color — highlight if at ball level
    const color = isAtBall ? '#ff8c42' : this.platformColor;
    const alpha = isAtBall ? 1.0 : 0.6;

    // Draw the platform arc
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = color;
    this.ctx.strokeStyle = isAtBall ? '#ffaa66' : '#cc5520';
    this.ctx.lineWidth = PLATFORM_THICKNESS;

    this.ctx.beginPath();
    // Draw the arc from platformStartDeg to platformStartDeg + platformArcDeg
    // Convert degrees to radians for the arc
    const startRad = (platformStartDeg * Math.PI) / 180;
    const endRad = ((platformStartDeg + platformArcDeg) * Math.PI) / 180;

    // Draw platform as an elliptical arc
    this.ctx.ellipse(cx, y, rx, ry, 0, startRad, endRad);
    this.ctx.stroke();

    // Also draw the thicker platform body
    this.ctx.lineWidth = PLATFORM_THICKNESS + 4;
    this.ctx.globalAlpha = alpha * 0.3;
    this.ctx.beginPath();
    this.ctx.ellipse(cx, y, rx, ry, 0, startRad, endRad);
    this.ctx.stroke();

    this.ctx.restore();

    // Draw the hazard zone (deadly segment adjacent to the gap) in red —
    // this is the thing the player must NOT rotate under the ball.
    {
      const effectiveHazard = ((hazardAngle + helixRotation) % 360 + 360) % 360;
      const hazardHalf = hazardWidth / 2;
      this.ctx.save();
      this.ctx.globalAlpha = isAtBall ? 0.95 : 0.55;
      this.ctx.strokeStyle = '#ff2d2d';
      this.ctx.lineWidth = PLATFORM_THICKNESS + 2;
      this.ctx.beginPath();
      this.ctx.ellipse(
        cx, y, rx, ry, 0,
        ((effectiveHazard - hazardHalf) * Math.PI) / 180,
        ((effectiveHazard + hazardHalf) * Math.PI) / 180,
      );
      this.ctx.stroke();
      this.ctx.restore();
    }

    // Draw the gap (safe passage) indicator — visible on upcoming
    // platforms too, not just the one the ball is on, so the safe route
    // is plannable in advance the same way the hazard already is.
    {
      const gapStartDeg = effectiveGap - half;
      const gapEndDeg = effectiveGap + half;

      this.ctx.save();
      this.ctx.globalAlpha = isAtBall ? 0.9 : 0.3;
      this.ctx.strokeStyle = '#2dff6b';
      this.ctx.lineWidth = isAtBall ? 3 : 2;
      this.ctx.beginPath();
      this.ctx.ellipse(cx, y, rx + 8, ry + 4, 0, (gapStartDeg * Math.PI) / 180, (gapEndDeg * Math.PI) / 180);
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  private drawBall(y: number): void {
    if (y < -BALL_RADIUS || y > CANVAS_HEIGHT + BALL_RADIUS) return;

    const cx = HELIX_CENTER_X;

    // Glow
    this.ctx.shadowColor = this.ballColor;
    this.ctx.shadowBlur = 20;
    this.fillCircle(cx, y, BALL_RADIUS, this.ballColor);
    this.ctx.shadowBlur = 0;

    // Highlight
    this.fillCircle(cx - 2, y - 2, BALL_RADIUS * 0.4, '#fff');

    // Outline
    this.ctx.strokeStyle = '#0099cc';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.arc(cx, y, BALL_RADIUS, 0, Math.PI * 2);
    this.ctx.stroke();
  }

  /** Draw a "Game Over" overlay */
  drawGameOver(score: number, won: boolean): void {
    const msg = won ? 'YOU WIN!' : 'GAME OVER';
    const color = won ? 'rgba(0,80,0,0.8)' : 'rgba(0,0,0,0.7)';
    this.drawOverlay(
      `${msg}\nPlatforms: ${score}`,
      color,
      '#fff',
      36,
    );
  }
}
