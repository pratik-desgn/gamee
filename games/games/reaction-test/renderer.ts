import { Renderer } from '../../sdk/renderer.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from './index.js';
import type { ReactionTestDisplay } from './index.js';

/**
 * Canvas renderer for Reaction Test.
 * Shows a waiting screen, then a green signal, then results.
 */
export class ReactionTestRenderer extends Renderer {
  private bgColor: string;
  private signalColor: string;
  private textColor: string;
  private accentColor: string;
  private waitColor: string;

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number = CANVAS_WIDTH,
    height: number = CANVAS_HEIGHT,
    colors?: {
      background?: string;
      signal?: string;
      text?: string;
      accent?: string;
      wait?: string;
    },
  ) {
    super(ctx, width, height);
    this.bgColor = colors?.background ?? '#1a1a2e';
    this.signalColor = colors?.signal ?? '#2ecc71';
    this.textColor = colors?.text ?? '#ffffff';
    this.accentColor = colors?.accent ?? '#e74c3c';
    // Solid red for the whole waiting window — a full-screen color flip is
    // the genre-standard reaction-test UX (unambiguous "not yet" vs "go").
    this.waitColor = colors?.wait ?? '#c0392b';
  }

  render(state: Record<string, unknown>): void {
    const display = state as unknown as ReactionTestDisplay;
    this.clear();

    if (display.state === 'waiting') {
      this.renderWaiting(display);
    } else if (display.state === 'signal') {
      this.renderSignal(display);
    } else if (display.state === 'finished') {
      this.renderFinished(display);
    }
  }

  private renderWaiting(display: ReactionTestDisplay): void {
    // Solid red for the entire wait — deliberately no progress bar or
    // countdown of any kind. The old version drew a fill bar tracking
    // waitingProgress, which told the player almost exactly when the
    // signal was coming; a reaction test whose "random" delay is
    // telegraphed by a UI element isn't actually testing reaction time.
    this.drawBackground(this.waitColor);

    this.drawText(
      'WAIT FOR GREEN',
      this.width / 2,
      this.height / 2 - 20,
      '#fff',
      32,
      'monospace',
      'center',
      'middle',
    );

    this.drawText(
      `Round ${display.round} / ${display.totalRounds}`,
      this.width / 2,
      this.height / 2 + 30,
      'rgba(255,255,255,0.85)',
      18,
      'monospace',
      'center',
      'top',
    );

    // Reacting now (before the flip) is a false start and ends the
    // session — worth stating plainly right where the player is looking.
    this.drawText(
      "Don't press yet — pressing now ends the round",
      this.width / 2,
      this.height / 2 + 60,
      'rgba(255,255,255,0.6)',
      13,
      'monospace',
      'center',
      'top',
    );
  }

  private renderSignal(display: ReactionTestDisplay): void {
    // Bright green flash
    this.drawBackground(this.signalColor);

    // "PRESS NOW!" text
    this.drawText(
      'PRESS NOW!',
      this.width / 2,
      this.height / 2 - 30,
      '#fff',
      48,
      'monospace',
      'center',
      'middle',
    );

    // Round indicator
    this.drawText(
      `Round ${display.round} / ${display.totalRounds}`,
      this.width / 2,
      this.height / 2 + 20,
      'rgba(255,255,255,0.8)',
      18,
      'monospace',
      'center',
      'top',
    );

    // Previous reaction times
    if (display.reactionTimes.length > 0) {
      const avg = display.averageReaction;
      this.drawText(
        `Last: ${display.reactionTimes[display.reactionTimes.length - 1]}ms  |  Avg: ${avg}ms`,
        this.width / 2,
        this.height / 2 + 50,
        'rgba(255,255,255,0.7)',
      14,
        'monospace',
        'center',
        'top',
      );
    }
  }

  private renderFinished(display: ReactionTestDisplay): void {
    const isWin = display.won;

    // Background
    this.drawBackground(isWin ? '#1a472a' : '#2d1b1b');

    // Result title
    const title = isWin ? 'YOU WIN!' : 'GAME OVER';
    this.drawText(
      title,
      this.width / 2,
      40,
      isWin ? '#2ecc71' : '#e74c3c',
      42,
      'monospace',
      'center',
      'top',
    );

    // Stats
    const avg = display.averageReaction;
    const avgColor = avg < 200 ? '#55efc4' : avg < 300 ? '#ffeaa7' : '#ff7675';

    this.drawText(
      `Average Reaction: ${avg}ms`,
      this.width / 2,
      100,
      avgColor,
      24,
      'monospace',
      'center',
      'top',
    );

    // Reaction times list
    this.drawText(
      'Reaction Times:',
      this.width / 2,
      140,
      '#b2bec3',
      18,
      'monospace',
      'center',
      'top',
    );

    const timesStr = display.reactionTimes
      .map((t, i) => `R${i + 1}: ${t}ms`)
      .join('  ');

    this.drawText(
      timesStr,
      this.width / 2,
      170,
      '#dfe6e9',
      14,
      'monospace',
      'center',
      'top',
    );

    // Round info
    this.drawText(
      `Rounds: ${display.round} / ${display.totalRounds}`,
      this.width / 2,
      200,
      '#b2bec3',
      16,
      'monospace',
      'center',
      'top',
    );

    // False start indicator
    if (!isWin && display.reactionTimes.length === 0) {
      this.drawText(
        'False Start!',
        this.width / 2,
      240,
        '#e74c3c',
        24,
        'monospace',
        'center',
        'top',
      );
    }
  }

  /** Draw a "Game Over" overlay */
  drawGameOver(score: number, won: boolean): void {
    const msg = won ? 'YOU WIN!' : 'GAME OVER';
    const color = won ? 'rgba(0,100,0,0.8)' : 'rgba(0,0,0,0.7)';
    this.drawOverlay(
      `${msg}\nAvg Reaction: ${score}ms`,
      color,
      '#fff',
      36,
    );
  }
}
