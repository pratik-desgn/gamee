'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import Link from 'next/link';
import type { GameSession, Ticket } from '@/types';
import { apiClient } from '@/lib/api';
import { GAME_GUIDES } from '@/lib/gameGuides';

const RESULT_BADGE: Record<string, { emoji: string; label: string; cls: string }> = {
  won: { emoji: '🎉', label: 'won', cls: 'text-green-400' },
  lost: { emoji: '😢', label: 'lost', cls: 'text-red-400' },
  rejected: { emoji: '🚫', label: 'rejected', cls: 'text-yellow-400' },
  review_hold: { emoji: '🔎', label: 'under review', cls: 'text-amber-400' },
  pending: { emoji: '⏳', label: 'pending', cls: 'text-gamee-muted' },
};

export default function ProfilePage() {
  const { publicKey, connected } = useWallet();
  const [sessions, setSessions] = useState<GameSession[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [activeTab, setActiveTab] = useState<'history' | 'achievements'>('history');

  useEffect(() => {
    if (!publicKey || !connected) return;
    apiClient.getUserHistory().then((d) => setSessions(d.sessions || [])).catch(() => {});
    apiClient.getMyTickets().then((d) => setTickets(d.tickets || [])).catch(() => {});
  }, [publicKey, connected]);

  if (!connected) {
    return (
      <div className="min-h-screen pt-24 flex items-center justify-center px-4">
        <div className="glass rounded-2xl p-10 max-w-md text-center">
          <div className="text-5xl mb-4">🔌</div>
          <h1 className="text-2xl font-bold mb-3">Connect Your Wallet</h1>
          <p className="text-gamee-muted">Use the wallet button in the top-right corner.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-24 py-16">
      <div className="max-w-4xl mx-auto px-6">
        <div className="flex items-center gap-4 mb-8">
          <div className="w-14 h-14 shrink-0 rounded-full bg-gradient-to-r from-purple-600 to-cyan-600 flex items-center justify-center text-white font-black text-xl shadow-lg shadow-purple-500/20">
            {publicKey?.toBase58().slice(0, 2)}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold">Profile</h1>
            <p className="text-sm font-mono text-gamee-muted truncate">{publicKey?.toBase58().slice(0, 12)}...</p>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-8">
          <div className="glass rounded-xl p-4 text-center">
            <div className="text-2xl font-bold gradient-text tabular-nums">{tickets.filter((t) => t.status === 'unused').length}</div>
            <div className="text-xs text-gamee-muted uppercase tracking-wider mt-1">Tickets Left</div>
          </div>
          <div className="glass rounded-xl p-4 text-center">
            <div className="text-2xl font-bold gradient-text tabular-nums">{sessions.length}</div>
            <div className="text-xs text-gamee-muted uppercase tracking-wider mt-1">Games Played</div>
          </div>
          <div className="glass rounded-xl p-4 text-center">
            <div className="text-2xl font-bold gradient-text tabular-nums">{sessions.filter(s => s.result === 'won').length}</div>
            <div className="text-xs text-gamee-muted uppercase tracking-wider mt-1">Wins</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setActiveTab('history')}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
              activeTab === 'history' ? 'bg-gradient-to-r from-purple-600 to-cyan-600 text-white shadow-md shadow-purple-500/20' : 'glass text-gamee-muted hover:text-gamee-text'
            }`}
          >
            Game History
          </button>
          <button
            onClick={() => setActiveTab('achievements')}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
              activeTab === 'achievements' ? 'bg-gradient-to-r from-purple-600 to-cyan-600 text-white shadow-md shadow-purple-500/20' : 'glass text-gamee-muted hover:text-gamee-text'
            }`}
          >
            Achievements
          </button>
        </div>

        {activeTab === 'history' ? (
          sessions.length === 0 ? (
            <div className="glass rounded-2xl p-10 text-center">
              <div className="text-4xl mb-3">🎮</div>
              <p className="text-gamee-muted">No games played yet.</p>
              <Link href="/ticket" className="inline-block mt-4 px-6 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 transition-all">
                Play Your First Game →
              </Link>
            </div>
          ) : (
            <div className="glass rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gamee-border text-left text-xs uppercase tracking-wider text-gamee-muted">
                      <th className="p-4 font-semibold">Game</th>
                      <th className="p-4 font-semibold">Result</th>
                      <th className="p-4 font-semibold">Score</th>
                      <th className="p-4 font-semibold">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      const guide = GAME_GUIDES[s.gameId];
                      const badge = RESULT_BADGE[s.result] ?? RESULT_BADGE.pending;
                      return (
                        <tr key={s.id} className="border-b border-gamee-border/50 hover:bg-white/[0.02] transition-colors">
                          <td className="p-4">
                            <Link href={`/result/${s.id}`} className="hover:text-purple-400 transition-colors">
                              {guide ? `${guide.icon} ${guide.name}` : s.gameId}
                            </Link>
                          </td>
                          <td className="p-4">
                            <span className={`inline-flex items-center gap-1.5 font-semibold ${badge.cls}`}>
                              {badge.emoji} {badge.label}
                            </span>
                          </td>
                          <td className="p-4 text-gamee-muted tabular-nums">
                            {s.finalScore ?? '-'}
                            {typeof s.targetScore === 'number' && <span className="text-xs"> / {s.targetScore}</span>}
                          </td>
                          <td className="p-4 text-gamee-muted text-sm">{new Date(s.startedAt).toLocaleDateString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : (
          <div className="glass rounded-2xl p-10 text-center">
            <div className="text-4xl mb-3">🏆</div>
            <p className="text-gamee-muted">Achievements coming soon. Play games to earn them!</p>
          </div>
        )}

        <div className="mt-8 text-center">
          <Link href="/" className="text-sm text-gamee-muted hover:text-purple-400 transition-colors">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
