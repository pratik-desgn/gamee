#!/usr/bin/env node
// Copies the compiled games SDK (../games/dist) into src/gamesdk so the
// play page can import the exact same deterministic game modules the
// replay verifier and the games/playground dev tool use — src/gamesdk is
// generated (gitignored), not committed, same relationship the backend
// has to games/dist via its own Docker build stage.
import { existsSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', '..', 'games', 'dist');
const dest = path.resolve(here, '..', 'src', 'gamesdk');

if (!existsSync(src)) {
  console.error(
    `[copy-gamesdk] ${src} does not exist — run "npm run build" in games/ first.`
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-gamesdk] copied ${src} -> ${dest}`);
