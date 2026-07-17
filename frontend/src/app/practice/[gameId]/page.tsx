'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { GAME_REGISTRY } from '@/lib/gameRegistry';
import { GAME_GUIDES } from '@/lib/gameGuides';
import { useGameCanvasInput } from '@/lib/useGameCanvasInput';
import type { TimestampedInput } from '@/types';
import type { JackpotGame } from '@/gamesdk/sdk/interface';
import type { Renderer } from '@/gamesdk/sdk/renderer';

// Free practice mode: runs the exact same game engine as the real /play
// page (see that file's header comment), but entirely client-side — no
// wallet, no ticket, no backend session, nothing recorded or submitted
// anywhere. It exists so a player can learn a game's feel and difficulty
// curve before spending a real ticket on it.
function randomSeed(): string {
  return 'practice_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const FRAME_MS = 1000 / 60;

export default function PracticePage() {
  const params = useParams();
  const router = useRouter();
  const gameId = params.gameId as string;
  const entry = GAME_REGISTRY[gameId];

  // The canvas must always be mounted (not gated behind `status`) — reading
  // canvasRef.current synchronously inside the same callback that flips
  // status away from 'idle' would still see null, since React hasn't
  // re-rendered yet. Conditionally mounting it was exactly why practice
  // got stuck on "Loading" forever: start() bailed out on a null ref
  // before ever calling entry.load(). It's just hidden via CSS pre-start.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<JackpotGame | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const rafRef = useRef(0);
  const frameRef = useRef(0);
  const lastTickRef = useRef(0);

  const [level, setLevel] = useState(5);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'finished'>('idle');
  const [score, setScore] = useState(0);
  const [targetScore, setTargetScore] = useState(0);
  const [won, setWon] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loop = useCallback(() => {
    const game = gameRef.current;
    const renderer = rendererRef.current;
    if (!game || !renderer) return;

    const now = performance.now();
    if (now - lastTickRef.current >= FRAME_MS) {
      lastTickRef.current += FRAME_MS;
      if (!game.isFinished()) {
        game.tick();
        frameRef.current++;
      }
    }

    const state = game.getState();
    renderer.render(state.display ?? {});
    setScore(state.score);

    if (game.isFinished()) {
      setWon(state.won === true);
      setStatus('finished');
      return;
    }

    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const start = useCallback(() => {
    if (!entry) return;
    setLoadError(null);

    const canvas = canvasRef.current;
    if (!canvas) {
      setLoadError('Canvas not ready — try again.');
      return;
    }
    setStatus('loading');
    canvas.width = entry.width;
    canvas.height = entry.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setLoadError('Could not get a 2D drawing context for this browser.');
      setStatus('idle');
      return;
    }

    entry.load().then(({ Game, Renderer: RendererClass }) => {
      const seed = randomSeed();
      const game = new Game();
      game.init(seed, { seed, level, params: {} });
      gameRef.current = game;
      rendererRef.current = new RendererClass(ctx, entry.width, entry.height);
      frameRef.current = 0;
      lastTickRef.current = performance.now();
      setTargetScore(game.getState().targetScore);
      setScore(0);
      setStatus('playing');
      rafRef.current = requestAnimationFrame(loop);
    }).catch((err) => {
      setLoadError(err instanceof Error ? err.message : `Failed to load "${gameId}"`);
      setStatus('idle');
    });
  }, [entry, gameId, level, loop]);

  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const sendInput = useCallback((partial: Omit<TimestampedInput, 'frame' | 'time'>) => {
    const game = gameRef.current;
    if (!game || game.isFinished() || status !== 'playing') return;
    game.onInput({ frame: frameRef.current, time: Date.now(), ...partial });
  }, [status]);

  // Input wiring (mouse + touch + keyboard) is shared with /play — see
  // lib/useGameCanvasInput.ts.
  const getEntry = useCallback(() => entry ?? null, [entry]);
  const getDisplay = useCallback(
    () => (gameRef.current?.getState().display ?? {}) as Record<string, unknown>,
    [],
  );
  useGameCanvasInput({
    canvasRef,
    getEntry,
    getDisplay,
    enabled: status === 'playing',
    sendInput,
  });

  const guide = GAME_GUIDES[gameId];

  if (!entry) {
    return (
      <div className="h-[100dvh] overflow-hidden pt-20 flex items-center justify-center px-4">
        <div className="glass rounded-2xl p-8 text-center max-w-md">
          <p className="text-gamee-muted">Unknown game &quot;{gameId}&quot;.</p>
          <Link href="/#games" className="mt-4 inline-block text-purple-400 hover:text-purple-300">← Back to games</Link>
        </div>
      </div>
    );
  }

  return (
    // h-screen + overflow-hidden: the whole game (header, canvas, footer)
    // must fit in one viewport with no page scroll — min-h-screen would
    // let a tall canvas (some games are 600px) push the footer below the
    // fold. The canvas itself is capped by CSS (max-h-*, w-auto) rather
    // than its width/height attributes, which stay at the game's native
    // resolution — click coordinates are already computed as a ratio via
    // getBoundingClientRect(), so scaling the displayed size down doesn't
    // affect input accuracy.
    // h-[100dvh], not h-screen: 100vh overflows under mobile browser
    // chrome (URL bar) and pushed the footer off-screen on phones.
    <div className="h-[100dvh] overflow-hidden pt-20 pb-3 flex flex-col items-center justify-center px-4">
      <div className="glass rounded-2xl p-4 sm:p-5 w-full max-w-2xl flex flex-col gap-3 max-h-full">
        <div className="flex items-center justify-between gap-3 shrink-0">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-xs font-bold text-cyan-300">
            🕹️ Practice — no ticket, no payout
          </span>
          <div className="text-right text-sm">
            <div className="text-gamee-muted">{entry.scoreLabel ?? 'Score'}: <span className="text-purple-400 font-bold tabular-nums">{score}</span></div>
            <div className="text-gamee-muted">{entry.targetLabel ?? 'Target'}: <span className="text-cyan-400 font-bold tabular-nums">{targetScore}</span></div>
          </div>
        </div>

        {status === 'idle' && (
          <div className="text-center py-4 space-y-4 shrink-0 overflow-y-auto">
            <h1 className="text-xl font-bold">
              {guide ? `${guide.icon} ${guide.name}` : gameId.replace(/-/g, ' ')}
            </h1>
            {guide && (
              <div className="max-w-md mx-auto space-y-2 text-left">
                <p className="text-sm text-gamee-muted leading-relaxed">{guide.goal}</p>
                <div className="text-xs text-gamee-muted space-y-1 bg-white/5 border border-gamee-border rounded-lg p-3">
                  <div className="hidden sm:block">🖥️ {guide.controls.desktop}</div>
                  <div className="sm:hidden">📱 {guide.controls.mobile}</div>
                  {guide.tip && <div className="pt-1 border-t border-gamee-border/60">💡 {guide.tip}</div>}
                </div>
              </div>
            )}
            <div>
              <label htmlFor="level" className="text-sm text-gamee-muted block mb-2">
                Difficulty level: <span className="text-gamee-text font-bold tabular-nums">{level}</span> / 10
              </label>
              <input
                id="level"
                type="range"
                min={1}
                max={10}
                value={level}
                onChange={(e) => setLevel(Number(e.target.value))}
                className="w-full max-w-xs mx-auto accent-purple-500"
              />
            </div>
            <button
              onClick={start}
              className="px-8 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 transition-all"
            >
              ▶ Start Practicing
            </button>
          </div>
        )}

        {loadError && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-400 shrink-0">⚠️ {loadError}</div>
        )}

        <canvas
          ref={canvasRef}
          width={entry.width}
          height={entry.height}
          tabIndex={0}
          className={`mx-auto max-w-full w-auto rounded-xl border border-gamee-border bg-[#1a1a2e] cursor-pointer shadow-inner min-h-0 flex-1 object-contain ${
            status === 'idle' ? 'hidden' : ''
          }`}
          style={{ maxHeight: '52vh', touchAction: 'none' }}
        />

        {status === 'finished' && (
          <div className={`p-4 rounded-xl text-center animate-fade-in-up shrink-0 ${won ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
            <div className="text-2xl mb-1">{won ? '🎉' : '🙂'}</div>
            <h2 className="text-base font-bold">{won ? 'You beat the target!' : 'Didn’t reach the target this time'}</h2>
            <p className="text-gamee-muted text-xs mt-1">Score {score} / {targetScore} at level {level}</p>
            <div className="mt-3 flex gap-2.5 justify-center flex-wrap">
              <button
                onClick={start}
                className="px-5 py-2 rounded-xl border border-gamee-border font-bold text-sm hover:border-cyan-500/50 hover:text-cyan-400 transition-all"
              >
                🔁 Try Again
              </button>
              <button
                onClick={() => router.push('/ticket')}
                className="px-5 py-2 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold text-sm shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 transition-all"
              >
                🎮 Play for Real
              </button>
            </div>
          </div>
        )}

        <div className="text-center text-xs text-gamee-muted shrink-0">
          {status === 'playing' && guide ? (
            <>
              <span className="hidden sm:inline">🖥️ {guide.controls.desktop}</span>
              <span className="sm:hidden">📱 {guide.controls.mobile}</span>
            </>
          ) : status === 'loading' ? 'Loading…' : ''}
        </div>

        <div className="text-center shrink-0">
          <Link href="/#games" className="text-xs text-gamee-muted hover:text-purple-400 transition-colors">← Back to all games</Link>
        </div>
      </div>
    </div>
  );
}
