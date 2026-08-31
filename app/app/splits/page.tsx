"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import SplitsPieChart from "@/components/SplitsPieChart";
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
          <div className="card p-12 text-center text-zinc-400 animate-pulse">
            Loading splits configuration...
          </div>
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
              receivers={splits.receivers}
              selectedAddress={selectedAddress}
              onSelect={setSelectedAddress}
            />

            {/* Receiver table */}
            <div className="border-t border-white/5 pt-4">
              <h3 className="text-sm font-medium text-zinc-300 mb-3">All Receivers</h3>
               <div className="overflow-x-auto -mx-1 px-1">
                 <table className="w-full text-sm min-w-[28rem]">
                  <thead>
                    <tr className="text-xs text-zinc-500 uppercase tracking-wider">
                      <th className="text-left py-2 px-3">Address</th>
                      <th className="text-right py-2 px-3">Weight (bps)</th>
                      <th className="text-right py-2 px-3">Percentage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {splits.receivers.map((receiver, i) => {
                      const pct = totalBps > 0 ? (receiver.weight_bps / totalBps) * 100 : 0;
                      const isSelected = selectedAddress === receiver.address;
                      return (
                        <tr
                          key={receiver.address + i}
                          className={`cursor-pointer transition-colors ${
                            isSelected ? "bg-white/5" : "hover:bg-white/[0.02]"
                          }`}
                          onClick={() =>
                            setSelectedAddress(
                              selectedAddress === receiver.address ? null : receiver.address,
                            )
                          }
                        >
                          <td className="py-2.5 px-3 font-mono text-xs text-zinc-300">
                            {receiver.address.slice(0, 10)}...{receiver.address.slice(-6)}
                          </td>
                          <td className="py-2.5 px-3 text-right tabular-nums text-zinc-300">
                            {receiver.weight_bps.toLocaleString()}
                          </td>
                          <td className="py-2.5 px-3 text-right tabular-nums text-zinc-300">
                            {pct.toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
