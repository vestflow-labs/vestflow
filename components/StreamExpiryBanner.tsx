"use client";
import { useEffect, useState } from "react";
import { formatTimeRemaining } from "@/lib/streamHealth";

interface StreamExpiryBannerProps {
  scheduleId: number;
  endTime: number;
  onTopUp: () => void;
}

/**
 * Yellow warning shown under an outgoing stream whose max end time is
 * within 48 hours (#809). Ticks every second so the countdown is exact.
 */
export default function StreamExpiryBanner({ scheduleId, endTime, onTopUp }: StreamExpiryBannerProps) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const secsLeft = endTime - now;
  if (secsLeft <= 0) return null;

  return (
    <div
      role="alert"
      data-testid={`expiry-banner-${scheduleId}`}
      className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300"
    >
      <span className="flex items-center gap-2">
        <span aria-hidden="true">⚠</span>
        <span>
          Stream ends in{" "}
          <span className="font-semibold tabular-nums">{formatTimeRemaining(secsLeft)}</span>
          {" "}({new Date(endTime * 1000).toLocaleString()})
        </span>
      </span>
      <button
        type="button"
        onClick={onTopUp}
        className="font-semibold underline underline-offset-2 hover:text-yellow-200 transition-colors min-h-[32px]"
      >
        Top Up
      </button>
    </div>
  );
}
