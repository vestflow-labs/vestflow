"use client";
import type { StreamBalanceStatus } from "@/lib/streamHealth";

interface StreamBalanceBadgeProps {
  status: StreamBalanceStatus;
  onTopUp?: () => void;
}

/**
 * Status badge for an outgoing stream row (#810). An exhausted stream
 * (balance 0, rate > 0) gets a red warning with an inline Top Up CTA,
 * while an intentionally stopped stream (rate 0) gets a neutral badge.
 */
export default function StreamBalanceBadge({ status, onTopUp }: StreamBalanceBadgeProps) {
  if (status === "healthy") return null;

  if (status === "stopped") {
    return (
      <span
        className="text-xs px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-400 border border-zinc-500/20"
        title="This stream was intentionally stopped (rate 0)"
      >
        ⏸ Stopped
      </span>
    );
  }

  return (
    <span
      role="status"
      className="inline-flex items-center gap-2 text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30"
      title="The stream is still configured to flow but has no balance left"
    >
      <span>⚠ Stream stopped — balance exhausted</span>
      {onTopUp && (
        <button
          type="button"
          onClick={onTopUp}
          className="font-semibold text-red-300 underline underline-offset-2 hover:text-red-200 transition-colors"
        >
          Top Up
        </button>
      )}
    </span>
  );
}
