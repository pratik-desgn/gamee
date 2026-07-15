#!/usr/bin/env node
// Empirical check for the dino-sprint jump-clearance rebalance: a simple
// physically-motivated bot (jump when the next obstacle is one ascent-time
// away) plays every level across several seeds and reports win rate. Run
// after `npx tsc` in games/. Not a CI test — a one-off sanity check kept
// around in case the difficulty curve changes again.
const path = require('path');
const { GameLoop } = require(path.resolve(__dirname, '..', 'dist', 'sdk', 'engine.js'));
const mod = require(path.resolve(__dirname, '..', 'dist', 'games', 'dino-sprint', 'index.js'));
const GameClass = mod.DinoSprintGame;

function playLevel(level, seed) {
  const game = new GameClass();
  const diff = { seed, level, params: {} };
  game.init(seed, diff);
  const d = game._getDifficulty ? game._getDifficulty() : null;

  const loop = new GameLoop(game);
  loop.init(seed, diff);

  let frame = 0;
  const maxFrames = 3600; // 60s ceiling for the bot run

  // The dino holds at the start line until the first jump (see
  // DinoSprintGame's `started` gate) — send one unconditionally so
  // obstacles actually start spawning, same as a real player's first tap.
  loop.enqueueInput({ frame: 0, type: 'tap', data: {}, time: 0 });

  while (!loop.isFinished() && frame < maxFrames) {
    const state = loop.getState();
    const display = state.display;
    const obstacles = display.obstacles;
    const dino = display.dino;

    if (obstacles && obstacles.length > 0 && d) {
      const ascentFrames = Math.abs(d.jumpVelocity) / d.gravity;
      const next = obstacles.find((o) => o.x + o.width >= dino.x);
      if (next) {
        const distanceToObstacle = next.x - dino.x;
        const framesToObstacle = distanceToObstacle / d.speed;
        const grounded = dino.velY === 0 || dino.y >= (600 - 50 - dino.radius - 0.01);
        if (grounded && framesToObstacle <= ascentFrames && framesToObstacle > 0) {
          loop.enqueueInput({ frame, type: 'tap', data: {}, time: frame * 16 });
        }
      }
    }
    loop.stepForward();
    frame++;
  }

  return { won: loop.getState().won, score: loop.finalScore(), target: loop.getState().targetScore, frames: frame };
}

let totalRuns = 0;
let totalWins = 0;
for (let level = 1; level <= 10; level++) {
  let wins = 0;
  const seeds = 8;
  for (let s = 0; s < seeds; s++) {
    const r = playLevel(level, `botcheck_${level}_${s}`);
    if (r.won) wins++;
    totalRuns++;
    if (r.won) totalWins++;
  }
  console.log(`level ${level}: ${wins}/${seeds} won`);
}
console.log(`\nTOTAL: ${totalWins}/${totalRuns} (${((totalWins / totalRuns) * 100).toFixed(0)}%)`);
