"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NETWORK, stroopsToXlm } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import SearchFilterBar from "@/components/SearchFilterBar";
import { NoSearchResultsEmptyState } from "@/components/EmptyState";
import { matchesAddressOrToken } from "@/lib/tokens";

import { exportTransactionHistoryCSV } from "@/lib/csvExport";

interface IndexedEvent {
  id: string;
  event_type: string;
  ledger: number;
  ledger_closed_at: string;
  schedule_id: number | null;
  grantor: string | null;
  beneficiary: string | null;
  amount: string | null;
  token: string | null;
  created_amount: string | null;
  created_at: number;
}

const PAGE_SIZE = 20;
type EventFilter = "all" | "stream" | "give" | "collect" | "split";

function eventCategory(eventType: string): Exclude<EventFilter, "all"> | null {
  if (["schedule_created", "stream_set", "stream_opened", "stream_closed", "claimed", "revoked"].includes(eventType)) return "stream";
  if (["given", "give", "give_sent", "give_received"].includes(eventType)) return "give";
  if (["collected", "collect"].includes(eventType)) return "collect";
  if (["split", "splits", "split_set", "splits_set"].includes(eventType)) return "split";
  return null;
}

function eventLabel(event: IndexedEvent): string {
  const labels: Record<string, string> = {
    schedule_created: "Stream opened",
    stream_set: "Stream updated",
    stream_opened: "Stream opened",
    stream_closed: "Stream closed",
    claimed: "Claim",
    revoked: "Stream revoked",
    given: "Give",
    give: "Give",
    give_sent: "Give sent",
    give_received: "Give received",
    collected: "Collect",
    collect: "Collect",
    split: "Split",
    split_set: "Split updated",
    splits_set: "Split updated",
  };
  return labels[event.event_type] || event.event_type;
}

function eventAmount(event: IndexedEvent): string | null {
  return event.amount ?? event.created_amount;
}

function formatEventDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

export default function TransactionHistory() {
  const { publicKey } = useWallet();
  const [events, setEvents] = useState<IndexedEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");

  useEffect(() => {
    if (!publicKey) return;
    setLoading(true);
    setErr("");

    fetch(`/api/events?address=${publicKey}&network=${NETWORK}&limit=200`)
      .then(r => r.json())
      .then(data => {
        const filtered: IndexedEvent[] = (data.events ?? []).filter(
          (e: IndexedEvent) => eventCategory(e.event_type) !== null
        );
        filtered.sort((a, b) => b.ledger - a.ledger);
        setEvents(filtered);
      })
      .catch(() => {
        setErr("Transaction history requires the indexer service.");
      })
      .finally(() => setLoading(false));
  }, [publicKey]);

  // Client-side filtering by address prefix, token symbol, or schedule ID (Issue #647)
  const q = query.trim().toLowerCase();
  const filteredEvents = useMemo(() => {
    return events.filter(e => {
      if (eventFilter !== "all" && eventCategory(e.event_type) !== eventFilter) return false;
      if (!q) return true;
      // Check schedule ID match (e.g. "12" or "#12")
      if (e.schedule_id !== null && (e.schedule_id.toString() === q || `#${e.schedule_id}` === q)) {
        return true;
      }
      // Check event type match ("claim", "revoke")
      if (e.event_type.toLowerCase().includes(q)) {
        return true;
      }
      // Check address prefix / token match
      return matchesAddressOrToken(
        q,
        [e.grantor, e.beneficiary],
        [e.token]
      );
    });
  }, [events, eventFilter, q]);

  // Reset to page 1 when filtered events count changes
  useEffect(() => { setPage(1); }, [filteredEvents.length, eventFilter, q]);

  const handleDownloadCSV = () => {
    const exportRows = filteredEvents.map(event => ({
      type: eventLabel(event),
      counterparty: (event.beneficiary || event.grantor || ""),
      token: event.token || "",
      amount: eventAmount(event) !== null ? stroopsToXlm(BigInt(eventAmount(event)!)) : "",
      timestamp: event.ledger_closed_at,
    }));
    exportTransactionHistoryCSV(exportRows, publicKey);
  };

  if (!publicKey) {
    return (
      <div className="card p-8 text-center text-zinc-400">
        Connect your wallet to view transaction history.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="card p-6 flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 rounded-lg bg-white/5 animate-pulse" />
        ))}
      </div>
    );
  }

  if (err) {
    return (
      <div className="card p-6 text-sm text-zinc-500 text-center">{err}</div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="card p-8 text-center text-zinc-400">
        No drip-related transactions found for your wallet.
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(filteredEvents.length / PAGE_SIZE));
  const pageStart = (page - 1) * PAGE_SIZE;
  const paginated = filteredEvents.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      {/* Search / Filter bar (Issue #647) & Download CSV (Issue #798) */}
      <div className="mb-2 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="flex-1">
          <SearchFilterBar
            value={query}
            onChange={setQuery}
            placeholder="Filter history by address prefix, token symbol, schedule ID, or event type…"
            resultCount={filteredEvents.length}
            totalCount={events.length}
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <span className="sr-only">Filter by event type</span>
            <select
              value={eventFilter}
              onChange={event => setEventFilter(event.target.value as EventFilter)}
              className="input w-full sm:w-48"
              aria-label="Filter by event type"
            >
              <option value="all">All event types</option>
              <option value="stream">Streams</option>
              <option value="give">Gives</option>
              <option value="collect">Collects</option>
              <option value="split">Splits</option>
            </select>
          </label>
          <button
            onClick={handleDownloadCSV}
            disabled={filteredEvents.length === 0}
            className="text-sm text-zinc-300 hover:text-white border border-white/10 hover:border-white/20 bg-white/5 rounded-lg px-3 py-2 transition-colors disabled:opacity-40 flex items-center gap-1.5 shrink-0"
            title="Download visible transactions as CSV"
            aria-label="Download CSV"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download CSV
          </button>
        </div>
      </div>

      {filteredEvents.length === 0 ? (
        <NoSearchResultsEmptyState
          searchQuery={query}
          onClearSearch={() => setQuery("")}
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500 uppercase tracking-wider border-b border-white/5">
                  <th className="text-left py-3 pr-4 font-medium">Type</th>
                  <th className="text-left py-3 pr-4 font-medium">Counterparty</th>
                  <th className="text-left py-3 pr-4 font-medium">Token</th>
                  <th className="text-left py-3 pr-4 font-medium">Amount</th>
                  <th className="text-left py-3 pr-4 font-medium">Date</th>
                  <th className="text-left py-3 font-medium">Ledger</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(event => (
                  <tr
                    key={event.id}
                    className="border-b border-white/5 hover:bg-white/3 transition-colors"
                  >
                    <td className="py-3 pr-4">
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-300">
                        {eventLabel(event)}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-zinc-300">
                      {(event.beneficiary || event.grantor) ? (
                        <Link
                          href={`/profile/${encodeURIComponent(event.beneficiary || event.grantor || "")}`}
                          className="hover:text-violet-400 transition-colors"
                        >
                          {(event.beneficiary || event.grantor || "").slice(0, 6)}...
                        </Link>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-zinc-400 font-mono text-xs">
                      {event.token ? `${event.token.slice(0, 6)}...` : <span className="text-zinc-600">—</span>}
                    </td>
                    <td className="py-3 pr-4 text-zinc-300 font-mono">
                      {eventAmount(event) !== null
                        ? `${stroopsToXlm(BigInt(eventAmount(event)!))} XLM`
                        : <span className="text-zinc-600">—</span>}
                    </td>
                    <td className="py-3 pr-4 text-zinc-400">
                      {formatEventDate(event.ledger_closed_at)}
                    </td>
                    <td className="py-3">
                      <a
                        href={`https://stellar.expert/explorer/${NETWORK}/ledger/${event.ledger}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-violet-400 hover:underline font-mono text-xs"
                      >
                        {event.ledger}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between flex-wrap gap-3">
              <p className="text-sm text-zinc-500">
                Showing{" "}
                <span className="text-zinc-300">
                  {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredEvents.length)}
                </span>{" "}
                of <span className="text-zinc-300">{filteredEvents.length}</span> events
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40"
                >
                  ← Previous
                </button>
                <span className="text-sm text-zinc-500">{page} / {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
