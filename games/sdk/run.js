#!/usr/bin/env node
/**
 * GAMEE Replay Verifier — Entry point called by the Go backend.
 *
 * Usage:
 *   node run.js --input /tmp/verifier-input-xxxxx.json
 *
 * Input file format (VerifierInput):
 * {
 *   "session_id": "uuid",
 *   "game_id": "wing-rush",
 *   "seed": "0xabc123...",
 *   "difficulty": { "level": 3, "params": { "gapSize": 155, "speed": 3.5 } },
 *   "input_log": [{ "frame": 0, "type": "tap", "data": {}, "time": 1234 }, ...],
 *   "client_score": 185,
 *   "target_score": 150
 * }
 *
 * Output (stdout, JSON):
 * { "verified_score": 185, "duration_ms": 12, "error": null }
 */

const fs = require('fs');
const path = require('path');

// Import the TypeScript verifier — expect it as a sibling directory
const verifierPath = path.join(__dirname, '..', 'dist', 'sdk', 'verifier.js');

function parseArgs() {
  const args = process.argv.slice(2);
  const inputFile = args.indexOf('--input');
  if (inputFile === -1 || !args[inputFile + 1]) {
    console.error(JSON.stringify({ error: 'Missing --input argument' }));
    process.exit(1);
  }
  return args[inputFile + 1];
}

async function main() {
  const inputFile = parseArgs();

  // Read input
  let raw;
  try {
    raw = fs.readFileSync(inputFile, 'utf-8');
  } catch (err) {
    console.log(JSON.stringify({ verified_score: 0, duration_ms: 0, error: `Cannot read input file: ${err.message}` }));
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    console.log(JSON.stringify({ verified_score: 0, duration_ms: 0, error: `Invalid JSON input: ${err.message}` }));
    process.exit(0);
  }

  // A missing compiled module means we cannot re-simulate. Never trust the
  // client score in that case — emit verdict "unverified" so the backend
  // refuses to pay out. The Go worker treats "unverified" as non-winning.
  const unverified = (msg) =>
    JSON.stringify({ verified_score: 0, verdict: 'unverified', duration_ms: 0, error: msg || null });

  // Try to load the compiled TypeScript verifier.
  let replay;
  try {
    replay = require(verifierPath).replay;
  } catch {
    console.log(unverified('compiled SDK verifier not found — run `npm run build` in games/'));
    process.exit(0);
  }

  let GameClass;
  try {
    const gameModule = require(path.join(__dirname, '..', 'dist', 'games', input.game_id, 'index.js'));
    // Pick the export that implements the JackpotGame interface. Games export
    // tuning constants alongside the class and have no default export, so
    // "default || first key" (the old logic) always grabbed a constant and
    // made every real verification fail closed as "unverified".
    const isGameClass = (v) =>
      typeof v === 'function' && v.prototype &&
      typeof v.prototype.init === 'function' &&
      typeof v.prototype.tick === 'function' &&
      typeof v.prototype.getState === 'function';
    GameClass = isGameClass(gameModule.default)
      ? gameModule.default
      : Object.values(gameModule).find(isGameClass);
  } catch {
    console.log(unverified(`game module not found for: ${input.game_id}`));
    process.exit(0);
  }

  if (!GameClass || typeof GameClass !== 'function') {
    console.log(unverified(`no game class exported for: ${input.game_id}`));
    process.exit(0);
  }

  const game = new GameClass();
  const difficultyParams = {
    seed: input.seed,
    level: input.difficulty?.level || 3,
    params: input.difficulty?.params || {},
  };

  const startTime = performance.now();

  // Run the replay via the SDK verifier.
  const result = replay(
    game,
    { inputs: input.input_log?.map((log) => ({
      frame: log.frame,
      type: log.type || 'tap',
      data: log.data || {},
      time: log.time || 0,
    })) || [] },
    input.seed,
    difficultyParams,
    { maxFrames: 60000, speedMultiplier: 10 }
  );

  const elapsed = Math.round(performance.now() - startTime);
  result.duration_ms = elapsed;
  result.error = null;

  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.log(JSON.stringify({ verified_score: 0, duration_ms: 0, error: err.message }));
  process.exit(0);
});
