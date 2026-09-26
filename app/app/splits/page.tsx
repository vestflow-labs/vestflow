"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import SplitsPieChart from "@/components/SplitsPieChart";
import SplitWeightEditor from "@/components/SplitWeightEditor";
import { useWallet } from "@/lib/WalletContext";
import { NETWORK } from "@/lib/stellar";

interface SplitReceiver {
  address: string;
  weight_bps: number;
}

interface SplitsConfig {
  receivers: SplitReceiver[];
  hash: string;
}

function SplitsSkeleton() {
  return (
    <div className="card p-6 sm:p-8 space-y-6" role="status" aria-label="Loading splits configuration">
      <div className="h-6 w-32 rounded bg-white/10 animate-pulse" />
      <div className="h-48 rounded-xl bg-white/5 animate-pulse" />
      <div className="space-y-3 border-t border-white/5 pt-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-11 rounded bg-white/5 animate-pulse" />
        ))}
      </div>
    </div>
  );
}

export default function SplitsPage() {
  const { publicKey } = useWallet();
  const [splits, setSplits] = useState<SplitsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  const fetchSplits = useCallback(async () => {
    if (!publicKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/splits?account=${publicKey}&network=${NETWORK}`);
      if (res.ok) {
        const data = await res.json();
        setSplits({
          receivers: Array.isArray(data.receivers) ? data.receivers : [],
          hash: data.hash ?? "",
        });
      } else {
        setSplits({ receivers: [], hash: "" });
      }
    } catch {
      setSplits({ receivers: [], hash: "" });
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    fetchSplits();
  }, [fetchSplits]);

  const totalBps = splits?.receivers.reduce((sum, r) => sum + r.weight_bps, 0) ?? 0;

  return (
    <>
      <Navbar />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Splits Configuration</h1>
            <p className="text-zinc-400 mt-1 text-sm">
              Visualize how incoming funds are distributed among your split receivers.
            </p>
          </div>
          <Link
            href="/app"
            className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3.5 py-2 min-h-[44px] inline-flex items-center transition-colors"
          >
            ← Dashboard
          </Link>
        </div>

        {!publicKey ? (
          <div className="card p-12 text-center text-zinc-400">
            Connect your wallet to view splits configuration.
          </div>
        ) : loading ? (
          <SplitsSkeleton />
        ) : !splits || splits.receivers.length === 0 ? (
          <div className="card p-12 text-center text-zinc-400">
            No splits configured for this wallet.
          </div>
        ) : (
          <div className="card p-6 sm:p-8 space-y-6">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">Receivers</h2>
                <p className="text-sm text-zinc-500">
                  {splits.receivers.length} receiver{splits.receivers.length !== 1 ? "s" : ""} configured
                  {totalBps !== 10000 && (
                    <span className="text-amber-400 ml-2">
                      (Total: {totalBps} bps — should be 10,000)
                    </span>
                  )}
                </p>
              </div>
              <button
                onClick={fetchSplits}
                disabled={loading}
                className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-1.5 min-h-[44px] transition-colors disabled:opacity-40 inline-flex items-center"
              >
                ↻ Refresh
              </button>
            </div>

            <SplitsPieChart
              receivers={splits.receivers.map(r => ({ address: r.address, weightBps: r.weight_bps }))}
              selectedAddress={selectedAddress}
              onSelect={setSelectedAddress}
            />

            {/* Receiver table — drag-and-drop weight editor (#792) */}
            <div className="border-t border-white/5 pt-4">
              <h3 className="text-sm font-medium text-zinc-300 mb-3">All Receivers</h3>
              <SplitWeightEditor
                receivers={splits.receivers}
                onChange={(next) => setSplits((prev) => (prev ? { ...prev, receivers: next } : prev))}
              />
            </div>
          </div>
        )}
      </main>
    </>
  );
}
