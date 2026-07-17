'use client';

import { useEffect, type RefObject } from 'react';
import type { GameEntry } from '@/lib/gameRegistry';

export interface GameInputPartial {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Shared canvas input wiring for /play and /practice — one place that
 * turns mouse, touch, and keyboard events into game inputs, so both pages
 * (and desktop + mobile) always produce the same input log the server's
 * replay verifier expects.
 *
 * Touch is handled directly (touchstart with preventDefault), never via
 * the browser's synthetic mouse events — those arrive late, double-fire,
 * and let double-tap zoom / scroll gestures eat gameplay taps:
 *   - click-driven games (clickMode 'pixel'/'grid', or a mapClick hit
 *     test): a tap fires the same click the mouse path sends
 *   - 'hold-lr' games: touching the left/right half holds ArrowLeft/Right
 *     until the finger lifts
 *   - 'swipe' games: a swipe sends one arrow-key press in its direction
 */
export function useGameCanvasInput(opts: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Called per event — lets /play resolve its entry from a ref. */
  getEntry: () => GameEntry | null;
  /** Current display state, for grid sizing and mapClick hit tests. */
  getDisplay: () => Record<string, unknown>;
  enabled: boolean;
  sendInput: (partial: GameInputPartial) => void;
}) {
  const { canvasRef, getEntry, getDisplay, enabled, sendInput } = opts;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Shared by the mouse and touch paths: map a viewport point to
    // canvas-space pixels and fire whatever input this game defines there.
    const firePointAt = (clientX: number, clientY: number) => {
      const entry = getEntry();
      if (!entry) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * canvas.width;
      const py = ((clientY - rect.top) / rect.height) * canvas.height;

      if (entry.mapClick) {
        const input = entry.mapClick(px, py, getDisplay());
        if (input) sendInput(input);
      } else if (entry.clickMode === 'pixel') {
        sendInput({ type: 'click', data: { x: px, y: py } });
      } else if (entry.clickMode === 'grid') {
        const gridSize = (getDisplay().gridSize as number) ?? 4;
        const cell = canvas.width / gridSize;
        sendInput({ type: 'click', data: { x: Math.floor(px / cell), y: Math.floor(py / cell) } });
      }
    };

    const isClickable = () => {
      const entry = getEntry();
      return !!entry && (entry.clickMode !== 'none' || !!entry.mapClick);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!enabled || !isClickable()) return;
      firePointAt(e.clientX, e.clientY);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabled) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
      sendInput({ type: 'keydown', data: { key: e.key } });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!enabled) return;
      sendInput({ type: 'keyup', data: { key: e.key } });
    };

    let heldKey: string | null = null;
    let swipeStart: { x: number; y: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const entry = getEntry();
      if (!entry || !enabled) return;
      e.preventDefault(); // no scroll, no zoom, no synthetic mousedown
      const t = e.touches[0];
      if (entry.touch === 'hold-lr') {
        const rect = canvas.getBoundingClientRect();
        heldKey = t.clientX - rect.left < rect.width / 2 ? 'ArrowLeft' : 'ArrowRight';
        sendInput({ type: 'keydown', data: { key: heldKey } });
      } else if (entry.touch === 'swipe') {
        swipeStart = { x: t.clientX, y: t.clientY };
      } else if (isClickable()) {
        firePointAt(t.clientX, t.clientY);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      const entry = getEntry();
      if (!entry) return;
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
  }, [canvasRef, getEntry, getDisplay, enabled, sendInput]);
}
