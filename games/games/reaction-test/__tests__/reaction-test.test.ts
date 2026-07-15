import { ReactionTestGame, ReactionTestDifficulty } from '../index.js';
import type { DifficultyParams, TimestampedInput } from '../../../sdk/interface.js';

// ─── Helpers ──────────────────────────────────────────────

function makeDiff(overrides: Partial<ReactionTestDifficulty> = {}): DifficultyParams {
  return {
    seed: 'test-seed',
    level: 3,
    params: {
      minWaitMs: overrides.minWaitMs ?? 1000,
      maxWaitMs: overrides.maxWaitMs ?? 2000,
      rounds: overrides.rounds ?? 3,
      targetReactionMs: overrides.targetReactionMs ?? 300,
    },
  };
}

function makeTap(frame: number = 0, key: string = ' '): TimestampedInput {
  return {
    frame,
    type: 'keydown',
    data: { key },
    time: frame * 16,
  };
}

function runFrames(game: ReactionTestGame, count: number): void {
  for (let i = 0; i < count; i++) {
    game.tick();
  }
}

// ─── Tests ────────────────────────────────────────────────

describe('ReactionTestGame', () => {
  describe('init', () => {
    it('should start in waiting state', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff());

      expect(game._getState()).toBe('waiting');
      expect(game.isFinished()).toBe(false);
      expect(game.getState().won).toBe(false);
      expect(game._getRound()).toBe(1);
    });

    it('should schedule a wait duration in the valid range', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff({ minWaitMs: 1500, maxWaitMs: 3000 }));

      const waitFrames = game._getWaitFrames();
      const waitMs = waitFrames * 16;
      expect(waitMs).toBeGreaterThanOrEqual(1000);
      expect(waitMs).toBeLessThanOrEqual(3000);
    });

    it('should produce deterministic wait times from same seed', () => {
      const game1 = new ReactionTestGame();
      game1.init('deterministic', makeDiff());
      const w1 = game1._getWaitFrames();

      const game2 = new ReactionTestGame();
      game2.init('deterministic', makeDiff());
      const w2 = game2._getWaitFrames();

      expect(w1).toBe(w2);
    });

    it('should produce different wait times from different seeds', () => {
      const game1 = new ReactionTestGame();
      game1.init('seed-a', makeDiff());
      const w1 = game1._getWaitFrames();

      const game2 = new ReactionTestGame();
      game2.init('seed-b', makeDiff());
      const w2 = game2._getWaitFrames();

      // Almost certainly different
      expect(w1).not.toBe(w2);
    });
  });

  describe('tick - waiting to signal transition', () => {
    it('should transition to signal after wait frames elapsed', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff({ minWaitMs: 100, maxWaitMs: 100 }));
      // Force wait to be very short: wait frames ~ 100/16 = 6
      // Run enough ticks
      runFrames(game, 20);

      expect(game._getState()).toBe('signal');
      const state = game.getState() as any;
      expect(state.display.showSignal).toBe(true);
    });

    it('should remain in waiting state before wait expires', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff({ minWaitMs: 5000, maxWaitMs: 5000 }));
      // Run a few frames - not enough to reach signal
      runFrames(game, 10);

      expect(game._getState()).toBe('waiting');
    });
  });

  describe('onInput - false start', () => {
    it('should finish with false start if input during waiting', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff({ minWaitMs: 5000, maxWaitMs: 5000 }));

      // Tap while waiting
      game.onInput(makeTap(5));

      expect(game.isFinished()).toBe(true);
      expect(game.getState().won).toBe(false);
      expect(game.finalScore()).toBe(0); // lost — matches getState().score
    });
  });

  describe('onInput - correct reaction', () => {
    it('should record reaction time when tapping during signal', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff());

      // Skip directly to signal
      game._forceSignal();
      // Run a few frames to simulate delay
      runFrames(game, 5);

      game.onInput(makeTap(5));

      const expectedMs = 5 * 16; // 80ms
      expect(game._getReactionTimes()).toEqual([expectedMs]);
      expect(game._getState()).toBe('waiting'); // should schedule next round
      expect(game._getRound()).toBe(2);
    });

    it('should auto-advance to next round after recording reaction', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff({ rounds: 3 }));

      // Complete round 1
      game._forceSignal();
      runFrames(game, 3);
      game.onInput(makeTap(3));

      expect(game._getRound()).toBe(2);
      expect(game._getState()).toBe('waiting');
      expect(game.isFinished()).toBe(false);

      // Complete round 2
      game._forceSignal();
      runFrames(game, 3);
      game.onInput(makeTap(3));

      expect(game._getRound()).toBe(3);
      expect(game._getState()).toBe('waiting');

      // Complete round 3
      game._forceSignal();
      runFrames(game, 3);
      game.onInput(makeTap(3));

      expect(game.isFinished()).toBe(true);
      expect(game._getReactionTimes()).toHaveLength(3);
    });
  });

  describe('getState', () => {
    it('should return correct display state during waiting', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff());

      const state = game.getState();
      const display = state.display as any;

      expect(display.state).toBe('waiting');
      expect(display.round).toBe(1);
      expect(display.waitingForSignal).toBe(true);
      expect(display.showSignal).toBe(false);
      expect(display.reactionTime).toBeNull();
      expect(state.finished).toBe(false);
    });

    it('should return correct display state during signal', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff());
      game._forceSignal();

      const state = game.getState();
      const display = state.display as any;

      expect(display.state).toBe('signal');
      expect(display.showSignal).toBe(true);
      expect(display.waitingForSignal).toBe(false);
    });
  });

  describe('isFinished / finalScore', () => {
    it('should finish after completing all rounds', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff({ rounds: 2 }));

      // Round 1
      game._forceSignal();
      runFrames(game, 3);
      game.onInput(makeTap(3));
      // Round 2
      game._forceSignal();
      runFrames(game, 3);
      game.onInput(makeTap(3));

      expect(game.isFinished()).toBe(true);
    });

    it('should calculate average reaction time', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff({ rounds: 3 }));

      // Three rounds with known reaction times (force them via _forceSignal + _completeRound)
      for (let r = 0; r < 3; r++) {
        game._forceSignal();
        game._completeRound(); // adds 150ms
      }

      expect(game.isFinished()).toBe(true);
      // Avg of [150, 150, 150] = 150
      expect(game.finalScore()).toBe(150);
    });

    it('should win if avg reaction < targetReactionMs', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff({ rounds: 2, targetReactionMs: 300 }));

      // Both rounds fast reactions
      game._forceSignal();
      runFrames(game, 2); // 32ms reaction
      game.onInput(makeTap(2));

      game._forceSignal();
      runFrames(game, 2);
      game.onInput(makeTap(2));

      expect(game.isFinished()).toBe(true);
      expect(game.getState().won).toBe(true);
    });

    it('should lose if avg reaction >= targetReactionMs', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff({ rounds: 2, targetReactionMs: 50 }));

      // Slow reactions
      game._forceSignal();
      runFrames(game, 10); // 160ms reaction
      game.onInput(makeTap(10));

      game._forceSignal();
      runFrames(game, 10);
      game.onInput(makeTap(10));

      expect(game.isFinished()).toBe(true);
      expect(game.getState().won).toBe(false);
    });
  });

  describe('serializeState', () => {
    it('should return valid JSON with state and times', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff());

      const serialized = game.serializeState();
      const parsed = JSON.parse(serialized);

      expect(parsed).toHaveProperty('state');
      expect(parsed).toHaveProperty('round');
      expect(parsed).toHaveProperty('reactionTimes');
      expect(parsed).toHaveProperty('difficulty');
    });
  });

  describe('multiple rounds end-to-end', () => {
    it('should handle a full game with correct inputs', () => {
      const game = new ReactionTestGame();
      game.init('test-seed', makeDiff({ rounds: 3, targetReactionMs: 300 }));

      // Play through 3 rounds
      for (let r = 0; r < 3; r++) {
        // Wait until signal
        while (game._getState() !== 'signal' && !game.isFinished()) {
          game.tick();
        }
        if (game.isFinished()) break;

        // Small delay before reacting
        runFrames(game, 2);
        game.onInput(makeTap(game.getState().frame));
      }

      expect(game.isFinished()).toBe(true);
      expect(game._getReactionTimes()).toHaveLength(3);
      // All reactions should be > 0
      for (const t of game._getReactionTimes()) {
        expect(t).toBeGreaterThan(0);
      }
      expect(game.getState().score).toBeDefined();
    });
  });
});
