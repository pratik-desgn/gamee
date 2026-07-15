import { SimonProGame, SimonProDifficulty } from '../index.js';
import type { DifficultyParams, TimestampedInput } from '../../../sdk/interface.js';

// ─── Helpers ──────────────────────────────────────────────

function makeDiff(overrides: Partial<SimonProDifficulty> = {}): DifficultyParams {
  return {
    seed: 'test-seed',
    level: 1,
    params: {
      sequenceSpeed: overrides.sequenceSpeed ?? 60,
      targetScore: overrides.targetScore ?? 8,
      colors: overrides.colors ?? 4,
    },
  };
}

function makeInput(button: number, frame: number = 0): TimestampedInput {
  // `button` here is the 0-indexed button number; the actual key the game
  // parses is 1-indexed (matching the on-screen label — see index.ts's
  // onInput doc comment), hence +1.
  return {
    frame,
    type: 'keydown',
    data: { key: String(button + 1) },
    time: frame * 16,
  };
}

function runFrames(game: SimonProGame, count: number): void {
  for (let i = 0; i < count; i++) {
    game.tick();
  }
}

function waitThroughShowPhase(game: SimonProGame): void {
  // Run enough frames to finish showing the current sequence
  const diff = game._getDifficulty();
  const seqLen = game._getSequence().length;
  const framesNeeded = seqLen * diff.sequenceSpeed + 5;
  runFrames(game, framesNeeded);
}

// ─── Tests ────────────────────────────────────────────────

describe('SimonProGame', () => {
  describe('init', () => {
    it('should initialize with first sequence step and be in showing phase', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff());

      const state = game.getState();
      expect(game._getSequence()).toHaveLength(1);
      expect(game._getPhase()).toBe('showing');
      expect(state.finished).toBe(false);
      expect(state.won).toBe(false);
      expect(state.targetScore).toBe(8);
    });

    it('should generate deterministic sequences from the same seed', () => {
      const game1 = new SimonProGame();
      game1.init('deterministic-seed', makeDiff());
      const seq1 = game1._getSequence();

      const game2 = new SimonProGame();
      game2.init('deterministic-seed', makeDiff());
      const seq2 = game2._getSequence();

      expect(seq1).toEqual(seq2);
    });

    it('should generate different sequences from different seeds', () => {
      const game1 = new SimonProGame();
      game1.init('seed-alpha', makeDiff({ targetScore: 15 }));
      const seq1 = game1._getSequence();

      const game2 = new SimonProGame();
      game2.init('seed-beta', makeDiff({ targetScore: 15 }));
      const seq2 = game2._getSequence();

      // Advance both games through multiple rounds to get longer sequences
      for (const game of [game1, game2]) {
        const speed = game._getDifficulty().sequenceSpeed;
        for (let r = 0; r < 10; r++) {
          runFrames(game, game._getSequence().length * speed + 5);
          if (game._getPhase() !== 'input') break;
          for (let i = 0; i < game._getSequence().length; i++) {
            game.onInput(makeInput(game._getSequence()[i]));
          }
        }
      }

      // With longer sequences and different seeds, they should diverge
      expect(seq1.length).toBe(1); // init only
      // After 10 rounds, sequences should be different between seeds
      const longSeq1 = game1._getSequence();
      const longSeq2 = game2._getSequence();
      // Both should have grown
      expect(longSeq1.length).toBeGreaterThan(1);
      expect(longSeq2.length).toBeGreaterThan(1);
      // Sequences should differ somewhere (extremely unlikely to be identical)
      expect(longSeq1).not.toEqual(longSeq2);
    });

    it('should respect the colors parameter (only generate 0..colors-1)', () => {
      for (const colors of [4, 5, 6]) {
        const game = new SimonProGame();
        game.init('test-seed', makeDiff({ colors, targetScore: 15 }));
        // Tick enough to generate a long sequence
        const diff = game._getDifficulty();
        const seqLen = game._getSequence().length;
        const framesNeeded = seqLen * diff.sequenceSpeed + 5;
        runFrames(game, framesNeeded);
        // Give 3 correct inputs to advance rounds
        for (let r = 0; r < 3; r++) {
          const seq = game._getSequence();
          for (let i = 0; i < seq.length; i++) {
            const prevPhase = game._getPhase();
            runFrames(game, diff.sequenceSpeed * seq.length + 5);
            if (game._getPhase() === 'input') {
              game.onInput(makeInput(seq[i]));
            }
          }
        }
        // Check all sequence values are in range
        const finalSeq = game._getSequence();
        for (const val of finalSeq) {
          expect(val).toBeGreaterThanOrEqual(0);
          expect(val).toBeLessThan(colors);
        }
      }
    });
  });

  describe('tick - showing phase', () => {
    it('should highlight buttons sequentially during showing phase', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff({ sequenceSpeed: 30 }));
      const seq = game._getSequence();

      // After first tick, should show first button
      game.tick();
      expect(game._getHighlightButton()).toBe(seq[0]);

      // After sequenceSpeed/2 frames, highlight should clear (flash effect)
      runFrames(game, 14);
      expect(game._getHighlightButton()).toBe(-1);

      // After sequenceSpeed frames, should move to next step (no more steps since len=1)
      runFrames(game, 16);
      expect(game._getPhase()).toBe('input');
    });

    it('should transition to input phase after showing all steps', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff({ sequenceSpeed: 10, targetScore: 8 }));
      const seqLen = game._getSequence().length;
      const speed = game._getDifficulty().sequenceSpeed;

      // Run until show phase ends
      runFrames(game, seqLen * speed + 10);
      expect(game._getPhase()).toBe('input');
    });
  });

  describe('onInput - playing back sequence', () => {
    it('should accept correct input and advance to next round', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff({ sequenceSpeed: 10 }));
      waitThroughShowPhase(game);

      expect(game._getPhase()).toBe('input');
      const seq = game._getSequence();
      expect(seq).toHaveLength(1);

      // Press the first (correct) button — completes the 1-step sequence
      game.onInput(makeInput(seq[0]));

      // Should advance to next round: sequence grows, back to showing
      expect(game._getSequence()).toHaveLength(2);
      expect(game._getPhase()).toBe('showing');
      const state = game.getState();
      expect(state.score).toBe(1);
    });

    it('should reject wrong input and finish the game', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff({ sequenceSpeed: 10 }));
      waitThroughShowPhase(game);

      const seq = game._getSequence();
      // Press a wrong button
      const wrongButton = (seq[0] + 1) % 4;
      game.onInput(makeInput(wrongButton));

      expect(game.isFinished()).toBe(true);
      expect(game.getState().won).toBe(false);
    });

    it('should advance to next round after completing the sequence', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff({ sequenceSpeed: 5, targetScore: 8 }));
      waitThroughShowPhase(game);

      const seq1 = game._getSequence();
      expect(seq1).toHaveLength(1);

      // Correctly press the first button
      game.onInput(makeInput(seq1[0]));

      // Should now have appended a new step and be back in showing phase
      expect(game._getPhase()).toBe('showing');
      expect(game._getSequence()).toHaveLength(2);
    });

    it('should win when reaching targetScore', () => {
      const game = new SimonProGame();
      // Set targetScore to 2 so we quickly reach it
      game.init('test-seed', makeDiff({ sequenceSpeed: 5, targetScore: 2 }));
      const speed = game._getDifficulty().sequenceSpeed;

      // Round 1: show 1 step, input it
      runFrames(game, 1 * speed + 5);
      game.onInput(makeInput(game._getSequence()[0]));
      expect(game._getSequence()).toHaveLength(2);
      expect(game._getPhase()).toBe('showing');

      // Round 2: show 2 steps, input them both
      runFrames(game, 2 * speed + 5);
      game.onInput(makeInput(game._getSequence()[0]));
      game.onInput(makeInput(game._getSequence()[1]));

      expect(game.isFinished()).toBe(true);
      expect(game.getState().won).toBe(true);
    });
  });

  describe('onInput - ignoring inputs during show phase', () => {
    it('should ignore inputs during showing phase', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff({ sequenceSpeed: 10 }));
      // Still in showing phase
      game.onInput(makeInput(0));

      // Should still be in showing, player progress still 0
      expect(game._getPhase()).toBe('showing');
      const state = game.getState() as any;
      expect(state.display.playerProgress).toBe(0);
    });
  });

  describe('isFinished / finalScore', () => {
    it('should return false when game is running', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff());
      expect(game.isFinished()).toBe(false);
    });

    it('should return the longest correct sequence completed', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff({ sequenceSpeed: 5, targetScore: 8 }));
      const speed = game._getDifficulty().sequenceSpeed;

      // Complete round 1 (1 step)
      runFrames(game, 1 * speed + 5);
      game.onInput(makeInput(game._getSequence()[0]));

      // Start round 2 showing (2 steps)
      runFrames(game, 2 * speed + 5);
      // Fail on first step of round 2
      const wrongButton = (game._getSequence()[0] + 1) % 4;
      game.onInput(makeInput(wrongButton));

      expect(game.isFinished()).toBe(true);
      // Score should be 1 (only completed round 1)
      expect(game.finalScore()).toBe(1);
    });
  });

  describe('serializeState', () => {
    it('should return valid JSON with sequence and progress', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff());
      const serialized = game.serializeState();
      const parsed = JSON.parse(serialized);

      expect(parsed).toHaveProperty('sequence');
      expect(parsed.sequence).toBeInstanceOf(Array);
      expect(parsed).toHaveProperty('playerIndex');
      expect(parsed).toHaveProperty('phase');
      expect(parsed).toHaveProperty('difficulty');
    });
  });

  describe('getState', () => {
    it('should return correct display state', () => {
      const game = new SimonProGame();
      game.init('test-seed', makeDiff());

      const state = game.getState();
      expect(state.display).toHaveProperty('sequence');
      expect(state.display).toHaveProperty('playerProgress');
      expect(state.display).toHaveProperty('phase');
      expect(state.display).toHaveProperty('highlightButton');
      expect(state.score).toBe(0);
      expect(state.finished).toBe(false);
    });
  });
});
