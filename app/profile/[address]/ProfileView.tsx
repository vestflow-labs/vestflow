"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import ScheduleCard from "@/components/ScheduleCard";
import CopyLinkButton from "@/components/CopyLinkButton";
import FundProjectButton from "./FundProjectButton";
import AddressLabel from "@/components/AddressLabel";
import SearchFilterBar from "@/components/SearchFilterBar";
import EmptyState, { NoSearchResultsEmptyState } from "@/components/EmptyState";
import { ScheduleListSkeleton } from "@/components/ScheduleCardSkeleton";
import DependencyTree from "@/components/DependencyTree";
import {
  getGrantorScheduleIds,
  getBeneficiaryScheduleIds,
  getScheduleBatch,
  ScheduleData,
  stroopsToXlm,
  vestingProgress,
  truncate,
  NETWORK,
} from "@/lib/stellar";
import { getTokenSymbol, matchesAddressOrToken } from "@/lib/tokens";
import { useAddressBook } from "@/hooks/useAddressBook";

interface ProfileSupplementalData {
  outgoing_streams: Array<{
    receiver: string;
    token: string;
    rate_per_second: string;
    estimated_end_time: number | null;
  }>;
  drips_lists: Array<{
    id: string;
    name: string;
    token: string;
    member_count: number;
    total_funding_rate_per_sec: string;
  }>;
  gives: {
    records: Array<{
      id: string;
      sender: string;
      receiver: string;
      token: string;
      amount_stroops: string;
      timestamp: number;
    }>;
  };
}

interface SplitsData {
  receivers: Array<{ receiver: string; weight_bps: number }>;
}

interface ProfileViewProps {
  address: string;
}

export default function ProfileView({ address }: ProfileViewProps) {
  const { getLabel } = useAddressBook();
  const [schedules, setSchedules] = useState<ScheduleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"all" | "grantor" | "beneficiary">("all");
  const [query, setQuery] = useState("");
  const [supplemental, setSupplemental] = useState<ProfileSupplementalData | null>(null);
  const [splits, setSplits] = useState<SplitsData>({ receivers: [] });
  const [activityLoading, setActivityLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      try {
        const [grantorIds, beneficiaryIds] = await Promise.all([
          getGrantorScheduleIds(address).catch(() => []),
          getBeneficiaryScheduleIds(address).catch(() => []),
        ]);
        const allIds = [...new Set([...grantorIds, ...beneficiaryIds])].sort((a, b) => a - b);
        if (allIds.length > 0) {
          const list = (await getScheduleBatch(allIds, address)).filter(Boolean) as ScheduleData[];
          if (mounted) setSchedules(list);
        } else {
          if (mounted) setSchedules([]);
        }
      } catch (e) {
        console.error("Failed to load profile schedules", e);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, [address]);

  useEffect(() => {
    let mounted = true;
    setActivityLoading(true);
    Promise.all([
      fetch(`/api/profile/${encodeURIComponent(address)}`).then(response => response.ok ? response.json() : null),
      fetch(`/api/splits?account=${encodeURIComponent(address)}`).then(response => response.ok ? response.json() : { receivers: [] }),
    ]).then(([profile, splitConfig]) => {
      if (!mounted) return;
      setSupplemental(profile);
      setSplits(splitConfig);
    }).catch(() => {
      if (mounted) setSupplemental(null);
    }).finally(() => {
      if (mounted) setActivityLoading(false);
    });
    return () => { mounted = false; };
  }, [address]);

  const stats = useMemo(() => {
    let totalGranted = 0n;
    let totalReceiving = 0n;
    let activeCount = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const s of schedules) {
      if (s.grantor === address) totalGranted += s.total_amount;
      if (s.beneficiary === address) totalReceiving += s.total_amount;
      if (!s.revoked && vestingProgress(s, now) < 100) activeCount++;
    }

    return { totalGranted, totalReceiving, activeCount };
  }, [schedules, address]);

  const tabFiltered = useMemo(() => {
    if (activeTab === "grantor") return schedules.filter(s => s.grantor === address);
    if (activeTab === "beneficiary") return schedules.filter(s => s.beneficiary === address);
    return schedules;
  }, [schedules, activeTab, address]);

  const searchFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tabFiltered;
    return tabFiltered.filter(s =>
      matchesAddressOrToken(
        q,
        [s.grantor, s.beneficiary],
        [s.token],
        [getLabel(s.grantor), getLabel(s.beneficiary)]
      )
    );
  }, [tabFiltered, query, getLabel]);

  const customLabel = getLabel(address);
  const gives = supplemental?.gives.records ?? [];
  const outgoingStreams = supplemental?.outgoing_streams ?? [];
  const ownedLists = supplemental?.drips_lists ?? [];
  const hasActivity = schedules.length > 0 || splits.receivers.length > 0 ||
    gives.length > 0 || outgoingStreams.length > 0 || ownedLists.length > 0;

  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        {/* Profile Header */}
        <div className="card p-6 sm:p-8 mb-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-violet-600 to-indigo-500 flex items-center justify-center text-2xl font-bold text-white shadow-lg shadow-violet-500/20">
                {address.slice(0, 2)}
              </div>
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="text-xl sm:text-2xl font-bold text-white">
                    {customLabel || truncate(address)}
                  </h1>
                  <span className="text-xs px-2.5 py-0.5 rounded-full border border-white/10 bg-white/5 text-zinc-400 font-mono">
                    {NETWORK}
                  </span>
                </div>
                <div className="mt-1">
                  <AddressLabel address={address} />
                </div>
              </div>
            </div>

            {/* Profile actions: fund this project (#812) + share (#648) */}
            <div className="flex items-center gap-3">
              <FundProjectButton address={address} />
              <CopyLinkButton label="Copy Profile Link" />
              {stats.activeCount > 0 && (
                <button
                  onClick={() => {
                    const profileUrl = typeof window !== "undefined" ? window.location.href : "";
                    const rate = stats.totalGranted > 0n
                      ? stroopsToXlm((stats.totalGranted / BigInt(Math.max(1, stats.activeCount))))
                      : "0";
                    const text = `I'm streaming tokens on Drips! 🌊 ${rate} per day to my network. Check out my profile: ${profileUrl}`;
                    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
                    window.open(twitterUrl, "_blank", "width=550,height=420");
                  }}
                  className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-2 transition-colors flex items-center gap-1.5"
                  aria-label="Share to Twitter"
                  title="Share profile on Twitter"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M23 3a10.9 10.9 0 01-3.14 1.53 4.48 4.48 0 00-7.86 3v1A10.66 10.66 0 013 4s-4 9 5 13a11.64 11.64 0 01-7 2s9 5 20 5a9.5 9.5 0 00-9-5.5c4.75-2.35 7-7 7-11.5a4.5 4.5 0 00-.08-.83A7.72 7.72 0 0323 3z" />
                  </svg>
                  Share on X
                </button>
              )}
            </div>
          </div>

          {/* Profile Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-white/5">
            <div className="p-3 bg-white/3 rounded-xl border border-white/5">
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Total Outgoing</p>
              <p className="text-lg font-bold text-white">{stroopsToXlm(stats.totalGranted)} XLM</p>
              <p className="text-[11px] text-zinc-500">as grantor</p>
            </div>
            <div className="p-3 bg-white/3 rounded-xl border border-white/5">
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Total Inbound</p>
              <p className="text-lg font-bold text-emerald-400">{stroopsToXlm(stats.totalReceiving)} XLM</p>
              <p className="text-[11px] text-zinc-500">as beneficiary</p>
            </div>
            <div className="p-3 bg-white/3 rounded-xl border border-white/5">
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Active Streams</p>
              <p className="text-lg font-bold text-white">{stats.activeCount}</p>
              <p className="text-[11px] text-zinc-500">currently vesting</p>
            </div>
          </div>
        </div>

        {/* Tab Selection */}
        <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
          <div className="flex gap-2">
            {(
              [
                { id: "all", label: `All Streams (${schedules.length})` },
                { id: "grantor", label: "Outgoing" },
                { id: "beneficiary", label: "Incoming" },
              ] as const
            ).map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`text-xs px-3.5 py-2 rounded-lg border font-medium transition-colors ${
                  activeTab === tab.id
                    ? "border-violet-500/60 bg-violet-500/10 text-violet-300"
                    : "border-white/10 text-zinc-400 hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="w-full sm:w-72">
            <SearchFilterBar
              value={query}
              onChange={setQuery}
              placeholder="Filter streams by address or token…"
            />
          </div>
        </div>

        {/* Stream List */}
        {loading ? (
          <ScheduleListSkeleton count={4} />
        ) : !activityLoading && !hasActivity ? (
          <EmptyState
            icon="🌱"
            title="No activity yet"
            description="This account has no vesting schedules, streams, splits, gives, or Drips lists."
          />
        ) : searchFiltered.length === 0 ? (
          query ? (
            <NoSearchResultsEmptyState
              searchQuery={query}
              onClearSearch={() => setQuery("")}
            />
          ) : (
            <div className="card p-12 text-center text-zinc-400">
              No schedules found for this account.
            </div>
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {searchFiltered.map(schedule => (
              <ScheduleCard
                key={schedule.id}
                schedule={schedule}
               
              />
            ))}
          </div>
        )}

        {!activityLoading && hasActivity && (
          <div className="mt-10 space-y-6">
            <DependencyTree address={address} schedules={schedules} />
            <section className="card p-6">
              <h2 className="text-lg font-semibold text-white mb-4">Splits configuration</h2>
              {splits.receivers.length === 0 ? (
                <p className="text-sm text-zinc-500">No splits configured.</p>
              ) : (
                <div className="space-y-2">
                  {splits.receivers.map(receiver => (
                    <div key={receiver.receiver} className="flex items-center justify-between gap-4 border-b border-white/5 pb-2 last:border-0 last:pb-0">
                      <AddressLabel address={receiver.receiver} />
                      <span className="text-sm font-mono text-violet-300">{(receiver.weight_bps / 100).toFixed(2)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {(outgoingStreams.length > 0 || gives.length > 0) && (
              <section className="card p-6">
                <h2 className="text-lg font-semibold text-white mb-4">Drips activity</h2>
                <div className="space-y-3">
                  {outgoingStreams.map((stream, index) => (
                    <div key={`${stream.receiver}-${stream.token}-${index}`} className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-zinc-400">Streaming to <AddressLabel address={stream.receiver} compact /></span>
                      <span className="font-mono text-emerald-300">{stroopsToXlm(BigInt(stream.rate_per_second))} {getTokenSymbol(stream.token)}/s</span>
                    </div>
                  ))}
                  {gives.map(give => (
                    <div key={give.id} className="flex items-center justify-between gap-4 text-sm border-t border-white/5 pt-3">
                      <span className="text-zinc-400">{give.sender === address ? "Gave to" : "Received from"} <AddressLabel address={give.sender === address ? give.receiver : give.sender} compact /></span>
                      <span className="font-mono text-white">{stroopsToXlm(BigInt(give.amount_stroops))} {getTokenSymbol(give.token)}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {ownedLists.length > 0 && (
              <section className="card p-6">
                <h2 className="text-lg font-semibold text-white mb-4">Owned Drips lists</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {ownedLists.map(list => (
                    <Link key={list.id} href={`/lists/${encodeURIComponent(list.id)}`} className="border border-white/10 rounded-lg p-4 hover:border-violet-500/40 transition-colors">
                      <p className="font-semibold text-white">{list.name}</p>
                      <p className="text-xs text-zinc-500 mt-1">{list.member_count} members · {getTokenSymbol(list.token)}</p>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </>
  );
}
