"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { claimableAt, vestedAmountAt } from "@/lib/portfolio/claimable";
import {
  cliffEndLedger,
  endLedger,
  isMultiToken,
  scheduleClaimed,
  scheduleTotal,
  type TimelineSchedule,
} from "@/lib/portfolio/types";
import { formatDate, stroopsToXlm, truncate } from "@/lib/stellar";

interface Props {
  schedule: TimelineSchedule | null;
  /** Ledger the timeline cursor currently sits at. */
  cursorLedger: number;
  /** Worker-computed claimable amount; falls back to a local calculation. */
  claimableAtCursor?: bigint;
  onClose: () => void;
}

/**
 * Side drawer opened by clicking (or keyboard-selecting) a timeline row.
 *
 * The canvas has no per-schedule DOM, so this panel is where the details of a
 * hit-tested row surface — including what the schedule would pay out at the
 * cursor's position rather than only at "now".
 */
export default function ScheduleDetailDrawer({
  schedule,
  cursorLedger,
  claimableAtCursor,
  onClose,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!schedule) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [schedule, onClose]);

  if (!schedule) return null;

  const total = scheduleTotal(schedule);
  const claimed = scheduleClaimed(schedule);
  const vested = vestedAmountAt(schedule, cursorLedger);
  const claimable = claimableAtCursor ?? claimableAt(schedule, cursorLedger);
  const pct = total > 0n ? Number((vested * 10_000n) / total) / 100 : 0;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={`Schedule ${schedule.id} details`}
      className="fixed right-0 top-0 z-40 flex h-full w-full max-w-sm flex-col gap-4 overflow-y-auto border-l border-[var(--border-default)] bg-[var(--background)] p-5"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-zinc-500">Schedule</p>
          <h2 className="text-lg font-bold">#{schedule.id}</h2>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close schedule details"
          className="rounded-md border border-[var(--border-default)] px-2 py-1 text-sm text-[var(--foreground)] transition-opacity hover:opacity-70"
        >
          Close
        </button>
      </header>

      <div className="flex flex-wrap gap-2 text-xs">
        <Badge>{schedule.kind}</Badge>
        <Badge>{roleLabel(schedule.role)}</Badge>
        {schedule.revoked && <Badge tone="error">Revoked</Badge>}
        {schedule.paused && <Badge tone="warn">Paused</Badge>}
        {isMultiToken(schedule) && <Badge>{schedule.tokens.length} tokens</Badge>}
      </div>

      <section className="card p-4">
        <p className="text-xs uppercase tracking-wider text-zinc-500">
          Claimable at cursor
        </p>
        <p className="text-xl font-bold tabular-nums text-[var(--accent-success)]">
          {stroopsToXlm(claimable)}
        </p>
        <p className="text-xs text-zinc-500">{formatDate(cursorLedger)}</p>
      </section>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Field label="Vested at cursor" value={`${stroopsToXlm(vested)} (${pct.toFixed(1)}%)`} />
        <Field label="Total" value={stroopsToXlm(total)} />
        <Field label="Claimed" value={stroopsToXlm(claimed)} />
        <Field label="Start" value={formatDate(schedule.start_time)} />
        <Field
          label="Cliff"
          value={
            schedule.cliff_duration > 0 ? formatDate(cliffEndLedger(schedule)) : "No cliff"
          }
        />
        <Field label="Ends" value={formatDate(endLedger(schedule))} />
        <Field label="Grantor" value={truncate(schedule.grantor)} />
        <Field label="Beneficiary" value={truncate(schedule.beneficiary)} />
      </dl>

      {isMultiToken(schedule) && (
        <section>
          <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Tokens</h3>
          <ul className="space-y-1 text-sm">
            {schedule.tokens.map((leg, i) => (
              <li key={`${leg.token}-${i}`} className="flex justify-between gap-2">
                <span className="text-[var(--muted-light)]">{truncate(leg.token)}</span>
                <span className="tabular-nums">{stroopsToXlm(leg.total_amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {schedule.kind === "Graded" && schedule.milestones.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Tranches</h3>
          <ul className="space-y-1 text-sm">
            {schedule.milestones.map((m, i) => (
              <li key={`${m.timestamp}-${i}`} className="flex justify-between gap-2">
                <span className="text-[var(--muted-light)]">{formatDate(m.timestamp)}</span>
                <span className="tabular-nums">{m.pct}%</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link
        href={`/app/schedule/${schedule.id}`}
        className="btn-primary mt-auto rounded-lg px-4 py-2 text-center text-sm font-medium text-white"
      >
        Open full schedule
      </Link>
    </aside>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-zinc-500">{label}</dt>
      <dd className="tabular-nums text-[var(--foreground)]">{value}</dd>
    </div>
  );
}

function Badge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "warn" | "error";
}) {
  const toneClass =
    tone === "error"
      ? "border-red-500/30 bg-red-500/10 text-red-300"
      : tone === "warn"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
      : "border-[var(--border-default)] bg-[var(--overlay-light)] text-[var(--foreground)]";
  return (
    <span className={`rounded-full border px-2 py-0.5 ${toneClass}`}>{children}</span>
  );
}

function roleLabel(role: TimelineSchedule["role"]): string {
  if (role === "both") return "Grantor & beneficiary";
  return role === "grantor" ? "Grantor" : "Beneficiary";
}
