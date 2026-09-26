/**
 * Pure vesting math for the portfolio timeline.
 *
 * This is the same model `vestingProgress` in `lib/stellar.ts` exposes as a
 * percentage, expressed in token base units so the timeline can show a
 * projected claimable amount at an arbitrary cursor position. It mirrors the
 * contract's `VestingSchedule::vested_at` / `claimable_at` (and
 * `MultiTokenVestingSchedule::vested_percentage_at` for multi-token
 * schedules), so a cursor parked on "now" agrees with what the chain reports.
 *
 * Everything here is dependency-free and synchronous: the module is imported
 * both by the Web Worker and by the main thread (as a fallback when workers
 * are unavailable), so it must not touch the DOM or the network.
 */

import type { TimelineSchedule, TokenLeg } from "./types";

/** Message posted to the worker. `schedules` may be omitted to reuse the cached set. */
export interface ClaimableRequest {
  cursorLedger: number;
  schedules?: TimelineSchedule[];
  /** Echoed back so the UI can drop responses for a superseded cursor position. */
  requestId?: number;
}

export interface ClaimableResult {
  scheduleId: number;
  claimableAtCursor: bigint;
}

export interface ClaimableResponse {
  cursorLedger: number;
  requestId?: number;
  results: ClaimableResult[];
}

const BPS_DENOMINATOR = 10_000n;

/**
 * Seconds of vesting progress accrued by `ledger`, excluding paused time.
 *
 * Returns 0 before `start_time`. Mirrors the contract's saturating
 * subtractions: paused time never pushes elapsed below zero.
 *
 * The result is floored to a whole second. A dragged cursor lands on a
 * fractional timestamp — pointer X divided by a float scale — and ledger time
 * on chain only advances in whole seconds, so rounding here keeps the integer
 * amount math exact instead of feeding a fraction to `BigInt`.
 */
export function effectiveElapsed(s: TimelineSchedule, ledger: number): number {
  if (ledger <= s.start_time) return 0;
  let elapsed = ledger - s.start_time;
  elapsed -= Math.max(0, s.paused_duration);
  if (s.paused && s.paused_at > 0) {
    elapsed -= Math.max(0, ledger - s.paused_at);
  }
  return Math.max(0, Math.floor(elapsed));
}

/**
 * Fraction of the schedule vested at `ledger`, in the range 0–1.
 *
 * Used for drawing (gradient stops, progress fills) where sub-unit precision
 * matters more than exact base-unit rounding. Amounts always come from
 * {@link vestedAmountAt}, which uses integer math instead.
 */
export function vestedFractionAt(s: TimelineSchedule, ledger: number): number {
  if (s.revoked) {
    const total = s.tokens.reduce((acc, t) => acc + t.total_amount, 0n);
    if (total <= 0n) return 0;
    return clamp01(Number(s.vested_at_revoke) / Number(total));
  }
  if (ledger < s.start_time) return 0;

  const elapsed = effectiveElapsed(s, ledger);

  switch (s.kind) {
    case "Cliff":
      return elapsed >= s.cliff_duration ? 1 : 0;
    case "LinearWithCliff": {
      if (elapsed < s.cliff_duration) return 0;
      if (elapsed >= s.duration) return 1;
      const linearDuration = s.duration - s.cliff_duration;
      if (linearDuration <= 0) return 1;
      return clamp01((elapsed - s.cliff_duration) / linearDuration);
    }
    case "Graded": {
      // Compare against the pause-adjusted ledger so a paused graded schedule
      // stops crossing tranches, exactly like the contract's offset compare.
      const effectiveLedger = s.start_time + elapsed;
      const pct = s.milestones
        .filter((m) => effectiveLedger >= m.timestamp)
        .reduce((sum, m) => sum + m.pct, 0);
      return clamp01(pct / 100);
    }
    case "Linear":
    default: {
      if (s.duration <= 0) return 1;
      if (elapsed >= s.duration) return 1;
      return clamp01(elapsed / s.duration);
    }
  }
}

/**
 * Vested amount, in base units, for one token leg at `ledger`.
 *
 * Single-token schedules use the contract's direct
 * `total * elapsed / duration` form. Multi-token schedules go through basis
 * points, matching `MultiTokenVestingSchedule::vested_percentage_at` — the two
 * round differently and the timeline should agree with whichever the chain
 * will actually pay out.
 */
export function vestedForLeg(
  s: TimelineSchedule,
  leg: TokenLeg,
  ledger: number
): bigint {
  if (leg.total_amount <= 0n) return 0n;

  if (s.revoked) {
    // Single-token schedules freeze at the amount captured on revocation.
    // Multi-token schedules have no per-leg snapshot on chain, so the contract
    // treats them as fully vested; follow it rather than invent a number.
    if (s.tokens.length === 1) {
      return min(s.vested_at_revoke, leg.total_amount);
    }
    return leg.total_amount;
  }

  if (ledger < s.start_time) return 0n;
  const elapsed = BigInt(effectiveElapsed(s, ledger));

  if (s.tokens.length > 1) {
    const bps = vestedBpsAt(s, ledger);
    return min((leg.total_amount * bps) / BPS_DENOMINATOR, leg.total_amount);
  }

  const cliff = BigInt(Math.floor(s.cliff_duration));
  const duration = BigInt(Math.floor(s.duration));

  switch (s.kind) {
    case "Cliff":
      return elapsed >= cliff ? leg.total_amount : 0n;
    case "LinearWithCliff": {
      if (elapsed < cliff) return 0n;
      if (elapsed >= duration) return leg.total_amount;
      const linearDuration = duration - cliff;
      if (linearDuration <= 0n) return leg.total_amount;
      return (leg.total_amount * (elapsed - cliff)) / linearDuration;
    }
    case "Graded": {
      const bps = vestedBpsAt(s, ledger);
      return min((leg.total_amount * bps) / BPS_DENOMINATOR, leg.total_amount);
    }
    case "Linear":
    default: {
      if (duration <= 0n) return leg.total_amount;
      if (elapsed >= duration) return leg.total_amount;
      return (leg.total_amount * elapsed) / duration;
    }
  }
}

/** Vested fraction expressed in basis points (0–10 000), as the contract does. */
export function vestedBpsAt(s: TimelineSchedule, ledger: number): bigint {
  if (ledger < s.start_time) return 0n;
  const elapsed = effectiveElapsed(s, ledger);

  switch (s.kind) {
    case "Cliff":
      return elapsed >= s.cliff_duration ? BPS_DENOMINATOR : 0n;
    case "LinearWithCliff": {
      if (elapsed < s.cliff_duration) return 0n;
      if (elapsed >= s.duration) return BPS_DENOMINATOR;
      const linearDuration = BigInt(Math.floor(s.duration - s.cliff_duration));
      if (linearDuration <= 0n) return BPS_DENOMINATOR;
      return (
        (BPS_DENOMINATOR * BigInt(elapsed - Math.floor(s.cliff_duration))) / linearDuration
      );
    }
    case "Graded": {
      const effectiveLedger = s.start_time + elapsed;
      const pct = s.milestones
        .filter((m) => effectiveLedger >= m.timestamp)
        .reduce((sum, m) => sum + m.pct, 0);
      // pct is a percentage; 1 % == 100 bps. Round down to stay conservative.
      const bps = BigInt(Math.floor(pct * 100));
      return bps > BPS_DENOMINATOR ? BPS_DENOMINATOR : bps;
    }
    case "Linear":
    default: {
      if (s.duration <= 0) return BPS_DENOMINATOR;
      if (elapsed >= s.duration) return BPS_DENOMINATOR;
      return (BPS_DENOMINATOR * BigInt(elapsed)) / BigInt(Math.floor(s.duration));
    }
  }
}

/** Total vested across every token leg at `ledger`. */
export function vestedAmountAt(s: TimelineSchedule, ledger: number): bigint {
  let total = 0n;
  for (const leg of s.tokens) total += vestedForLeg(s, leg, ledger);
  return total;
}

/**
 * Projected claimable amount at `ledger`, summed across token legs.
 *
 * Returns 0 while the lockup window is still open, matching the contract:
 * tokens can be vested and yet not withdrawable.
 */
export function claimableAt(s: TimelineSchedule, ledger: number): bigint {
  const lockupEnd = s.start_time + Math.max(0, s.lockup_duration);
  if (ledger < lockupEnd) return 0n;

  let claimable = 0n;
  for (const leg of s.tokens) {
    const vested = vestedForLeg(s, leg, ledger);
    if (vested > leg.claimed) claimable += vested - leg.claimed;
  }
  return claimable;
}

/**
 * Claimable amount for every schedule at one cursor position.
 *
 * This is the whole body of the Web Worker's work. It allocates a single
 * result array and does no string or object churn per schedule, which is what
 * keeps 200 schedules comfortably inside one 16 ms frame.
 */
export function computeClaimableForCursor(
  schedules: readonly TimelineSchedule[],
  cursorLedger: number
): ClaimableResult[] {
  const results: ClaimableResult[] = new Array(schedules.length);
  for (let i = 0; i < schedules.length; i++) {
    const s = schedules[i];
    results[i] = { scheduleId: s.id, claimableAtCursor: claimableAt(s, cursorLedger) };
  }
  return results;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
