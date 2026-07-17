/**
 * Offline coverage check for the e2e bots (e2e-bots.ts): runs every bot
 * against its real compiled game — the same modules the replay verifier
 * loads — at production difficulty, and asserts the properties the devnet
 * e2e depends on:
 *
 *   1. the bot actually wins (win rate per game/level over N seeds)
 *   2. the input log replays deterministically to the same score/won
 *      (what backend replay verification will do with it)
 *   3. finalScore() === getState().score (the settlement score-match)
 *   4. the log's timing passes the anti-cheat analyzer's rules
 *      (sub-100ms share, interval stddev, inputs/sec — mirrored from
 *      backend/internal/anticheat/analyzer.go)
 *
 * Run:  cd contracts && npx ts-node scripts/bots-offline-check.ts
 * Env:  SEEDS=<n per game/level, default 10>   GAMES=<comma list>
 *
 * Prereq: npx tsc in games/ (needs games/dist).
 */
import { BOTS, playBot, Rec } from "./e2e-bots";

const GAMES_DIST = `${__dirname}/../../games/dist/games`;
const SEEDS = parseInt(process.env.SEEDS ?? "10", 10);
const ONLY = process.env.GAMES?.split(",").map((s) => s.trim());

// Production difficulty per game: base_difficulty and max_difficulty from
// scripts/init-db.sql. Bots are checked at base and at the anti-cheat
// hardened level (base+3, clamped) — the two levels real sessions get.
const LEVELS: Record<string, { base: number; max: number }> = {
  "wing-rush":      { base: 6, max: 10 },
  "dino-sprint":    { base: 6, max: 8 },
  "block-merge":    { base: 7, max: 10 },
  "simon-pro":      { base: 7, max: 9 },
  "aim-master":     { base: 7, max: 9 },
  "perfect-stack":  { base: 6, max: 8 },
  "reaction-test":  { base: 6, max: 7 },
  "helix-drop":     { base: 8, max: 10 },
  "minefield":      { base: 8, max: 10 },
  "sliding-puzzle": { base: 7, max: 9 },
};

function replay(GameClass: any, seed: string, level: number, log: Rec[]) {
  const game = new GameClass();
  game.init(seed, { seed, level, params: {} });
  let i = 0;
  for (let frame = 0; frame < 60000 && !game.isFinished(); frame++) {
    while (i < log.length && log[i].frame === frame) {
      game.onInput(log[i]);
      i++;
    }
    game.tick();
  }
  return game.getState();
}

/** Mirror of backend/internal/anticheat/analyzer.go's hard rules. */
function antiCheatIssues(log: Rec[]): string[] {
  const issues: string[] = [];
  if (log.length < 3) return issues; // analyzer passes short logs
  const intervals: number[] = [];
  for (let i = 1; i < log.length; i++) {
    const df = log[i].frame - log[i - 1].frame;
    if (df > 0) intervals.push(df * 16.667);
  }
  if (intervals.length === 0) return issues;
  const sub100 = intervals.filter((iv) => iv < 100).length;
  if (sub100 / intervals.length > 0.5 && sub100 >= 5) issues.push("sub_100ms_reaction");
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const std = Math.sqrt(intervals.reduce((a, b) => a + (b - avg) ** 2, 0) / intervals.length);
  if (std < 30 && intervals.length >= 10) issues.push("metronomic_timing");
  const totalFrames = log[log.length - 1].frame - log[0].frame;
  if (totalFrames > 0) {
    const ips = log.length / ((totalFrames * 16.667) / 1000);
    if (ips > 15) issues.push("input_rate_exceeded");
  }
  return issues;
}

let failures = 0;

for (const [gameId, bot] of Object.entries(BOTS)) {
  if (ONLY && !ONLY.includes(gameId)) continue;
  const mod = require(`${GAMES_DIST}/${gameId}/index.js`);
  const GameClass = mod[bot.cls];
  const { base, max } = LEVELS[gameId];
  const hardened = Math.min(base + 3, max);
  for (const level of [...new Set([base, hardened])]) {
    let wins = 0;
    const problems: string[] = [];
    const t0 = Date.now();
    for (let s = 0; s < SEEDS; s++) {
      const seed = `botcheck_${gameId}_${level}_${s}`;
      const game = new GameClass();
      game.init(seed, { seed, level, params: {} });
      let log: Rec[];
      try {
        log = playBot(game, bot.makeDecide(), bot.pace);
      } catch (e: any) {
        problems.push(`seed ${s}: bot threw: ${e.message}`);
        continue;
      }
      const st = game.getState();
      if (st.won) wins++;
      if (game.finalScore() !== st.score) {
        problems.push(`seed ${s}: finalScore ${game.finalScore()} !== score ${st.score}`);
      }
      const re = replay(GameClass, seed, level, log);
      if (re.won !== st.won || re.score !== st.score) {
        problems.push(`seed ${s}: replay mismatch (live ${st.score}/${st.won} vs replay ${re.score}/${re.won})`);
      }
      if (st.won) {
        const ac = antiCheatIssues(log);
        if (ac.length) problems.push(`seed ${s}: anti-cheat would flag: ${ac.join(",")}`);
      }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const tag = level === base ? "base" : "hardened";
    console.log(`${gameId.padEnd(15)} level ${level} (${tag.padEnd(8)}): ${wins}/${SEEDS} won  [${secs}s]`);
    for (const p of problems) {
      console.log(`    FAIL ${p}`);
      failures++;
    }
    if (level === base && wins === 0) {
      console.log(`    FAIL no wins at production base difficulty`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall bots OK");
