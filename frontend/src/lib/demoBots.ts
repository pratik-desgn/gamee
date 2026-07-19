'use client';

/**
 * Self-playing demo mode: every game can play itself on the canvas so a
 * new player can SEE the mechanic before touching it — watching one pass
 * of helix-drop teaches more than any paragraph. Bot logic is a trimmed
 * per-frame port of the proven e2e bots (contracts/scripts/e2e-bots.ts);
 * these only need to look sensibly played for ~20 seconds, not win.
 *
 * The demo runs a throwaway game instance with a random seed — it never
 * touches a real session's game state or input log.
 */
import type { GameEntry } from '@/lib/gameRegistry';

type DemoInput = { type: string; data: Record<string, unknown> } | null;
type DemoBot = () => (g: any, frame: number) => DemoInput;

// ─── helix helpers (mirrors the game's isAngleInGap) ───────────────────
function inArc(angle: number, center: number, width: number): boolean {
  const half = width / 2;
  const a = ((angle - center) % 360 + 360) % 360;
  return a <= half || a >= 360 - half;
}
function framesUntilCovered(center: number, width: number, rot: number, dir: number, r: number): number {
  for (let t = 0; t <= Math.ceil(360 / r) + 1; t++) {
    if (inArc(0, center + rot + dir * r * t, width)) return t;
  }
  return Infinity;
}

const DEMO_BOTS: Record<string, DemoBot> = {
  'wing-rush': () => {
    let lastFlap = -99;
    let started = false;
    return (g, frame) => {
      if (!started) { started = true; lastFlap = frame; return { type: 'tap', data: {} }; }
      if (frame - lastFlap < 6) return null;
      const d = g.getState().display;
      const bird = d.bird;
      const next = d.pipes.find((p: any) => p.x + 60 >= bird.x);
      const target = (next ? next.gapY + next.gapSize / 2 : 300) + 12;
      if (bird.y + bird.velY * 2 > target) { lastFlap = frame; return { type: 'tap', data: {} }; }
      return null;
    };
  },
  'dino-sprint': () => {
    let started = false;
    return (g) => {
      const d = g.getState().display;
      if (!started) { started = true; return { type: 'tap', data: {} }; }
      const diff = g._getDifficulty();
      const dino = d.dino;
      const next = (d.obstacles || []).find((o: any) => o.x + o.width >= dino.x);
      if (!next) return null;
      const grounded = Math.abs(dino.velY) < 0.5 && dino.y >= d.groundY - dino.radius - 0.5;
      if (!grounded) return null;
      const ascent = Math.abs(diff.jumpVelocity) / diff.gravity;
      const eta = (next.x - dino.x) / diff.speed;
      if (eta > 0 && eta <= ascent * 0.95) return { type: 'tap', data: {} };
      return null;
    };
  },
  'perfect-stack': () => (g) => {
    const s = g.getState();
    const d = s.display;
    if (d.stack.length === 0) return { type: 'tap', data: {} };
    const prev = d.stack[d.stack.length - 1];
    if (Math.abs(d.currentBlock.x - prev.x) <= d.currentSpeed * 1.2) return { type: 'tap', data: {} };
    return null;
  },
  'reaction-test': () => {
    let goSince = -1;
    return (g, frame) => {
      const st = g.getState().display.state;
      if (st === 'signal') {
        if (goSince < 0) goSince = frame;
        if (frame - goSince >= 9) { goSince = -1; return { type: 'tap', data: {} }; }
        return null;
      }
      goSince = -1;
      return null;
    };
  },
  'block-merge': () => {
    // The classic beginner strategy, visibly: keep everything in one
    // corner by cycling down/left with occasional right to unstick.
    const cycle = ['down', 'left', 'down', 'left', 'down', 'right'];
    let i = 0;
    let last = -99;
    return (_g, frame) => {
      if (frame - last < 22) return null;
      last = frame;
      const dir = cycle[i % cycle.length];
      i++;
      return { type: 'swipe', data: { direction: dir } };
    };
  },
  'simon-pro': () => {
    let last = -99;
    return (g, frame) => {
      if (frame - last < 18) return null;
      const d = g.getState().display;
      if (d.phase !== 'input') return null;
      const next = d.sequence[d.playerProgress];
      if (next === undefined) return null;
      last = frame;
      return { type: 'tap', data: { button: next } };
    };
  },
  'aim-master': () => {
    let last = -99;
    return (g, frame) => {
      if (frame - last < 14) return null;
      const t = (g.getState().display.targets || []).find((t: any) => t.active && t.radius > 4);
      if (!t) return null;
      last = frame;
      return { type: 'click', data: { x: t.x, y: t.y } };
    };
  },
  'sliding-puzzle': () => {
    // Teaching goal is the mechanic (tap a tile next to the empty slot to
    // slide it), not a solve — random legal slides show it clearly.
    let last = -99;
    let prev = -1;
    return (g, frame) => {
      if (frame - last < 24) return null;
      const d = g.getState().display;
      const opts: Array<{ x: number; y: number }> = [];
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const x = d.emptyX + dx, y = d.emptyY + dy;
        if (x >= 0 && x < d.gridSize && y >= 0 && y < d.gridSize) opts.push({ x, y });
      }
      const pick = opts.filter((o) => d.grid[o.y][o.x] !== prev);
      const t = (pick.length ? pick : opts)[Math.floor(Math.random() * (pick.length ? pick.length : opts.length))];
      prev = d.grid[d.emptyY][d.emptyX]; // value about to move into the tapped slot
      last = frame;
      return { type: 'tap', data: { x: t.x, y: t.y } };
    };
  },
  'helix-drop': () => {
    let holding = 0;
    const keyOf = (dir: number) => (dir < 0 ? 'ArrowLeft' : 'ArrowRight');
    return (g) => {
      const s = g.getState();
      const d = s.display;
      const idx = s.score;
      if (idx >= d.platforms.length) return null;
      const p = d.platforms[idx];
      const diff = g._getDifficulty();
      const r = diff.rotationSpeed;
      const rot = d.helixRotation;
      const resting = d.ball.y >= p.y;
      if (resting) {
        let dir = 1;
        let best = -Infinity;
        for (const cand of [1, -1]) {
          const tGap = framesUntilCovered(p.gapAngle, p.gapWidth, rot, cand, r);
          const tHaz = framesUntilCovered(p.hazardAngle, p.hazardWidth, rot, cand, r);
          if (tHaz - tGap > best) { best = tHaz - tGap; dir = cand; }
        }
        if (holding === dir) return null;
        if (holding !== 0) { const k = keyOf(holding); holding = 0; return { type: 'keyup', data: { key: k } }; }
        holding = dir;
        return { type: 'keydown', data: { key: keyOf(dir) } };
      }
      const hazardUnder = inArc(0, p.hazardAngle + rot, p.hazardWidth);
      if (holding !== 0 && !hazardUnder) {
        const k = keyOf(holding); holding = 0;
        return { type: 'keyup', data: { key: k } };
      }
      return null;
    };
  },
  minefield: () => {
    let last = -99;
    return (g, frame) => {
      if (frame - last < 26) return null;
      const grid = g.grid;
      if (!grid) return null;
      for (let y = 0; y < grid.length; y++)
        for (let x = 0; x < grid[y].length; x++) {
          const c = grid[y][x];
          if (!c.isMine && !(c.revealed ?? c.isRevealed)) { last = frame; return { type: 'click', data: { x, y } }; }
        }
      return null;
    };
  },
};

/**
 * Starts a looping self-playing demo on the canvas. Returns a stop
 * function; the demo also stops itself if the canvas disappears. Restarts
 * with a fresh seed whenever a run ends, until stopped.
 */
export function startDemo(entry: GameEntry, canvas: HTMLCanvasElement, level = 4): () => void {
  let stopped = false;
  let raf = 0;

  (async () => {
    const { Game, Renderer: RendererClass } = await entry.load();
    if (stopped) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const renderer = new RendererClass(ctx, entry.width, entry.height);
    const makeBot = DEMO_BOTS[entry.id];

    let game: any;
    let decide: (g: any, frame: number) => DemoInput;
    let frame = 0;
    let endPause = 0;
    const reset = () => {
      const seed = 'demo_' + Math.random().toString(36).slice(2);
      game = new Game();
      game.init(seed, { seed, level, params: {} });
      decide = makeBot ? makeBot() : () => null;
      frame = 0;
      endPause = 0;
    };
    reset();

    let lastTick = performance.now();
    const FRAME_MS = 1000 / 60;
    const loop = () => {
      if (stopped || !canvas.isConnected) return;
      const now = performance.now();
      if (now - lastTick >= FRAME_MS) {
        lastTick += FRAME_MS;
        if (now - lastTick > 500) lastTick = now; // tab was backgrounded
        if (!game.isFinished()) {
          const inp = decide(game, frame);
          if (inp) game.onInput({ frame, time: frame * 16.667, ...inp });
          game.tick();
          frame++;
        } else if (++endPause > 90) {
          reset(); // linger ~1.5s on the end state, then run again
        }
      }
      renderer.render(game.getState().display ?? {});
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  })();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}
