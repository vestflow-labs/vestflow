"use client";

import { useState, useCallback } from "react";
import { signMessage } from "@stellar/freighter-api";
import { connectWallet } from "@/lib/stellar";

interface AuthState {
  token: string | null;
  publicKey: string | null;
  expiresIn: number | null;
}

/**
 * Wallet-signature authentication flow:
 * 1. Connect Freighter, get public key
 * 2. Request a nonce from the backend
 * 3. Sign the nonce with Freighter (SEP-53 message signing)
 * 4. Send the signature back to verify and receive a short-lived JWT
 */
export function useWalletAuth() {
  const [auth, setAuth] = useState<AuthState>({ token: null, publicKey: null, expiresIn: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authenticate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const publicKey = await connectWallet();

      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey }),
      });
      if (!nonceRes.ok) throw new Error((await nonceRes.json()).error || "Failed to get nonce");
      const { nonce } = await nonceRes.json();

      const signResult = await signMessage(nonce, { address: publicKey });
      if ("error" in signResult && signResult.error) {
        throw new Error(signResult.error.message || "Signing failed");
      }

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey,
          nonce,
          signedMessage: signResult.signedMessage,
        }),
      });
      if (!verifyRes.ok) throw new Error((await verifyRes.json()).error || "Verification failed");
      const { token, expiresIn } = await verifyRes.json();

      setAuth({ token, publicKey, expiresIn });
      return token;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed");
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  return { ...auth, authenticate, loading, error };
}
