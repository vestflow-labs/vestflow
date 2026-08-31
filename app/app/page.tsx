"use client";
import { useEffect, useMemo, useState } from "react";
import Navbar from "@/components/Navbar";
import ScheduleCard from "@/components/ScheduleCard";
import RecentlyViewedSchedules from "@/components/RecentlyViewedSchedules";
import SearchFilterBar from "@/components/SearchFilterBar";
import { matchesAddressOrToken } from "@/lib/tokens";
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
  getVestedAmountBulk,
  getGrantorScheduleIds,
  getBeneficiaryScheduleIds,
  getScheduleBatch,
  ScheduleData,
  vestingProgress,
  NATIVE_TOKEN,
  NETWORK,
  stroopsToXlm,
  revokeSchedule,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import { useCountUp } from "@/hooks/useCountUp";
import { useAddressBook } from "@/hooks/useAddressBook";
import { useRecentlyViewed } from "@/hooks/useRecentlyViewed";
import { useStreamNotifications } from "@/hooks/useStreamNotifications";
import Link from "next/link";

import { buildCombinedExportCSV, downloadCSV } from "@/lib/csvExport";
import WalletQrModal from "@/components/WalletQrModal";
import OnboardingTour from "@/components/OnboardingTour";
import CycleCountdown from "@/components/CycleCountdown";
import IncomingStreamsList from "@/components/IncomingStreamsList";

type RoleFilter = "all" | "grantor" | "beneficiary";
type StatusFilter = "all" | "active" | "completed" | "revoked";
type KindFilter = "all" | "Linear" | "Cliff" | "LinearWithCliff" | "Graded";
type SortKey = "newest" | "ending-soon" | "largest-amount" | "status";
const PAGE_SIZE = 10;

interface DashboardStats {
  totalGranted: bigint;
  totalReceiving: bigint;
  claimableNow: bigint;
  totalVested: bigint;
  activeSchedules: number;
}

interface IndexedEvent {
  id: string;
  event_type: string;
  ledger: number;
  ledger_closed_at: string;
  grantor?: string | null;
  beneficiary?: string | null;
  amount?: string | null;
  token?: string | null;
}

interface StreamTokenSummary {
  token: string;
  dripped: bigint;
  received: bigint;
}

function tokenLabel(token: string): string {
  if (token === NATIVE_TOKEN) return "XLM";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function formatAmount(value: bigint): string {
  return Number(stroopsToXlm(value)).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
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

  const toXlm = (v: bigint) => parseFloat(stroopsToXlm(v));

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
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
        label="Total Vested"
        value={toXlm(stats.totalVested)}
        unit="XLM earned"
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

function StreamsAnalyticsSummary({ publicKey, refreshKey }: { publicKey: string; refreshKey: number }) {
  const [summaries, setSummaries] = useState<StreamTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/events?address=${publicKey}&network=${NETWORK}&limit=200`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("events unavailable")))
      .then((data) => {
        if (cancelled) return;
        const byToken = new Map<string, StreamTokenSummary>();
        for (const event of (data.events ?? []) as IndexedEvent[]) {
          if (event.event_type !== "given" && event.event_type !== "collected") continue;
          const token = event.token ?? NATIVE_TOKEN;
          const amount = BigInt(event.amount ?? "0");
          const current = byToken.get(token) ?? { token, dripped: 0n, received: 0n };
          if (event.event_type === "given") {
            if (event.grantor === publicKey) current.dripped += amount;
            if (event.beneficiary === publicKey) current.received += amount;
          }
          if (event.event_type === "collected" && event.beneficiary === publicKey) {
            current.received += amount;
          }
          byToken.set(token, current);
        }
        setSummaries([...byToken.values()].sort((a, b) => tokenLabel(a.token).localeCompare(tokenLabel(b.token))));
      })
      .catch(() => {
        if (!cancelled) setSummaries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey, refreshKey]);

  if (loading) {
    return (
      <div className="card p-4 mb-6">
        <p className="text-sm text-zinc-400">Loading stream analytics...</p>
      </div>
    );
  }

  if (summaries.length === 0) return null;

  return (
    <div className="card p-5 mb-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold">Streams Analytics</h2>
          <p className="text-sm text-zinc-500">All-time dripped and received totals by token</p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {summaries.map((summary) => {
          const net = summary.received - summary.dripped;
          const netPositive = net >= 0n;
          return (
            <div key={summary.token} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs text-zinc-500 mb-3 font-mono">{tokenLabel(summary.token)}</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Dripped</span>
                  <span className="text-red-300 tabular-nums">{formatAmount(summary.dripped)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Received</span>
                  <span className="text-emerald-300 tabular-nums">{formatAmount(summary.received)}</span>
                </div>
                <div className="flex justify-between gap-3 border-t border-white/10 pt-2">
                  <span className="text-zinc-400">Net</span>
                  <span className={`tabular-nums font-semibold ${netPositive ? "text-emerald-300" : "text-red-300"}`}>
                    {netPositive ? "+" : "-"}{formatAmount(netPositive ? net : -net)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Outgoing Streams List (#632) ──────────────────────────────────────────────

function OutgoingStreamsList({
  schedules,
  publicKey,
  onEdit,
  onStop,
}: {
  schedules: ScheduleData[];
  publicKey: string;
  onEdit: (s: ScheduleData) => void;
  onStop: (s: ScheduleData) => void;
}) {
  const outgoing = schedules.filter(
    (s) => s.grantor === publicKey && !s.revoked,
  );

  if (outgoing.length === 0) return null;

  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="card p-5 mb-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Outgoing Streams</h2>
        <p className="text-sm text-zinc-500">All active vesting schedules sent from your wallet</p>
      </div>
      <div className="divide-y divide-white/10">
        {outgoing.map((s) => {
          const ratePerSec = s.duration > 0 ? s.total_amount / BigInt(s.duration) : 0n;
          const ratePerDay = ratePerSec * 86400n;
          const endTime = s.start_time + s.duration;
          const secsLeft = Math.max(0, endTime - now);
          const daysLeft = Math.floor(secsLeft / 86400);
          const isNative = s.token === NATIVE_TOKEN;
          const tokenSym = isNative ? "XLM" : `${s.token.slice(0, 5)}…`;
          const isBeneficiary = s.beneficiary === publicKey;
          const claimable = claimableMap.get(s.id) ?? 0n;

          return (
            <div key={s.id} className="flex items-start justify-between gap-4 py-4 text-sm">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/schedule/${s.id}`}
                    className="font-semibold text-zinc-200 hover:text-violet-300 transition-colors"
                  >
                    Schedule #{s.id}
                  </Link>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20">
                    {s.kind === "LinearWithCliff" ? "Lin+Cliff" : s.kind}
                  </span>
                </div>
                <p className="text-zinc-500 font-mono text-xs truncate">
                  → {s.beneficiary.slice(0, 10)}…{s.beneficiary.slice(-6)}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-zinc-500">
                  <span>
                    Rate:{" "}
                    <span className="text-zinc-300">
                      {stroopsToXlm(ratePerDay)} {tokenSym}/day
                    </span>
                  </span>
                  <span>
                    Remaining:{" "}
                    <span className={daysLeft < 7 ? "text-amber-400" : "text-zinc-300"}>
                      {daysLeft}d
                    </span>
                  </span>
                  <span>
                    Total:{" "}
                    <span className="text-zinc-300">
                      {stroopsToXlm(s.total_amount)} {tokenSym}
                    </span>
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                <button
                  onClick={() => onEdit(s)}
                  className="px-3 py-2 min-h-[44px] rounded-lg text-xs font-medium border border-white/10 text-zinc-300 hover:border-white/20 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => onStop(s)}
                  className="px-3 py-2 min-h-[44px] rounded-lg text-xs font-medium bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  Stop
                </button>
                {isBeneficiary && claimable > 0n && (
                  <button
                    onClick={() => {
                      // TODO: implement collect call
                    }}
                    className="px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 transition-colors flex items-center gap-2 grow sm:grow-0">
                    Collect {stroopsToXlm(claimable)} XLM
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecentGives({ publicKey, refreshKey }: { publicKey: string; refreshKey: number }) {
  const [gives, setGives] = useState<IndexedEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/events?address=${publicKey}&event_type=given&network=${NETWORK}&limit=50`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("gives unavailable")))
      .then((data) => {
        if (cancelled) return;
        const sorted = ((data.events ?? []) as IndexedEvent[])
          .filter((event) => event.event_type === "given")
          .sort((a, b) => b.ledger - a.ledger)
          .slice(0, 5);
        setGives(sorted);
      })
      .catch(() => {
        if (!cancelled) setGives([]);
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey, refreshKey]);

  if (gives.length === 0) return null;

  return (
    <div className="card p-5 mb-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold">Recent Gives</h2>
          <p className="text-sm text-zinc-500">Latest one-time gives sent or received</p>
        </div>
        <Link href="/app/history" className="text-sm text-violet-300 hover:text-violet-200 transition-colors">
          See all
        </Link>
      </div>
      <div className="divide-y divide-white/10">
        {gives.map((give) => {
          const sent = give.grantor === publicKey;
          const counterparty = sent ? give.beneficiary : give.grantor;
          return (
            <div key={give.id} className="flex items-center justify-between gap-3 py-3 text-sm">
              <div className="min-w-0">
                <p className={`font-medium ${sent ? "text-red-300" : "text-emerald-300"}`}>
                  {sent ? "Sent" : "Received"} {formatAmount(BigInt(give.amount ?? "0"))} {tokenLabel(give.token ?? NATIVE_TOKEN)}
                </p>
                {counterparty && (
                  <Link
                    href={`/app/profile/${encodeURIComponent(counterparty)}`}
                    className="font-mono text-xs text-zinc-500 hover:text-violet-300 transition-colors"
                  >
                    {counterparty.slice(0, 10)}...{counterparty.slice(-6)}
                  </Link>
                )}
              </div>
              <time className="text-xs text-zinc-500 whitespace-nowrap" dateTime={give.ledger_closed_at}>
                {new Date(give.ledger_closed_at).toLocaleDateString()}
              </time>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RpcErrorBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 mb-6 px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 text-sm"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span className="flex-1">
        Could not reach the Stellar RPC — check your connection and refresh.
      </span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss error banner"
        className="text-red-400 hover:text-red-200 transition-colors ml-2 leading-none"
      >
        ×
      </button>
    </div>
  );
}

export default function DashboardPage() {
  const { publicKey } = useWallet();
  const { getLabel } = useAddressBook();
  const { recentlyViewed } = useRecentlyViewed();
  const [schedules, setSchedules] = useState<ScheduleData[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [rpcError, setRpcError] = useState(false);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [tokenFilter, setTokenFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [startDateFilter, setStartDateFilter] = useState<string>("");
  const [endDateFilter, setEndDateFilter] = useState<string>("");
  const [sortBy, setSortBy] = useState<SortKey>("newest");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [showQrModal, setShowQrModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [stopConfirmSchedule, setStopConfirmSchedule] = useState<ScheduleData | null>(null);
  const [stoppingId, setStoppingId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setRpcError(false);
    try {
      if (publicKey) {
        // Use the on-chain grantor/beneficiary index instead of fetching all schedules.
        const [grantorIds, beneficiaryIds] = await Promise.all([
          getGrantorScheduleIds(publicKey),
          getBeneficiaryScheduleIds(publicKey),
        ]);
        const allIds = [...new Set([...grantorIds, ...beneficiaryIds])].sort((a, b) => a - b);
        const userSchedules = allIds.length > 0
          ? (await getScheduleBatch(allIds, publicKey)).filter(Boolean) as ScheduleData[]
          : [];
        setSchedules(userSchedules);

        // Compute aggregate stats
        const userIds = userSchedules.map(s => s.id);
        const claimableAmounts = await getClaimableBulk(userIds, publicKey);
        const vestedAmounts = await getVestedAmountBulk(userIds, publicKey);
        
        const claimableMap = new Map<number, bigint>();
        const vestedMap = new Map<number, bigint>();
        userIds.forEach((id, i) => {
          claimableMap.set(id, claimableAmounts[i] ?? 0n);
          vestedMap.set(id, vestedAmounts[i] ?? 0n);
        });

        const now = Math.floor(Date.now() / 1000);
        let totalGranted = 0n;
        let totalReceiving = 0n;
        let claimableNow = 0n;
        let totalVested = 0n;
        let activeSchedules = 0;

        for (const s of userSchedules) {
          if (s.grantor === publicKey) {
            totalGranted += s.total_amount;
          }
          if (s.beneficiary === publicKey) {
            totalReceiving += s.total_amount;
            claimableNow += claimableMap.get(s.id) ?? 0n;
            totalVested += vestedMap.get(s.id) ?? 0n;
          }
          if (!s.revoked && vestingProgress(s, now) < 100) {
            activeSchedules++;
          }
        }

        setStats({ totalGranted, totalReceiving, claimableNow, totalVested, activeSchedules });
      } else {
        const all = await getAllSchedules();
        setSchedules(all.slice(0, 6));
        setStats(null);
      }
    } catch (err) {
      const isNetworkError =
        err instanceof TypeError ||
        (err instanceof Error && /fetch|network|rpc|connect|econnrefused|timeout/i.test(err.message));
      if (isNetworkError) {
        setRpcError(true);
      }
    } finally {
      setLoading(false);
      setRefreshKey((value) => value + 1);
    }
  };

  useEffect(() => { load(); }, [publicKey]);

  // Stream notifications for incoming streams
  useStreamNotifications(publicKey ? schedules : null, publicKey);

  // Recently viewed schedules (#416), resolved from the wallet-filtered list
  // and ordered most-recent-first.
  const recentSchedules = useMemo(() => {
    return recentlyViewed
      .map((id) => schedules.find((s) => s.id === id))
      .filter((s): s is ScheduleData => !!s);
  }, [recentlyViewed, schedules]);

  // Apply role filter on top of the wallet-filtered list
  const roleFiltered = useMemo(() => {
    if (!publicKey || roleFilter === "all") return schedules;
    if (roleFilter === "grantor") return schedules.filter(s => s.grantor === publicKey);
    return schedules.filter(s => s.beneficiary === publicKey);
  }, [schedules, roleFilter, publicKey]);

  // Get unique token addresses from schedules
  const uniqueTokens = useMemo(() => {
    const tokens = new Set(schedules.map(s => s.token));
    return Array.from(tokens);
  }, [schedules]);

  // Apply additional filters
  const multiFiltered = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    let filtered = [...roleFiltered];

    // Status filter
    if (statusFilter !== "all") {
      filtered = filtered.filter(s => {
        if (statusFilter === "revoked") return s.revoked;
        if (statusFilter === "completed") return !s.revoked && vestingProgress(s, now) >= 100;
        if (statusFilter === "active") return !s.revoked && vestingProgress(s, now) < 100;
        return true;
      });
    }

    // Token filter
    if (tokenFilter !== "all") {
      filtered = filtered.filter(s => s.token === tokenFilter);
    }

    // Vesting kind filter
    if (kindFilter !== "all") {
      filtered = filtered.filter(s => s.kind === kindFilter);
    }

    // Date range filters
    if (startDateFilter) {
      const startTimestamp = new Date(startDateFilter).getTime() / 1000;
      filtered = filtered.filter(s => s.start_time >= startTimestamp);
    }
    if (endDateFilter) {
      const endTimestamp = new Date(endDateFilter).getTime() / 1000;
      filtered = filtered.filter(s => (s.start_time + s.duration) <= endTimestamp);
    }

    return filtered;
  }, [roleFiltered, statusFilter, tokenFilter, kindFilter, startDateFilter, endDateFilter]);

  // Apply sort on top of the multi-filtered list
  const sortedSchedules = useMemo(() => {
    const list = [...multiFiltered];
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
  }, [multiFiltered, sortBy]);

  // Apply address prefix and token search on top of sorted list (Issue #647)
  const q = query.trim().toLowerCase();
  const searchFiltered = useMemo(() => {
    if (!q) return sortedSchedules;
    return sortedSchedules.filter(s =>
      matchesAddressOrToken(
        q,
        [s.grantor, s.beneficiary],
        [s.token],
        [getLabel(s.grantor), getLabel(s.beneficiary)]
      )
    );
  }, [sortedSchedules, q, getLabel]);

  // Reset to page 1 whenever the filtered set changes
  useEffect(() => { setPage(1); }, [searchFiltered.length, roleFilter, statusFilter, tokenFilter, kindFilter, startDateFilter, endDateFilter, sortBy]);

  const totalPages = Math.max(1, Math.ceil(searchFiltered.length / PAGE_SIZE));
  const pageStart = (page - 1) * PAGE_SIZE;
  const paginated = searchFiltered.slice(pageStart, pageStart + PAGE_SIZE);

  const handleExportCSV = () => {
    const csv = buildCombinedExportCSV(multiFiltered);
    const timestamp = new Date().toISOString().split('T')[0];
    downloadCSV(csv, `vestflow-schedules-${timestamp}.csv`);
  };

  const clearAllFilters = () => {
    setStatusFilter("all");
    setTokenFilter("all");
    setKindFilter("all");
    setStartDateFilter("");
    setEndDateFilter("");
    setQuery("");
  };

  const hasActiveFilters = statusFilter !== "all" || tokenFilter !== "all" || kindFilter !== "all" || startDateFilter || endDateFilter || query;

  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        {/* RPC offline banner (#278) */}
        {rpcError && <RpcErrorBanner onDismiss={() => setRpcError(false)} />}

        {/* Header row */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold">Dashboard</h1>
            <p className="text-zinc-400 mt-1">Your active vesting schedules</p>
          </div>
          <div className="flex gap-3 flex-wrap items-center">
            {publicKey && (
              <button
                onClick={() => setShowQrModal(true)}
                className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-2 transition-colors flex items-center gap-1.5"
                aria-label="Show wallet QR code"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                </svg>
                Wallet QR
              </button>
            )}
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

        {/* Cycle countdown timer (#630) */}
        {publicKey && (
          <div className="mb-6">
            <CycleCountdown onCycleEnd={() => setRefreshKey((k) => k + 1)} />
          </div>
        )}

        {/* Summary stats — animated count-up (#270) */}
        {publicKey && stats && <AnimatedStats stats={stats} />}
        {publicKey && <IncomingStreamsList publicKey={publicKey} refreshKey={refreshKey} />}
        {publicKey && <StreamsAnalyticsSummary publicKey={publicKey} refreshKey={refreshKey} />}
        {publicKey && schedules.length > 0 && (
          <OutgoingStreamsList
            schedules={schedules}
            publicKey={publicKey}
            onEdit={(s) => { window.location.href = `/schedule/${s.id}`; }}
            onStop={(s) => setStopConfirmSchedule(s)}
          />
        )}
        {publicKey && <RecentGives publicKey={publicKey} refreshKey={refreshKey} />}

        {/* Recently viewed schedules (#416) */}
        {publicKey && <RecentlyViewedSchedules schedules={recentSchedules} />}

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

        {/* Filter controls */}
        {publicKey && schedules.length > 0 && (
          <div className="card p-4 mb-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-zinc-300">Filters</h3>
              {hasActiveFilters && (
                <button
                  onClick={clearAllFilters}
                  className="text-xs text-zinc-500 hover:text-white transition-colors"
                >
                  Clear all filters
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
              {/* Status filter */}
              <div>
                <label htmlFor="status-filter" className="block text-xs text-zinc-500 mb-1.5">
                  Status
                </label>
                <select
                  id="status-filter"
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value as StatusFilter)}
                  className="w-full text-xs bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-zinc-300 outline-none focus:border-violet-500/50 transition-colors"
                >
                  <option value="all">All statuses</option>
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                  <option value="revoked">Revoked</option>
                </select>
              </div>

              {/* Vesting kind filter */}
              <div>
                <label htmlFor="kind-filter" className="block text-xs text-zinc-500 mb-1.5">
                  Vesting Kind
                </label>
                <select
                  id="kind-filter"
                  value={kindFilter}
                  onChange={e => setKindFilter(e.target.value as KindFilter)}
                  className="w-full text-xs bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-zinc-300 outline-none focus:border-violet-500/50 transition-colors"
                >
                  <option value="all">All kinds</option>
                  <option value="Linear">Linear</option>
                  <option value="Cliff">Cliff</option>
                  <option value="LinearWithCliff">Linear with Cliff</option>
                  <option value="Graded">Graded</option>
                </select>
              </div>

              {/* Token filter */}
              <div>
                <label htmlFor="token-filter" className="block text-xs text-zinc-500 mb-1.5">
                  Token
                </label>
                <select
                  id="token-filter"
                  value={tokenFilter}
                  onChange={e => setTokenFilter(e.target.value)}
                  className="w-full text-xs bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-zinc-300 outline-none focus:border-violet-500/50 transition-colors"
                >
                  <option value="all">All tokens</option>
                  {uniqueTokens.map(token => {
                    const isNative = token === NATIVE_TOKEN;
                    const label = isNative ? "XLM (Native)" : `${token.slice(0, 8)}...${token.slice(-4)}`;
                    return (
                      <option key={token} value={token}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* Start date filter */}
              <div>
                <label htmlFor="start-date-filter" className="block text-xs text-zinc-500 mb-1.5">
                  Start date from
                </label>
                <input
                  type="date"
                  id="start-date-filter"
                  value={startDateFilter}
                  onChange={e => setStartDateFilter(e.target.value)}
                  className="w-full text-xs bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-zinc-300 outline-none focus:border-violet-500/50 transition-colors"
                />
              </div>

              {/* End date filter */}
              <div>
                <label htmlFor="end-date-filter" className="block text-xs text-zinc-500 mb-1.5">
                  End date until
                </label>
                <input
                  type="date"
                  id="end-date-filter"
                  value={endDateFilter}
                  onChange={e => setEndDateFilter(e.target.value)}
                  className="w-full text-xs bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-zinc-300 outline-none focus:border-violet-500/50 transition-colors"
                />
              </div>
            </div>
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

        {/* Search / filter bar (Issue #647) */}
        <div className="mb-6">
          <SearchFilterBar
            value={query}
            onChange={setQuery}
            placeholder="Filter streams by address prefix or token symbol…"
            resultCount={searchFiltered.length}
            totalCount={multiFiltered.length}
          />
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

      {/* QR Code Modal */}
      {publicKey && (
        <WalletQrModal
          address={publicKey}
          open={showQrModal}
          onClose={() => setShowQrModal(false)}
        />
      )}

      {/* Onboarding Tour */}
      <OnboardingTour />

      {/* Stop Stream confirmation dialog */}
      {stopConfirmSchedule && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Stop stream confirmation"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setStopConfirmSchedule(null)} />
          <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
            <h2 className="text-lg font-bold mb-2">Stop Stream?</h2>
            <p className="text-sm text-zinc-400 mb-5">
              This will revoke schedule #{stopConfirmSchedule.id} and stop all future vesting. Unvested tokens will be returned to your wallet.
              This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setStopConfirmSchedule(null)}
                disabled={stoppingId !== null}
                className="flex-1 rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-zinc-300 hover:border-white/20 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                disabled={stoppingId !== null}
                onClick={async () => {
                  if (!publicKey || !stopConfirmSchedule) return;
                  setStoppingId(stopConfirmSchedule.id);
                  try {
                    await revokeSchedule(publicKey, stopConfirmSchedule.id);
                    setStopConfirmSchedule(null);
                    setRefreshKey((k) => k + 1);
                  } catch {
                    // leave dialog open on error so user sees failure
                  } finally {
                    setStoppingId(null);
                  }
                }}
                className="flex-1 rounded-xl bg-red-600 hover:bg-red-700 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50"
              >
                {stoppingId === stopConfirmSchedule.id ? "Stopping…" : "Stop Stream"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
