'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { GameResult } from '@/types';
import { apiClient } from '@/lib/api';
import { GAME_GUIDES } from '@/lib/gameGuides';
import { explorerTxUrl } from '@/lib/solana';

export default function ResultPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.sessionId as string;
  const [result, setResult] = useState<GameResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slowVerify, setSlowVerify] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Poll for the real, verified result — the verification worker still
    // needs to replay the input log and settlement needs to run, which
    // takes longer than a single request. "pending" means keep polling;
    // the interval also keeps running after a win so the payout tx (and a
    // review_hold release) appears live without a refresh.
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
    const slow = setTimeout(() => setSlowVerify(true), 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(slow);
    };
  }, [sessionId]);

  const loading = !result || result.verdict === 'pending';
  const guide = result?.gameId ? GAME_GUIDES[result.gameId] : undefined;
  const verdict = result?.verdict;

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
            {slowVerify && (
              <p className="text-xs text-gamee-muted leading-relaxed">
                Still working — the server replays your entire game input-by-input
                to confirm the score. This usually takes under a minute.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-6 animate-fade-in-up">
            <div className="text-6xl">
              {verdict === 'won' ? '🎉' : verdict === 'rejected' ? '🚫' : verdict === 'review_hold' ? '🔎' : '😢'}
            </div>
            <h1 className={`text-3xl font-black ${verdict === 'won' ? 'gradient-text' : verdict === 'review_hold' ? 'text-amber-400' : 'text-gamee-muted'}`}>
              {verdict === 'won'
                ? 'Congratulations!'
                : verdict === 'rejected'
                  ? 'Session Rejected'
                  : verdict === 'review_hold'
                    ? 'Win Under Review'
                    : 'Better Luck Next Time'}
            </h1>
            {verdict === 'review_hold' && (
              <p className="text-sm text-gamee-muted leading-relaxed">
                You hit the target! Big payouts get a quick human look before
                settling — no action needed. This page updates on its own once
                the review clears.
              </p>
            )}
            {verdict === 'rejected' && (
              <p className="text-sm text-gamee-muted leading-relaxed">
                The server replay couldn&apos;t reproduce this session&apos;s
                score from its input log, so it wasn&apos;t counted. This can
                happen after heavy lag or a modified client.
              </p>
            )}
            <div className="glass rounded-xl p-6 divide-y divide-gamee-border text-left">
              {guide && (
                <div className="flex justify-between pb-3">
                  <span className="text-gamee-muted">Game</span>
                  <span className="font-bold">{guide.icon} {guide.name}</span>
                </div>
              )}
              <div className={`flex justify-between ${guide ? 'py-3' : 'pb-3'}`}>
                <span className="text-gamee-muted">Final Score</span>
                <span className="font-bold text-xl tabular-nums">
                  {result.score ?? '-'}
                  {typeof result.targetScore === 'number' && (
                    <span className="text-sm font-semibold text-gamee-muted"> / {result.targetScore} to win</span>
                  )}
                </span>
              </div>
              {verdict === 'won' && (
                <div className="flex justify-between items-center pt-3 gap-3">
                  <span className="text-gamee-muted">Payout</span>
                  {result.payoutTx ? (
                    <a
                      href={explorerTxUrl(result.payoutTx)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-green-400 font-mono text-sm hover:underline"
                      title="View on Solana Explorer"
                    >
                      {result.payoutTx.slice(0, 12)}... ↗
                    </a>
                  ) : (
                    <span className="text-amber-400 text-sm animate-pulse">settling on-chain…</span>
                  )}
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
              {result.gameId && verdict !== 'won' && (
                <Link
                  href={`/practice/${result.gameId}`}
                  className="px-6 py-3 rounded-xl border border-gamee-border text-gamee-muted font-semibold hover:border-cyan-500/50 hover:text-cyan-400 transition-all"
                >
                  Practice This Game
                </Link>
              )}
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
