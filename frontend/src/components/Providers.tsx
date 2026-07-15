'use client';

import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
// Backpack no longer ships a legacy adapter — it is auto-detected via the
// Wallet Standard, so only Phantom needs an explicit adapter here. Imported
// from the dedicated lightweight package, not @solana/wallet-adapter-wallets
// — that bundle transitively pulls in Trezor/Ledger hardware wallet support
// (the `usb` native module), which needs node-gyp + Python to compile and
// isn't needed since nothing here uses those wallets.
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { clusterApiUrl } from '@solana/web3.js';
import { useMemo } from 'react';
import { useAuthSession } from '@/lib/useAuthSession';

require('@solana/wallet-adapter-react-ui/styles.css');

// Drives the wallet sign-in flow (nonce -> sign -> verify -> JWT). Must be
// rendered inside WalletProvider since it calls useWallet(); has no output
// of its own.
function AuthSessionBridge() {
  useAuthSession();
  return null;
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const network = WalletAdapterNetwork.Devnet;
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_SOLANA_RPC || clusterApiUrl(network), [network]);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <AuthSessionBridge />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
