"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import FullyFundedBadge from "@/components/FullyFundedBadge";
import AddressLabel from "@/components/AddressLabel";
import SearchFilterBar from "@/components/SearchFilterBar";
import { NoSearchResultsEmptyState } from "@/components/EmptyState";
import { stroopsToXlm } from "@/lib/stellar";
import { getTokenSymbol } from "@/lib/tokens";
import { DripsListData } from "@/components/DripsListDetail";

const PAGE_SIZE = 20;

type FundedFilter = "all" | "funded" | "unfunded";

function isFunded(list: DripsListData): boolean {
  try {
    return BigInt(list.total_funding_rate_per_sec ?? "0") > 0n;
  } catch {
    return false;
  }
}

export default function DripsListsPage() {
  const [lists, setLists] = useState<DripsListData[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [fundedFilter, setFundedFilter] = useState<FundedFilter>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    // Fetch a large window from the indexer so client-side search, funded
    // filter and pagination all operate on the full public set.
    fetch("/api/lists?limit=100")
      .then(res => res.json())
      .then(data => {
        setLists(data.lists || []);
      })
      .catch(err => {
        console.error("Failed to load drips lists", err);
      })
      .finally(() => setLoading(false));
  }, []);

  // Reset to first page whenever the filter criteria change.
  useEffect(() => {
    setPage(1);
  }, [query, fundedFilter]);

  const filteredLists = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lists.filter(l => {
      if (fundedFilter === "funded" && !isFunded(l)) return false;
      if (fundedFilter === "unfunded" && isFunded(l)) return false;
      if (!q) return true;
      // Search by list name (primary), also match id/owner/token for usability.
      return (
        l.name.toLowerCase().includes(q) ||
        l.id.toLowerCase().includes(q) ||
        l.owner.toLowerCase().includes(q) ||
        getTokenSymbol(l.token).toLowerCase().includes(q)
      );
    });
  }, [lists, query, fundedFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredLists.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedLists = filteredLists.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Drips Lists</h1>
            <p className="text-zinc-400 mt-1 text-sm">
              Browse all public lists: name, owner, member count, current funding rate, and target rate.
            </p>
          </div>
          <Link
            href="/app"
            className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3.5 py-2 transition-colors"
          >
            ← Dashboard
          </Link>
        </div>

        <div className="mb-4">
          <SearchFilterBar
            value={query}
            onChange={setQuery}
            placeholder="Search by list name…"
            resultCount={filteredLists.length}
            totalCount={lists.length}
          />
        </div>

        <div className="flex gap-2 mb-6 flex-wrap" role="tablist" aria-label="Funding filter">
          {(
            [
              { id: "all", label: "All" },
              { id: "funded", label: "Funded" },
              { id: "unfunded", label: "Unfunded" },
            ] as const
          ).map(f => (
            <button
              key={f.id}
              role="tab"
              aria-selected={fundedFilter === f.id}
              onClick={() => setFundedFilter(f.id)}
              className={`text-xs px-3.5 py-2 rounded-lg border font-medium transition-colors min-h-[44px] ${
                fundedFilter === f.id
                  ? "border-violet-500/60 bg-violet-500/10 text-violet-300"
                  : "border-white/10 text-zinc-400 hover:text-white"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card p-6 h-40 animate-pulse bg-white/5" />
            ))}
          </div>
        ) : filteredLists.length === 0 ? (
          query || fundedFilter !== "all" ? (
            <NoSearchResultsEmptyState
              searchQuery={query || fundedFilter}
              onClearSearch={() => { setQuery(""); setFundedFilter("all"); }}
            />
          ) : (
            <div className="card p-12 text-center text-zinc-400">
              No Drips lists found.
            </div>
          )
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {pagedLists.map(list => {
                const tokenSymbol = getTokenSymbol(list.token);
                return (
                  <div
                    key={list.id}
                    className="card p-6 hover:border-violet-500/40 transition-all group space-y-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          href={`/lists/${encodeURIComponent(list.id)}`}
                          className="text-lg font-bold text-white group-hover:text-violet-300 transition-colors hover:underline"
                        >
                          {list.name}
                        </Link>
                        <p className="text-xs text-zinc-500 font-mono mt-0.5">ID: {list.id}</p>
                        <div className="mt-1.5">
                          <span className="text-xs text-zinc-500">Owner: </span>
                          <AddressLabel address={list.owner} compact />
                        </div>
                      </div>
                      <FullyFundedBadge
                        fundingRate={list.total_funding_rate_per_sec}
                        targetRate={list.target_rate_per_sec}
                        tokenSymbol={tokenSymbol}
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-3 border-t border-white/5 text-xs">
                      <div>
                        <p className="text-zinc-500">Rate / sec</p>
                        <p className="font-semibold text-white font-mono mt-0.5">
                          {stroopsToXlm(BigInt(list.total_funding_rate_per_sec))} {tokenSymbol}
                        </p>
                      </div>
                      <div>
                        <p className="text-zinc-500">Members</p>
                        <p className="font-semibold text-violet-300 mt-0.5">
                          {list.member_count}
                        </p>
                      </div>
                      <div>
                        <p className="text-zinc-500">Target Rate</p>
                        <p className="font-semibold text-zinc-300 mt-0.5">
                          {list.target_rate_per_sec !== "0"
                            ? `${stroopsToXlm(BigInt(list.target_rate_per_sec))} /s`
                            : "—"}
                        </p>
                      </div>
                    </div>

                    <div className="pt-1">
                      <Link
                        href={`/lists/${encodeURIComponent(list.id)}`}
                        className="btn-primary inline-flex items-center justify-center w-full rounded-lg px-4 py-2.5 min-h-[44px] text-sm font-semibold text-white transition-colors"
                        aria-label={`Fund ${list.name}`}
                      >
                        Fund this list
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between mt-8 flex-wrap gap-3">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-4 py-2 min-h-[44px] transition-colors disabled:opacity-40"
              >
                ← Previous
              </button>
              <p className="text-sm text-zinc-500" role="status" aria-live="polite">
                Page {safePage} of {totalPages} · {filteredLists.length} list{filteredLists.length !== 1 ? "s" : ""} (20 per page)
              </p>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-4 py-2 min-h-[44px] transition-colors disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </>
        )}
      </main>
    </>
  );
}
