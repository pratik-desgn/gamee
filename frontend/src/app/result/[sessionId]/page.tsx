'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { GameResult } from '@/types';
import { apiClient } from '@/lib/api';

export default function ResultPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.sessionId as string;
  const [result, setResult] = useState<GameResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Poll for the real, verified result — the verification worker still
    // needs to replay the input log and settlement needs to run, which
    // takes longer than a single request. "pending" means keep polling.
    const check = async () => {
      try {
        const data = await apiClient.getSessionResult(sessionId);
        if (cancelled) return;
        setResult(data);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch result');
      }
    };
    check();
    const interval = setInterval(check, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId]);

  const loading = !result || result.verdict === 'pending';

  return (
    <div className="min-h-screen pt-24 flex items-center justify-center px-4 py-10">
      <div className="glass rounded-2xl p-8 sm:p-10 max-w-md w-full text-center">
        {error ? (
          <div className="space-y-4">
            <div className="text-5xl">❌</div>
            <p className="text-gamee-muted">{error}</p>
          </div>
        ) : loading ? (
          <div className="space-y-4">
            <div className="text-5xl animate-pulse">🔍</div>
            <p className="text-gamee-muted">Verifying your game session...</p>
            <div className="w-16 h-1 mx-auto rounded-full bg-gradient-to-r from-purple-600 to-cyan-600 animate-pulse" />
          </div>
        ) : (
          <div className="space-y-6 animate-fade-in-up">
            <div className="text-6xl">
              {result.verdict === 'won' ? '🎉' : result.verdict === 'rejected' ? '🚫' : '😢'}
            </div>
            <h1 className={`text-3xl font-black ${result.verdict === 'won' ? 'gradient-text' : 'text-gamee-muted'}`}>
              {result.verdict === 'won' ? 'Congratulations!' : result.verdict === 'rejected' ? 'Session Rejected' : 'Better Luck Next Time'}
            </h1>
            <div className="glass rounded-xl p-6 divide-y divide-gamee-border">
              <div className="flex justify-between pb-3">
                <span className="text-gamee-muted">Final Score</span>
                <span className="font-bold text-xl tabular-nums">{result.score ?? '-'}</span>
              </div>
              {result.payoutTx && (
                <div className="flex justify-between pt-3">
                  <span className="text-gamee-muted">Payout Tx</span>
                  <span className="text-green-400 font-mono text-sm">{result.payoutTx.slice(0, 12)}...</span>
                </div>
              )}
            </div>
            <div className="flex gap-3 justify-center flex-wrap">
              <button
                onClick={() => router.push('/spin')}
                className="px-6 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 transition-all"
              >
                Play Again
              </button>
              <Link
                href="/leaderboard"
                className="px-6 py-3 rounded-xl border border-gamee-border text-gamee-muted font-semibold hover:border-purple-500/50 hover:text-gamee-text transition-all"
              >
                Leaderboard
              </Link>
            </div>
          </div>
        )}

        <div className="mt-8">
          <Link href="/" className="text-sm text-gamee-muted hover:text-purple-400 transition-colors">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
