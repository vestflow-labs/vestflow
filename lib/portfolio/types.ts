/**
 * View-model types shared by the portfolio timeline canvas, its Web Worker,
 * and the API mapping layer.
 *
 * The contract exposes two schedule shapes — `VestingSchedule` (one token) and
 * `MultiTokenVestingSchedule` (a list of `TokenTranche`). Both collapse into a
 * single row model here: every schedule carries a `tokens` array, with length 1
 * for the ordinary case. The renderer only has to know about one shape, and a
 * multi-token schedule naturally becomes N stacked sub-rows.
 *
 * Timestamps are Unix seconds — the same unit the contract's ledger timestamps
 * use — and are referred to as "ledger" throughout the timeline code.
 */

export type TimelineRole = "grantor" | "beneficiary" | "both";

export type VestingKind = "Linear" | "Cliff" | "LinearWithCliff" | "Graded";

/** One token's amounts inside a schedule. Mirrors the contract's `TokenTranche`. */
export interface TokenLeg {
  token: string;
  total_amount: bigint;
  claimed: bigint;
}

/**
 * A graded-vesting tranche, in the frontend's absolute-timestamp form.
 *
 * The contract stores `(offset_secs, bps)`; `lib/stellar.ts` normalises that to
 * `{ pct, timestamp }` and `vestingProgress` reads it in that form, so the
 * timeline uses the same convention.
 */
export interface TimelineMilestone {
  /** Percent of the total unlocked by this tranche (0–100). */
  pct: number;
  /** Absolute Unix timestamp at which the tranche unlocks. */
  timestamp: number;
}

export interface TimelineSchedule {
  id: number;
  grantor: string;
  beneficiary: string;
  /** How the connected wallet relates to this schedule. */
  role: TimelineRole;
  kind: VestingKind;
  start_time: number;
  duration: number;
  cliff_duration: number;
  lockup_duration: number;
  paused: boolean;
  paused_duration: number;
  paused_at: number;
  revoked: boolean;
  vested_at_revoke: bigint;
  /** Always at least one entry; more than one means a multi-token schedule. */
  tokens: TokenLeg[];
  milestones: TimelineMilestone[];
}

/** Sum of every token leg's total. */
export function scheduleTotal(s: TimelineSchedule): bigint {
  return s.tokens.reduce((acc, t) => acc + t.total_amount, 0n);
}

/** Sum of every token leg's claimed amount. */
export function scheduleClaimed(s: TimelineSchedule): bigint {
  return s.tokens.reduce((acc, t) => acc + t.claimed, 0n);
}

/** True when the schedule vests more than one asset and needs stacked sub-rows. */
export function isMultiToken(s: TimelineSchedule): boolean {
  return s.tokens.length > 1;
}

/** Ledger at which the cliff (if any) releases. Equals `start_time` with no cliff. */
export function cliffEndLedger(s: TimelineSchedule): number {
  return s.start_time + Math.max(0, s.cliff_duration);
}

/**
 * Ledger at which the schedule reaches 100%.
 *
 * Mirrors the contract's `fully_vested_at`: paused time pushes the end out,
 * because paused seconds do not count towards elapsed vesting time.
 */
export function endLedger(s: TimelineSchedule): number {
  return s.start_time + Math.max(0, s.duration) + Math.max(0, s.paused_duration);
}

/**
 * Unlock ledgers a graded schedule steps at.
 *
 * Returned sorted ascending so the renderer can draw tick marks left to right
 * without re-sorting every frame.
 */
export function trancheLedgers(s: TimelineSchedule): number[] {
  if (s.kind !== "Graded") return [];
  return s.milestones.map((m) => m.timestamp).sort((a, b) => a - b);
}
