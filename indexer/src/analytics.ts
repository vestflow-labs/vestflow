/**
 * VestFlow Analytics Materialization Worker
 *
 * Folds raw schedule_events (schedule_created / claimed / revoked) into the
 * schedule_daily_snapshots, token_daily_tvl and grantor_daily_stats tables
 * so the /analytics/* endpoints never have to scan raw events at request
 * time.
 *
 * Incremental by construction: every schedule_events row carries a
 * `materialized_at` marker (see schema.sql). Each run picks up only the
 * rows still marked NULL, works out which (schedule, day) / (token, day) /
 * (grantor, day) pairs they touch, and recomputes just those rows from the
 * schedule's full event history. Because the recompute is a full fold over
 * that one schedule's events (not a running diff), replayed events that
 * land out of ledger order — including ones for a day already
 * materialized — self-correct the affected day without touching any other
 * day's snapshot.
 *
 * Each run also writes the current hour's per-token summary of active Drips
 * streams into stream_hourly_snapshots.
 */

import {
  getUnmaterializedEvents,
  markEventsMaterialized,
  getEventsForSchedule,
  getScheduleIdsForToken,
  getScheduleIdsForGrantor,
  getScheduleSnapshotOnOrBefore,
  upsertScheduleDailySnapshot,
  upsertTokenDailyTvl,
  upsertGrantorDailyStats,
  runInTransaction,
  queryScheduleDailySnapshots,
  queryTokenDailyTvl,
  getStreamTotalsByToken,
  getStreamHourlySnapshotBefore,
  upsertStreamHourlySnapshot,
  type RawScheduleEventRow,
  type ScheduleDailySnapshotRow,
} from "./db";
import type { NetworkName } from "./config";

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;

// ── Day bucketing ─────────────────────────────────────────────────────

/** `ledger_closed_at` is an ISO 8601 timestamp from Stellar RPC. */
export function dayFromIso(iso: string): string {
  return iso.slice(0, 10);
}

/** Unix seconds at the last instant of the given YYYY-MM-DD day (UTC). */
export function endOfDaySeconds(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1000) + SECONDS_PER_DAY - 1;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Vesting curve ─────────────────────────────────────────────────────

export interface VestingParams {
  total_amount: bigint;
  start_time: number;
  duration: number;
  cliff_duration: number;
  vesting_kind: string | null;
}

/**
 * Mirrors VestingSchedule::vested_at in contracts/vestflow/src/lib.rs for
 * the Linear and LinearWithCliff/Cliff variants — the only ones whose
 * vested amount is a pure function of time (no external milestone state).
 * Other kinds (e.g. graded/milestone schedules) fall back to `null`,
 * signaling the caller to treat "vested" conservatively as "claimed so
 * far" rather than guess at unindexed milestone state.
 */
export function vestedAt(params: VestingParams, atSeconds: number): bigint | null {
  const { total_amount, start_time, duration, cliff_duration, vesting_kind } = params;

  if (atSeconds <= start_time) return 0n;
  if (duration <= 0) return total_amount;
  const elapsed = atSeconds - start_time;
  if (elapsed >= duration) return total_amount;

  const kind = (vesting_kind ?? "Linear").replace(/"/g, "");

  if (kind === "Cliff") {
    return elapsed >= cliff_duration ? total_amount : 0n;
  }

  if (kind === "LinearWithCliff") {
    if (elapsed < cliff_duration) return 0n;
    const linearDuration = BigInt(duration - cliff_duration);
    const linearElapsed = BigInt(elapsed - cliff_duration);
    if (linearDuration <= 0n) return total_amount;
    return (total_amount * linearElapsed) / linearDuration;
  }

  if (kind === "Linear") {
    return (total_amount * BigInt(elapsed)) / BigInt(duration);
  }

  // Graded / milestone / unrecognized kinds: no pure-time formula available.
  return null;
}

// ── Per-schedule fold ─────────────────────────────────────────────────

interface ScheduleState {
  token: string | null;
  grantor: string | null;
  vestingParams: VestingParams | null;
  createdAmount: bigint;
  claimedByDay: Map<string, bigint>; // incremental claimed amount, keyed by day
  revokedAtDay: string | null;
  revokedUnvested: bigint;
}

function foldScheduleEvents(rows: RawScheduleEventRow[]): ScheduleState {
  const state: ScheduleState = {
    token: null,
    grantor: null,
    vestingParams: null,
    createdAmount: 0n,
    claimedByDay: new Map(),
    revokedAtDay: null,
    revokedUnvested: 0n,
  };

  for (const row of rows) {
    const day = dayFromIso(row.ledger_closed_at);

    if (row.event_type === "schedule_created") {
      state.token = row.token;
      state.grantor = row.grantor;
      state.createdAmount = BigInt(row.created_amount ?? "0");
      if (row.start_time != null && row.duration != null) {
        state.vestingParams = {
          total_amount: state.createdAmount,
          start_time: row.start_time,
          duration: row.duration,
          cliff_duration: row.cliff_duration ?? 0,
          vesting_kind: row.vesting_kind,
        };
      }
    } else if (row.event_type === "claimed") {
      const claimed = BigInt(row.amount ?? "0");
      state.claimedByDay.set(day, (state.claimedByDay.get(day) ?? 0n) + claimed);
    } else if (row.event_type === "revoked") {
      // value: [schedule_id, unvested, vested]
      let unvested = 0n;
      try {
        const value = JSON.parse(row.raw_value);
        const arr = Array.isArray(value) ? value : Object.values(value ?? {});
        unvested = BigInt(arr[1] ?? 0);
      } catch {
        unvested = 0n;
      }
      state.revokedAtDay = day;
      state.revokedUnvested = unvested;
    }
  }

  return state;
}

/**
 * Snapshot for `scheduleId` as of the end of `day`, given its full event
 * history. Returns null if the schedule has no schedule_created event yet
 * (defensive — shouldn't happen since created always precedes other events).
 */
function computeScheduleSnapshotForDay(
  state: ScheduleState,
  day: string
): { vested: bigint; claimed: bigint; claimable: bigint; locked: bigint } | null {
  if (state.createdAmount === 0n && state.vestingParams === null && state.claimedByDay.size === 0) {
    return null;
  }

  let claimed = 0n;
  for (const [claimDay, amount] of state.claimedByDay) {
    if (claimDay <= day) claimed += amount;
  }

  const isRevokedByDay = state.revokedAtDay !== null && state.revokedAtDay <= day;
  const total = state.createdAmount;

  let vested: bigint;
  if (isRevokedByDay) {
    // Once revoked, only what had already vested (== created - unvested
    // clawed back) can ever be claimed; nothing more accrues.
    vested = total - state.revokedUnvested;
  } else if (state.vestingParams) {
    const computed = vestedAt(state.vestingParams, endOfDaySeconds(day));
    vested = computed ?? claimed; // unknown curve shape → conservative
  } else {
    vested = claimed; // no curve params captured (legacy replayed event)
  }

  if (vested < claimed) vested = claimed; // never report less than what's provably claimed
  if (vested > total) vested = total;

  const claimable = vested - claimed;
  const locked = total - vested - (isRevokedByDay ? state.revokedUnvested : 0n);

  return {
    vested,
    claimed,
    claimable: claimable > 0n ? claimable : 0n,
    locked: locked > 0n ? locked : 0n,
  };
}

// ── Materialization run ───────────────────────────────────────────────

export interface MaterializeResult {
  events_processed: number;
  schedules_affected: number;
  tokens_affected: number;
  grantors_affected: number;
}

/**
 * Folds every not-yet-materialized event into the snapshot tables and
 * refreshes the current hour's stream snapshot. Safe to call after every
 * processed ledger batch — apart from the stream snapshot it's a no-op
 * (besides a cheap SELECT) when there's nothing new.
 */
export function materialize(network?: NetworkName): MaterializeResult {
  materializeStreamHourlySnapshots(network);

  const pending = getUnmaterializedEvents(network);
  if (pending.length === 0) {
    return { events_processed: 0, schedules_affected: 0, tokens_affected: 0, grantors_affected: 0 };
  }

  // Group pending events by schedule so we touch each schedule's full
  // history exactly once, and know which days actually need recomputing.
  const affectedDaysBySchedule = new Map<number, Set<string>>();
  for (const row of pending) {
    if (row.schedule_id == null) continue;
    const days = affectedDaysBySchedule.get(row.schedule_id) ?? new Set<string>();
    days.add(dayFromIso(row.ledger_closed_at));
    // A schedule's day-N snapshot also depends on state carried forward
    // from day N; a late claim on an earlier day must re-derive every day
    // from there through today, not just the day it landed on.
    affectedDaysBySchedule.set(row.schedule_id, days);
  }

  const today = todayUtc();
  const affectedTokens = new Set<string>();
  const affectedGrantors = new Set<string>();

  runInTransaction(() => {
    for (const [scheduleId, touchedDays] of affectedDaysBySchedule) {
      const history = getEventsForSchedule(scheduleId, network);
      const state = foldScheduleEvents(history);
      if (state.token) affectedTokens.add(state.token);
      if (state.grantor) affectedGrantors.add(state.grantor);

      // Recompute every day from the earliest touched day through today —
      // a late-arriving past event shifts the running "claimed so far"
      // and "vested so far" totals for every subsequent day, not just the
      // one it landed on.
      const earliestTouched = [...touchedDays].sort()[0];
      for (const day of enumerateDays(earliestTouched, today)) {
        const snapshot = computeScheduleSnapshotForDay(state, day);
        if (!snapshot) continue;
        upsertScheduleDailySnapshot(
          {
            schedule_id: scheduleId,
            day,
            total_vested_stroops: snapshot.vested.toString(),
            total_claimed_stroops: snapshot.claimed.toString(),
            claimable_stroops: snapshot.claimable.toString(),
            locked_stroops: snapshot.locked.toString(),
          },
          network
        );
      }
    }

    recomputeTokenTvl(affectedTokens, today, network);
    recomputeGrantorStats(affectedGrantors, today, network);

    markEventsMaterialized(pending.map((r) => r.id), network);
  }, network);

  return {
    events_processed: pending.length,
    schedules_affected: affectedDaysBySchedule.size,
    tokens_affected: affectedTokens.size,
    grantors_affected: affectedGrantors.size,
  };
}

function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += SECONDS_PER_DAY * 1000;
  }
  return days;
}

function recomputeTokenTvl(tokens: Set<string>, today: string, network?: NetworkName): void {
  for (const token of tokens) {
    const scheduleIds = getScheduleIdsForToken(token, network);
    let totalLocked = 0n;
    let activeCount = 0;
    for (const scheduleId of scheduleIds) {
      const snapshot = getScheduleSnapshotOnOrBefore(scheduleId, today, network);
      if (!snapshot) continue;
      const locked = BigInt(snapshot.locked_stroops);
      totalLocked += locked;
      if (locked > 0n) activeCount++;
    }
    upsertTokenDailyTvl(
      {
        token_address: token,
        day: today,
        total_locked_stroops: totalLocked.toString(),
        active_schedule_count: activeCount,
      },
      network
    );
  }
}

// ── Hourly stream snapshots ───────────────────────────────────────────

/**
 * Writes the current UTC hour's per-token stream summary, overwriting it on
 * later runs in the same hour so the row ends up with that hour's latest
 * state. Hours since a token's previous row that the worker never ran in
 * (e.g. while the poller was down) are filled with that previous row's
 * values, leaving one row per token per hour.
 */
function materializeStreamHourlySnapshots(network?: NetworkName): void {
  const now = Math.floor(Date.now() / 1000);
  const hour = now - (now % SECONDS_PER_HOUR);

  runInTransaction(() => {
    for (const totals of getStreamTotalsByToken(now, network)) {
      const previous = getStreamHourlySnapshotBefore(totals.token, hour, network);
      if (previous) {
        for (let gap = previous.hour + SECONDS_PER_HOUR; gap < hour; gap += SECONDS_PER_HOUR) {
          upsertStreamHourlySnapshot({ ...previous, hour: gap }, network);
        }
      }
      upsertStreamHourlySnapshot({ ...totals, hour }, network);
    }
  }, network);
}

// ── Query helpers backing the /analytics/* endpoints ────────────────────

export interface TvlPoint {
  day: string;
  total_locked_stroops: string;
  active_schedule_count: number;
}

/**
 * Daily TVL for a token over [from, to]. With `cumulative`, returns a
 * running total of `total_locked_stroops` instead of the per-day balance —
 * computed in application code rather than a SQL window function so the
 * same code path works identically on SQLite and Postgres.
 */
export function getTvlSeries(
  token: string,
  from: string,
  to: string,
  cumulative: boolean,
  network?: NetworkName
): TvlPoint[] {
  const rows = queryTokenDailyTvl(token, from, to, network);
  if (!cumulative) {
    return rows.map((r) => ({
      day: r.day,
      total_locked_stroops: r.total_locked_stroops,
      active_schedule_count: r.active_schedule_count,
    }));
  }

  let running = 0n;
  return rows.map((r) => {
    running += BigInt(r.total_locked_stroops);
    return { day: r.day, total_locked_stroops: running.toString(), active_schedule_count: r.active_schedule_count };
  });
}

export interface ScheduleHistoryPoint {
  day: string;
  vested: string;
  claimed: string;
  claimable: string;
  locked: string;
}

/**
 * Daily {vested, claimed, claimable, locked} for a schedule over
 * [from, to], gap-filled: a day with no materialized row (nothing changed
 * that day) repeats the last known values instead of leaving a hole.
 */
export function getScheduleHistory(
  scheduleId: number,
  from: string,
  to: string,
  network?: NetworkName
): ScheduleHistoryPoint[] {
  const rows = queryScheduleDailySnapshots(scheduleId, from, to, network);
  const byDay = new Map(rows.map((r) => [r.day, r]));

  let carry: ScheduleDailySnapshotRow | null = getScheduleSnapshotOnOrBefore(scheduleId, from, network);
  const points: ScheduleHistoryPoint[] = [];

  for (const day of enumerateDays(from, to)) {
    const row = byDay.get(day) ?? carry;
    if (row) {
      carry = row;
      points.push({
        day,
        vested: row.total_vested_stroops,
        claimed: row.total_claimed_stroops,
        claimable: row.claimable_stroops,
        locked: row.locked_stroops,
      });
    }
  }

  return points;
}

export interface GrantorSummary {
  grantor_address: string;
  total_schedules_created: number;
  total_distributed: string;
  active_schedules: number;
  revoked_schedules: number;
  avg_duration_days: number;
}

export function getGrantorSummary(grantorAddress: string, network?: NetworkName): GrantorSummary {
  const scheduleIds = getScheduleIdsForGrantor(grantorAddress, network);

  let totalDistributed = 0n;
  let activeSchedules = 0;
  let revokedSchedules = 0;
  let durationSum = 0;
  let durationCount = 0;

  for (const scheduleId of scheduleIds) {
    const history = getEventsForSchedule(scheduleId, network);
    const state = foldScheduleEvents(history);

    totalDistributed += [...state.claimedByDay.values()].reduce((sum, v) => sum + v, 0n);
    if (state.revokedAtDay !== null) revokedSchedules++;
    if (state.vestingParams) {
      durationSum += state.vestingParams.duration;
      durationCount++;
    }

    const today = todayUtc();
    const latest = getScheduleSnapshotOnOrBefore(scheduleId, today, network);
    if (latest && !state.revokedAtDay && BigInt(latest.locked_stroops) > 0n) {
      activeSchedules++;
    }
  }

  return {
    grantor_address: grantorAddress,
    total_schedules_created: scheduleIds.length,
    total_distributed: totalDistributed.toString(),
    active_schedules: activeSchedules,
    revoked_schedules: revokedSchedules,
    avg_duration_days: durationCount > 0 ? Math.round(durationSum / durationCount / SECONDS_PER_DAY) : 0,
  };
}

function recomputeGrantorStats(grantors: Set<string>, today: string, network?: NetworkName): void {
  for (const grantor of grantors) {
    const scheduleIds = getScheduleIdsForGrantor(grantor, network);
    let totalDistributed = 0n;
    let activeCount = 0;
    for (const scheduleId of scheduleIds) {
      const snapshot = getScheduleSnapshotOnOrBefore(scheduleId, today, network);
      if (!snapshot) continue;
      totalDistributed += BigInt(snapshot.total_claimed_stroops);
      if (BigInt(snapshot.locked_stroops) > 0n) activeCount++;
    }
    upsertGrantorDailyStats(
      {
        grantor_address: grantor,
        day: today,
        active_schedule_count: activeCount,
        total_distributed_stroops: totalDistributed.toString(),
      },
      network
    );
  }
}
