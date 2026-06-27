"use client";
import { useEffect, useMemo, useState } from "react";
import Navbar from "@/components/Navbar";
import ScheduleCard from "@/components/ScheduleCard";
import { ScheduleListSkeleton } from "@/components/ScheduleCardSkeleton";
import {
  NoSchedulesEmptyState,
  NoSearchResultsEmptyState,
  NoGrantorSchedulesEmptyState,
  NoBeneficiarySchedulesEmptyState,
} from "@/components/EmptyState";
import {
  getAllSchedules,
  getClaimableBulk,
  ScheduleData,
  vestingProgress,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import { useCountUp } from "@/hooks/useCountUp";
import { useAddressBook } from "@/hooks/useAddressBook";
import Link from "next/link";

import { buildCombinedExportCSV, downloadCSV } from "@/lib/csvExport";

type RoleFilter = "all" | "grantor" | "beneficiary";
type SortKey = "newest" | "ending-soon" | "largest-amount" | "status";
const PAGE_SIZE = 10;
const ALL_ASSETS = "all";

interface DashboardStats {
  totalGranted: bigint;
  totalReceiving: bigint;
  claimableNow: bigint;
  activeSchedules: number;
}

// ── Animated stats bar (#94) ──────────────────────────────────────────────────

function AnimatedStatCard({
  label,
  value,
  unit,
  color,
  decimals = 4,
  enabled,
}: {
  label: string;
  value: number;
  unit: string;
  color?: string;
  decimals?: number;
  enabled: boolean;
}) {
  const animated = useCountUp(value, 1200, enabled);
  const display = animated.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
  return (
    <div className="card p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${color ?? "text-white"}`}>{display}</p>
      <p className="text-xs text-zinc-500">{unit}</p>
    </div>
  );
}

function AnimatedStats({ stats }: { stats: DashboardStats }) {
  const [fired, setFired] = useState(false);
  useEffect(() => {
    // Trigger animation on the frame after mount so we get the count-up from 0
    const id = requestAnimationFrame(() => setFired(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const toXlm = (v: bigint) => Number(v) / 10_000_000;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      <AnimatedStatCard
        label="Total Granted"
        value={toXlm(stats.totalGranted)}
        unit="XLM as grantor"
        decimals={4}
        enabled={fired}
      />
      <AnimatedStatCard
        label="Total Receiving"
        value={toXlm(stats.totalReceiving)}
        unit="XLM as beneficiary"
        decimals={4}
        enabled={fired}
      />
      <AnimatedStatCard
        label="Claimable Now"
        value={toXlm(stats.claimableNow)}
        unit="XLM available"
        color="text-emerald-400"
        decimals={4}
        enabled={fired}
      />
      <AnimatedStatCard
        label="Active Schedules"
        value={stats.activeSchedules}
        unit="Currently vesting"
        decimals={0}
        enabled={fired}
      />
    </div>
  );
}

export default function DashboardPage() {
  const { publicKey } = useWallet();
  const { getLabel } = useAddressBook();
  const [schedules, setSchedules] = useState<ScheduleData[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [sortBy, setSortBy] = useState<SortKey>("newest");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState(ALL_ASSETS);

  const load = async () => {
    setLoading(true);
    try {
      const all = await getAllSchedules(publicKey ?? undefined);
      if (publicKey) {
        const userSchedules = all.filter(s => s.grantor === publicKey || s.beneficiary === publicKey);
        setSchedules(userSchedules);

        // Compute aggregate stats
        const userIds = userSchedules.map(s => s.id);
        const claimableAmounts = await getClaimableBulk(userIds, publicKey);
        const claimableMap = new Map<number, bigint>();
        userIds.forEach((id, i) => claimableMap.set(id, claimableAmounts[i] ?? 0n));

        const now = Math.floor(Date.now() / 1000);
        let totalGranted = 0n;
        let totalReceiving = 0n;
        let claimableNow = 0n;
        let activeSchedules = 0;

        for (const s of userSchedules) {
          if (s.grantor === publicKey) {
            totalGranted += s.total_amount;
          }
          if (s.beneficiary === publicKey) {
            totalReceiving += s.total_amount;
            claimableNow += claimableMap.get(s.id) ?? 0n;
          }
          if (!s.revoked && vestingProgress(s, now) < 100) {
            activeSchedules++;
          }
        }

        setStats({ totalGranted, totalReceiving, claimableNow, activeSchedules });
      } else {
        setSchedules(all.slice(0, 6));
        setStats(null);
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [publicKey]);

  // Get unique assets from schedules
  const availableAssets = useMemo(() => {
    const assets = new Set<string>();
    schedules.forEach(s => assets.add(s.token));
    return Array.from(assets).sort();
  }, [schedules]);

  // Apply role filter on top of the wallet-filtered list
  const roleFiltered = useMemo(() => {
    if (!publicKey || roleFilter === "all") return schedules;
    if (roleFilter === "grantor") return schedules.filter(s => s.grantor === publicKey);
    return schedules.filter(s => s.beneficiary === publicKey);
  }, [schedules, roleFilter, publicKey]);

  // Apply asset filter
  const filteredSchedules = useMemo(() => {
    if (assetFilter === ALL_ASSETS) return roleFiltered;
    return roleFiltered.filter(s => s.token === assetFilter);
  }, [roleFiltered, assetFilter]);

  // Apply sort on top of the role-filtered list
  const sortedSchedules = useMemo(() => {
    const list = [...filteredSchedules];
    const now = Math.floor(Date.now() / 1000);
    switch (sortBy) {
      case "newest":
        list.sort((a, b) => b.id - a.id);
        break;
      case "ending-soon":
        list.sort((a, b) => (a.start_time + a.duration) - (b.start_time + b.duration));
        break;
      case "largest-amount":
        list.sort((a, b) => (b.total_amount < a.total_amount ? -1 : b.total_amount > a.total_amount ? 1 : 0));
        break;
      case "status": {
        const statusOrder = (s: ScheduleData) => s.revoked ? 2 : vestingProgress(s, now) >= 100 ? 0 : 1;
        list.sort((a, b) => statusOrder(a) - statusOrder(b));
        break;
      }
    }
    return list;
  }, [filteredSchedules, sortBy]);

  // Apply address search on top of sorted list
  const q = query.trim().toLowerCase();
  const searchFiltered = useMemo(() => {
    if (!q) return sortedSchedules;
    return sortedSchedules.filter(
      s =>
        s.grantor.toLowerCase().includes(q) ||
        s.beneficiary.toLowerCase().includes(q) ||
        (getLabel(s.grantor) ?? "").toLowerCase().includes(q) ||
        (getLabel(s.beneficiary) ?? "").toLowerCase().includes(q)
    );
  }, [sortedSchedules, q, getLabel]);

  // Reset to page 1 whenever the filtered set changes
  useEffect(() => { setPage(1); }, [searchFiltered.length, roleFilter, sortBy, assetFilter]);

  const totalPages = Math.max(1, Math.ceil(searchFiltered.length / PAGE_SIZE));
  const pageStart = (page - 1) * PAGE_SIZE;
  const paginated = searchFiltered.slice(pageStart, pageStart + PAGE_SIZE);

  const handleExportCSV = () => {
    const csv = buildCombinedExportCSV(filteredSchedules);
    const timestamp = new Date().toISOString().split('T')[0];
    downloadCSV(csv, `vestflow-schedules-${timestamp}.csv`);
  };

  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        {/* Header row */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold">Dashboard</h1>
            <p className="text-zinc-400 mt-1">Your active vesting schedules</p>
          </div>
          <div className="flex gap-3 flex-wrap items-center">
            <button
              onClick={load}
              disabled={loading}
              className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-2 transition-colors disabled:opacity-40"
            >
              {loading ? "Loading…" : "↻ Refresh"}
            </button>
            {publicKey && schedules.length > 0 && (
              <button
                onClick={handleExportCSV}
                className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-2 transition-colors"
              >
                ↓ Export CSV
              </button>
            )}
            <Link href="/app/create" className="btn-primary rounded-lg px-4 py-2 text-sm font-semibold text-white">
              + New Schedule
            </Link>
          </div>
        </div>

        {/* Summary stats — animated count-up (#270) */}
        {publicKey && stats && <AnimatedStats stats={stats} />}

        {/* Role filter tabs (only when wallet connected and there are schedules) */}
        {publicKey && schedules.length > 0 && (
          <div className="flex gap-2 mb-5">
            {(["all", "grantor", "beneficiary"] as RoleFilter[]).map(r => (
              <button
                key={r}
                onClick={() => setRoleFilter(r)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors capitalize ${
                  roleFilter === r
                    ? "border-violet-500/60 bg-violet-500/10 text-violet-300"
                    : "border-white/10 text-zinc-400 hover:text-white"
                }`}
              >
                {r === "all" ? "All" : r === "grantor" ? "As Grantor" : "As Beneficiary"}
              </button>
            ))}
          </div>
        )}

        {/* Asset filter */}
        {schedules.length > 0 && availableAssets.length > 0 && (
          <div className="flex items-center gap-2 mb-5 flex-wrap">
            <label htmlFor="asset-select" className="text-xs text-zinc-500">Asset</label>
            <select
              id="asset-select"
              value={assetFilter}
              onChange={e => setAssetFilter(e.target.value)}
              className="text-xs bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-zinc-300 outline-none focus:border-violet-500/50 transition-colors"
            >
              <option value={ALL_ASSETS}>All assets</option>
              {availableAssets.map(asset => (
                <option key={asset} value={asset}>
                  {asset.slice(0, 8)}...
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Sort control */}
        {searchFiltered.length > 0 && (
          <div className="flex items-center gap-2 mb-5">
            <label htmlFor="sort-select" className="text-xs text-zinc-500">Sort by</label>
            <select
              id="sort-select"
              value={sortBy}
              onChange={e => setSortBy(e.target.value as SortKey)}
              className="text-xs bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-zinc-300 outline-none focus:border-violet-500/50 transition-colors"
            >
              <option value="newest">Newest first</option>
              <option value="ending-soon">Ending soonest</option>
              <option value="largest-amount">Largest amount</option>
              <option value="status">Status (vesting → fully vested → revoked)</option>
            </select>
          </div>
        )}

        {/* Address search input */}
        <div className="relative mb-6">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by address or label…"
            className="input pr-8"
            aria-label="Search schedules by address or label"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white transition-colors"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        {/* Schedule grid */}
        {loading && schedules.length === 0 ? (
          <ScheduleListSkeleton count={6} />
        ) : searchFiltered.length === 0 ? (
          q ? (
            <NoSearchResultsEmptyState 
              searchQuery={q} 
              onClearSearch={() => setQuery("")} 
            />
          ) : publicKey ? (
            roleFilter === "grantor" ? (
              <NoGrantorSchedulesEmptyState />
            ) : roleFilter === "beneficiary" ? (
              <NoBeneficiarySchedulesEmptyState />
            ) : (
              <NoSchedulesEmptyState isConnected={true} />
            )
          ) : (
            <NoSchedulesEmptyState isConnected={false} />
          )
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {paginated.map(s => (
                <ScheduleCard key={s.id} schedule={s} onAction={load} />
              ))}
            </div>

            {/* Pagination controls */}
            <div className="flex items-center justify-between mt-6 flex-wrap gap-3">
              <p className="text-sm text-zinc-500">
                Showing{" "}
                <span className="text-zinc-300">
                  {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, searchFiltered.length)}
                </span>{" "}
                of{" "}
                <span className="text-zinc-300">{searchFiltered.length}</span>{" "}
                schedule{searchFiltered.length !== 1 ? "s" : ""}
              </p>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40"
                  >
                    ← Previous
                  </button>
                  <span className="text-sm text-zinc-500">
                    {page} / {totalPages}
                  </span>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40"
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </>
  );
}
