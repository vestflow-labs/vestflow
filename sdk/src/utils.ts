// ===========================================================================
// VestFlow SDK — Utilities
// Issue #95: @vestflow/sdk
//
// Pure helper functions with no network dependencies.
// Safe to use in any environment (browser, Node.js, React Native).
// ===========================================================================

import type { ScheduleData } from "./types";

/**
 * Convert an XLM amount string to stroops using integer-only arithmetic.
 *
 * Avoids floating-point imprecision (e.g. 0.0000001 XLM → 1 stroop).
 *
 * @example
 * xlmToStroops("1")           // 10_000_000n
 * xlmToStroops("0.0000001")   // 1n
 */
export function xlmToStroops(amountXlm: string): bigint {
  const normalized = amountXlm.trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
    throw new Error("Invalid amount");
  }

  const [whole, fraction = ""] = normalized.split(".");
  const fractionPadded = (fraction + "0000000").slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(fractionPadded);
}

/**
 * Convert a stroop value to a human-readable XLM string.
 *
 * @example
 * stroopsToXlm(10_000_000n) // "1.0000"
 * stroopsToXlm(5_500_000n)  // "0.5500"
 */
export function stroopsToXlm(stroops: bigint): string {
  return (Number(stroops) / 10_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}

/**
 * Truncate a Stellar public key for display.
 *
 * @example
 * truncate("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN")
 * // "GAAZI4...CCWN"
 */
export function truncate(addr: string, prefixLen = 6, suffixLen = 4): string {
  if (addr.length <= prefixLen + suffixLen + 3) return addr;
  return `${addr.slice(0, prefixLen)}...${addr.slice(-suffixLen)}`;
}

/**
 * Calculate the vesting progress percentage for a schedule at a given time.
 *
 * Returns a value between 0 and 100.
 *
 * @param schedule - The vesting schedule
 * @param now - Current Unix timestamp in seconds
 */
export function vestingProgress(schedule: ScheduleData, now: number): number {
  if (now < schedule.start_time) return 0;
  const elapsed = now - schedule.start_time;
  return Math.min(100, Math.round((elapsed / schedule.duration) * 100));
}

/**
 * Format a Unix timestamp as a human-readable date string.
 *
 * @example
 * formatDate(1_700_000_000) // "Nov 14, 2023"
 */
export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Parse a contract error message into a user-friendly string.
 *
 * Maps raw Soroban contract panic strings to readable messages
 * so dApps can display them directly without string matching.
 */
export function parseContractError(e: Error): string {
  const msg = e.message;
  if (msg.includes("Nothing to claim yet"))
    return "No tokens are available to claim yet.";
  if (msg.includes("Schedule is not revocable"))
    return "This schedule cannot be revoked.";
  if (msg.includes("Already revoked"))
    return "This schedule has already been revoked.";
  if (msg.includes("Not the grantor"))
    return "Only the grantor can perform this action.";
  if (msg.includes("Not the beneficiary"))
    return "Only the beneficiary can claim tokens.";
  if (msg.includes("Schedule not found"))
    return "Schedule not found.";
  if (msg.includes("Insufficient balance"))
    return "Insufficient balance to complete this action.";
  if (msg.includes("Schedule has ended"))
    return "This vesting schedule has already ended.";
  if (msg.includes("Start time in the past"))
    return "The start time must be in the future.";
  if (
    msg.includes("Duration too short") ||
    msg.includes("DurationTooShort") ||
    msg.includes("Contract error: 15") ||
    msg.includes("Contract, #15")
  )
    return "The vesting duration is too short.";
  if (msg.includes("Beneficiary must differ from grantor"))
    return "The beneficiary must be a different address from the grantor.";
  if (msg.includes("Amount must be positive"))
    return "The vesting amount must be greater than zero.";
  if (msg.includes("Duration must be positive"))
    return "The vesting duration must be greater than zero.";
  if (msg.includes("Cliff cannot exceed duration"))
    return "The cliff period cannot be longer than the total vesting duration.";
  return msg;
}

// ---------------------------------------------------------------------------
// formatSchedule (#447)
// ---------------------------------------------------------------------------

/**
 * Human-readable summary of a vesting schedule.
 *
 * All stroop values are converted to XLM strings; all timestamps are
 * converted to locale date strings so consuming components do not repeat
 * the same conversion logic.
 */
export interface ScheduleSummary {
  /** Schedule ID as a string for display. */
  id: string;
  /** Abbreviated grantor address. */
  grantor: string;
  /** Abbreviated beneficiary address. */
  beneficiary: string;
  /** Total vesting amount in XLM (e.g. "1,000.0000"). */
  totalAmountXlm: string;
  /** Already-claimed amount in XLM. */
  claimedXlm: string;
  /** Remaining (unclaimed) amount in XLM. */
  remainingXlm: string;
  /** Vesting start date (locale string). */
  startDate: string;
  /** Vesting end date (locale string). */
  endDate: string;
  /** Cliff date, or null when no cliff applies. */
  cliffDate: string | null;
  /** Vesting curve label. */
  kind: string;
  /** "Active" | "Revoked" | "Paused" | "Completed" */
  status: string;
  /** Percentage of total duration elapsed (0–100). */
  progressPct: number;
}

/**
 * Return a human-readable summary object for a vesting schedule.
 *
 * Centralises stroops → XLM conversion and timestamp → date formatting
 * so downstream apps don't repeat the same transformation logic.
 *
 * @param s   - A `ScheduleData` object returned from `VestflowClient.getSchedule`.
 * @param now - Current Unix timestamp in seconds (defaults to `Date.now() / 1000`).
 *
 * @example
 * const summary = formatSchedule(schedule);
 * console.log(summary.totalAmountXlm); // "1,000.0000"
 * console.log(summary.status);         // "Active"
 */
export function formatSchedule(
  s: ScheduleData,
  now: number = Math.floor(Date.now() / 1000)
): ScheduleSummary {
  const endTime = s.start_time + s.duration;
  const cliffTime =
    s.cliff_duration > 0 ? s.start_time + s.cliff_duration : null;

  let status: string;
  if (s.revoked) {
    status = "Revoked";
  } else if (s.paused) {
    status = "Paused";
  } else if (now >= endTime) {
    status = "Completed";
  } else {
    status = "Active";
  }

  const elapsed = Math.max(0, now - s.start_time);
  const progressPct =
    s.duration > 0
      ? Math.min(100, Math.round((elapsed / s.duration) * 100))
      : 100;

  const remaining = s.total_amount - s.claimed;

  return {
    id: String(s.id),
    grantor: truncate(s.grantor),
    beneficiary: truncate(s.beneficiary),
    totalAmountXlm: stroopsToXlm(s.total_amount),
    claimedXlm: stroopsToXlm(s.claimed),
    remainingXlm: stroopsToXlm(remaining >= 0n ? remaining : 0n),
    startDate: formatDate(s.start_time),
    endDate: formatDate(endTime),
    cliffDate: cliffTime !== null ? formatDate(cliffTime) : null,
    kind: s.kind,
    status,
    progressPct,
  };
}

/**
 * Total weight for splits (100% = 10_000 basis points).
 * All receiver weights must sum to this value.
 * Mirrors the TOTAL_SPLITS_WEIGHT constant in the Soroban contract.
 */
export const TOTAL_SPLITS_WEIGHT = 10_000;

/**
 * Maximum number of receivers allowed in a splits configuration.
 * Mirrors the MAX_SPLITS_RECEIVERS constant in the Soroban contract.
 */
export const MAX_SPLITS_RECEIVERS = 20;
