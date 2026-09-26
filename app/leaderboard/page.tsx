"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import AddressLabel from "@/components/AddressLabel";
import { NATIVE_TOKEN, stroopsToXlm } from "@/lib/stellar";
import { getTokenSymbol } from "@/lib/tokens";

// Supported tokens for the leaderboard (#794). Extend as new tokens launch.
const SUPPORTED_TOKENS: Array<{ address: string; symbol: string }> = [
  { address: NATIVE_TOKEN, symbol: "XLM" },
];

interface TopSender {
  account: string;
  total_rate_per_sec: string;
  receiver_count: number;
}

function truncate(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function ratePerDay(ratePerSec: string): string {
  try {
    const perDay = BigInt(ratePerSec) * 86400n;
    return stroopsToXlm(perDay);
  } catch {
    return "0";
  }
}

export default function LeaderboardPage() {
  const [activeToken, setActiveToken] = useState<string>(SUPPORTED_TOKENS[0].address);
  const [senders, setSenders] = useState<TopSender[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/streams/top-senders?token=${encodeURIComponent(activeToken)}&limit=20`
      );
      if (!res.ok) throw new Error("Failed to load leaderboard");
      const data = await res.json();
      setSenders(Array.isArray(data.top_senders) ? data.top_senders : []);
      setLastUpdated(typeof data.last_updated === "number" ? data.last_updated : Math.floor(Date.now() / 1000));
    } catch (e) {
      console.error(e);
      setSenders([]);
    } finally {
      setLoading(false);
    }
  }, [activeToken]);

  useEffect(() => {
    setLoading(true);
    load();
    // Refresh every 60 seconds (#794).
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  const tokenSymbol = getTokenSymbol(activeToken);

  return (
    <>
      <Navbar />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Streaming Leaderboard</h1>
            <p className="text-zinc-400 mt-1 text-sm">
              Top 20 senders by total outgoing stream rate, per token.
            </p>
          </div>
          <Link
            href="/app"
            className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3.5 py-2 transition-colors"
          >
            ← Dashboard
          </Link>
        </div>

        <div className="flex gap-2 mb-6 flex-wrap" role="tablist" aria-label="Token filter">
          {SUPPORTED_TOKENS.map((t) => (
            <button
              key={t.address}
              role="tab"
              aria-selected={activeToken === t.address}
              onClick={() => setActiveToken(t.address)}
              className={`text-xs px-3.5 py-2 rounded-lg border font-medium transition-colors min-h-[44px] ${
                activeToken === t.address
                  ? "border-violet-500/60 bg-violet-500/10 text-violet-300"
                  : "border-white/10 text-zinc-400 hover:text-white"
              }`}
            >
              {t.symbol}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="card p-6 space-y-3" role="status" aria-label="Loading leaderboard">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 rounded bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : senders.length === 0 ? (
          <div className="card p-12 text-center text-zinc-400">
            No streaming activity for {tokenSymbol} yet.
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[36rem]">
                <thead>
                  <tr className="text-xs text-zinc-500 uppercase tracking-wider border-b border-white/5">
                    <th className="text-left py-3 px-4" scope="col">Rank</th>
                    <th className="text-left py-3 px-4" scope="col">Address</th>
                    <th className="text-left py-3 px-4" scope="col">Token</th>
                    <th className="text-right py-3 px-4" scope="col">Total rate / day</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {senders.slice(0, 20).map((sender, i) => (
                    <tr key={sender.account} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3 px-4 font-bold text-zinc-300 tabular-nums w-16">
                        #{i + 1}
                      </td>
                      <td className="py-3 px-4">
                        <Link
                          href={`/profile/${encodeURIComponent(sender.account)}`}
                          className="text-violet-300 hover:text-violet-200 transition-colors font-mono text-xs"
                          title={sender.account}
                        >
                          <span className="sm:hidden">{truncate(sender.account)}</span>
                          <span className="hidden sm:inline">
                            <AddressLabel address={sender.account} compact />
                          </span>
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-zinc-400">{tokenSymbol}</td>
                      <td className="py-3 px-4 text-right font-mono text-emerald-300 tabular-nums">
                        {ratePerDay(sender.total_rate_per_sec)} {tokenSymbol}/day
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lastUpdated !== null && (
              <p className="text-xs text-zinc-500 px-4 py-3 border-t border-white/5">
                Last updated {new Date(lastUpdated * 1000).toLocaleTimeString()} · refreshes every 60s
              </p>
            )}
          </div>
        )}
      </main>
    </>
  );
}
