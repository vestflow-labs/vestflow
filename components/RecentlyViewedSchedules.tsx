"use client";
import Link from "next/link";
import { ScheduleData, stroopsToXlm, vestingProgress } from "@/lib/stellar";

export default function RecentlyViewedSchedules({
  schedules,
}: {
  schedules: ScheduleData[];
}) {
  if (schedules.length === 0) return null;

  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="mb-6">
      <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
        Recently Viewed
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {schedules.map((s) => {
          const progress = vestingProgress(s, now);
          const statusColor = s.revoked
            ? "bg-red-500"
            : progress >= 100
            ? "bg-green-500"
            : "bg-violet-500";
          const statusLabel = s.revoked
            ? "Revoked"
            : progress >= 100
            ? "Fully Vested"
            : "Vesting";

          return (
            <Link
              key={s.id}
              href={`/app/schedule/${s.id}`}
              className="shrink-0 flex flex-col gap-1 rounded-xl border border-white/8 hover:border-white/20 bg-white/2 px-3 py-2 transition-colors min-w-[9rem]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-zinc-200">
                  #{s.id}
                </span>
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full ${statusColor}`}
                  role="img"
                  aria-label={statusLabel}
                  title={statusLabel}
                />
              </div>
              <span className="text-xs text-zinc-500">
                {stroopsToXlm(s.total_amount)} XLM
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
