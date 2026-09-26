import { useEffect, useState } from "react";

export interface Countdown {
  days: number;
  hours: number;
  minutes: number;
  totalSeconds: number;
  expired: boolean;
}

function computeCountdown(targetUnixSeconds: number): Countdown {
  const totalSeconds = Math.max(0, targetUnixSeconds - Math.floor(Date.now() / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return { days, hours, minutes, totalSeconds, expired: totalSeconds <= 0 };
}

/**
 * Live countdown to a Unix timestamp (seconds).
 *
 * Ticks once per minute — the smallest unit surfaced is minutes, so
 * second-level ticking would just cause needless re-renders.
 */
export function useCountdown(targetUnixSeconds: number): Countdown {
  const [countdown, setCountdown] = useState(() => computeCountdown(targetUnixSeconds));

  useEffect(() => {
    setCountdown(computeCountdown(targetUnixSeconds));
    if (targetUnixSeconds <= Math.floor(Date.now() / 1000)) return;

    const interval = setInterval(() => {
      setCountdown(computeCountdown(targetUnixSeconds));
    }, 60_000);

    return () => clearInterval(interval);
  }, [targetUnixSeconds]);

  return countdown;
}

/**
 * Format a Countdown as a "X days Y hours" style string.
 *
 * @example
 * formatCountdown({ days: 12, hours: 4, ... })  // "12 days 4 hours"
 * formatCountdown({ days: 0, hours: 3, minutes: 22, ... }) // "3 hours 22 minutes"
 * formatCountdown({ days: 0, hours: 0, minutes: 5, ... }) // "5 minutes"
 */
export function formatCountdown(countdown: Countdown): string {
  if (countdown.expired) return "now";
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (countdown.days > 0) return `${plural(countdown.days, "day")} ${plural(countdown.hours, "hour")}`;
  if (countdown.hours > 0) return `${plural(countdown.hours, "hour")} ${plural(countdown.minutes, "minute")}`;
  return plural(countdown.minutes, "minute");
}
