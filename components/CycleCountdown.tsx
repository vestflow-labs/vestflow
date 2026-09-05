"use client";

import { useEffect, useRef, useState } from "react";

const CYCLE_DURATION_SECONDS = 86400;

function computeNextCycleEnd(): number {
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now % CYCLE_DURATION_SECONDS;
  return now + (CYCLE_DURATION_SECONDS - elapsed);
}

function formatTime(totalSeconds: number): string {
  if (totalSeconds <= 0) return "00:00:00";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours.toString().padStart(2, "0"),
    minutes.toString().padStart(2, "0"),
    seconds.toString().padStart(2, "0"),
  ].join(":");
}

interface CycleCountdownProps {
  onCycleEnd?: () => void;
}

export default function CycleCountdown({ onCycleEnd }: CycleCountdownProps) {
  const [remaining, setRemaining] = useState(() => {
    const end = computeNextCycleEnd();
    return Math.max(0, end - Math.floor(Date.now() / 1000));
  });
  const [settling, setSettling] = useState(false);

  const onCycleEndRef = useRef(onCycleEnd);
  useEffect(() => { onCycleEndRef.current = onCycleEnd; });

  useEffect(() => {
    const nextCycleEnd = computeNextCycleEnd();
    setRemaining(Math.max(0, nextCycleEnd - Math.floor(Date.now() / 1000)));

    let settlingTimeout: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      const end = computeNextCycleEnd();
      const rem = Math.max(0, end - now);
      setRemaining(rem);

      if (rem <= 0) {
        setSettling(true);
        onCycleEndRef.current?.();
        if (!settlingTimeout) {
          settlingTimeout = setTimeout(() => {
            setSettling(false);
            settlingTimeout = null;
          }, 5000);
        }
      }
    };

    tick();
    const interval = setInterval(tick, 1000);

    return () => {
      clearInterval(interval);
      if (settlingTimeout) clearTimeout(settlingTimeout);
    };
  }, []);

  const isLow = remaining > 0 && remaining <= 300;

  return (
    <div
      className={`card px-4 py-3 flex items-center gap-3 text-sm ${
        settling
          ? "border-emerald-500/30 bg-emerald-500/5"
          : isLow
          ? "border-amber-500/30 bg-amber-500/5"
          : ""
      }`}
      role="status"
      aria-live="polite"
      aria-label={`Next settlement in ${formatTime(remaining)}`}
    >
      <div
        className={`w-2 h-2 rounded-full shrink-0 ${
          settling
            ? "bg-emerald-500 animate-pulse"
            : isLow
            ? "bg-amber-500 animate-pulse"
            : "bg-violet-500"
        }`}
        aria-hidden="true"
      />
      <div>
        <p className="text-xs text-zinc-500 uppercase tracking-wider">
          {settling ? "Settling\u2026" : "Next settlement in"}
        </p>
        <p
          className={`font-mono font-semibold tabular-nums ${
            settling
              ? "text-emerald-400"
              : isLow
              ? "text-amber-400"
              : "text-zinc-200"
          }`}
        >
          {settling ? "Processing\u2026" : formatTime(remaining)}
        </p>
      </div>
    </div>
  );
}
