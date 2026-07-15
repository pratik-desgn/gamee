'use client';

import { useEffect, useState } from 'react';
import type { JackpotState } from '@/types';
import { apiClient } from '@/lib/api';
import { JACKPOT_TIERS, TIER_LABELS, TIER_ICONS, TIER_ACCENT, tierRequirementLabel } from '@/lib/tiers';

export default function JackpotDisplay() {
  // null until the first successful fetch — render placeholders rather
  // than fabricated numbers; a failed poll keeps the last real values.
  const [jackpot, setJackpot] = useState<JackpotState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchJackpot = async () => {
      try {
        const data = await apiClient.getJackpot();
        if (!cancelled) setJackpot(data);
      } catch {
        // keep whatever we last showed
      }
    };
    fetchJackpot();
    const interval = setInterval(fetchJackpot, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const tier = jackpot?.tier ?? 'small';
  const accent = TIER_ACCENT[tier];
  // currentAmount is whole USDC (converted in apiClient.getJackpot) — the
  // jackpot vault holds USDC, not SOL, so render it as dollars directly.

  return (
    <div className="glass gradient-border relative overflow-hidden rounded-2xl p-6 sm:p-8 inline-block max-w-full">
      {/* Ambient glow blob */}
      <div
        aria-hidden
        className={`float-blob pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full bg-gradient-to-br ${accent.gradient} opacity-20 blur-3xl`}
      />

      <div className="relative flex items-center justify-between gap-4 mb-2">
        <span className="text-xs uppercase tracking-widest text-gamee-muted">
          Current Jackpot
        </span>
        <span className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider ${accent.text}`}>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
          </span>
          Live
        </span>
      </div>

      <div className={`relative inline-flex items-center gap-1.5 mb-3 rounded-full border ${accent.border} ${accent.bg} px-3 py-1`}>
        <span className="text-sm">{TIER_ICONS[tier]}</span>
        <span className={`text-xs font-bold uppercase tracking-wide ${accent.text}`}>
          {TIER_LABELS[tier]} Tier
        </span>
      </div>

      <div className="relative flex items-baseline gap-2">
        <span className="text-3xl font-black text-purple-400">$</span>
        <span className="jackpot-glow text-4xl sm:text-5xl font-black gradient-text tracking-tight tabular-nums">
          {jackpot ? jackpot.currentAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
        </span>
      </div>
      <div className="relative text-sm text-gamee-muted mt-1">
        USDC — live from the on-chain vault
      </div>

      <div className="relative flex gap-8 mt-5 pt-4 border-t border-gamee-border">
        <div className="text-center">
          <span className="block text-lg font-bold tabular-nums">{jackpot ? jackpot.playersOnline : '—'}</span>
          <span className="text-xs uppercase tracking-wider text-gamee-muted">Players Online</span>
        </div>
        <div className="text-center">
          <span className="block text-lg font-bold tabular-nums">{jackpot ? jackpot.todayPlays.toLocaleString() : '—'}</span>
          <span className="text-xs uppercase tracking-wider text-gamee-muted">Today&apos;s Plays</span>
        </div>
      </div>

      {/* Tier ladder — thresholds sourced from lib/tiers.ts, never hardcoded */}
      <div className="relative mt-5 pt-4 border-t border-gamee-border">
        <div className="text-xs uppercase tracking-widest text-gamee-muted mb-2.5">
          Jackpot Ladder
        </div>
        <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
          {JACKPOT_TIERS.map((t) => {
            const isActive = t === tier;
            const tierAccent = TIER_ACCENT[t];
            return (
              <div
                key={t}
                title={tierRequirementLabel(t)}
                className={`rounded-lg border p-1.5 sm:p-2 text-center transition-all ${
                  isActive
                    ? `${tierAccent.border} ${tierAccent.bg} shadow-sm ${tierAccent.glow}`
                    : 'border-gamee-border/70 opacity-50'
                }`}
              >
                <div className="text-sm sm:text-base leading-none">{TIER_ICONS[t]}</div>
                <div className={`text-[10px] sm:text-[11px] font-bold mt-1 truncate ${isActive ? tierAccent.text : 'text-gamee-muted'}`}>
                  {TIER_LABELS[t]}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
