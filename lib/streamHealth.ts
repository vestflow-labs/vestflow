import type { ScheduleData } from "@/lib/stellar";

/** Streams ending within this window get an expiry warning (#809). */
export const EXPIRY_WARNING_WINDOW_SECS = 48 * 60 * 60;

/**
 * The latest time a stream can keep flowing. Paused time pushes the end
 * out, so it is added on top of the configured duration.
 */
export function maxEndTime(s: ScheduleData): number {
  return s.start_time + s.duration + (s.paused_duration ?? 0);
}

/** Tokens per second the stream is configured to release. */
export function streamRatePerSec(s: ScheduleData): bigint {
  if (s.revoked || s.paused || s.duration <= 0) return 0n;
  return s.total_amount / BigInt(s.duration);
}

/** Funds still held by the stream that have not yet been streamed out. */
export function streamBalance(s: ScheduleData, vested: bigint): bigint {
  const remaining = s.total_amount - vested;
  return remaining > 0n ? remaining : 0n;
}

/** True when the stream ends within the warning window but hasn't ended yet. */
export function isExpiringSoon(s: ScheduleData, now: number): boolean {
  const secsLeft = maxEndTime(s) - now;
  return secsLeft > 0 && secsLeft <= EXPIRY_WARNING_WINDOW_SECS;
}

export type StreamBalanceStatus = "healthy" | "exhausted" | "stopped";

/**
 * Distinguishes a stream that ran out of funds (balance 0 while still
 * configured to flow) from one that was intentionally stopped (rate 0).
 */
export function balanceStatus(
  s: ScheduleData,
  vested: bigint | undefined,
): StreamBalanceStatus {
  if (streamRatePerSec(s) === 0n) return "stopped";
  if (vested === undefined) return "healthy";
  return streamBalance(s, vested) === 0n ? "exhausted" : "healthy";
}

/** Formats a number of seconds as e.g. "1d 4h 12m" or "37m 05s". */
export function formatTimeRemaining(totalSecs: number): string {
  const secs = Math.max(0, Math.floor(totalSecs));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
