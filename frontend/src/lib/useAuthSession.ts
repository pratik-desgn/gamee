'use client';

import { useEffect, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { apiClient } from './api';

/**
 * Drives the wallet sign-in flow: on wallet connect, get a nonce, have the
 * wallet sign the challenge message, verify it against the backend, and
 * cache the resulting JWT on apiClient. Without this, every protected API
 * call (tickets, spin, session finish, history) 401s forever — connecting
 * a wallet alone never authenticates against the backend.
 */
export function useAuthSession() {
  const { publicKey, connected, signMessage, disconnecting } = useWallet();
  // Prevents re-prompting for a signature on every re-render/effect re-run
  // for the same wallet (e.g. if the user rejects the signature once).
  const attemptedForWallet = useRef<string | null>(null);

  useEffect(() => {
    if (disconnecting) {
      apiClient.clearToken();
      attemptedForWallet.current = null;
      return;
    }

    if (!connected || !publicKey || !signMessage) return;

    const wallet = publicKey.toBase58();

    // Already have a valid-looking token for this exact wallet.
    if (apiClient.hasToken() && apiClient.getTokenWallet() === wallet) return;

    // A different wallet's token is cached — drop it before signing in fresh.
    if (apiClient.getTokenWallet() && apiClient.getTokenWallet() !== wallet) {
      apiClient.clearToken();
    }

    if (attemptedForWallet.current === wallet) return;
    attemptedForWallet.current = wallet;

    (async () => {
      try {
        const { nonce, message } = await apiClient.getNonce(wallet);
        const signatureBytes = await signMessage(new TextEncoder().encode(message));
        const signature = bs58.encode(signatureBytes);
        const { token } = await apiClient.verifySignature(wallet, signature, nonce);
        apiClient.setToken(token, wallet);
      } catch (err) {
        // User rejected the signature request, or the backend call failed.
        // Leave attemptedForWallet set so we don't loop re-prompting; a
        // wallet reconnect (or page refresh) will retry.
        console.error('[auth] wallet sign-in failed:', err);
      }
    })();
  }, [connected, publicKey, signMessage, disconnecting]);
}
