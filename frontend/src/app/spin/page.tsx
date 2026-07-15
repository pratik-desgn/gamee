'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import Link from 'next/link';
import PrizeWheel, { WHEEL_GAMES, rotationToLandOn } from '@/components/PrizeWheel';
import type { Ticket, SpinResult } from '@/types';

const IDLE_TURN_MS = 1600; // one steady revolution while waiting on-chain
const LAND_MS = 4200;      // final decisive ease-out onto the assigned game
const REVEAL_PAUSE_MS = 2600; // linger on the result before entering the game

export default function SpinPage() {
  const { publicKey } = useWallet();
  const router = useRouter();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<string | null>(null);
  const [phase, setPhase] = useState<'pick' | 'drawing' | 'landing' | 'landed'>('pick');
  const [session, setSession] = useState<SpinResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Wheel drive: the same shared PrizeWheel as the homepage, but here it's
  // driven by the REAL flow — steady linear revolutions while the backend
  // draws on-chain randomness (~15s Switchboard commit-reveal), then one
  // decisive ease-out landing exactly on the game the backend assigned.
  const [rotation, setRotation] = useState(0);
  const [spinMs, setSpinMs] = useState(0);
  const [easing, setEasing] = useState<string | undefined>(undefined);
  const idleIntervalRef = useRef<number | undefined>(undefined);
  const timeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    if (!publicKey) return;
    apiClient.getMyTickets('unused').then((res) => {
      setTickets(res.tickets);
    }).catch(() => {});
  }, [publicKey]);

  useEffect(() => {
    return () => {
      window.clearInterval(idleIntervalRef.current);
      timeoutsRef.current.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const startIdleSpin = useCallback(() => {
    setEasing('linear');
    setSpinMs(IDLE_TURN_MS);
    setRotation((prev) => prev + 360);
    idleIntervalRef.current = window.setInterval(() => {
      setRotation((prev) => prev + 360);
    }, IDLE_TURN_MS);
  }, []);

  const landOn = useCallback((gameId: string) => {
    window.clearInterval(idleIntervalRef.current);
    const index = WHEEL_GAMES.findIndex((g) => g.slug === gameId);
    setEasing(undefined); // default decisive ease-out
    setSpinMs(LAND_MS);
    // Unknown game id (registry drift) → land anywhere rather than break;
    // the caption below always names the real assigned game from the API
    // response, so worst case the pointer is off, never the text.
    setRotation((prev) => rotationToLandOn(prev, index >= 0 ? index : 0, 3));
  }, []);

  const handleSpin = async () => {
    if (!selectedTicket) return;
    setPhase('drawing');
    setError(null);
    startIdleSpin();
    try {
      const s = await apiClient.spin(selectedTicket);
      setSession(s);
      setPhase('landing');
      landOn(s.gameId);
      timeoutsRef.current.push(window.setTimeout(() => {
        setPhase('landed');
        timeoutsRef.current.push(window.setTimeout(() => {
          router.push(`/play/${s.sessionId}`);
        }, REVEAL_PAUSE_MS));
      }, LAND_MS));
    } catch (err) {
      window.clearInterval(idleIntervalRef.current);
      setError(err instanceof Error ? err.message : 'Spin failed');
      setPhase('pick');
    }
  };

  const landedGame = session ? WHEEL_GAMES.find((g) => g.slug === session.gameId) : null;
  const busy = phase !== 'pick';

  return (
    <div className="min-h-screen pt-24 flex items-center justify-center px-4 py-10">
      <div className="glass rounded-2xl p-6 sm:p-8 max-w-lg w-full">
        <div className="text-center mb-5">
          <h1 className="text-2xl font-bold">Spin the Wheel</h1>
          <p className="text-gamee-muted mt-1 text-sm h-5">
            {phase === 'drawing' && 'Drawing verifiable randomness on-chain…'}
            {phase === 'landing' && 'Locked in — landing…'}
            {phase === 'landed' && 'Here we go!'}
            {phase === 'pick' && 'A verifiable random game picks your challenge'}
          </p>
        </div>

        {/* The wheel is always visible — it's the centerpiece of this page. */}
        <div className="flex justify-center mb-5">
          <PrizeWheel
            rotation={rotation}
            spinMs={spinMs}
            easing={easing}
            className="h-[260px] w-[260px] sm:h-[300px] sm:w-[300px]"
          />
        </div>

        {phase === 'landed' && session && (
          <div className="text-center space-y-1.5 animate-fade-in-up mb-5">
            <h2 className="text-xl font-bold gradient-text">
              {landedGame ? `${landedGame.icon} ${landedGame.name}` : `🎮 ${session.gameId}`}
            </h2>
            <p className="text-sm text-gamee-muted">
              Target Score: <span className="text-purple-400 font-bold tabular-nums">{session.targetScore}</span>
            </p>
            <p className="text-sm text-gamee-muted animate-pulse">Entering the game…</p>
          </div>
        )}

        {phase === 'pick' && (
          <>
            {tickets.length === 0 ? (
              <div className="text-center space-y-4 py-2">
                <p className="text-gamee-muted">🎟️ You don&apos;t have any unused tickets.</p>
                <Link
                  href="/ticket"
                  className="inline-block px-6 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 transition-all"
                >
                  Buy a Ticket →
                </Link>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-gamee-muted mb-2">Select a ticket to use:</p>
                <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                  {tickets.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setSelectedTicket(t.id)}
                      aria-pressed={selectedTicket === t.id}
                      className={`w-full text-left p-3 rounded-xl border transition-all ${
                        selectedTicket === t.id
                          ? 'border-purple-500 bg-purple-500/10 shadow-sm shadow-purple-500/20'
                          : 'border-gamee-border glass hover:border-purple-500/30'
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <span className="font-mono text-sm flex items-center gap-2">
                          <span aria-hidden>🎟️</span>{t.id.slice(0, 8)}...
                        </span>
                        <span className="text-xs text-gamee-muted">{new Date(t.purchasedAt).toLocaleDateString()}</span>
                      </div>
                    </button>
                  ))}
                </div>

                {error && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-400 flex items-start gap-2">
                    <span aria-hidden>⚠️</span>
                    <span>{error}</span>
                  </div>
                )}

                <button
                  onClick={handleSpin}
                  disabled={!selectedTicket || busy}
                  className="w-full py-4 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold text-lg shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
                >
                  ▶ SPIN THE WHEEL
                </button>
              </div>
            )}
          </>
        )}

        <div className="mt-6 text-center">
          <Link href="/" className="text-sm text-gamee-muted hover:text-purple-400 transition-colors">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
