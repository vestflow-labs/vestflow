"use client";
import Navbar from "@/components/Navbar";
import Link from "next/link";
import { useEffect, useState } from "react";

interface ProtocolStats {
  total_value_locked: string;
  total_claimed: string;
  active_schedules: number;
  unique_beneficiaries: number;
  total_schedules: number;
  total_revoked: number;
  tvl_usd: string;
  last_updated: number;
}

export default function AnalyticsDashboard() {
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadStats() {
      try {
        setLoading(true);
        const response = await fetch("/api/analytics/stats");
        
        if (!response.ok) {
          setError("Failed to load analytics data");
          return;
        }

        const data = await response.json();
        setStats(data);
      } catch (err) {
        setError("Failed to load analytics");
        console.error(err);
      } finally {
        setLoading(false);
      }
    }

    loadStats();
    // Refresh every 2 minutes
    const interval = setInterval(loadStats, 120000);
    return () => clearInterval(interval);
  }, []);

  const formatAmount = (amount: string) => {
    try {
      const whole = BigInt(amount) / 10_000_000n;
      const frac = BigInt(amount) % 10_000_000n;
      const xlm = Number(`${whole}.${frac.toString().padStart(7, "0")}`);
      return xlm.toLocaleString("en-US", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      });
    } catch {
      return "0";
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  if (loading) {
    return (
      <>
        <Navbar />
        <main className="max-w-6xl mx-auto px-6 py-12">
          <div className="card p-8 text-center">
            <div className="inline-block">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-violet-500"></div>
            </div>
            <p className="text-zinc-400 mt-4">Loading analytics...</p>
          </div>
        </main>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Navbar />
        <main className="max-w-6xl mx-auto px-6 py-12">
          <div className="card p-8 text-center border-red-500/20">
            <p className="text-red-400 font-semibold mb-4">{error}</p>
            <Link href="/app" className="text-violet-400 hover:text-violet-300 transition-colors">
              ← Back to dashboard
            </Link>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <main className="max-w-6xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="mb-8">
          <Link href="/app" className="text-zinc-400 hover:text-zinc-300 transition-colors text-sm mb-4 inline-block">
            ← Back to dashboard
          </Link>
          <h1 className="text-4xl font-bold mb-2">Protocol Analytics</h1>
          <p className="text-zinc-400">
            Real-time insights into VestFlow protocol usage and activity
          </p>
        </div>

        {/* Main Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {/* Total Value Locked */}
          <div className="card p-6 border-violet-500/20 bg-gradient-to-br from-violet-500/10 to-transparent">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-zinc-400 text-sm mb-2">Total Value Locked</p>
                <div className="flex items-baseline gap-2">
                  <h2 className="text-3xl font-bold">
                    {formatAmount(stats?.total_value_locked || "0")}
                  </h2>
                  <span className="text-zinc-400 text-sm">XLM</span>
                </div>
              </div>
              <div className="text-2xl">💎</div>
            </div>
            <p className="text-sm text-zinc-500">
              ≈ ${stats?.tvl_usd || "0"} USD
            </p>
          </div>

          {/* Total Claimed */}
          <div className="card p-6 border-green-500/20 bg-gradient-to-br from-green-500/10 to-transparent">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-zinc-400 text-sm mb-2">Total Claimed</p>
                <div className="flex items-baseline gap-2">
                  <h2 className="text-3xl font-bold">
                    {formatAmount(stats?.total_claimed || "0")}
                  </h2>
                  <span className="text-zinc-400 text-sm">XLM</span>
                </div>
              </div>
              <div className="text-2xl">✅</div>
            </div>
            <p className="text-sm text-zinc-500">
              Released to beneficiaries
            </p>
          </div>

          {/* Active Schedules */}
          <div className="card p-6 border-blue-500/20 bg-gradient-to-br from-blue-500/10 to-transparent">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-zinc-400 text-sm mb-2">Active Schedules</p>
                <h2 className="text-3xl font-bold">
                  {stats?.active_schedules || 0}
                </h2>
              </div>
              <div className="text-2xl">⏱️</div>
            </div>
            <p className="text-sm text-zinc-500">
              Currently vesting
            </p>
          </div>

          {/* Unique Beneficiaries */}
          <div className="card p-6 border-orange-500/20 bg-gradient-to-br from-orange-500/10 to-transparent">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-zinc-400 text-sm mb-2">Unique Beneficiaries</p>
                <h2 className="text-3xl font-bold">
                  {stats?.unique_beneficiaries || 0}
                </h2>
              </div>
              <div className="text-2xl">👥</div>
            </div>
            <p className="text-sm text-zinc-500">
              Have claimed tokens
            </p>
          </div>

          {/* Total Schedules */}
          <div className="card p-6 border-pink-500/20 bg-gradient-to-br from-pink-500/10 to-transparent">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-zinc-400 text-sm mb-2">Total Schedules</p>
                <h2 className="text-3xl font-bold">
                  {stats?.total_schedules || 0}
                </h2>
              </div>
              <div className="text-2xl">📅</div>
            </div>
            <p className="text-sm text-zinc-500">
              Created on VestFlow
            </p>
          </div>

          {/* Revoked Schedules */}
          <div className="card p-6 border-red-500/20 bg-gradient-to-br from-red-500/10 to-transparent">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-zinc-400 text-sm mb-2">Revoked Schedules</p>
                <h2 className="text-3xl font-bold">
                  {stats?.total_revoked || 0}
                </h2>
              </div>
              <div className="text-2xl">🔴</div>
            </div>
            <p className="text-sm text-zinc-500">
              Cancelled by grantors
            </p>
          </div>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <div className="card p-6">
            <h3 className="text-lg font-semibold mb-4">Key Metrics</h3>
            <div className="space-y-4">
              <div className="flex justify-between items-center pb-3 border-b border-zinc-800">
                <span className="text-zinc-400">Average Schedule Value</span>
                <span className="font-semibold">
                  {stats && stats.total_schedules > 0
                    ? formatAmount(
                        String(
                          BigInt(stats.total_value_locked || "0") / BigInt(stats.total_schedules)
                        )
                      )
                    : "0"}
                  {" XLM"}
                </span>
              </div>
              <div className="flex justify-between items-center pb-3 border-b border-zinc-800">
                <span className="text-zinc-400">Revocation Rate</span>
                <span className="font-semibold">
                  {stats && stats.total_schedules > 0
                    ? ((stats.total_revoked / stats.total_schedules) * 100).toFixed(1)
                    : "0"}
                  %
                </span>
              </div>
              <div className="flex justify-between items-center pb-3 border-b border-zinc-800">
                <span className="text-zinc-400">Claimed vs Locked</span>
                <span className="font-semibold">
                  {stats && BigInt(stats.total_claimed || "0") + BigInt(stats.total_value_locked || "0") > 0n
                    ? (
                        (Number(BigInt(stats.total_claimed) || 0n) /
                          Number(BigInt(stats.total_claimed || "0") + BigInt(stats.total_value_locked || "0"))) *
                        100
                      ).toFixed(1)
                    : "0"}
                  %
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-400">Schedules per Beneficiary</span>
                <span className="font-semibold">
                  {stats && stats.unique_beneficiaries > 0
                    ? (stats.total_schedules / stats.unique_beneficiaries).toFixed(2)
                    : "0"}
                </span>
              </div>
            </div>
          </div>

          <div className="card p-6">
            <h3 className="text-lg font-semibold mb-4">Data Quality</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <span className="text-zinc-400">Last Updated</span>
                <span className="font-mono text-sm">
                  {stats ? formatDate(stats.last_updated) : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <span className="text-zinc-400">Data Source</span>
                <span className="text-sm text-violet-400">Stellar Soroban RPC</span>
              </div>
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <span className="text-zinc-400">Network</span>
                <span className="text-sm">Stellar Testnet</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Update Frequency</span>
                <span className="text-sm">Every 2 minutes</span>
              </div>
            </div>
          </div>
        </div>

        {/* Info Section */}
        <div className="card p-6 bg-blue-500/5 border-blue-500/20">
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <span>ℹ️</span> About These Metrics
          </h3>
          <ul className="space-y-2 text-sm text-zinc-400">
            <li>
              <strong className="text-zinc-300">Total Value Locked (TVL):</strong> Sum of all active vesting schedules not yet claimed.
            </li>
            <li>
              <strong className="text-zinc-300">Active Schedules:</strong> Schedules that haven't reached their end date and haven't been revoked.
            </li>
            <li>
              <strong className="text-zinc-300">Unique Beneficiaries:</strong> Number of unique addresses that have claimed tokens.
            </li>
          </ul>
        </div>
      </main>
    </>
  );
}
