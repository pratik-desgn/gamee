'use client';

import { useState } from 'react';
import Link from 'next/link';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

const LINKS = [
  { href: '/#how', label: 'How It Works' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/#games', label: 'Games' },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-gamee-dark/80 backdrop-blur-xl border-b border-gamee-border">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
        <Link href="/" className="text-xl font-black gradient-text tracking-tight shrink-0">
          GAMEE
        </Link>

        <div className="hidden md:flex items-center gap-6">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-gamee-muted hover:text-gamee-text transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <WalletMultiButton className="!bg-gradient-to-r !from-purple-600 !to-cyan-600 !rounded-xl !px-3.5 sm:!px-5 !py-2 !text-xs sm:!text-sm !font-semibold !h-auto hover:!opacity-90 transition-all" />

          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={open}
            className="md:hidden flex items-center justify-center h-9 w-9 rounded-lg border border-gamee-border text-gamee-text hover:border-purple-500/50 transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {open ? (
                <path d="M6 6l12 12M18 6L6 18" />
              ) : (
                <path d="M3 6h18M3 12h18M3 18h18" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile menu panel */}
      {open && (
        <div className="md:hidden border-t border-gamee-border bg-gamee-dark/95 backdrop-blur-xl">
          <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-1">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="px-2 py-2.5 rounded-lg text-sm font-medium text-gamee-muted hover:text-gamee-text hover:bg-white/[0.03] transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
