'use client';

import { useState, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { getUsdcBalance, createBuyTicketTransaction, TICKET_PRICE_USDC } from '@/lib/solana';
import {
  JACKPOT_TIERS,
  TIER_LABELS,
  TIER_ICONS,
  TIER_ACCENT,
  TIER_ENTRY_THRESHOLDS,
  tierRequirementLabel,
  type JackpotTier,
} from '@/lib/tiers';
import Link from 'next/link';

export default function TicketPage() {
  const { publicKey, signTransaction, connected } = useWallet();
  const router = useRouter();
  const [buying, setBuying] = useState(false);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  // Which jackpot vault the 80% cut is routed to. The backend enforces the
  // qualification ladder (see backend/internal/jackpot/tiers.go) on confirm
  // — we don't gate selection client-side, we just surface its rejection.
  const [selectedTier, setSelectedTier] = useState<JackpotTier>('small');

  const checkBalance = useCallback(async () => {
    if (!publicKey) return;
    const bal = await getUsdcBalance(publicKey);
    setBalance(bal);
  }, [publicKey]);

  // Beta/devnet only: the faucet route exists only when the backend runs
  // with BETA_FAUCET=true; the button only renders when NEXT_PUBLIC_BETA
  // is set, so production builds never show it.
  const isBeta = process.env.NEXT_PUBLIC_BETA === 'true';
  const [fauceting, setFauceting] = useState(false);
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);
  const requestFunds = useCallback(async () => {
    setFauceting(true);
    setFaucetMsg(null);
    setError(null);
    try {
      const res = await apiClient.requestFaucet();
      setFaucetMsg(`Received ${res.usdc} test USDC + ${res.sol} SOL`);
      await checkBalance();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Faucet request failed');
    } finally {
      setFauceting(false);
    }
  }, [checkBalance]);

  const buyTicket = useCallback(async () => {
    if (!publicKey || !signTransaction) return;
    setBuying(true);
    setError(null);

    try {
      // Pre-flight: a wallet that has never held USDC has no token account
      // at all, so the on-chain buy fails with a raw AccountNotInitialized
      // simulation log. Check the balance first (0 covers the missing-ATA
      // case too) and explain what to do instead.
      const bal = await getUsdcBalance(publicKey);
      setBalance(bal);
      if (bal < TICKET_PRICE_USDC) {
        setError(
          `You need at least ${TICKET_PRICE_USDC} USDC in your wallet to buy a ticket` +
            (isBeta
              ? ' — tap "Get test funds" above to receive test USDC.'
              : '. Fund your wallet with USDC and try again.')
        );
        return;
      }

      const tx = await createBuyTicketTransaction(publicKey, selectedTier);
      const signed = await signTransaction(tx);
      // The wallet already signed — send the raw transaction and confirm it.
      const connection = (await import('@/lib/solana')).getConnection();
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
      });
      await connection.confirmTransaction(sig, 'confirmed');
      setTxSignature(sig);

      // Confirm with backend — this is also where an unqualified tier pick
      // (or a tx that funded the wrong vault) gets rejected.
      await apiClient.confirmTicket(sig, selectedTier);

      // Redirect to spin after short delay
      setTimeout(() => router.push('/spin'), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setBuying(false);
    }
  }, [publicKey, signTransaction, router, selectedTier, isBeta]);

  if (!connected) {
    return (
      <div className="min-h-screen pt-24 flex items-center justify-center px-4">
        <div className="text-center glass rounded-2xl p-12 max-w-md">
          <div className="text-5xl mb-4">🔌</div>
          <h1 className="text-2xl font-bold mb-3">Connect Your Wallet</h1>
          <p className="text-gamee-muted mb-6">You need a Solana wallet to buy a ticket and play.</p>
          <p className="text-sm text-gamee-muted">Use the wallet button in the top-right corner.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-24 flex items-center justify-center px-4 py-10">
      <div className="glass rounded-2xl p-8 sm:p-10 max-w-md w-full">
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">🎟️</div>
          <h1 className="text-2xl font-bold">Buy a Ticket</h1>
          <p className="text-gamee-muted mt-2">$1 USDC entry fee — 80% goes to the jackpot</p>
        </div>

        <div className="mb-8">
          <div className="text-gamee-muted text-sm mb-2.5">Choose Jackpot Tier</div>
          <div className="grid grid-cols-2 gap-2.5">
            {JACKPOT_TIERS.map((tier) => {
              const active = selectedTier === tier;
              const accent = TIER_ACCENT[tier];
              const locked = TIER_ENTRY_THRESHOLDS[tier] > 0;
              return (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setSelectedTier(tier)}
                  disabled={buying || !!txSignature}
                  aria-pressed={active}
                  className={`relative rounded-xl p-3.5 text-left border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                    active
                      ? `${accent.border} ${accent.bg} shadow-sm ${accent.glow}`
                      : 'border-gamee-border glass hover:border-purple-500/40'
                  }`}
                >
                  {active && (
                    <span className={`absolute top-2 right-2 h-2 w-2 rounded-full ${accent.dot}`} />
                  )}
                  <div className="flex items-center gap-1.5">
                    <span className="text-base leading-none">{TIER_ICONS[tier]}</span>
                    <span className={`font-bold ${active ? accent.text : ''}`}>{TIER_LABELS[tier]}</span>
                  </div>
                  <div className="text-xs text-gamee-muted mt-1 flex items-center gap-1">
                    {locked && <span aria-hidden>🔒</span>}
                    {tierRequirementLabel(tier)}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-gamee-muted mt-2.5 leading-relaxed">
            Picking a tier you haven&apos;t unlocked yet will be rejected when the purchase is confirmed.
          </p>
        </div>

        <div className="glass rounded-xl divide-y divide-gamee-border mb-8">
          <div className="p-4 flex justify-between items-center gap-3">
            <span className="text-gamee-muted text-sm">Your Wallet</span>
            <span className="text-sm font-mono truncate max-w-[180px]" title={publicKey?.toBase58()}>{publicKey?.toBase58()}</span>
          </div>
          <div className="p-4 flex justify-between items-center">
            <span className="text-gamee-muted text-sm">USDC Balance</span>
            <button onClick={checkBalance} className="text-sm font-semibold text-purple-400 hover:text-purple-300 transition-colors">
              {balance !== null ? `${balance.toFixed(2)} USDC` : 'Check →'}
            </button>
          </div>
          {isBeta && (
            <div className="p-4 flex justify-between items-center gap-3">
              <span className="text-gamee-muted text-sm">
                Beta faucet
                {faucetMsg && <span className="block text-green-400 mt-0.5">{faucetMsg}</span>}
              </span>
              <button
                onClick={requestFunds}
                disabled={fauceting}
                className="text-sm font-semibold text-cyan-400 hover:text-cyan-300 transition-colors disabled:opacity-50"
              >
                {fauceting ? 'Sending…' : 'Get test funds'}
              </button>
            </div>
          )}
          <div className="p-4 flex justify-between items-center">
            <span className="text-gamee-muted text-sm">Fee</span>
            <span className="font-bold">1 USDC</span>
          </div>
          <div className="p-4 flex justify-between items-center">
            <span className="text-gamee-muted text-sm">To Jackpot (80%)</span>
            <span className="text-purple-400 font-bold">0.80 USDC</span>
          </div>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-400 mb-4 flex items-start gap-2">
            <span aria-hidden>⚠️</span>
            <span>{error}</span>
          </div>
        )}

        {txSignature && (
          <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 text-sm text-green-400 mb-4 break-all">
            ✅ Ticket purchased! Tx: {txSignature.slice(0, 20)}...
          </div>
        )}

        <button
          onClick={buyTicket}
          disabled={buying || !!txSignature}
          className="w-full py-4 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold text-lg shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
        >
          {buying ? '🔄 Processing...' : txSignature ? '✅ Done! Redirecting...' : '🎮 Buy Ticket ($1 USDC)'}
        </button>

        <div className="mt-6 text-center">
          <Link href="/" className="text-sm text-gamee-muted hover:text-purple-400 transition-colors">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
