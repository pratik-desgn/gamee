'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import JackpotDisplay from '@/components/JackpotDisplay';
import Wheel from '@/components/Wheel';
import { GAME_GUIDES } from '@/lib/gameGuides';
import { GAME_REGISTRY } from '@/lib/gameRegistry';
import { startDemo } from '@/lib/demoBots';

const GAMES_LIST = [
  { icon: '🐦', name: 'Wing Rush', slug: 'wing-rush', cat: 'Precision' },
  { icon: '🏃', name: 'Dino Sprint', slug: 'dino-sprint', cat: 'Endless' },
  { icon: '🔄', name: 'Perfect Stack', slug: 'perfect-stack', cat: 'Precision' },
  { icon: '⏱️', name: 'Reaction Test', slug: 'reaction-test', cat: 'Reflex' },
  { icon: '🧩', name: 'Block Merge', slug: 'block-merge', cat: 'Puzzle' },
  { icon: '🧠', name: 'Simon Pro', slug: 'simon-pro', cat: 'Memory' },
  { icon: '🎯', name: 'Aim Master', slug: 'aim-master', cat: 'Reflex' },
  { icon: '🧊', name: 'Sliding Puzzle', slug: 'sliding-puzzle', cat: 'Puzzle' },
  { icon: '🌀', name: 'Helix Drop', slug: 'helix-drop', cat: 'Precision' },
  { icon: '💣', name: 'Minefield', slug: 'minefield', cat: 'Luck-Skill' },
];

const STEPS = [
  { num: '1', title: 'Connect & Pay', desc: 'Connect your Phantom wallet. Pay $1 USDC — 80% goes to the jackpot pool, transparent on-chain.' },
  { num: '2', title: 'Spin the Wheel', desc: 'A verifiable random game picks your challenge. Easy games are common. Legendary games are rare — and pay big.' },
  { num: '3', title: 'Play & Win', desc: 'Beat the target score through pure skill. Your every input is verified server-side. No bots, no cheats.' },
  { num: '4', title: 'Instant Payout', desc: 'Win the round? USDC lands in your wallet in seconds. 95% to you, 5% seeds the next jackpot.' },
];

export default function HomePage() {
  const [openGame, setOpenGame] = useState<(typeof GAMES_LIST)[number] | null>(null);
  const demoCanvasRef = useRef<HTMLCanvasElement>(null);

  // Live demo inside the guide modal: the real game plays itself on a
  // small canvas right after the how-to-play steps — a "demo video" that
  // can never go stale, because it IS the game (lib/demoBots.ts).
  useEffect(() => {
    if (!openGame) return;
    const entry = GAME_REGISTRY[openGame.slug];
    const canvas = demoCanvasRef.current;
    if (!entry || !canvas) return;
    canvas.width = entry.width;
    canvas.height = entry.height;
    const stop = startDemo(entry, canvas);
    return stop;
  }, [openGame]);

  useEffect(() => {
    if (!openGame) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenGame(null);
    window.addEventListener('keydown', onKey);
    // Lock page scroll behind the modal — otherwise the page keeps
    // scrolling under it (especially jarring on touch, where a swipe on
    // the modal moves the whole homepage).
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [openGame]);

  return (
    <>
      {/* Hero */}
      <section className="relative min-h-screen flex items-center pt-28 pb-16 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_0%,rgba(124,58,237,0.14),transparent),radial-gradient(ellipse_60%_50%_at_80%_100%,rgba(6,182,212,0.08),transparent)] pointer-events-none" />
        <div className="max-w-6xl mx-auto px-6 w-full">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <div className="space-y-6">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple-500/15 border border-purple-500/30 text-sm font-semibold text-purple-300">
                ⚡ Solana Skill-Gaming
              </div>
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black leading-[1.05] tracking-tight">
                Prove Your Skill.<br />
                <span className="gradient-text">Win the Jackpot.</span>
              </h1>
              <p className="text-lg text-gamee-muted leading-relaxed max-w-lg">
                Pay $1. Spin the wheel. Play a skill-based arcade game. Beat the target score and the jackpot is yours — transparent, verifiable, instant payout on Solana.
              </p>
              <JackpotDisplay />
              <div className="flex flex-wrap gap-4 pt-2">
                <Link href="/ticket" className="px-8 py-4 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold text-lg shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50 hover:-translate-y-0.5 transition-all text-center">
                  🎮 Play Now
                </Link>
                <a href="#how" className="px-8 py-4 rounded-xl border border-gamee-border text-gamee-muted font-semibold hover:border-purple-500/50 hover:text-gamee-text transition-all text-center">
                  How It Works ↓
                </a>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-2 text-xs text-gamee-muted">
                <span className="flex items-center gap-1.5">✅ Provably fair</span>
                <span className="flex items-center gap-1.5">⚡ Instant payouts</span>
                <span className="flex items-center gap-1.5">🔒 On-chain vaults</span>
              </div>
            </div>
            <div className="flex justify-center">
              <Wheel />
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how" className="py-20 sm:py-24 scroll-mt-20">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-3xl sm:text-4xl font-black text-center gradient-text mb-4">How It Works</h2>
          <p className="text-center text-gamee-muted max-w-lg mx-auto mb-14 sm:mb-16">
            From wallet to payout in 4 simple steps
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {STEPS.map((step) => (
              <div key={step.num} className="glass rounded-2xl p-8 text-center hover:border-purple-500/30 hover:-translate-y-1 transition-all duration-300">
                <div className="w-11 h-11 mx-auto mb-4 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 flex items-center justify-center text-white font-extrabold text-lg shadow-lg shadow-purple-500/20">
                  {step.num}
                </div>
                <h3 className="text-lg font-bold mb-2">{step.title}</h3>
                <p className="text-sm text-gamee-muted leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Games */}
      <section id="games" className="py-20 sm:py-24 bg-gamee-darker scroll-mt-20">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-3xl sm:text-4xl font-black text-center gradient-text mb-4">Featured Games</h2>
          <p className="text-center text-gamee-muted max-w-lg mx-auto mb-12">
            From precision to puzzles — ten games at launch, more on the way. Tap a card for how to play.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {GAMES_LIST.map((game) => (
              <button
                key={game.name}
                type="button"
                onClick={() => setOpenGame(game)}
                className="glass rounded-xl p-5 text-center hover:border-purple-500/30 hover:-translate-y-1 transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
              >
                <div className="text-3xl mb-1">{game.icon}</div>
                <div className="text-xs text-gamee-muted mb-1">{game.cat}</div>
                <h4 className="font-semibold text-sm">{game.name}</h4>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* How-to-play modal */}
      {openGame && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setOpenGame(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="game-guide-title"
            className="glass rounded-2xl p-5 sm:p-6 max-w-sm sm:max-w-2xl w-full relative animate-fade-in-up max-h-[92dvh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpenGame(null)}
              aria-label="Close"
              className="absolute top-4 right-4 text-gamee-muted hover:text-gamee-text transition-colors text-lg leading-none"
            >
              ✕
            </button>
            <div className="flex items-baseline gap-2 mb-3 shrink-0">
              <span className="text-2xl">{openGame.icon}</span>
              <h3 id="game-guide-title" className="text-lg font-bold">{openGame.name}</h3>
              <span className="text-xs text-gamee-muted">{openGame.cat}</span>
            </div>
            {/* Two columns on sm+ (guide left, demo right) so everything is
                visible at once without scrolling; on phones the demo is
                height-capped for the same reason. */}
            <div className="grid sm:grid-cols-2 gap-4 text-left min-h-0">
              <div className="space-y-3 min-h-0 overflow-y-auto">
                <p className="text-sm text-gamee-muted leading-relaxed">{GAME_GUIDES[openGame.slug]?.goal}</p>
                <ol className="space-y-1 list-decimal list-inside">
                  {GAME_GUIDES[openGame.slug]?.steps.map((s) => (
                    <li key={s} className="text-xs sm:text-sm text-gamee-muted leading-relaxed">{s}</li>
                  ))}
                </ol>
                <div className="text-xs space-y-1 bg-white/5 border border-gamee-border rounded-lg p-2.5 leading-relaxed">
                  <div className="text-gamee-muted hidden sm:block">🖥️ {GAME_GUIDES[openGame.slug]?.controls.desktop}</div>
                  <div className="text-gamee-muted sm:hidden">📱 {GAME_GUIDES[openGame.slug]?.controls.mobile}</div>
                  {GAME_GUIDES[openGame.slug]?.tip && (
                    <div className="text-gamee-muted pt-1 border-t border-gamee-border/60">💡 {GAME_GUIDES[openGame.slug]?.tip}</div>
                  )}
                </div>
              </div>
              <div className="relative flex items-center justify-center min-h-0">
                <canvas
                  ref={demoCanvasRef}
                  className="max-w-full rounded-lg border border-gamee-border bg-[#1a1a2e] object-contain"
                  style={{ maxHeight: 'min(38dvh, 340px)', width: 'auto' }}
                />
                <span className="absolute top-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-purple-500/80 text-white text-[10px] font-bold tracking-wide pointer-events-none">
                  DEMO
                </span>
              </div>
            </div>
            <div className="mt-4 flex gap-2.5 shrink-0">
              <Link
                href={`/practice/${openGame.slug}`}
                className="flex-1 text-center px-4 py-3 rounded-xl border border-gamee-border font-bold text-sm hover:border-cyan-500/50 hover:text-cyan-400 transition-all"
              >
                🕹️ Practice Free
              </Link>
              <Link
                href="/ticket"
                className="flex-1 text-center px-4 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold text-sm shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 transition-all"
              >
                🎮 Play Now
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
