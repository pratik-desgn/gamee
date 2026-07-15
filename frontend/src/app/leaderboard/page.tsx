'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';
import type { LeaderboardEntry } from '@/types';
import Link from 'next/link';

type Scope = 'daily' | 'weekly' | 'monthly' | 'alltime';

export default function LeaderboardPage() {
  const [scope, setScope] = useState<Scope>('alltime');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiClient.getLeaderboard(scope).then((res) => {
      setEntries(res.entries);
    }).catch(() => {
      setEntries([]);
    }).finally(() => setLoading(false));
  }, [scope]);

  const SCOPES: { key: Scope; label: string }[] = [
    { key: 'daily', label: 'Daily' },
    { key: 'weekly', label: 'Weekly' },
    { key: 'monthly', label: 'Monthly' },
    { key: 'alltime', label: 'All-Time' },
  ];

  const RANK_MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

  return (
    <div className="min-h-screen pt-24 py-16">
      <div className="max-w-4xl mx-auto px-6">
        <div className="text-center mb-10">
          <h1 className="text-3xl sm:text-4xl font-black gradient-text mb-3">Leaderboard</h1>
          <p className="text-gamee-muted">Top players ranked by wins</p>
        </div>

        {/* Scope Tabs */}
        <div className="flex justify-center gap-2 mb-8 flex-wrap">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              onClick={() => setScope(s.key)}
              className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
                scope === s.key
                  ? 'bg-gradient-to-r from-purple-600 to-cyan-600 text-white shadow-md shadow-purple-500/20'
                  : 'glass text-gamee-muted hover:text-gamee-text'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="glass rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gamee-border text-left text-xs uppercase tracking-wider text-gamee-muted">
                  <th className="p-4 font-semibold w-16">Rank</th>
                  <th className="p-4 font-semibold">Player</th>
                  <th className="p-4 font-semibold text-right">Games</th>
                  <th className="p-4 font-semibold text-right">Wins</th>
                  <th className="p-4 font-semibold text-right">Win Rate</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b border-gamee-border/50">
                      <td className="p-4"><div className="h-4 w-8 rounded bg-white/5 animate-pulse" /></td>
                      <td className="p-4"><div className="h-4 w-32 rounded bg-white/5 animate-pulse" /></td>
                      <td className="p-4"><div className="h-4 w-10 ml-auto rounded bg-white/5 animate-pulse" /></td>
                      <td className="p-4"><div className="h-4 w-10 ml-auto rounded bg-white/5 animate-pulse" /></td>
                      <td className="p-4"><div className="h-4 w-12 ml-auto rounded bg-white/5 animate-pulse" /></td>
                    </tr>
                  ))
                ) : entries.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-12 text-center text-gamee-muted">
                      <div className="text-4xl mb-3">🏆</div>
                      No rankings yet — be the first to play!
                    </td>
                  </tr>
                ) : (
                  entries.map((entry) => (
                    <tr
                      key={entry.rank}
                      className={`border-b border-gamee-border/50 hover:bg-white/[0.02] transition-colors ${
                        entry.rank <= 3 ? 'bg-gradient-to-r from-yellow-500/5 via-transparent to-transparent' : ''
                      }`}
                    >
                      <td className="p-4">
                        <span className={`font-bold text-lg flex items-center gap-1 ${
                          entry.rank === 1 ? 'text-yellow-400' :
                          entry.rank === 2 ? 'text-gray-300' :
                          entry.rank === 3 ? 'text-orange-400' : 'text-gamee-muted'
                        }`}>
                          {RANK_MEDAL[entry.rank] ?? `#${entry.rank}`}
                        </span>
                      </td>
                      <td className="p-4">
                        <span className="font-mono text-sm">{entry.wallet.slice(0, 8)}...{entry.wallet.slice(-4)}</span>
                      </td>
                      <td className="p-4 text-right text-gamee-muted tabular-nums">{entry.gamesPlayed}</td>
                      <td className="p-4 text-right font-bold text-purple-400 tabular-nums">{entry.wins}</td>
                      <td className="p-4 text-right">
                        <span className="text-sm font-semibold text-cyan-400 tabular-nums">{entry.winRate}%</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-8 text-center">
          <Link href="/" className="text-sm text-gamee-muted hover:text-purple-400 transition-colors">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
