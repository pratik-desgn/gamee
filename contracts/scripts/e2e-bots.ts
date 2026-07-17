/**
 * Humanlike bots for all 10 GAMEE games, shared by the devnet e2e script
 * (e2e-devnet.ts) and the offline coverage check (bots-offline-check.ts).
 *
 * Contract with anti-cheat (backend/internal/anticheat/analyzer.go — the
 * analyzer works on FRAME deltas × 16.667ms):
 *   - <50% of input intervals under 100ms (6 frames)  → keep gaps ≥ 6 frames
 *   - interval stddev ≥ 30ms                          → randomize every gap
 *   - ≤ 15 inputs/second overall                      → avg gap ≥ 4 frames
 * The playBot pacing (per-bot `pace`, default 15–40 frames per action)
 * satisfies all three with margin; decision polls between actions run every
 * 2–4 frames but emit nothing.
 *
 * Bots may read game internals ("cheat" at the decision level) — the replay
 * verifier re-runs the deterministic sim, so a bot can only win by making
 * inputs that legitimately win; anti-cheat's job is input timing, which the
 * pacing above keeps humanlike.
 */

export type BotInput = { type: string; data: Record<string, unknown> } | null;
export type BotDecide = (g: any, frame: number) => BotInput;
export type Bot = {
  cls: string;
  /** Fresh decision function per run (bots keep closure state). */
  makeDecide: () => BotDecide;
  /** Frames to wait after an emitted action: base + rand(spread). */
  pace?: [number, number];
};

export type Rec = { frame: number; type: string; data: Record<string, unknown>; time: number };

export function playBot(game: any, decide: BotDecide, pace: [number, number] = [15, 25]): Rec[] {
  const log: Rec[] = [];
  let frame = 0;
  let nextAction = 30 + Math.floor(Math.random() * 30);
  while (!game.isFinished() && frame < 60000) {
    if (frame >= nextAction) {
      const inp = decide(game, frame);
      if (inp) {
        const rec: Rec = {
          frame,
          type: inp.type,
          data: inp.data,
          time: Math.round(frame * 16.667 + Math.random() * 9 + 1),
        };
        game.onInput(rec);
        log.push(rec);
        nextAction = frame + pace[0] + Math.floor(Math.random() * (pace[1] + 1));
      } else {
        nextAction = frame + 2 + Math.floor(Math.random() * 3);
      }
    }
    game.tick();
    frame++;
  }
  return log;
}

// ─── block-merge: depth-2 adversarial search with a snake heuristic ────

type MergeMove = { grid: number[][]; moved: boolean };

function bmSlideRow(row: number[]): number[] {
  // Byte-for-byte the game's slideRow semantics: single-pass adjacent
  // merges, a merged tile does not merge again this move.
  const cells = row.filter((v) => v !== 0);
  for (let i = 0; i < cells.length - 1; i++) {
    if (cells[i] === cells[i + 1]) {
      cells[i] *= 2;
      cells.splice(i + 1, 1);
    }
  }
  while (cells.length < row.length) cells.push(0);
  return cells;
}

function bmApply(grid: number[][], dir: string): MergeMove {
  const n = grid.length;
  const out = grid.map((r) => [...r]);
  if (dir === "left" || dir === "right") {
    for (let r = 0; r < n; r++) {
      const row = dir === "left" ? out[r] : [...out[r]].reverse();
      const slid = bmSlideRow(row);
      out[r] = dir === "left" ? slid : slid.reverse();
    }
  } else {
    for (let c = 0; c < n; c++) {
      let col = out.map((r) => r[c]);
      if (dir === "down") col = col.reverse();
      let slid = bmSlideRow(col);
      if (dir === "down") slid = slid.reverse();
      for (let r = 0; r < n; r++) out[r][c] = slid[r];
    }
  }
  let moved = false;
  for (let r = 0; r < n && !moved; r++)
    for (let c = 0; c < n; c++)
      if (out[r][c] !== grid[r][c]) { moved = true; break; }
  return { grid: out, moved };
}

function bmHeuristic(grid: number[][]): number {
  // Snake weighting keeps the big tiles ordered along a serpentine path
  // from one corner; empty cells add survival slack.
  const n = grid.length;
  let score = 0;
  let empties = 0;
  let rank = n * n - 1;
  for (let r = 0; r < n; r++) {
    const cols = r % 2 === 0 ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
    for (const c of cols) {
      const v = grid[r][c];
      if (v === 0) empties++;
      score += v * Math.pow(3, rank);
      rank--;
    }
  }
  return score + empties * Math.pow(3, n * n - 6);
}

const BM_DIRS = ["left", "up", "right", "down"];

function bmBestMove(grid: number[][]): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const dir of BM_DIRS) {
    const m = bmApply(grid, dir);
    if (!m.moved) continue;
    // Adversarial spawn: assume the RNG drops a 2 in the worst empty cell,
    // then take our best reply — depth-2 without modeling the real
    // (unknown-to-a-player) spawn sequence.
    const empties: Array<{ r: number; c: number }> = [];
    for (let r = 0; r < m.grid.length; r++)
      for (let c = 0; c < m.grid.length; c++)
        if (m.grid[r][c] === 0) empties.push({ r, c });
    let worst = Infinity;
    for (const e of empties) {
      m.grid[e.r][e.c] = 2;
      let reply = -Infinity;
      for (const d2 of BM_DIRS) {
        const m2 = bmApply(m.grid, d2);
        if (m2.moved) reply = Math.max(reply, bmHeuristic(m2.grid));
      }
      if (reply === -Infinity) reply = bmHeuristic(m.grid) - 1e30; // stuck board
      worst = Math.min(worst, reply);
      m.grid[e.r][e.c] = 0;
    }
    const score = empties.length === 0 ? bmHeuristic(m.grid) : worst;
    if (score > bestScore) { bestScore = score; best = dir; }
  }
  return best;
}

// ─── sliding-puzzle: IDA* (≤4×4) + constructive ring reduction (5×5) ───

type Pt = { x: number; y: number };

/**
 * IDA* on an arbitrary square puzzle with Manhattan + linear-conflict
 * heuristic. `goal[i]` is the value that belongs at flat index i (0 =
 * empty). Returns the tap sequence (each tap = the cell the empty moves
 * into), or null if the node budget is exhausted.
 */
function idaSolve(start: number[], goal: number[], n: number, nodeBudget = 4_000_000): Pt[] | null {
  const goalPos = new Map<number, number>();
  goal.forEach((v, i) => goalPos.set(v, i));

  function manhattan(state: number[]): number {
    let h = 0;
    for (let i = 0; i < state.length; i++) {
      const v = state[i];
      if (v === 0) continue;
      const g = goalPos.get(v)!;
      h += Math.abs((i % n) - (g % n)) + Math.abs(Math.floor(i / n) - Math.floor(g / n));
    }
    // Linear conflicts: two tiles in their goal row/col but reversed cost
    // two extra moves each pair.
    for (let r = 0; r < n; r++) {
      for (let a = 0; a < n; a++) {
        const va = state[r * n + a];
        if (va === 0) continue;
        const ga = goalPos.get(va)!;
        if (Math.floor(ga / n) !== r) continue;
        for (let b = a + 1; b < n; b++) {
          const vb = state[r * n + b];
          if (vb === 0) continue;
          const gb = goalPos.get(vb)!;
          if (Math.floor(gb / n) === r && ga % n > gb % n) h += 2;
        }
      }
    }
    for (let c = 0; c < n; c++) {
      for (let a = 0; a < n; a++) {
        const va = state[a * n + c];
        if (va === 0) continue;
        const ga = goalPos.get(va)!;
        if (ga % n !== c) continue;
        for (let b = a + 1; b < n; b++) {
          const vb = state[b * n + c];
          if (vb === 0) continue;
          const gb = goalPos.get(vb)!;
          if (gb % n === c && Math.floor(ga / n) > Math.floor(gb / n)) h += 2;
        }
      }
    }
    return h;
  }

  const state = [...start];
  let emptyIdx = state.indexOf(0);
  const path: number[] = []; // sequence of empty destinations (flat indices)
  let nodes = 0;

  function search(g: number, bound: number, prevEmpty: number): number {
    const h = manhattan(state);
    const f = g + h;
    if (f > bound) return f;
    if (h === 0) return -1; // solved
    if (++nodes > nodeBudget) return -2; // budget blown
    let min = Infinity;
    const er = Math.floor(emptyIdx / n);
    const ec = emptyIdx % n;
    const neighbors: number[] = [];
    if (er > 0) neighbors.push(emptyIdx - n);
    if (er < n - 1) neighbors.push(emptyIdx + n);
    if (ec > 0) neighbors.push(emptyIdx - 1);
    if (ec < n - 1) neighbors.push(emptyIdx + 1);
    for (const nb of neighbors) {
      if (nb === prevEmpty) continue; // don't undo the last move
      const from = emptyIdx;
      state[from] = state[nb];
      state[nb] = 0;
      emptyIdx = nb;
      path.push(nb);
      const t = search(g + 1, bound, from);
      if (t === -1) return -1;
      if (t === -2) return -2;
      if (t < min) min = t;
      path.pop();
      emptyIdx = from;
      state[nb] = state[from];
      state[from] = 0;
    }
    return min;
  }

  let bound = manhattan(state);
  if (bound === 0) return [];
  for (;;) {
    const t = search(0, bound, -1);
    if (t === -1) return path.map((i) => ({ x: i % n, y: Math.floor(i / n) }));
    if (t === -2 || t === Infinity) return null;
    bound = t;
  }
}

/** Constructive solver state: mutable grid + tap recorder. */
class PuzzleState {
  g: number[][];
  ex: number;
  ey: number;
  taps: Pt[] = [];
  n: number;
  locked: Set<string> = new Set();

  constructor(grid: number[][]) {
    this.g = grid.map((r) => [...r]);
    this.n = grid.length;
    this.ex = 0; this.ey = 0;
    for (let y = 0; y < this.n; y++)
      for (let x = 0; x < this.n; x++)
        if (this.g[y][x] === 0) { this.ex = x; this.ey = y; }
  }

  key(x: number, y: number) { return `${x},${y}`; }
  isLocked(x: number, y: number) { return this.locked.has(this.key(x, y)); }
  lock(x: number, y: number) { this.locked.add(this.key(x, y)); }

  tap(x: number, y: number) {
    // (x,y) must be adjacent to the empty; slides that tile into the empty.
    // The game silently ignores illegal taps, so an illegal tap here means
    // the model desynced from the real board — fail loudly instead.
    if (Math.abs(x - this.ex) + Math.abs(y - this.ey) !== 1) {
      throw new Error(`illegal tap ${x},${y} with empty at ${this.ex},${this.ey}`);
    }
    this.g[this.ey][this.ex] = this.g[y][x];
    this.g[y][x] = 0;
    this.ex = x; this.ey = y;
    this.taps.push({ x, y });
  }

  find(v: number): Pt {
    for (let y = 0; y < this.n; y++)
      for (let x = 0; x < this.n; x++)
        if (this.g[y][x] === v) return { x, y };
    throw new Error(`tile ${v} not found`);
  }

  /** Walk the empty to (tx,ty) avoiding locked cells and `avoid`. */
  moveEmpty(tx: number, ty: number, avoid?: Pt) {
    if (this.ex === tx && this.ey === ty) return;
    // BFS over free cells.
    const q: Pt[] = [{ x: this.ex, y: this.ey }];
    const prev = new Map<string, Pt | null>([[this.key(this.ex, this.ey), null]]);
    while (q.length) {
      const cur = q.shift()!;
      if (cur.x === tx && cur.y === ty) break;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || nx >= this.n || ny < 0 || ny >= this.n) continue;
        if (this.isLocked(nx, ny)) continue;
        if (avoid && avoid.x === nx && avoid.y === ny) continue;
        if (prev.has(this.key(nx, ny))) continue;
        prev.set(this.key(nx, ny), cur);
        q.push({ x: nx, y: ny });
      }
    }
    if (!prev.has(this.key(tx, ty))) throw new Error(`empty cannot reach ${tx},${ty}`);
    const rpath: Pt[] = [];
    let cur: Pt | null = { x: tx, y: ty };
    while (cur && !(cur.x === this.ex && cur.y === this.ey)) {
      rpath.push(cur);
      cur = prev.get(this.key(cur.x, cur.y)) ?? null;
    }
    for (let i = rpath.length - 1; i >= 0; i--) this.tap(rpath[i].x, rpath[i].y);
  }

  /** Move tile with value v to (tx,ty), leaving it there (not locked). */
  moveTile(v: number, tx: number, ty: number) {
    for (let guard = 0; guard < 200; guard++) {
      const p = this.find(v);
      if (p.x === tx && p.y === ty) return;
      // BFS path for the tile itself through free cells.
      const q: Pt[] = [p];
      const prev = new Map<string, Pt | null>([[this.key(p.x, p.y), null]]);
      while (q.length) {
        const cur = q.shift()!;
        if (cur.x === tx && cur.y === ty) break;
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const nx = cur.x + dx, ny = cur.y + dy;
          if (nx < 0 || nx >= this.n || ny < 0 || ny >= this.n) continue;
          if (this.isLocked(nx, ny)) continue;
          if (prev.has(this.key(nx, ny))) continue;
          prev.set(this.key(nx, ny), cur);
          q.push({ x: nx, y: ny });
        }
      }
      if (!prev.has(this.key(tx, ty))) throw new Error(`tile ${v} cannot reach ${tx},${ty}`);
      // First step of the tile's path (walk back from target).
      let cur: Pt | null = { x: tx, y: ty };
      let step: Pt = cur;
      while (cur && !(cur.x === p.x && cur.y === p.y)) {
        step = cur;
        cur = prev.get(this.key(cur.x, cur.y)) ?? null;
      }
      // Bring the empty to the tile's next cell (without disturbing the
      // tile), then slide the tile into it.
      this.moveEmpty(step.x, step.y, p);
      this.tap(p.x, p.y);
    }
    throw new Error(`moveTile(${v}) did not converge`);
  }
}

/**
 * Place the last two tiles of a row/column edge with the standard corner
 * rotation: park the second-to-last value in the corner, the last value
 * right past it (perpendicular), then rotate both in.
 */
function placeEdgePair(
  st: PuzzleState,
  vA: number, aX: number, aY: number,   // second-to-last tile and its goal
  vB: number, bX: number, bY: number,   // last (corner) tile and its goal
  perp: Pt,                              // unit vector pointing into the board
) {
  const solved = () => {
    const pa = st.find(vA), pb = st.find(vB);
    return pa.x === aX && pa.y === aY && pb.x === bX && pb.y === bY;
  };
  const scratch = { x: bX + 2 * perp.x, y: bY + 2 * perp.y };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (solved()) return;
    // If either tile is parked where the maneuver needs the other (a
    // classic deadlock), shove it two cells into the board first.
    for (const v of [vA, vB]) {
      const p = st.find(v);
      if ((p.x === bX && p.y === bY) || (p.x === bX + perp.x && p.y === bY + perp.y) ||
          (p.x === aX && p.y === aY)) {
        st.moveTile(v, scratch.x, scratch.y);
      }
    }
    // vA into the corner, vB one step past it (into the board).
    st.moveTile(vA, bX, bY);
    st.lock(bX, bY);
    st.moveTile(vB, bX + perp.x, bY + perp.y);
    // Walk the empty to vA's goal cell — with BOTH parked tiles locked, or
    // the walk can pass straight through vB and silently displace it.
    st.lock(bX + perp.x, bY + perp.y);
    st.moveEmpty(aX, aY);
    st.locked.delete(st.key(bX, bY));
    st.locked.delete(st.key(bX + perp.x, bY + perp.y));
    // Rotate: slide vA across into its goal, then vB into the corner.
    st.tap(bX, bY);
    st.tap(bX + perp.x, bY + perp.y);
  }
  if (!solved()) throw new Error(`edge pair (${vA},${vB}) did not settle`);
}

/** Full solver: taps that solve `grid` (0 = empty, goal = 1..n²-1 rowwise). */
export function solveSlidingPuzzle(grid: number[][]): Pt[] {
  const n = grid.length;
  const goalOf = (x: number, y: number) => (y * n + x + 1) % (n * n);

  if (n === 3) {
    const goal = Array.from({ length: 9 }, (_, i) => (i + 1) % 9);
    const sol = idaSolve(grid.flat(), goal, 3);
    if (!sol) throw new Error("3x3 IDA* exhausted its node budget");
    return sol;
  }

  // n ≥ 4: constructive ring reduction (top row + left column per ring)
  // down to 3×3, then optimal IDA* on the remainder. Direct IDA* on a full
  // random 15-puzzle is too slow without pattern databases; the
  // constructive path is instant and its move counts fit the game's
  // budgets.
  const st = new PuzzleState(grid);
  let top = 0, left = 0, size = n;
  while (size > 3) {
    // Top row of the unsolved region.
    for (let x = left; x < left + size - 2; x++) {
      st.moveTile(goalOf(x, top), x, top);
      st.lock(x, top);
    }
    placeEdgePair(
      st,
      goalOf(left + size - 2, top), left + size - 2, top,
      goalOf(left + size - 1, top), left + size - 1, top,
      { x: 0, y: 1 },
    );
    for (let x = left + size - 2; x < left + size; x++) st.lock(x, top);
    top++;
    // Left column of the remaining region.
    for (let y = top; y < top + size - 3; y++) {
      st.moveTile(goalOf(left, y), left, y);
      st.lock(left, y);
    }
    placeEdgePair(
      st,
      goalOf(left, top + size - 3), left, top + size - 3,
      goalOf(left, top + size - 2), left, top + size - 2,
      { x: 1, y: 0 },
    );
    for (let y = top + size - 3; y < top + size - 1; y++) st.lock(left, y);
    left++;
    size--;
  }
  // Remaining size×size block (4×4 after one 5×5 ring, or 3×3): IDA* on the
  // subgrid with its real goal values.
  const sub: number[] = [];
  const goalSub: number[] = [];
  for (let y = top; y < top + size; y++)
    for (let x = left; x < left + size; x++) {
      sub.push(st.g[y][x]);
      goalSub.push(goalOf(x, y));
    }
  const inner = idaSolve(sub, goalSub, size);
  if (!inner) throw new Error(`inner IDA* exhausted its node budget (grid=${JSON.stringify(st.g)} sub=${JSON.stringify(sub)} goal=${JSON.stringify(goalSub)})`);
  return [...st.taps, ...inner.map((p) => ({ x: p.x + left, y: p.y + top }))];
}

// ─── helix-drop helpers ────────────────────────────────────────────────

function inArc(angle: number, center: number, width: number): boolean {
  const half = width / 2;
  const a = ((angle - center) % 360 + 360) % 360;
  return a <= half || a >= 360 - half;
}

/** Frames of rotation at r deg/frame (direction dir) until the arc covers 0°. */
function framesUntilCovered(center: number, width: number, rot: number, dir: number, r: number): number {
  for (let t = 0; t <= Math.ceil(360 / r) + 1; t++) {
    if (inArc(0, center + rot + dir * r * t, width)) return t;
  }
  return Infinity;
}

// ─── the bots ──────────────────────────────────────────────────────────

export const BOTS: Record<string, Bot> = {
  "aim-master": {
    cls: "AimMasterGame",
    makeDecide: () => (g) => {
      const t = (g.getState().display.targets || []).find((t: any) => t.active && t.radius > 4);
      if (!t) return null;
      const jitter = () => (Math.random() - 0.5) * t.radius * 0.6;
      return { type: "click", data: { x: t.x + jitter(), y: t.y + jitter() } };
    },
  },

  minefield: {
    cls: "MinefieldGame",
    makeDecide: () => (g) => {
      const grid = g.grid; // peek internals: bots may cheat, anti-cheat's job is timing
      if (!grid) return null;
      for (let y = 0; y < grid.length; y++)
        for (let x = 0; x < grid[y].length; x++) {
          const c = grid[y][x];
          if (!c.isMine && !(c.revealed ?? c.isRevealed)) return { type: "click", data: { x, y } };
        }
      return null;
    },
  },

  "reaction-test": {
    cls: "ReactionTestGame",
    makeDecide: () => {
      let goSince = -1;
      return (g: any, frame: number) => {
        const st = g.getState().display.state;
        if (st === "signal") {
          if (goSince < 0) goSince = frame;
          // react ~120-230ms after the signal (7-11 frames + detection lag)
          if (frame - goSince >= 7 + Math.floor(Math.random() * 5)) {
            goSince = -1;
            return { type: "tap", data: {} };
          }
          return null;
        }
        goSince = -1;
        return null;
      };
    },
  },

  "simon-pro": {
    cls: "SimonProGame",
    makeDecide: () => (g) => {
      const d = g.getState().display;
      if (d.phase !== "input") return null;
      const next = d.sequence[d.playerProgress];
      if (next === undefined) return null;
      return { type: "tap", data: { button: next } };
    },
  },

  "wing-rush": {
    cls: "WingRushGame",
    // Flapping needs a faster cadence than the default 15–40 frames: 6–8
    // frames (100–133ms) is a fast human tap rhythm that never dips under
    // the 100ms anti-cheat line, and the null-poll gaps between climb
    // phases keep the interval stddev well above the metronomic threshold
    // (measured ~109ms over 40 runs). Tuned empirically at level 6 over
    // fixed seeds: 32/40 wins; wider spreads and fancier controllers
    // (velocity caps, MPC) all scored worse — same lesson as
    // games/scripts/wing-rush-bot-check.js, don't overcomplicate this.
    pace: [6, 2],
    makeDecide: () => {
      let started = false;
      return (g) => {
        const d = g.getState().display;
        const diff = g._getDifficulty();
        if (!started) { started = true; return { type: "tap", data: {} }; }
        const bird = d.bird;
        const next = d.pipes.find((p: any) => p.x + 60 >= bird.x);
        // Aim slightly below the gap center (flaps spike the bird upward,
        // so the hover point sits under the midline) at the position
        // predicted 2 frames out.
        const targetY = (next ? next.gapY + next.gapSize / 2 : 300) + 12;
        const pred = bird.y + bird.velY * 2 + 0.5 * diff.gravity * 4;
        if (pred > targetY) return { type: "tap", data: {} };
        return null;
      };
    },
  },

  "dino-sprint": {
    cls: "DinoSprintGame",
    makeDecide: () => {
      let started = false;
      return (g) => {
        const d = g.getState().display;
        if (!started) { started = true; return { type: "tap", data: {} }; }
        const diff = g._getDifficulty();
        const dino = d.dino;
        const next = (d.obstacles || []).find((o: any) => o.x + o.width >= dino.x);
        if (!next) return null;
        const grounded = Math.abs(dino.velY) < 0.5 && dino.y >= d.groundY - dino.radius - 0.5;
        if (!grounded) return null;
        const ascentFrames = Math.abs(diff.jumpVelocity) / diff.gravity;
        const framesToObstacle = (next.x - dino.x) / diff.speed;
        // Decision polls lag up to ~5 frames, so trigger slightly inside the
        // ascent window (same policy as games/scripts/dino-sprint-bot-check).
        if (framesToObstacle > 0 && framesToObstacle <= ascentFrames * 0.95) {
          return { type: "tap", data: {} };
        }
        return null;
      };
    },
  },

  "perfect-stack": {
    cls: "PerfectStackGame",
    makeDecide: () => (g) => {
      const s = g.getState();
      const d = s.display;
      if (d.stack.length === 0) return { type: "tap", data: {} }; // first block always lands full-width
      const prev = d.stack[d.stack.length - 1];
      const cur = d.currentBlock;
      const offset = Math.abs(cur.x - prev.x);
      const remaining = Math.max(1, s.targetScore - s.score);
      // Fire when alignment is inside tolerance. The tolerance balances two
      // failure modes: too loose bleeds width (the miss is subtracted from
      // the block) and the stack dies before target; too tight and polls
      // (every 2–4 frames while waiting) rarely land inside it. Budget the
      // remaining width across remaining locks, floored by what the poll
      // cadence can actually hit at the current speed.
      const tol = Math.max(d.currentSpeed * 0.8, (cur.width - 10) / (2 * remaining));
      if (offset <= tol) return { type: "tap", data: {} };
      return null;
    },
  },

  "helix-drop": {
    cls: "HelixDropGame",
    // Sparse inputs (a few keydown/keyup per platform) but the fall between
    // platforms is only ~15 frames — the post-pass keyup must land inside
    // it, so actions re-poll after 6–12 frames (100–200ms) instead of the
    // default 15–40.
    pace: [6, 6],
    makeDecide: () => {
      let holding = 0; // -1 = ArrowLeft (rotation decreases), +1 = ArrowRight
      const keyOf = (dir: number) => (dir < 0 ? "ArrowLeft" : "ArrowRight");
      /** Frames of rotation (dir) until the hazard arc no longer covers 0°. */
      const framesToExit = (center: number, width: number, rot: number, dir: number, r: number) => {
        for (let t = 0; t <= Math.ceil(360 / r) + 1; t++) {
          if (!inArc(0, center + rot + dir * r * t, width)) return t;
        }
        return Infinity;
      };
      return (g) => {
        const s = g.getState();
        const d = s.display;
        const idx = s.score; // platforms passed = index of the next platform
        if (idx >= d.platforms.length) return null;
        const p = d.platforms[idx];
        const diff = g._getDifficulty();
        const r = diff.rotationSpeed;
        const rot = d.helixRotation;
        const resting = d.ball.y >= p.y;

        if (resting) {
          // Rotate toward the gap from the side where the gap arrives
          // before the hazard (the hazard sits flush on one side of the
          // gap, so exactly one direction is safe).
          let dir = 1;
          let bestMargin = -Infinity;
          for (const cand of [1, -1]) {
            const tGap = framesUntilCovered(p.gapAngle, p.gapWidth, rot, cand, r);
            const tHaz = framesUntilCovered(p.hazardAngle, p.hazardWidth, rot, cand, r);
            const margin = tHaz - tGap;
            if (margin > bestMargin) { bestMargin = margin; dir = cand; }
          }
          if (holding === dir) return null;
          if (holding !== 0) {
            const k = keyOf(holding);
            holding = 0;
            return { type: "keyup", data: { key: k } };
          }
          holding = dir;
          return { type: "keydown", data: { key: keyOf(dir) } };
        }

        // Falling toward platform idx: the only lethal landing is on its
        // hazard arc, evaluated the tick the ball reaches p.y. Steer the
        // rotation to a hazard-free angle within the frames that remain.
        const framesLeft = Math.max(0, Math.floor((p.y - d.ball.y) / diff.dropSpeed));
        const hazardUnder = inArc(0, p.hazardAngle + rot, p.hazardWidth);
        if (!hazardUnder) {
          // Safe right now — freeze here (or stay frozen).
          if (holding !== 0) {
            const k = keyOf(holding);
            holding = 0;
            return { type: "keyup", data: { key: k } };
          }
          return null;
        }
        // Hazard under the ball: exit it the fastest way that fits the
        // remaining fall. Continuing the held direction costs nothing;
        // reversing (or starting) costs one action now.
        if (holding !== 0) {
          const ahead = framesToExit(p.hazardAngle, p.hazardWidth, rot, holding, r);
          if (ahead <= framesLeft) return null; // will clear it — keep holding
          // Can't clear ahead in time; a reversal only helps if the way
          // back is much shorter (we entered recently). Release now; the
          // next poll starts the reverse rotation.
          const back = framesToExit(p.hazardAngle, p.hazardWidth, rot, -holding, r);
          if (back < ahead) {
            const k = keyOf(holding);
            holding = 0;
            return { type: "keyup", data: { key: k } };
          }
          return null; // doomed either way — ride it out
        }
        const tRight = framesToExit(p.hazardAngle, p.hazardWidth, rot, 1, r);
        const tLeft = framesToExit(p.hazardAngle, p.hazardWidth, rot, -1, r);
        const dir = tRight <= tLeft ? 1 : -1;
        holding = dir;
        return { type: "keydown", data: { key: keyOf(dir) } };
      };
    },
  },

  "block-merge": {
    cls: "BlockMergeGame",
    // 2048-tier boards need ~1000 moves inside the 36000-frame cap: 8–18
    // frame gaps (133–300ms) is fast-but-human swiping.
    pace: [8, 10],
    makeDecide: () => (g) => {
      const d = g.getState().display;
      const dir = bmBestMove(d.grid);
      if (!dir) return null;
      return { type: "swipe", data: { direction: dir } };
    },
  },

  "sliding-puzzle": {
    cls: "SlidingPuzzleGame",
    makeDecide: () => {
      let plan: Pt[] | null = null;
      let i = 0;
      return (g) => {
        if (!plan) plan = solveSlidingPuzzle(g.getState().display.grid);
        if (i >= plan.length) return null;
        const t = plan[i++];
        return { type: "tap", data: { x: t.x, y: t.y } };
      };
    },
  },
};
