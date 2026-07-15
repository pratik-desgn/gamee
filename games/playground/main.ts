/**
 * GAMEE Playground — runs the real deterministic game modules + renderers
 * directly in the browser, bypassing wallet/ticket/backend entirely.
 *
 * Not part of the production app. Local-only dev tool for playtesting the
 * games in games/games/*, and for eyeballing behavior at each difficulty.
 */
import type { JackpotGame, DifficultyParams, TimestampedInput } from '../sdk/interface.js';
import type { Renderer } from '../sdk/renderer.js';

type ClickMode = 'pixel' | 'grid' | 'none';

interface GameEntry {
  id: string;
  name: string;
  width: number;
  height: number;
  clickMode: ClickMode;
  hint: string;
  load: () => Promise<{
    Game: new () => JackpotGame;
    Renderer: new (ctx: CanvasRenderingContext2D, w: number, h: number) => Renderer;
  }>;
}

const GAMES: GameEntry[] = [
  {
    id: 'wing-rush',
    name: 'Wing Rush',
    width: 400,
    height: 600,
    clickMode: 'pixel',
    hint: 'Click, tap, or press Space to flap.',
    load: async () => {
      const m = await import('../games/wing-rush/index.js');
      const r = await import('../games/wing-rush/renderer.js');
      return { Game: m.WingRushGame, Renderer: r.WingRushRenderer };
    },
  },
  {
    id: 'dino-sprint',
    name: 'Dino Sprint',
    width: 400,
    height: 600,
    clickMode: 'pixel',
    hint: 'Click, tap, or press Space to jump.',
    load: async () => {
      const m = await import('../games/dino-sprint/index.js');
      const r = await import('../games/dino-sprint/renderer.js');
      return { Game: m.DinoSprintGame, Renderer: r.DinoSprintRenderer };
    },
  },
  {
    id: 'reaction-test',
    name: 'Reaction Test',
    width: 400,
    height: 400,
    clickMode: 'pixel',
    hint: 'Wait for the signal, then click or press Space as fast as you can.',
    load: async () => {
      const m = await import('../games/reaction-test/index.js');
      const r = await import('../games/reaction-test/renderer.js');
      return { Game: m.ReactionTestGame, Renderer: r.ReactionTestRenderer };
    },
  },
  {
    id: 'aim-master',
    name: 'Aim Master',
    width: 400,
    height: 600,
    clickMode: 'pixel',
    hint: 'Click the targets as they appear.',
    load: async () => {
      const m = await import('../games/aim-master/index.js');
      const r = await import('../games/aim-master/renderer.js');
      return { Game: m.AimMasterGame, Renderer: r.AimMasterRenderer };
    },
  },
  {
    id: 'perfect-stack',
    name: 'Perfect Stack',
    width: 400,
    height: 600,
    clickMode: 'pixel',
    hint: 'Click, tap, or press Space to lock the moving block.',
    load: async () => {
      const m = await import('../games/perfect-stack/index.js');
      const r = await import('../games/perfect-stack/renderer.js');
      return { Game: m.PerfectStackGame, Renderer: r.PerfectStackRenderer };
    },
  },
  {
    id: 'helix-drop',
    name: 'Helix Drop',
    width: 400,
    height: 600,
    clickMode: 'none',
    hint: 'Hold Arrow Left / Arrow Right to rotate the gap under the resting ball — avoid sweeping the red hazard zone under it.',
    load: async () => {
      const m = await import('../games/helix-drop/index.js');
      const r = await import('../games/helix-drop/renderer.js');
      return { Game: m.HelixDropGame, Renderer: r.HelixDropRenderer };
    },
  },
  {
    id: 'block-merge',
    name: 'Block Merge',
    width: 400,
    height: 500,
    clickMode: 'none',
    hint: 'Arrow keys to slide and merge tiles (2048-style).',
    load: async () => {
      const m = await import('../games/block-merge/index.js');
      const r = await import('../games/block-merge/renderer.js');
      return { Game: m.BlockMergeGame, Renderer: r.BlockMergeRenderer };
    },
  },
  {
    id: 'simon-pro',
    name: 'Simon Pro',
    width: 400,
    height: 400,
    clickMode: 'none',
    hint: 'Watch the sequence, then repeat it with number keys 0-5.',
    load: async () => {
      const m = await import('../games/simon-pro/index.js');
      const r = await import('../games/simon-pro/renderer.js');
      return { Game: m.SimonProGame, Renderer: r.SimonProRenderer };
    },
  },
  {
    id: 'minefield',
    name: 'Minefield',
    width: 400,
    height: 400,
    clickMode: 'grid',
    hint: 'Click a tile to reveal it. Avoid the mines.',
    load: async () => {
      const m = await import('../games/minefield/index.js');
      const r = await import('../games/minefield/renderer.js');
      return { Game: m.MinefieldGame, Renderer: r.MinefieldRenderer };
    },
  },
  {
    id: 'sliding-puzzle',
    name: 'Sliding Puzzle',
    width: 400,
    height: 400,
    clickMode: 'grid',
    hint: 'Arrow keys, or click a tile adjacent to the empty slot.',
    load: async () => {
      const m = await import('../games/sliding-puzzle/index.js');
      const r = await import('../games/sliding-puzzle/renderer.js');
      return { Game: m.SlidingPuzzleGame, Renderer: r.SlidingPuzzleRenderer };
    },
  },
];

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const select = document.getElementById('game-select') as HTMLSelectElement;
const levelInput = document.getElementById('level') as HTMLInputElement;
const levelVal = document.getElementById('level-val') as HTMLSpanElement;
const restartBtn = document.getElementById('restart') as HTMLButtonElement;
const scoreEl = document.getElementById('score')!;
const targetEl = document.getElementById('target')!;
const frameEl = document.getElementById('frame')!;
const statusEl = document.getElementById('status')!;
const hintEl = document.getElementById('hint')!;

for (const g of GAMES) {
  const opt = document.createElement('option');
  opt.value = g.id;
  opt.textContent = g.name;
  select.appendChild(opt);
}

let game: JackpotGame | null = null;
let renderer: Renderer | null = null;
let entry: GameEntry | null = null;
let rafId = 0;
let frame = 0;
let lastTickTime = 0;
const FRAME_MS = 1000 / 60;

function randomSeed(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function loadGame(id: string) {
  cancelAnimationFrame(rafId);
  entry = GAMES.find((g) => g.id === id) ?? GAMES[0];

  canvas.width = entry.width;
  canvas.height = entry.height;
  hintEl.textContent = entry.hint;
  statusEl.textContent = '';
  statusEl.className = 'status';

  const { Game, Renderer: RendererClass } = await entry.load();
  game = new Game();
  renderer = new RendererClass(ctx, entry.width, entry.height);

  const level = Number(levelInput.value);
  const difficulty: DifficultyParams = { seed: randomSeed(), level, params: {} };
  game.init(difficulty.seed, difficulty);

  frame = 0;
  lastTickTime = performance.now();
  loop();
}

function sendInput(partial: Omit<TimestampedInput, 'frame' | 'time'>) {
  if (!game || game.isFinished()) return;
  const input: TimestampedInput = {
    frame,
    time: Date.now(),
    ...partial,
  };
  game.onInput(input);
}

canvas.addEventListener('mousedown', (e) => {
  if (!entry || entry.clickMode === 'none') return;
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const py = ((e.clientY - rect.top) / rect.height) * canvas.height;

  if (entry.clickMode === 'pixel') {
    sendInput({ type: 'click', data: { x: px, y: py } });
  } else if (entry.clickMode === 'grid') {
    const state = game?.getState();
    const display = (state?.display ?? {}) as Record<string, unknown>;
    const gridSize = (display.gridSize as number) ?? 4;
    const cell = canvas.width / gridSize;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    sendInput({ type: 'click', data: { x: gx, y: gy } });
  }
});

window.addEventListener('keydown', (e) => {
  if (!game || game.isFinished()) return;
  // Avoid scrolling the page with arrow keys / space while playing.
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) {
    e.preventDefault();
  }
  sendInput({ type: 'keydown', data: { key: e.key } });
});

window.addEventListener('keyup', (e) => {
  if (!game || game.isFinished()) return;
  sendInput({ type: 'keyup', data: { key: e.key } });
});

function loop() {
  const now = performance.now();
  if (now - lastTickTime >= FRAME_MS) {
    lastTickTime += FRAME_MS;
    if (game && !game.isFinished()) {
      game.tick();
      frame++;
    }
  }

  if (game && renderer) {
    const state = game.getState();
    renderer.render(state.display ?? {});
    scoreEl.textContent = String(state.score);
    targetEl.textContent = String(state.targetScore ?? '-');
    frameEl.textContent = String(state.frame ?? frame);

    if (game.isFinished()) {
      if (state.won) {
        statusEl.textContent = `WON — final score ${game.finalScore()}`;
        statusEl.className = 'status won';
      } else {
        statusEl.textContent = `LOST — final score ${game.finalScore()}`;
        statusEl.className = 'status lost';
      }
    }
  }

  rafId = requestAnimationFrame(loop);
}

select.addEventListener('change', () => loadGame(select.value));
levelInput.addEventListener('input', () => {
  levelVal.textContent = levelInput.value;
});
levelInput.addEventListener('change', () => loadGame(select.value));
restartBtn.addEventListener('click', () => loadGame(select.value));

loadGame(GAMES[0].id);
