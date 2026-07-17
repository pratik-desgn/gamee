/**
 * Client-side game registry — loads the exact same deterministic game
 * modules the backend's replay verifier and games/playground use (copied
 * into src/gamesdk by scripts/copy-gamesdk.mjs, see that file's comment).
 * Running the real sim here — not a placeholder canvas — is what makes a
 * player's live score real: the input log recorded while playing is what
 * gets replayed server-side to verify the win, so the client must run the
 * identical logic for the two to ever match.
 *
 * clickMode mirrors games/playground/main.ts's table exactly (kept in sync
 * by hand — there are only 10 games, a generated single-source-of-truth
 * isn't worth the build complexity here).
 */
import type { JackpotGame } from '@/gamesdk/sdk/interface';
import type { Renderer } from '@/gamesdk/sdk/renderer';

export type ClickMode = 'pixel' | 'grid' | 'none';

export interface GameEntry {
  id: string;
  width: number;
  height: number;
  clickMode: ClickMode;
  // Most games are "higher score is better, reach the target to win" —
  // the generic Score/Target readout on /play and /practice fits them
  // as-is. sliding-puzzle is the one exception: its live "score" is a
  // move count (lower is better) and its "target" is a par benchmark,
  // not the actual win condition (solving within the move budget is) —
  // labeling it "Score"/"Target" implies the opposite of how it works.
  // The renderer's own on-canvas text is the correct, detailed readout
  // for this game; these labels just keep the generic header from
  // actively misleading instead of showing nothing useful.
  scoreLabel?: string;
  targetLabel?: string;
  // Touch fallback for keyboard-only (clickMode 'none') games, so they're
  // playable on phones. Handlers synthesize the same keydown/keyup inputs
  // the keyboard path sends, so the recorded input log — and therefore
  // server-side replay verification — is identical either way.
  //   'hold-lr': touching the left/right half of the canvas holds
  //              ArrowLeft/ArrowRight until the finger lifts (helix-drop)
  //   'swipe':   a swipe sends one arrow-key press in its direction
  //              (block-merge)
  touch?: 'hold-lr' | 'swipe';
  // Custom pointer mapping for games whose canvas is a set of controls
  // rather than a plain field/grid (simon-pro's buttons). Takes canvas-
  // space pixel coordinates + the current display state and returns the
  // game input to send, or null for a miss. Takes precedence over
  // clickMode in the pages' pointer handlers.
  mapClick?: (
    px: number,
    py: number,
    display: Record<string, unknown>,
  ) => { type: string; data: Record<string, unknown> } | null;
  load: () => Promise<{
    Game: new () => JackpotGame;
    Renderer: new (ctx: CanvasRenderingContext2D, w: number, h: number) => Renderer;
  }>;
}

export const GAME_REGISTRY: Record<string, GameEntry> = {
  'wing-rush': {
    id: 'wing-rush',
    width: 400,
    height: 600,
    clickMode: 'pixel',
    load: async () => {
      const m = await import('@/gamesdk/games/wing-rush/index.js');
      const r = await import('@/gamesdk/games/wing-rush/renderer.js');
      return { Game: m.WingRushGame, Renderer: r.WingRushRenderer };
    },
  },
  'dino-sprint': {
    id: 'dino-sprint',
    width: 400,
    height: 600,
    clickMode: 'pixel',
    load: async () => {
      const m = await import('@/gamesdk/games/dino-sprint/index.js');
      const r = await import('@/gamesdk/games/dino-sprint/renderer.js');
      return { Game: m.DinoSprintGame, Renderer: r.DinoSprintRenderer };
    },
  },
  'reaction-test': {
    id: 'reaction-test',
    width: 400,
    height: 400,
    clickMode: 'pixel',
    load: async () => {
      const m = await import('@/gamesdk/games/reaction-test/index.js');
      const r = await import('@/gamesdk/games/reaction-test/renderer.js');
      return { Game: m.ReactionTestGame, Renderer: r.ReactionTestRenderer };
    },
  },
  'aim-master': {
    id: 'aim-master',
    width: 400,
    height: 600,
    clickMode: 'pixel',
    load: async () => {
      const m = await import('@/gamesdk/games/aim-master/index.js');
      const r = await import('@/gamesdk/games/aim-master/renderer.js');
      return { Game: m.AimMasterGame, Renderer: r.AimMasterRenderer };
    },
  },
  'perfect-stack': {
    id: 'perfect-stack',
    width: 400,
    height: 600,
    clickMode: 'pixel',
    load: async () => {
      const m = await import('@/gamesdk/games/perfect-stack/index.js');
      const r = await import('@/gamesdk/games/perfect-stack/renderer.js');
      return { Game: m.PerfectStackGame, Renderer: r.PerfectStackRenderer };
    },
  },
  'helix-drop': {
    id: 'helix-drop',
    width: 400,
    height: 600,
    clickMode: 'none',
    touch: 'hold-lr',
    load: async () => {
      const m = await import('@/gamesdk/games/helix-drop/index.js');
      const r = await import('@/gamesdk/games/helix-drop/renderer.js');
      return { Game: m.HelixDropGame, Renderer: r.HelixDropRenderer };
    },
  },
  'block-merge': {
    id: 'block-merge',
    touch: 'swipe',
    width: 400,
    height: 500,
    clickMode: 'none',
    load: async () => {
      const m = await import('@/gamesdk/games/block-merge/index.js');
      const r = await import('@/gamesdk/games/block-merge/renderer.js');
      return { Game: m.BlockMergeGame, Renderer: r.BlockMergeRenderer };
    },
  },
  'simon-pro': {
    id: 'simon-pro',
    width: 400,
    height: 400,
    clickMode: 'none',
    // Tap/click-to-button hit test, replicating SimonProRenderer's
    // layoutButtons() math exactly (padding 20, gap 10, 40px header band;
    // 2x2 grid up to 4 colors, 3-wide grid above) so the tappable areas
    // are the squares the player actually sees. Keyboard 1–6 still works.
    mapClick: (px, py, display) => {
      const colors = (display.colors as number) ?? 4;
      const padding = 20;
      const gap = 10;
      const totalWidth = 400 - padding * 2;
      const totalHeight = 400 - padding * 2 - 40;
      const cols = colors <= 4 ? 2 : 3;
      const rows = colors <= 4 ? 2 : Math.ceil(colors / 3);
      const cellW = (totalWidth - gap * (cols - 1)) / cols;
      const cellH = (totalHeight - gap * (rows - 1)) / rows;
      const size = Math.min(cellW, cellH);
      for (let i = 0; i < colors; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = padding + col * (size + gap);
        const y = padding + 40 + row * (size + gap);
        if (px >= x && px <= x + size && py >= y && py <= y + size) {
          return { type: 'tap', data: { button: i } };
        }
      }
      return null;
    },
    load: async () => {
      const m = await import('@/gamesdk/games/simon-pro/index.js');
      const r = await import('@/gamesdk/games/simon-pro/renderer.js');
      return { Game: m.SimonProGame, Renderer: r.SimonProRenderer };
    },
  },
  minefield: {
    id: 'minefield',
    width: 400,
    height: 400,
    clickMode: 'grid',
    load: async () => {
      const m = await import('@/gamesdk/games/minefield/index.js');
      const r = await import('@/gamesdk/games/minefield/renderer.js');
      return { Game: m.MinefieldGame, Renderer: r.MinefieldRenderer };
    },
  },
  'sliding-puzzle': {
    id: 'sliding-puzzle',
    width: 400,
    height: 400,
    clickMode: 'grid',
    scoreLabel: 'Moves',
    targetLabel: 'Par',
    load: async () => {
      const m = await import('@/gamesdk/games/sliding-puzzle/index.js');
      const r = await import('@/gamesdk/games/sliding-puzzle/renderer.js');
      return { Game: m.SlidingPuzzleGame, Renderer: r.SlidingPuzzleRenderer };
    },
  },
};
