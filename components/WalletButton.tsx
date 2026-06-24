"use client";
import { useEffect, useState } from "react";
import { getNetworkDetails } from "@stellar/freighter-api";
import { connectWallet, truncate, NETWORK, NETWORK_PASSPHRASE } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";

export default function WalletButton() {
  const { publicKey, setPublicKey, sessionExpired, dismissExpired, reconnect } = useWallet();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [networkMismatch, setNetworkMismatch] = useState(false);

  useEffect(() => {
    if (!publicKey) { setNetworkMismatch(false); return; }
    getNetworkDetails().then(details => {
      setNetworkMismatch(details.networkPassphrase !== NETWORK_PASSPHRASE);
    }).catch(() => {});
  }, [publicKey]);

  const connect = async () => {
    setLoading(true); setErr("");
    try { setPublicKey(await connectWallet()); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : "Connection failed"); }
    finally { setLoading(false); }
  };

  const handleReconnect = async () => {
    setLoading(true); setErr("");
    try { await reconnect(); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : "Reconnect failed"); }
    finally { setLoading(false); }
  };

  // ── Session-expired reconnect prompt ──────────────────────────────────────
  if (sessionExpired) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-amber-400 font-medium">Session expired</span>
          <button
            onClick={handleReconnect}
            disabled={loading}
            className="btn-primary rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {loading ? "Reconnecting…" : "Reconnect"}
          </button>
          <button
            onClick={dismissExpired}
            className="text-xs text-zinc-500 hover:text-white transition-colors"
            aria-label="Dismiss session expired notice"
          >
            Dismiss
          </button>
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
      </div>
    );
  }

  // ── Connected ─────────────────────────────────────────────────────────────
  if (publicKey) return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-zinc-300">
          {truncate(publicKey)}
        </span>
        <button
          onClick={() => setPublicKey(null)}
          className="text-xs text-zinc-500 hover:text-white transition-colors"
        >
          Disconnect
        </button>
      </div>
      {networkMismatch && (
        <p className="text-xs text-amber-400">
          Network mismatch — switch Freighter to {NETWORK === "mainnet" ? "Mainnet" : "Testnet"}
        </p>
      )}
    </div>
  );

  // ── Disconnected ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={connect}
        disabled={loading}
        className="btn-primary rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {loading ? "Connecting…" : "Connect Wallet"}
      </button>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
