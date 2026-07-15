'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { GAME_REGISTRY } from '@/lib/gameRegistry';
import type { TimestampedInput } from '@/types';
import type { JackpotGame } from '@/gamesdk/sdk/interface';
import type { Renderer } from '@/gamesdk/sdk/renderer';

// The play page runs the actual deterministic game client-side (same
// modules the backend's replay verifier runs — see lib/gameRegistry.ts) so
// the player gets real, responsive gameplay and a real score, rather than a
// cosmetic placeholder. The WebSocket is used only to learn which game/
// seed/difficulty this session was assigned (the one thing a fresh page
// load of /play/:sessionId can't otherwise recover) — it is NOT the
// authority on score, frame, or completion. That authority is this page's
// own local JackpotGame instance, exactly mirroring how
// games/playground/main.ts and the server's replay worker both drive the
// same interface. See gamesession.HandleWebSocket's tick-loop comment
// (backend/internal/gamesession/service.go) for why the server's own
// per-tick messages are a non-authoritative preview only.
export default function PlayPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.sessionId as string;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080';

  const gameRef = useRef<JackpotGame | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const entryRef = useRef<(typeof GAME_REGISTRY)[string] | null>(null);
  const rafRef = useRef(0);
  const frameRef = useRef(0);
  const lastTickRef = useRef(0);
  const inputsRef = useRef<TimestampedInput[]>([]);
  const finishedRef = useRef(false);

  const [gameId, setGameId] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [targetScore, setTargetScore] = useState(0);
  const [gameState, setGameState] = useState<'connecting' | 'loading' | 'playing' | 'finished'>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);

  const finishGame = useCallback(async (finalScore: number) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setGameState('finished');
    try {
      const res = await apiClient.finishSession(sessionId, inputsRef.current, finalScore);
      // The only success response HandleFinish ever returns is
      // {verdict:"pending", queued:true} — `verdict` is never literally
      // "queued" (that was checking a value the field can't hold, so this
      // redirect never fired and the page sat on "Submitting…" forever).
      if (res.queued) {
        setTimeout(() => router.push(`/result/${sessionId}`), 1500);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to submit result');
    }
  }, [sessionId, router]);

  const FRAME_MS = 1000 / 60;

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

    if (game.isFinished() && !finishedRef.current) {
      finishGame(game.finalScore());
      return;
    }

    rafRef.current = requestAnimationFrame(loop);
  }, [FRAME_MS, finishGame]);

  const sendInput = useCallback((partial: Omit<TimestampedInput, 'frame' | 'time'>) => {
    const game = gameRef.current;
    if (!game || game.isFinished() || finishedRef.current) return;
    const input: TimestampedInput = {
      frame: frameRef.current,
      time: Date.now(),
      ...partial,
    };
    inputsRef.current.push(input);
    game.onInput(input);
    // Best-effort cosmetic broadcast — the WS tick loop is a non-
    // authoritative preview (see file header); losing this send changes
    // nothing about correctness.
    wsRef.current?.send(JSON.stringify({
      action: 'input',
      frame: input.frame,
      input_type: input.type,
      data: input.data,
      time: input.time,
    }));
  }, []);

  // WebSocket: only used to learn game_id/seed/difficulty for this
  // session. Its per-tick 'state'/'result' messages are ignored — see file
  // header for why.
  useEffect(() => {
    const token = apiClient.getToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${wsUrl}/api/v1/session/${sessionId}/play${tokenParam}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'init') {
        setGameId(msg.game_id);
        setTargetScore(msg.target_score);
        loadAndStartGame(msg.game_id, msg.seed, msg.difficulty);
      }
      // 'state'/'result'/'pong' intentionally ignored — see file header.
    };
    ws.onerror = () => setLoadError('Connection error — try refreshing.');

    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const loadAndStartGame = async (id: string, seed: string, difficulty: { level: number; params: Record<string, number> }) => {
    setGameState('loading');
    const entry = GAME_REGISTRY[id];
    if (!entry) {
      setLoadError(`Unknown game "${id}" — this build's game registry is out of date.`);
      return;
    }
    entryRef.current = entry;

    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = entry.width;
    canvas.height = entry.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    try {
      const { Game, Renderer: RendererClass } = await entry.load();
      const game = new Game();
      game.init(seed, { seed, level: difficulty.level, params: difficulty.params ?? {} });
      gameRef.current = game;
      rendererRef.current = new RendererClass(ctx, entry.width, entry.height);
      frameRef.current = 0;
      lastTickRef.current = performance.now();
      setGameState('playing');
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : `Failed to load game "${id}"`);
    }
  };

  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Input wiring: click/tap for 'pixel' and 'grid' games, window-level
  // keyboard for every game (space/arrows/number keys) — mirrors
  // games/playground/main.ts's input handling exactly, since that's the
  // same interface every game's onInput expects.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMouseDown = (e: MouseEvent) => {
      const entry = entryRef.current;
      if (!entry || entry.clickMode === 'none' || gameState !== 'playing') return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const py = ((e.clientY - rect.top) / rect.height) * canvas.height;

      if (entry.clickMode === 'pixel') {
        sendInput({ type: 'click', data: { x: px, y: py } });
      } else if (entry.clickMode === 'grid') {
        const display = (gameRef.current?.getState().display ?? {}) as Record<string, unknown>;
        const gridSize = (display.gridSize as number) ?? 4;
        const cell = canvas.width / gridSize;
        sendInput({ type: 'click', data: { x: Math.floor(px / cell), y: Math.floor(py / cell) } });
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (gameState !== 'playing') return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
      sendInput({ type: 'keydown', data: { key: e.key } });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (gameState !== 'playing') return;
      sendInput({ type: 'keyup', data: { key: e.key } });
    };

    // Touch fallback for keyboard-only games (see GameEntry.touch): sends
    // the same keydown/keyup inputs as the keyboard path, so the recorded
    // input log replays identically server-side.
    let heldKey: string | null = null;
    let swipeStart: { x: number; y: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const entry = entryRef.current;
      if (!entry?.touch || gameState !== 'playing') return;
      e.preventDefault(); // no scroll, no synthetic mousedown
      const t = e.touches[0];
      if (entry.touch === 'hold-lr') {
        const rect = canvas.getBoundingClientRect();
        heldKey = t.clientX - rect.left < rect.width / 2 ? 'ArrowLeft' : 'ArrowRight';
        sendInput({ type: 'keydown', data: { key: heldKey } });
      } else {
        swipeStart = { x: t.clientX, y: t.clientY };
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!entryRef.current?.touch) return;
      e.preventDefault();
      if (heldKey) {
        sendInput({ type: 'keyup', data: { key: heldKey } });
        heldKey = null;
      }
      if (swipeStart) {
        const t = e.changedTouches[0];
        const dx = t.clientX - swipeStart.x;
        const dy = t.clientY - swipeStart.y;
        swipeStart = null;
        if (Math.max(Math.abs(dx), Math.abs(dy)) >= 24) {
          const key = Math.abs(dx) > Math.abs(dy)
            ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft')
            : (dy > 0 ? 'ArrowDown' : 'ArrowUp');
          sendInput({ type: 'keydown', data: { key } });
          sendInput({ type: 'keyup', data: { key } });
        }
      }
    };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [gameState, sendInput]);

  const entry = entryRef.current;

  return (
    // h-screen + overflow-hidden: the whole game (header, canvas, footer)
    // must fit in one viewport with no page scroll — min-h-screen let a
    // tall canvas (some games are 600px) push content below the fold. The
    // canvas is capped via CSS (max-height, w-auto) rather than its
    // width/height attributes, which stay at the game's native resolution
    // — click coordinates are already a ratio via getBoundingClientRect(),
    // so scaling the displayed size down doesn't affect input accuracy.
    <div className="h-screen overflow-hidden pt-20 pb-3 flex flex-col items-center justify-center px-4">
      <div className="glass rounded-2xl p-4 sm:p-5 w-full max-w-2xl flex flex-col gap-3 max-h-full">
        <div className="flex justify-between items-center gap-3 shrink-0">
          <h1 className="text-xl font-bold truncate">{gameId || 'Loading...'}</h1>
          <div className="flex items-center gap-3 shrink-0">
            {(gameState === 'connecting' || gameState === 'loading') && (
              <span className="text-xs font-semibold text-gamee-muted animate-pulse">
                {gameState === 'connecting' ? 'Connecting…' : 'Loading game…'}
              </span>
            )}
            <div className="text-right">
              <div className="text-sm text-gamee-muted">
                {entry?.scoreLabel ?? 'Score'}: <span className="text-purple-400 font-bold tabular-nums">{score}</span>
              </div>
              <div className="text-sm text-gamee-muted">
                {entry?.targetLabel ?? 'Target'}: <span className="text-cyan-400 font-bold tabular-nums">{targetScore}</span>
              </div>
            </div>
          </div>
        </div>

        {loadError && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-400 shrink-0">
            ⚠️ {loadError}
          </div>
        )}

        <canvas
          ref={canvasRef}
          width={entry?.width ?? 400}
          height={entry?.height ?? 400}
          className="mx-auto max-w-full w-auto rounded-xl border border-gamee-border bg-[#1a1a2e] cursor-pointer shadow-inner min-h-0 flex-1 object-contain"
          style={{ maxHeight: '58vh' }}
          tabIndex={0}
        />

        {gameState === 'finished' && !loadError && (
          <div className="p-4 rounded-xl text-center bg-white/5 border border-gamee-border animate-fade-in-up shrink-0">
            <div className="text-2xl mb-1">🎮</div>
            <h2 className="text-base font-bold">Final score: {score}</h2>
            <p className="text-gamee-muted text-xs mt-1 animate-pulse">
              Submitting for verification…
            </p>
          </div>
        )}

        <div className="text-center text-xs text-gamee-muted shrink-0">
          {gameState === 'playing'
            ? entry?.clickMode === 'none'
              ? entry?.touch === 'hold-lr'
                ? 'Arrow keys — or hold the left/right side of the board'
                : entry?.touch === 'swipe'
                  ? 'Arrow keys — or swipe on the board'
                  : 'Use your keyboard to play'
              : 'Click/tap the board, or use your keyboard'
            : gameState === 'finished'
              ? 'Verifying your result…'
              : 'Setting up your session…'}
        </div>
      </div>
    </div>
  );
}
