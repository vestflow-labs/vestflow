"use client";

import { useState } from "react";

interface FullyFundedBadgeProps {
  fundingRate: bigint | string | number;
  targetRate: bigint | string | number;
  tokenSymbol?: string;
  className?: string;
  showProgressWhenUnderfunded?: boolean;
}

export function isFullyFunded(
  fundingRate: bigint | string | number,
  targetRate: bigint | string | number
): boolean {
  try {
    const funding = BigInt(fundingRate.toString());
    const target = BigInt(targetRate.toString());
    return target > 0n && funding >= target;
  } catch {
    return false;
  }
}

export default function FullyFundedBadge({
  fundingRate,
  targetRate,
  tokenSymbol = "XLM",
  className = "",
  showProgressWhenUnderfunded = false,
}: FullyFundedBadgeProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  const fundingBig = (() => {
    try {
      return BigInt(fundingRate.toString());
    } catch {
      return 0n;
    }
  })();

  const targetBig = (() => {
    try {
      return BigInt(targetRate.toString());
    } catch {
      return 0n;
    }
  })();

  const fullyFunded = targetBig > 0n && fundingBig >= targetBig;

  // If underfunded and progress not requested, hide badge per acceptance criteria
  if (!fullyFunded) {
    if (!showProgressWhenUnderfunded || targetBig === 0n) {
      return null;
    }

    const pct = Number((fundingBig * 100n) / targetBig);
    return (
      <div className={`relative inline-flex items-center ${className}`}>
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border border-amber-500/30 bg-amber-500/10 text-amber-300"
          onMouseEnter={() => setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
          onFocus={() => setShowTooltip(true)}
          onBlur={() => setShowTooltip(false)}
          tabIndex={0}
          role="status"
          aria-label={`Underfunded: ${pct}% of target rate`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span>{pct}% Funded</span>
        </span>
      </div>
    );
  }

  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 shadow-sm shadow-emerald-500/20 cursor-help transition-all hover:bg-emerald-500/25"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onFocus={() => setShowTooltip(true)}
        onBlur={() => setShowTooltip(false)}
        tabIndex={0}
        role="status"
        aria-label="Fully Funded badge"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-3.5 w-3.5 text-emerald-400 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <span>Fully Funded</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-3 w-3 text-emerald-400/70"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      </span>

      {/* Tooltip explaining what Fully Funded means (Issue #649) */}
      {showTooltip && (
        <div
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-zinc-900 border border-emerald-500/30 rounded-xl text-xs text-zinc-300 shadow-2xl z-40 pointer-events-none animate-fade-in backdrop-blur-md"
        >
          <div className="font-semibold text-emerald-300 mb-1 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Fully Funded Status
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-300">
            This Drips list has reached 100% of its target funding rate. The total incoming stream rate covers all list members completely.
          </p>
          <div className="mt-2 pt-2 border-t border-white/5 flex justify-between text-[10px] text-zinc-400">
            <span>Current: {fundingBig.toString()} / sec</span>
            <span>Target: {targetBig.toString()} / sec</span>
          </div>
        </div>
      )}
    </div>
  );
}
