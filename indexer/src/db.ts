import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { EventQueryParams, IndexedEvent } from "./types";

const DB_PATH =
  process.env.INDEXER_DB_PATH ??
  path.join(process.cwd(), "vestflow-events.db");

const SCHEMA_PATH = path.join(__dirname, "..", "schema.sql");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    // WAL mode: safe concurrent reads from the query server while the
    // poller writes, without blocking either side.
    _db.pragma("journal_mode = WAL");
    _db.pragma("synchronous = NORMAL");
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    _db.exec(schema);
  }
  return _db;
}

// ── Checkpoint ────────────────────────────────────────────────────────

export function getCheckpoint(): number {
  const row = getDb()
    .prepare("SELECT last_ledger FROM checkpoint WHERE id = 1")
    .get() as { last_ledger: number } | undefined;
  return row?.last_ledger ?? 0;
}

export function setCheckpoint(ledger: number): void {
  getDb()
    .prepare("UPDATE checkpoint SET last_ledger = ? WHERE id = 1")
    .run(ledger);
}

// ── Events ────────────────────────────────────────────────────────────

export interface InsertEventRow {
  id: string;
  event_type: string;
  ledger: number;
  ledger_closed_at: string;
  schedule_id: number | null;
  grantor: string | null;
  beneficiary: string | null;
  amount: string | null;
  raw_topics: string;
  raw_value: string;
}

/**
 * Inserts an event row.
 * Returns true if a new row was written, false if it already existed
 * (idempotent — duplicate Stellar event IDs are silently ignored).
 */
export function insertEvent(row: InsertEventRow): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO schedule_events
        (id, event_type, ledger, ledger_closed_at, schedule_id,
         grantor, beneficiary, amount, raw_topics, raw_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.event_type,
      row.ledger,
      row.ledger_closed_at,
      row.schedule_id,
      row.grantor,
      row.beneficiary,
      row.amount,
      row.raw_topics,
      row.raw_value
    );
  return result.changes > 0;
}

/** Query events with optional filters. Results ordered by ledger DESC. */
export function queryEvents(params: EventQueryParams): IndexedEvent[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.address) {
    conditions.push("(grantor = ? OR beneficiary = ?)");
    values.push(params.address, params.address);
  }
  if (params.grantor) {
    conditions.push("grantor = ?");
    values.push(params.grantor);
  }
  if (params.beneficiary) {
    conditions.push("beneficiary = ?");
    values.push(params.beneficiary);
  }
  if (params.event_type) {
    conditions.push("event_type = ?");
    values.push(params.event_type);
  }
  if (params.schedule_id != null) {
    conditions.push("schedule_id = ?");
    values.push(params.schedule_id);
  }
  if (params.from_ledger != null) {
    conditions.push("ledger >= ?");
    values.push(params.from_ledger);
  }
  if (params.to_ledger != null) {
    conditions.push("ledger <= ?");
    values.push(params.to_ledger);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;

  // Special-case: when requesting created schedules, exclude schedules
  // that have been revoked so paginated results don't contain gaps
  // caused by client-side filtering. Apply the exclusion in SQL so
  // LIMIT/OFFSET operate on the final filtered set.
  if (params.event_type === "schedule_created") {
    const sql = `SELECT * FROM schedule_events ${where}
                 AND schedule_id NOT IN (
                   SELECT schedule_id FROM schedule_events WHERE event_type = 'revoked'
                 )
                 ORDER BY ledger DESC LIMIT ? OFFSET ?`;
    return getDb().prepare(sql).all(...values, limit, offset) as IndexedEvent[];
  }

  return getDb()
    .prepare(
      `SELECT * FROM schedule_events ${where} ORDER BY ledger DESC LIMIT ? OFFSET ?`
    )
    .all(...values, limit, offset) as IndexedEvent[];
}

// ── Analytics ──────────────────────────────────────────────────────────

export interface AnalyticsStats {
  total_value_locked: string;
  total_claimed: string;
  active_schedules: number;
  unique_beneficiaries: number;
  total_schedules_created: number;
  total_revoked: number;
  last_updated: number;
}

export interface DailySnapshot {
  date: string;
  total_value_locked: string;
  total_claimed: string;
  active_schedules: number;
  unique_beneficiaries: number;
  total_schedules_created: number;
  total_revoked: number;
}

/**
 * Get current analytics stats from cache
 */
export function getAnalyticsStats(): AnalyticsStats {
  const row = getDb()
    .prepare("SELECT * FROM analytics_cache WHERE id = 1")
    .get() as AnalyticsStats | undefined;
  
  return row || {
    total_value_locked: "0",
    total_claimed: "0",
    active_schedules: 0,
    unique_beneficiaries: 0,
    total_schedules_created: 0,
    total_revoked: 0,
    last_updated: 0,
  };
}

/**
 * Calculate and cache current analytics stats
 */
export function computeAnalyticsStats(): AnalyticsStats {
  const db = getDb();
  
  // Count unique schedule IDs from created events to get total schedules
  const totalCreated = db
    .prepare("SELECT COUNT(DISTINCT schedule_id) as count FROM schedule_events WHERE event_type = 'schedule_created'")
    .get() as { count: number } | undefined;
  
  // Count revoked schedules
  const totalRevoked = db
    .prepare("SELECT COUNT(DISTINCT schedule_id) as count FROM schedule_events WHERE event_type = 'revoked'")
    .get() as { count: number } | undefined;

  // Total claimed across all events
  const totalClaimed = db
    .prepare("SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) as total FROM schedule_events WHERE event_type = 'claimed'")
    .get() as { total: number } | undefined;

  // Count unique beneficiaries
  const uniqueBeneficiaries = db
    .prepare("SELECT COUNT(DISTINCT beneficiary) as count FROM schedule_events WHERE event_type = 'claimed'")
    .get() as { count: number } | undefined;

  const stats: AnalyticsStats = {
    total_value_locked: "0", // This requires on-chain data, will be computed by frontend
    total_claimed: (totalClaimed?.total || 0).toString(),
    active_schedules: 0, // Requires on-chain state check
    unique_beneficiaries: uniqueBeneficiaries?.count || 0,
    total_schedules_created: totalCreated?.count || 0,
    total_revoked: totalRevoked?.count || 0,
    last_updated: Math.floor(Date.now() / 1000),
  };

  // Update cache
  db.prepare(
    `UPDATE analytics_cache SET 
     total_claimed = ?, 
     unique_beneficiaries = ?,
     total_schedules_created = ?,
     total_revoked = ?,
     last_updated = ?
     WHERE id = 1`
  ).run(
    stats.total_claimed,
    stats.unique_beneficiaries,
    stats.total_schedules_created,
    stats.total_revoked,
    stats.last_updated
  );

  return stats;
}

/**
 * Get daily stats snapshots for trend analysis (last N days)
 */
export function getDailyStats(days: number = 30): DailySnapshot[] {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceDate = since.toISOString().split("T")[0];

  return db
    .prepare(
      `SELECT * FROM daily_stats 
       WHERE date >= ? 
       ORDER BY date ASC`
    )
    .all(sinceDate) as DailySnapshot[];
}

/**
 * Record daily snapshot (call once per day)
 */
export function recordDailySnapshot(stats: AnalyticsStats): void {
  const today = new Date().toISOString().split("T")[0];
  
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO daily_stats 
       (date, total_value_locked, total_claimed, active_schedules, unique_beneficiaries, total_schedules_created, total_revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      today,
      stats.total_value_locked,
      stats.total_claimed,
      stats.active_schedules,
      stats.unique_beneficiaries,
      stats.total_schedules_created,
      stats.total_revoked
    );
}

// ── Notifications ──────────────────────────────────────────────────────────

export interface NotificationSubscription {
  id: number;
  email: string;
  schedule_id: number;
  beneficiary_address: string;
  notification_type: string;
  is_active: number;
  verified: number;
  verification_token?: string;
  created_at: number;
  updated_at: number;
}

/**
 * Create a new notification subscription
 */
export function createNotificationSubscription(
  email: string,
  scheduleId: number,
  beneficiaryAddress: string,
  notificationType: string
): NotificationSubscription {
  const verificationToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  
  const result = getDb()
    .prepare(
      `INSERT INTO notification_subscriptions (email, schedule_id, beneficiary_address, notification_type, verification_token)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, scheduleId, beneficiaryAddress, notificationType, verificationToken);

  return {
    id: result.lastInsertRowid as number,
    email,
    schedule_id: scheduleId,
    beneficiary_address: beneficiaryAddress,
    notification_type: notificationType,
    is_active: 0,
    verified: 0,
    verification_token: verificationToken,
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Get a subscription by ID
 */
export function getNotificationSubscription(id: number): NotificationSubscription | null {
  const row = getDb()
    .prepare("SELECT * FROM notification_subscriptions WHERE id = ?")
    .get(id) as NotificationSubscription | undefined;
  return row || null;
}

/**
 * Get subscriptions by email
 */
export function getSubscriptionsByEmail(email: string): NotificationSubscription[] {
  return getDb()
    .prepare("SELECT * FROM notification_subscriptions WHERE email = ? AND is_active = 1")
    .all(email) as NotificationSubscription[];
}

/**
 * Get subscriptions for a schedule
 */
export function getSubscriptionsBySchedule(scheduleId: number): NotificationSubscription[] {
  return getDb()
    .prepare("SELECT * FROM notification_subscriptions WHERE schedule_id = ? AND is_active = 1 AND verified = 1")
    .all(scheduleId) as NotificationSubscription[];
}

/**
 * Verify an email subscription
 */
export function verifyNotificationSubscription(verificationToken: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE notification_subscriptions 
       SET verified = 1, is_active = 1, updated_at = ? 
       WHERE verification_token = ? AND verified = 0`
    )
    .run(Math.floor(Date.now() / 1000), verificationToken);
  return result.changes > 0;
}

/**
 * Unsubscribe from notifications
 */
export function unsubscribeNotifications(id: number): boolean {
  const result = getDb()
    .prepare("UPDATE notification_subscriptions SET is_active = 0, updated_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), id);
  return result.changes > 0;
}

/**
 * Record a notification event
 */
export function recordNotificationEvent(
  subscriptionId: number,
  eventType: string,
  scheduleId: number,
  status: string = 'sent',
  errorMessage?: string
): void {
  getDb()
    .prepare(
      `INSERT INTO notification_events (subscription_id, event_type, schedule_id, status, error_message)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(subscriptionId, eventType, scheduleId, status, errorMessage || null);
}

/**
 * Check if a milestone has been processed (to avoid duplicates)
 */
export function hasMilestoneBeenProcessed(scheduleId: number, milestoneType: string): boolean {
  const row = getDb()
    .prepare("SELECT id FROM notification_milestones WHERE schedule_id = ? AND milestone_type = ?")
    .get(scheduleId, milestoneType) as { id: number } | undefined;
  return !!row;
}

/**
 * Mark a milestone as processed
 */
export function markMilestoneProcessed(scheduleId: number, milestoneType: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO notification_milestones (schedule_id, milestone_type)
       VALUES (?, ?)`
    )
    .run(scheduleId, milestoneType);
}