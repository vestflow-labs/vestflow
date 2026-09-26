import { Pool, PoolClient, QueryResult } from "pg";
import fs from "fs";
import path from "path";
import type { EventQueryParams, IndexedEvent } from "./types";
import { getDatabasePoolConfig } from "./config";

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const POOL_CONFIG = getDatabasePoolConfig();

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    if (!DB_URL) {
      throw new Error(
        "PostgreSQL connection string not found. Set DATABASE_URL or POSTGRES_URL environment variable."
      );
    }
    pool = new Pool({
      connectionString: DB_URL,
      min: POOL_CONFIG.min,
      max: POOL_CONFIG.max,
      idleTimeoutMillis: POOL_CONFIG.idleTimeoutMs,
      connectionTimeoutMillis: 2000,
    });
  }
  return pool;
}

export async function initializeSchema(): Promise<void> {
  const migrationsDir = path.join(__dirname, "..", "migrations");
  const files = [
    "001_postgresql_schema.sql",
    "002_proposal_events.sql",
    "003_webhook_system.sql",
    "004_analytics_snapshots.sql",
    "005_gives_token_indexes.sql",
    "006_stream_hourly_snapshots.sql",
  ];
  const client = await getPool().connect();
  try {
    for (const file of files) {
      const schema = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query(schema);
    }
  } finally {
    client.release();
  }
}

export async function getCheckpoint(): Promise<number> {
  const result = await getPool().query(
    "SELECT last_ledger FROM checkpoint WHERE id = 1"
  );
  return result.rows[0]?.last_ledger ?? 0;
}

export async function setCheckpoint(ledger: number): Promise<void> {
  await getPool().query(
    "UPDATE checkpoint SET last_ledger = $1, last_updated = NOW() WHERE id = 1",
    [ledger]
  );
}

export interface InsertScheduleRow {
  schedule_id: number;
  grantor: string;
  beneficiary: string;
  token: string;
  total_amount: string;
  claimed: string;
  start_time: number;
  duration: number;
  cliff_duration: number;
  vesting_kind: string;
  revocable: boolean;
  revoked: boolean;
  ledger_created: number;
  ledger_closed_at: string;
}

export async function upsertSchedule(schedule: InsertScheduleRow): Promise<void> {
  await getPool().query(
    `INSERT INTO vesting_schedules 
      (schedule_id, grantor, beneficiary, token, total_amount, claimed, 
       start_time, duration, cliff_duration, vesting_kind, revocable, revoked,
       ledger_created, ledger_closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (schedule_id) DO UPDATE SET
       claimed = EXCLUDED.claimed,
       revoked = EXCLUDED.revoked,
       updated_at = NOW()`,
    [
      schedule.schedule_id,
      schedule.grantor,
      schedule.beneficiary,
      schedule.token,
      schedule.total_amount,
      schedule.claimed,
      schedule.start_time,
      schedule.duration,
      schedule.cliff_duration,
      schedule.vesting_kind,
      schedule.revocable,
      schedule.revoked,
      schedule.ledger_created,
      schedule.ledger_closed_at,
    ]
  );
}

export interface InsertClaimEventRow {
  id: string;
  schedule_id: number;
  beneficiary: string;
  amount: string;
  ledger: number;
  ledger_closed_at: string;
  transaction_hash: string | null;
  raw_topics: string;
  raw_value: string;
}

export async function insertClaimEvent(event: InsertClaimEventRow): Promise<boolean> {
  const result = await getPool().query(
    `INSERT INTO claim_events 
      (id, schedule_id, beneficiary, amount, ledger, ledger_closed_at, 
       transaction_hash, raw_topics, raw_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.schedule_id,
      event.beneficiary,
      event.amount,
      event.ledger,
      event.ledger_closed_at,
      event.transaction_hash,
      event.raw_topics,
      event.raw_value,
    ]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export interface InsertRevokeEventRow {
  id: string;
  schedule_id: number;
  grantor: string;
  revoked_amount: string;
  ledger: number;
  ledger_closed_at: string;
  transaction_hash: string | null;
  raw_topics: string;
  raw_value: string;
}

export async function insertRevokeEvent(event: InsertRevokeEventRow): Promise<boolean> {
  const result = await getPool().query(
    `INSERT INTO revoke_events 
      (id, schedule_id, grantor, revoked_amount, ledger, ledger_closed_at, 
       transaction_hash, raw_topics, raw_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.schedule_id,
      event.grantor,
      event.revoked_amount,
      event.ledger,
      event.ledger_closed_at,
      event.transaction_hash,
      event.raw_topics,
      event.raw_value,
    ]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export interface InsertGivenEventRow {
  id: string;
  sender: string;
  receiver: string;
  token: string;
  amount_stroops: string;
  ledger: number;
  timestamp: string;
}

export async function insertGivenEvent(event: InsertGivenEventRow): Promise<boolean> {
  const result = await getPool().query(
    `INSERT INTO gives (id, sender, receiver, token, amount_stroops, ledger, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.sender,
      event.receiver,
      event.token,
      event.amount_stroops,
      event.ledger,
      event.timestamp,
    ]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function upsertCurrentStream(row: {
  account: string;
  token: string;
  receivers_json: unknown;
  updated_at: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO current_streams (account, token, receivers_json, updated_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (account, token) DO UPDATE SET
       receivers_json = EXCLUDED.receivers_json,
       updated_at = EXCLUDED.updated_at`,
    [row.account, row.token, JSON.stringify(row.receivers_json), row.updated_at]
  );
}

export async function upsertCollectedTotal(row: {
  account: string;
  token: string;
  amount_stroops: string;
  updated_at: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO collected_totals (account, token, total_collected_stroops, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account, token) DO UPDATE SET
       total_collected_stroops = collected_totals.total_collected_stroops + EXCLUDED.total_collected_stroops,
       updated_at = EXCLUDED.updated_at`,
    [row.account, row.token, row.amount_stroops, row.updated_at]
  );
}

export async function getScheduleById(scheduleId: number): Promise<any | null> {
  const result = await getPool().query(
    "SELECT * FROM vesting_schedules WHERE schedule_id = $1",
    [scheduleId]
  );
  return result.rows[0] || null;
}

export async function getClaimEventsByScheduleId(scheduleId: number): Promise<any[]> {
  const result = await getPool().query(
    "SELECT * FROM claim_events WHERE schedule_id = $1 ORDER BY ledger DESC",
    [scheduleId]
  );
  return result.rows;
}

export async function getRevokeEventsByScheduleId(scheduleId: number): Promise<any[]> {
  const result = await getPool().query(
    "SELECT * FROM revoke_events WHERE schedule_id = $1 ORDER BY ledger DESC",
    [scheduleId]
  );
  return result.rows;
}

export async function getSchedulesByAddress(address: string): Promise<any[]> {
  const result = await getPool().query(
    `SELECT * FROM vesting_schedules 
     WHERE grantor = $1 OR beneficiary = $1 
     ORDER BY created_at DESC`,
    [address]
  );
  return result.rows;
}

export async function getAllSchedules(): Promise<any[]> {
  const result = await getPool().query(
    "SELECT * FROM vesting_schedules ORDER BY schedule_id DESC"
  );
  return result.rows;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── Beneficiary Index ─────────────────────────────────────────────────────

/**
 * Insert a beneficiary-schedule mapping into the index table.
 * Called when a schedule is created.
 */
export async function insertBeneficiarySchedule(beneficiary: string, scheduleId: number): Promise<void> {
  await getPool().query(
    `INSERT INTO beneficiary_schedules (beneficiary, schedule_id)
     VALUES ($1, $2)
     ON CONFLICT (beneficiary, schedule_id) DO NOTHING`,
    [beneficiary, scheduleId]
  );
}

/**
 * Get all schedule IDs for a beneficiary address using the index.
 * Provides O(1) lookup by leveraging the beneficiary_schedules table.
 */
export async function getScheduleIdsByBeneficiary(beneficiary: string): Promise<number[]> {
  const result = await getPool().query(
    "SELECT schedule_id FROM beneficiary_schedules WHERE beneficiary = $1 ORDER BY created_at DESC",
    [beneficiary]
  );
  return result.rows.map((row: any) => row.schedule_id);
}

// ── Materialized analytics snapshots ────────────────────────────────────
// Mirrors the query surface in db.ts (SQLite) against the tables added by
// migrations/004_analytics_snapshots.sql, so the /analytics/* handlers in
// server.ts can run unmodified against either backend once a Postgres-backed
// materialization worker is wired up (schedule_created/claimed/revoked here
// are split across vesting_schedules/claim_events/revoke_events rather than
// a single events table, so that worker folds across three tables instead
// of one — see analytics.ts for the SQLite fold this should mirror).

export interface PgScheduleDailySnapshotRow {
  schedule_id: number;
  day: string;
  total_vested_stroops: string;
  total_claimed_stroops: string;
  claimable_stroops: string;
  locked_stroops: string;
}

export async function upsertScheduleDailySnapshot(row: PgScheduleDailySnapshotRow): Promise<void> {
  await getPool().query(
    `INSERT INTO schedule_daily_snapshots
      (schedule_id, day, total_vested_stroops, total_claimed_stroops, claimable_stroops, locked_stroops)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (schedule_id, day) DO UPDATE SET
       total_vested_stroops = EXCLUDED.total_vested_stroops,
       total_claimed_stroops = EXCLUDED.total_claimed_stroops,
       claimable_stroops = EXCLUDED.claimable_stroops,
       locked_stroops = EXCLUDED.locked_stroops`,
    [row.schedule_id, row.day, row.total_vested_stroops, row.total_claimed_stroops, row.claimable_stroops, row.locked_stroops]
  );
}

export async function queryScheduleDailySnapshots(
  scheduleId: number,
  from: string,
  to: string
): Promise<PgScheduleDailySnapshotRow[]> {
  const result = await getPool().query(
    `SELECT schedule_id, day::text, total_vested_stroops::text, total_claimed_stroops::text,
            claimable_stroops::text, locked_stroops::text
     FROM schedule_daily_snapshots
     WHERE schedule_id = $1 AND day >= $2 AND day <= $3
     ORDER BY day ASC`,
    [scheduleId, from, to]
  );
  return result.rows;
}

export interface PgTokenDailyTvlRow {
  token_address: string;
  day: string;
  total_locked_stroops: string;
  active_schedule_count: number;
}

export async function upsertTokenDailyTvl(row: PgTokenDailyTvlRow): Promise<void> {
  await getPool().query(
    `INSERT INTO token_daily_tvl (token_address, day, total_locked_stroops, active_schedule_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token_address, day) DO UPDATE SET
       total_locked_stroops = EXCLUDED.total_locked_stroops,
       active_schedule_count = EXCLUDED.active_schedule_count`,
    [row.token_address, row.day, row.total_locked_stroops, row.active_schedule_count]
  );
}

export async function queryTokenDailyTvl(
  token: string,
  from: string,
  to: string
): Promise<PgTokenDailyTvlRow[]> {
  const result = await getPool().query(
    `SELECT token_address, day::text, total_locked_stroops::text, active_schedule_count
     FROM token_daily_tvl
     WHERE token_address = $1 AND day >= $2 AND day <= $3
     ORDER BY day ASC`,
    [token, from, to]
  );
  return result.rows;
}

export interface PgGrantorDailyStatsRow {
  grantor_address: string;
  day: string;
  active_schedule_count: number;
  total_distributed_stroops: string;
}

export async function upsertGrantorDailyStats(row: PgGrantorDailyStatsRow): Promise<void> {
  await getPool().query(
    `INSERT INTO grantor_daily_stats (grantor_address, day, active_schedule_count, total_distributed_stroops)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (grantor_address, day) DO UPDATE SET
       active_schedule_count = EXCLUDED.active_schedule_count,
       total_distributed_stroops = EXCLUDED.total_distributed_stroops`,
    [row.grantor_address, row.day, row.active_schedule_count, row.total_distributed_stroops]
  );
}

export async function getAnalyticsWatermark(network: string): Promise<number> {
  const result = await getPool().query(
    "SELECT last_ledger FROM analytics_watermark WHERE network = $1",
    [network]
  );
  return Number(result.rows[0]?.last_ledger ?? 0);
}

export async function setAnalyticsWatermark(network: string, ledger: number): Promise<void> {
  await getPool().query(
    `INSERT INTO analytics_watermark (network, last_ledger, last_materialized_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (network) DO UPDATE SET
       last_ledger = EXCLUDED.last_ledger,
       last_materialized_at = EXCLUDED.last_materialized_at`,
    [network, ledger]
  );
}

export interface PgRawScheduleEventRow {
  id: string;
  event_type: "schedule_created" | "claimed" | "revoked";
  ledger: number;
  ledger_closed_at: string;
  schedule_id: number;
  grantor: string | null;
  beneficiary: string | null;
  token: string | null;
  amount: string | null;
  created_amount: string | null;
  start_time: number | null;
  duration: number | null;
  cliff_duration: number | null;
  vesting_kind: string | null;
  raw_value: string;
}

export async function getPostgresEventsAfterWatermark(
  lastLedger: number
): Promise<PgRawScheduleEventRow[]> {
  const result = await getPool().query(
    `SELECT ('schedule_created:' || schedule_id::text) AS id,
            'schedule_created' AS event_type, ledger_created AS ledger,
            ledger_closed_at::text, schedule_id, grantor, beneficiary, token,
            NULL::text AS amount, total_amount::text AS created_amount,
            start_time, duration, cliff_duration, vesting_kind, '{}'::text AS raw_value
       FROM vesting_schedules
       WHERE ledger_created > $1
     UNION ALL
     SELECT c.id, 'claimed' AS event_type, c.ledger, c.ledger_closed_at::text,
            c.schedule_id, v.grantor, c.beneficiary, v.token,
            c.amount::text AS amount, NULL::text AS created_amount,
            NULL::bigint AS start_time, NULL::bigint AS duration,
            NULL::bigint AS cliff_duration, NULL::text AS vesting_kind, c.raw_value
       FROM claim_events c
       JOIN vesting_schedules v ON v.schedule_id = c.schedule_id
       WHERE c.ledger > $1
     UNION ALL
     SELECT r.id, 'revoked' AS event_type, r.ledger, r.ledger_closed_at::text,
            r.schedule_id, r.grantor, v.beneficiary, v.token,
            r.revoked_amount::text AS amount, NULL::text AS created_amount,
            NULL::bigint AS start_time, NULL::bigint AS duration,
            NULL::bigint AS cliff_duration, NULL::text AS vesting_kind, r.raw_value
       FROM revoke_events r
       JOIN vesting_schedules v ON v.schedule_id = r.schedule_id
       WHERE r.ledger > $1
     ORDER BY ledger ASC, id ASC`,
    [lastLedger]
  );
  return result.rows;
}

export async function getPostgresEventsForSchedule(
  scheduleId: number
): Promise<PgRawScheduleEventRow[]> {
  const result = await getPool().query(
    `SELECT ('schedule_created:' || schedule_id::text) AS id,
            'schedule_created' AS event_type, ledger_created AS ledger,
            ledger_closed_at::text, schedule_id, grantor, beneficiary, token,
            NULL::text AS amount, total_amount::text AS created_amount,
            start_time, duration, cliff_duration, vesting_kind, '{}'::text AS raw_value
       FROM vesting_schedules
       WHERE schedule_id = $1
     UNION ALL
     SELECT c.id, 'claimed' AS event_type, c.ledger, c.ledger_closed_at::text,
            c.schedule_id, v.grantor, c.beneficiary, v.token,
            c.amount::text AS amount, NULL::text AS created_amount,
            NULL::bigint AS start_time, NULL::bigint AS duration,
            NULL::bigint AS cliff_duration, NULL::text AS vesting_kind, c.raw_value
       FROM claim_events c
       JOIN vesting_schedules v ON v.schedule_id = c.schedule_id
       WHERE c.schedule_id = $1
     UNION ALL
     SELECT r.id, 'revoked' AS event_type, r.ledger, r.ledger_closed_at::text,
            r.schedule_id, r.grantor, v.beneficiary, v.token,
            r.revoked_amount::text AS amount, NULL::text AS created_amount,
            NULL::bigint AS start_time, NULL::bigint AS duration,
            NULL::bigint AS cliff_duration, NULL::text AS vesting_kind, r.raw_value
       FROM revoke_events r
       JOIN vesting_schedules v ON v.schedule_id = r.schedule_id
       WHERE r.schedule_id = $1
     ORDER BY ledger ASC, id ASC`,
    [scheduleId]
  );
  return result.rows;
}

const SECONDS_PER_DAY = 86_400;

function pgDayFromIso(iso: string): string {
  return iso.slice(0, 10);
}

function pgEndOfDaySeconds(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1000) + SECONDS_PER_DAY - 1;
}

function pgEnumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += SECONDS_PER_DAY * 1000;
  }
  return days;
}

function pgVestedAt(row: PgRawScheduleEventRow, atSeconds: number): bigint | null {
  const total = BigInt(row.created_amount ?? "0");
  if (row.start_time == null || row.duration == null) return null;
  if (atSeconds <= row.start_time) return 0n;
  if (row.duration <= 0) return total;
  const elapsed = atSeconds - row.start_time;
  if (elapsed >= row.duration) return total;

  const kind = (row.vesting_kind ?? "Linear").replace(/"/g, "");
  if (kind === "Cliff") {
    return elapsed >= (row.cliff_duration ?? 0) ? total : 0n;
  }
  if (kind === "LinearWithCliff") {
    const cliff = row.cliff_duration ?? 0;
    if (elapsed < cliff) return 0n;
    const linearDuration = BigInt(row.duration - cliff);
    const linearElapsed = BigInt(elapsed - cliff);
    if (linearDuration <= 0n) return total;
    return (total * linearElapsed) / linearDuration;
  }
  if (kind === "Linear") {
    return (total * BigInt(elapsed)) / BigInt(row.duration);
  }
  return null;
}

export interface PostgresMaterializeResult {
  events_processed: number;
  schedules_affected: number;
  tokens_affected: number;
  grantors_affected: number;
  watermark_ledger: number;
}

export async function materializePostgresAnalytics(network: string): Promise<PostgresMaterializeResult> {
  const lastLedger = await getAnalyticsWatermark(network);
  const pending = await getPostgresEventsAfterWatermark(lastLedger);
  if (pending.length === 0) {
    return {
      events_processed: 0,
      schedules_affected: 0,
      tokens_affected: 0,
      grantors_affected: 0,
      watermark_ledger: lastLedger,
    };
  }

  const affected = new Map<number, Set<string>>();
  let watermark = lastLedger;
  for (const row of pending) {
    watermark = Math.max(watermark, row.ledger);
    const days = affected.get(row.schedule_id) ?? new Set<string>();
    days.add(pgDayFromIso(row.ledger_closed_at));
    affected.set(row.schedule_id, days);
  }

  const today = new Date().toISOString().slice(0, 10);
  const affectedTokens = new Set<string>();
  const affectedGrantors = new Set<string>();
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    for (const [scheduleId, days] of affected) {
      const history = await getPostgresEventsForSchedule(scheduleId);
      const created = history.find((row) => row.event_type === "schedule_created");
      if (!created) continue;
      if (created.token) affectedTokens.add(created.token);
      if (created.grantor) affectedGrantors.add(created.grantor);

      for (const day of pgEnumerateDays([...days].sort()[0], today)) {
        const claimed = history
          .filter((row) => row.event_type === "claimed" && pgDayFromIso(row.ledger_closed_at) <= day)
          .reduce((sum, row) => sum + BigInt(row.amount ?? "0"), 0n);
        const revoked = history.find((row) => row.event_type === "revoked" && pgDayFromIso(row.ledger_closed_at) <= day);
        const total = BigInt(created.created_amount ?? "0");
        let revokedUnvested = 0n;
        if (revoked) {
          try {
            const decoded = JSON.parse(revoked.raw_value);
            const values = Array.isArray(decoded) ? decoded : Object.values(decoded ?? {});
            revokedUnvested = BigInt(String(values[1] ?? "0"));
          } catch {
            revokedUnvested = BigInt(revoked.amount ?? "0");
          }
        }
        let vested = revoked ? total - revokedUnvested : (pgVestedAt(created, pgEndOfDaySeconds(day)) ?? claimed);
        if (vested < claimed) vested = claimed;
        if (vested > total) vested = total;
        const claimable = vested > claimed ? vested - claimed : 0n;
        const locked = total > vested + revokedUnvested ? total - vested - revokedUnvested : 0n;
        await client.query(
          `INSERT INTO schedule_daily_snapshots
            (schedule_id, day, total_vested_stroops, total_claimed_stroops, claimable_stroops, locked_stroops)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (schedule_id, day) DO UPDATE SET
             total_vested_stroops = EXCLUDED.total_vested_stroops,
             total_claimed_stroops = EXCLUDED.total_claimed_stroops,
             claimable_stroops = EXCLUDED.claimable_stroops,
             locked_stroops = EXCLUDED.locked_stroops`,
          [scheduleId, day, vested.toString(), claimed.toString(), claimable.toString(), locked.toString()]
        );
      }
    }

    for (const token of affectedTokens) {
      await client.query(
        `INSERT INTO token_daily_tvl (token_address, day, total_locked_stroops, active_schedule_count)
         SELECT $1, $2, COALESCE(SUM(locked_stroops), 0), COUNT(*) FILTER (WHERE locked_stroops > 0)
         FROM schedule_daily_snapshots s
         JOIN vesting_schedules v ON v.schedule_id = s.schedule_id
         WHERE v.token = $1 AND s.day = $2
         ON CONFLICT (token_address, day) DO UPDATE SET
           total_locked_stroops = EXCLUDED.total_locked_stroops,
           active_schedule_count = EXCLUDED.active_schedule_count`,
        [token, today]
      );
    }

    for (const grantor of affectedGrantors) {
      await client.query(
        `INSERT INTO grantor_daily_stats (grantor_address, day, active_schedule_count, total_distributed_stroops)
         SELECT $1, $2,
                COUNT(*) FILTER (WHERE s.locked_stroops > 0),
                COALESCE(SUM(s.total_claimed_stroops), 0)
         FROM vesting_schedules v
         LEFT JOIN schedule_daily_snapshots s ON s.schedule_id = v.schedule_id AND s.day = $2
         WHERE v.grantor = $1
         ON CONFLICT (grantor_address, day) DO UPDATE SET
           active_schedule_count = EXCLUDED.active_schedule_count,
           total_distributed_stroops = EXCLUDED.total_distributed_stroops`,
        [grantor, today]
      );
    }

    await client.query(
      `INSERT INTO analytics_watermark (network, last_ledger, last_materialized_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (network) DO UPDATE SET
         last_ledger = EXCLUDED.last_ledger,
         last_materialized_at = EXCLUDED.last_materialized_at`,
      [network, watermark]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    events_processed: pending.length,
    schedules_affected: affected.size,
    tokens_affected: affectedTokens.size,
    grantors_affected: affectedGrantors.size,
    watermark_ledger: watermark,
  };
}
