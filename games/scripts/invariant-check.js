#!/usr/bin/env node
/**
 * invariant-check.js — cross-game invariant + fuzz harness.
 *
 * Complements the per-game unit suites: instead of testing each game's own
 * rules, it hammers every compiled game through the exact machinery the
 * replay verifier uses (GameLoop from dist/sdk) and asserts the properties
 * the *platform* depends on for money decisions:
 *
 *   1. Termination  — every run finishes within the verifier's 60k-frame
 *                     budget (a non-terminating game = every session
 *                     unverifiable = no payout ever).
 *   2. No free wins — a no-input run must never end won=true.
 *   3. Score parity — finalScore() === getState().score at finish (the
 *                     reaction-test bug class: client and verifier must
 *                     score on the same scale).
 *   4. Determinism  — identical seed+level+inputs → identical score, won,
 *                     and end frame (twice, on fresh instances).
 *   5. Seed matters — across many seeds at least some variation appears in
 *                     the run outcome for randomness-driven games.
 *   6. Fuzz safety  — garbage input (unknown types, NaN/±Infinity coords,
 *                     huge/negative/out-of-order frames, junk keys) must
 *                     never throw, never hang, and never produce a win by
 *                     accident.
 *   7. Level clamps — init at level 0 / -3 / 99 must not throw (the Go
 *                     engine clamps, but a raw replay input file may not).
 *
 * Usage: node scripts/invariant-check.js   (from games/, after `npx tsc`)
 * Exit 0 = all invariants hold; nonzero = failures printed.
 */

const path = require('path');
const fs = require('fs');

const DIST = path.join(__dirname, '..', 'dist');
const GAMES_DIR = path.join(DIST, 'games');
const { GameLoop } = require(path.join(DIST, 'sdk', 'engine.js'));

// Same selection rule as sdk/run.js: the export whose prototype implements
// the JackpotGame interface.
function loadGameClass(gameId) {
  const mod = require(path.join(GAMES_DIR, gameId, 'index.js'));
  for (const v of Object.values(mod)) {
    if (
      typeof v === 'function' &&
      v.prototype &&
      typeof v.prototype.init === 'function' &&
      typeof v.prototype.tick === 'function' &&
      typeof v.prototype.getState === 'function' &&
      typeof v.prototype.finalScore === 'function'
    ) {
      return v;
    }
  }
  throw new Error(`no JackpotGame export found for ${gameId}`);
}

// Small deterministic RNG for reproducible fuzz logs.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLAUSIBLE_TYPES = ['tap', 'click', 'keydown', 'keyup', 'swipe', 'release'];
const KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'a', 'Enter'];

function plausibleLog(rng, count) {
  const inputs = [];
  let frame = 0;
  for (let i = 0; i < count; i++) {
    frame += 1 + Math.floor(rng() * 30);
    inputs.push({
      frame,
      type: PLAUSIBLE_TYPES[Math.floor(rng() * PLAUSIBLE_TYPES.length)],
      data: {
        x: Math.floor(rng() * 400),
        y: Math.floor(rng() * 600),
        key: KEYS[Math.floor(rng() * KEYS.length)],
        row: Math.floor(rng() * 12),
        col: Math.floor(rng() * 12),
        index: Math.floor(rng() * 9),
        direction: ['up', 'down', 'left', 'right'][Math.floor(rng() * 4)],
      },
      time: frame * 16,
    });
  }
  return { inputs };
}

function garbageLog(rng, count) {
  const junkTypes = ['', 'null', '__proto__', 'constructor', 'TAP', 'x'.repeat(500), '🎰', 'undefined'];
  const junkVals = [NaN, Infinity, -Infinity, -1e18, 1e18, 0.5, -0, null, 'str', {}, [], true];
  const inputs = [];
  for (let i = 0; i < count; i++) {
    const pick = () => junkVals[Math.floor(rng() * junkVals.length)];
    inputs.push({
      // huge, negative, and non-monotonic frames on purpose
      frame: [0, -5, 1e9, 42, 41, NaN][Math.floor(rng() * 6)],
      type: rng() < 0.5
        ? junkTypes[Math.floor(rng() * junkTypes.length)]
        : PLAUSIBLE_TYPES[Math.floor(rng() * PLAUSIBLE_TYPES.length)],
      data: { x: pick(), y: pick(), key: pick(), row: pick(), col: pick(), index: pick(), direction: pick() },
      time: pick(),
    });
  }
  return { inputs };
}

function runOnce(GameClass, seed, level, log) {
  const loop = new GameLoop(new GameClass());
  loop.init(seed, { seed, level, params: {} });
  const frames = loop.runFromLog(log, 60_000);
  const finished = loop.isFinished();
  const state = loop.getState();
  return {
    finished,
    frames,
    score: finished ? loop.finalScore() : null,
    stateScore: state.score,
    won: state.won === true,
  };
}

const gameIds = fs.readdirSync(GAMES_DIR).filter((d) =>
  fs.existsSync(path.join(GAMES_DIR, d, 'index.js')) &&
  (!process.argv[2] || d === process.argv[2]));

const failures = [];
const notes = [];
let checks = 0;

function fail(game, invariant, detail) {
  failures.push(`${game} [${invariant}] ${detail}`);
}

for (const id of gameIds) {
  const GameClass = loadGameClass(id);

  // 1+2+3: no-input termination / no free wins / score parity, levels 1..10 × 5 seeds
  for (let level = 1; level <= 10; level++) {
    for (let s = 0; s < 5; s++) {
      const seed = `vrf_noinput_${id}_${level}_${s}`;
      let r;
      try {
        r = runOnce(GameClass, seed, level, { inputs: [] });
      } catch (e) {
        fail(id, 'no-input crash', `level=${level} seed=${seed}: ${e.message}`);
        continue;
      }
      checks++;
      if (!r.finished) fail(id, 'termination', `no-input run did not finish in 60k frames (level=${level} seed=${seed})`);
      if (r.won) fail(id, 'free win', `no-input run ended won=true (level=${level} seed=${seed} score=${r.score})`);
      if (r.finished && r.score !== r.stateScore)
        fail(id, 'score parity', `finalScore()=${r.score} !== getState().score=${r.stateScore} (level=${level} seed=${seed})`);
      if (r.finished && (!Number.isFinite(r.score) || r.score < 0))
        fail(id, 'score sanity', `finalScore()=${r.score} (level=${level} seed=${seed})`);
    }
  }

  // 4: determinism with plausible input logs, 3 (seed × log) pairs × levels {1, base-ish 6, 10}
  for (const level of [1, 6, 10]) {
    for (let s = 0; s < 3; s++) {
      const seed = `vrf_det_${id}_${level}_${s}`;
      const log = plausibleLog(mulberry32(level * 1000 + s), 400);
      let a, b;
      try {
        a = runOnce(GameClass, seed, level, log);
        b = runOnce(GameClass, seed, level, log);
      } catch (e) {
        fail(id, 'plausible-input crash', `level=${level} seed=${seed}: ${e.message}`);
        continue;
      }
      checks++;
      if (a.finished !== b.finished || a.score !== b.score || a.won !== b.won || a.frames !== b.frames)
        fail(id, 'determinism', `same seed+log diverged: ${JSON.stringify(a)} vs ${JSON.stringify(b)} (level=${level} seed=${seed})`);
      if (a.finished && a.score !== a.stateScore)
        fail(id, 'score parity', `with inputs: finalScore()=${a.score} !== state.score=${a.stateScore} (level=${level} seed=${seed})`);
      if (!a.finished) fail(id, 'termination', `plausible-input run did not finish (level=${level} seed=${seed})`);
    }
  }

  // 5: seed sensitivity — over 12 seeds (same empty log), outcomes should not
  // ALL be identical for randomness-driven games. Deterministic-layout games
  // may legitimately tie (all losses at score 0), so this is a note, not a failure.
  {
    const outcomes = new Set();
    for (let s = 0; s < 12; s++) {
      try {
        const r = runOnce(GameClass, `vrf_seed_${id}_${s}`, 6, { inputs: [] });
        outcomes.add(`${r.score}|${r.frames}`);
      } catch { /* already reported above */ }
    }
    if (outcomes.size === 1) notes.push(`${id}: all 12 no-input seeds gave identical (score|endframe) ${[...outcomes][0]} — fine if the loss condition is time/input-based, worth a glance otherwise`);
    checks++;
  }

  // 6: fuzz — garbage input must not throw, hang, or win. 6 logs × levels {1,10}
  for (const level of [1, 10]) {
    for (let s = 0; s < 6; s++) {
      const seed = `vrf_fuzz_${id}_${level}_${s}`;
      const log = garbageLog(mulberry32(0xf00d + level * 100 + s), 300);
      let r;
      try {
        r = runOnce(GameClass, seed, level, log);
      } catch (e) {
        fail(id, 'fuzz crash', `level=${level} seed=${seed}: ${e.stack.split('\n')[0]}`);
        continue;
      }
      checks++;
      if (!r.finished) fail(id, 'fuzz hang', `garbage log ran past 60k frames (level=${level} seed=${seed})`);
      if (r.won) fail(id, 'fuzz win', `garbage input produced won=true (level=${level} seed=${seed} score=${r.score})`);
      if (r.finished && r.score !== r.stateScore)
        fail(id, 'score parity', `fuzz: finalScore()=${r.score} !== state.score=${r.stateScore} (level=${level} seed=${seed})`);
    }
  }

  // 7: out-of-range levels must not throw (raw replay inputs may carry them)
  for (const level of [0, -3, 99]) {
    try {
      runOnce(GameClass, `vrf_clamp_${id}_${level}`, level, { inputs: [] });
      checks++;
    } catch (e) {
      fail(id, 'level clamp', `init/tick threw at level=${level}: ${e.message}`);
    }
  }

  process.stderr.write(`checked ${id}\n`);
}

console.log(`\n${checks} invariant groups checked across ${gameIds.length} games`);
for (const n of notes) console.log(`NOTE: ${n}`);
if (failures.length) {
  console.log(`\n${failures.length} FAILURES:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('ALL INVARIANTS HOLD');
