#!/usr/bin/env node
// Empirical check for wing-rush difficulty tuning: a simple physically-
// motivated bot (flap whenever falling and below the next gap's center)
// plays every level across several seeds and reports win rate. Run after
// `npx tsc` in games/. Not a CI test — a one-off sanity check for when the
// difficulty curve changes.
const path = require('path');
const { GameLoop } = require(path.resolve(__dirname, '..', 'dist', 'sdk', 'engine.js'));
const mod = require(path.resolve(__dirname, '..', 'dist', 'games', 'wing-rush', 'index.js'));
const GameClass = mod.WingRushGame;

function playLevel(level, seed) {
  const game = new GameClass();
  const diff = { seed, level, params: {} };
  game.init(seed, diff);

  const loop = new GameLoop(game);
  loop.init(seed, diff);

  let frame = 0;
  const maxFrames = 3600; // 60s ceiling

  // First flap to start gravity (the bird holds at spawn until then).
  loop.enqueueInput({ frame: 0, type: 'tap', data: {}, time: 0 });

  while (!loop.isFinished() && frame < maxFrames) {
    const state = loop.getState();
    const display = state.display;
    const bird = display.bird;
    const next = display.pipes.find((p) => p.x + 60 >= bird.x);
    // No pipe visible yet (before the first spawns) — just hover near
    // mid-screen instead of free-falling into the ground while waiting.
    // Deliberately simple: flap whenever below the gap's center, no
    // velocity gate, no lookahead. Tried fancier prediction/lookahead
    // logic first and it scored *worse* — a naive bot beats an
    // over-engineered one here, so don't overcomplicate this.
    const targetY = next ? next.gapY + next.gapSize / 2 : 300;
    if (bird.y > targetY) {
      loop.enqueueInput({ frame, type: 'tap', data: {}, time: frame * 16 });
    }
    loop.stepForward();
    frame++;
  }

  return { won: loop.getState().won, score: loop.finalScore(), target: loop.getState().targetScore };
}

let totalRuns = 0;
let totalWins = 0;
for (let level = 1; level <= 10; level++) {
  let wins = 0;
  const seeds = 8;
  for (let s = 0; s < seeds; s++) {
    const r = playLevel(level, `wrbotcheck_${level}_${s}`);
    if (r.won) wins++;
    totalRuns++;
    if (r.won) totalWins++;
  }
  console.log(`level ${level}: ${wins}/${seeds} won`);
}
console.log(`\nTOTAL: ${totalWins}/${totalRuns} (${((totalWins / totalRuns) * 100).toFixed(0)}%)`);
