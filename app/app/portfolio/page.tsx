"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Navbar from "@/components/Navbar";
import PortfolioTimeline from "@/components/PortfolioTimeline";
import ScheduleDetailDrawer from "@/components/ScheduleDetailDrawer";
import { fetchPortfolioSchedules } from "@/lib/portfolio/api";
import type { TimelineSchedule } from "@/lib/portfolio/types";
import { scheduleTotal } from "@/lib/portfolio/types";
import { stroopsToXlm } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";

interface LoadResult {
  /** Wallet the rows belong to, or null before the first load. */
  address: string | null;
  rows: TimelineSchedule[];
  error: string | null;
}

/** Stable empty list so the memoised timeline does not re-render on every pass. */
const EMPTY_SCHEDULES: TimelineSchedule[] = [];

/**
 * Portfolio vesting timeline.
 *
 * Every schedule the connected wallet is party to — as grantor, as beneficiary,
 * or both — on one canvas timeline. The two role views are fetched in parallel
 * and merged by schedule id, so a wallet on both sides of a schedule sees one
 * row rather than a duplicate.
 */
export default function PortfolioPage() {
  const { publicKey } = useWallet();

  // One state slot keyed by the address it belongs to: "loading" is then just
  // "the result on hand is not for the connected wallet", which keeps the fetch
  // effect free of synchronous setState round-trips.
  const [result, setResult] = useState<LoadResult>({
    address: null,
    rows: EMPTY_SCHEDULES,
    error: null,
  });
  const [selected, setSelected] = useState<TimelineSchedule | null>(null);
  const [claimable, setClaimable] = useState<Map<number, bigint>>(new Map());
  const [cursorLedger, setCursorLedger] = useState(() => Math.floor(Date.now() / 1000));

  const settled = result.address === publicKey;
  const schedules = settled ? result.rows : EMPTY_SCHEDULES;
  const error = settled ? result.error : null;
  const loading = Boolean(publicKey) && !settled;

  useEffect(() => {
    // Without a wallet there is nothing to fetch; the page renders the
    // connect prompt instead of the timeline.
    if (!publicKey) return;
    const controller = new AbortController();

    fetchPortfolioSchedules(publicKey, fetch, controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setResult({ address: publicKey, rows, error: null });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          address: publicKey,
          rows: EMPTY_SCHEDULES,
          error: e instanceof Error ? e.message : "Failed to load schedules",
        });
      });

    return () => controller.abort();
  }, [publicKey]);

  const handleClaimableChange = useCallback(
    (next: Map<number, bigint>, ledger: number) => {
      setClaimable(next);
      setCursorLedger(ledger);
    },
    []
  );

  const handleSelect = useCallback((schedule: TimelineSchedule | null) => {
    setSelected(schedule);
  }, []);

  const totals = useMemo(() => {
    let locked = 0n;
    let claimableNow = 0n;
    for (const s of schedules) {
      locked += scheduleTotal(s);
      claimableNow += claimable.get(s.id) ?? 0n;
    }
    return { locked, claimableNow };
  }, [schedules, claimable]);

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold">Portfolio Timeline</h1>
          <p className="text-sm text-zinc-500">
            Every schedule you grant or receive, on one timeline. Drag the time
            cursor to project what each schedule pays out at any moment.
          </p>
        </header>

        {!publicKey && (
          <div className="card p-8 text-center text-sm text-zinc-400">
            Connect your wallet to see your vesting portfolio.
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          >
            {error}
          </div>
        )}

        {publicKey && (
          <>
            <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <StatCard label="Schedules" value={String(schedules.length)} unit="on timeline" />
              <StatCard
                label="Total locked"
                value={stroopsToXlm(totals.locked)}
                unit="XLM across schedules"
              />
              <StatCard
                label="Claimable at cursor"
                value={stroopsToXlm(totals.claimableNow)}
                unit={new Date(cursorLedger * 1000).toLocaleDateString()}
                accent
              />
              <StatCard
                label="Selected"
                value={selected ? `#${selected.id}` : "—"}
                unit={selected ? selected.kind : "click a row"}
              />
            </div>

            <PortfolioTimeline
              schedules={schedules}
              loading={loading}
              selectedId={selected?.id ?? null}
              onSelect={handleSelect}
              onClaimableChange={handleClaimableChange}
            />

            {!loading && schedules.length === 0 && !error && (
              <p className="mt-6 text-center text-sm text-zinc-500">
                No vesting schedules found for this wallet yet.
              </p>
            )}
          </>
        )}
      </main>

      <ScheduleDetailDrawer
        schedule={selected}
        cursorLedger={cursorLedger}
        claimableAtCursor={selected ? claimable.get(selected.id) : undefined}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  unit,
  accent = false,
}: {
  label: string;
  value: string;
  unit: string;
  accent?: boolean;
}) {
  return (
    <div className="card p-4">
      <p className="mb-1 text-xs uppercase tracking-wider text-zinc-500">{label}</p>
      <p
        className={`truncate text-xl font-bold tabular-nums ${
          accent ? "text-[var(--accent-success)]" : "text-[var(--foreground)]"
        }`}
      >
        {value}
      </p>
      <p className="text-xs text-zinc-500">{unit}</p>
    </div>
  );
}
