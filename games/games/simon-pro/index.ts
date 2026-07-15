import type { JackpotGame, GameState, DifficultyParams, TimestampedInput } from '../../sdk/interface.js';
import { SeededRNG } from '../../sdk/engine.js';

// ─── Constants ────────────────────────────────────────────────

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 400;
export const DEFAULT_SEQUENCE_SPEED = 60; // frames per step while showing
export const DEFAULT_TARGET_SCORE = 12;
export const DEFAULT_COLORS = 4;
export const MAX_FRAMES = 36000; // 10 minutes at 60fps — idle sessions end as a loss

// ─── Interfaces ───────────────────────────────────────────────

export interface SimonProDifficulty {
  sequenceSpeed: number; // 30–120 frames per step when showing sequence
  targetScore: number;   // 8–20 steps to win
  colors: number;        // 4–6 buttons
}

export interface SimonProDisplay {
  sequence: number[];
  playerProgress: number; // how many of the sequence the player has matched so far
  currentStep: number;    // which step of the sequence the game is showing (-1 if done showing)
  highlightButton: number; // button currently lit up (-1 if none)
  phase: 'showing' | 'input' | 'finished';
  score: number;
  frame: number;
  colors: number;
}

// ─── Difficulty presets ───────────────────────────────────────

function difficultyFromParams(diff: DifficultyParams): SimonProDifficulty {
  const level = diff.level;
  // sequenceSpeed: 120 at level 1 → 30 at level 10
  const sequenceSpeed = Math.max(30, Math.round(120 - (level - 1) * (90 / 9)));
  // targetScore: 8 at level 1 → 20 at level 10
  const targetScore = Math.round(8 + (level - 1) * (12 / 9));
  // colors: 4 at level 1 → 6 at level 10
  const colors = Math.min(6, Math.max(4, Math.round(4 + (level - 1) * (2 / 9))));

  const d = diff.params;
  return {
    sequenceSpeed: d.sequenceSpeed ?? sequenceSpeed,
    targetScore: d.targetScore ?? targetScore,
    colors: d.colors ?? colors,
  };
}

// ─── SimonProGame ───────────────────────────────────────────

export class SimonProGame implements JackpotGame {
  private rng!: SeededRNG;
  private difficulty!: SimonProDifficulty;

  private sequence: number[] = [];
  private playerIndex: number = 0;
  private currentShowStep: number = -1; // -1 = not showing, index in sequence being shown
  private highlightButton: number = -1;
  private showFrameCounter: number = 0;

  private phase: 'showing' | 'input' | 'finished' = 'showing';
  private score: number = 0;
  private frame: number = 0;
  private finished: boolean = false;
  private won: boolean = false;

  init(seed: string, difficulty: DifficultyParams): void {
    this.rng = new SeededRNG(seed);
    this.difficulty = difficultyFromParams(difficulty);

    this.sequence = [];
    this.playerIndex = 0;
    this.currentShowStep = 0;
    this.highlightButton = -1;
    this.showFrameCounter = 0;
    this.phase = 'showing';
    this.score = 0;
    this.frame = 0;
    this.finished = false;
    this.won = false;

    // Generate first step and begin showing it
    this.appendSequenceStep();
  }

  onInput(input: TimestampedInput): void {
    if (this.finished) return;
    if (this.phase !== 'input') return;

    // Only accept tap/click/keydown with button index 0..colors-1
    const isAction =
      input.type === 'tap' || input.type === 'click' || input.type === 'keydown';
    if (!isAction) return;

    let button: number = -1;
    const data = input.data;

    // Extract button index: could be from 'button' field, or from key name.
    // Keys are 1-indexed ('1'..'6') to match the on-screen button labels
    // (SimonProRenderer draws `index + 1` on each button) — this used to
    // be 0-indexed ('0'..'5'), silently one off from every label the
    // player could actually see, so pressing the number shown on a button
    // selected the *previous* button instead.
    if (typeof data.button === 'number') {
      button = data.button;
    } else if (typeof data.key === 'string') {
      const key = data.key;
      const colorKeys = ['1', '2', '3', '4', '5', '6'];
      const idx = colorKeys.indexOf(key);
      if (idx >= 0) button = idx;
    }

    if (button < 0 || button >= this.difficulty.colors) return;

    // Check if the button matches the expected next step
    if (button === this.sequence[this.playerIndex]) {
      this.playerIndex++;
      this.score = this.playerIndex; // score = steps matched

      if (this.playerIndex >= this.sequence.length) {
        // Player completed the current sequence
        if (this.sequence.length >= this.difficulty.targetScore) {
          // Won!
          this.won = true;
          this.finished = true;
          this.phase = 'finished';
        } else {
          // Advance to next round: append a new step and start showing
          this.appendSequenceStep();
          this.playerIndex = 0;
          this.currentShowStep = 0;
          this.showFrameCounter = 0;
          this.highlightButton = -1;
          this.phase = 'showing';
        }
      }
    } else {
      // Wrong button — game over
      this.finished = true;
      this.phase = 'finished';
    }
  }

  tick(): void {
    if (this.finished) return;

    this.frame++;

    // Idle timeout: a session with no (correct) input must still end (as a
    // loss) instead of sitting in the input phase forever.
    if (this.frame >= MAX_FRAMES) {
      this.finished = true;
      this.won = false;
      this.phase = 'finished';
      return;
    }

    if (this.phase === 'showing') {
      this.showFrameCounter++;

      if (this.showFrameCounter >= this.difficulty.sequenceSpeed) {
        this.showFrameCounter = 0;

        // Move to next step in the show sequence
        this.currentShowStep++;

        if (this.currentShowStep >= this.sequence.length) {
          // Done showing the full sequence — switch to input phase
          this.phase = 'input';
          this.highlightButton = -1;
          this.playerIndex = 0;
        } else {
          // Highlight the current step's button
          this.highlightButton = this.sequence[this.currentShowStep];
        }
      } else {
        // On the first frame of a step, set the highlight
        if (this.showFrameCounter === 1 && this.currentShowStep >= 0 && this.currentShowStep < this.sequence.length) {
          this.highlightButton = this.sequence[this.currentShowStep];
        }
        // Clear highlight halfway through to create flash effect
        if (this.showFrameCounter === Math.floor(this.difficulty.sequenceSpeed / 2)) {
          this.highlightButton = -1;
        }
      }
    }
  }

  private appendSequenceStep(): void {
    const nextColor = this.rng.nextInt(0, this.difficulty.colors - 1);
    this.sequence.push(nextColor);
  }

  getState(): GameState {
    return {
      score: this.score,
      finished: this.finished,
      won: this.won,
      targetScore: this.difficulty.targetScore,
      frame: this.frame,
      display: {
        sequence: this.sequence,
        playerProgress: this.playerIndex,
        currentStep: this.currentShowStep,
        highlightButton: this.highlightButton,
        phase: this.phase,
        score: this.score,
        frame: this.frame,
        colors: this.difficulty.colors,
      },
    };
  }

  isFinished(): boolean {
    return this.finished;
  }

  finalScore(): number {
    // Longest correct sequence the player completed
    return this.score;
  }

  serializeState(): string {
    return JSON.stringify({
      sequence: this.sequence,
      playerIndex: this.playerIndex,
      currentShowStep: this.currentShowStep,
      highlightButton: this.highlightButton,
      showFrameCounter: this.showFrameCounter,
      phase: this.phase,
      score: this.score,
      frame: this.frame,
      finished: this.finished,
      won: this.won,
      difficulty: this.difficulty,
    });
  }

  // ─── Test helpers ──────────────────────────────────────

  _getSequence(): number[] {
    return [...this.sequence];
  }

  _getPhase(): string {
    return this.phase;
  }

  _getHighlightButton(): number {
    return this.highlightButton;
  }

  _getDifficulty(): SimonProDifficulty {
    return { ...this.difficulty };
  }
}
