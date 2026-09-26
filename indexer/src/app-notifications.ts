/**
 * VestFlow — in-app notifications
 *
 * A `notifications` row is written by the poller for every indexed contract
 * event that affects a wallet, keyed by the wallet address. Its `id` column is
 * the global, monotonically increasing cursor used by the SSE stream (see
 * sse.ts) for Last-Event-ID replay — the ids are globally ordered rather than
 * per-connection UUIDs.
 *
 * Read state lives in `notification_reads`, keyed by (wallet, notification_id),
 * so it survives browser refreshes and is tied to the wallet address.
 */

import { getDb } from "./db";
import type { NetworkName } from "./config";

export type AppNotificationEventType =
  | "VestingStarted"
  | "CliffReached"
  | "FullyVested"
  | "Claimed"
  | "Revoked"
  | "PausedSchedule"
  | "ResumedSchedule";

/** A single in-app notification as served to the client. */
export interface AppNotification {
  id: number;
  wallet: string;
  event_type: string;
  schedule_id: number | null;
  event_id: string;
  ledger: number;
  payload: string;
  created_at: number;
  /** 1 when the wallet has marked this notification read. */
  read: number;
}

export interface InsertAppNotification {
  wallet: string;
  event_type: string;
  schedule_id: number | null;
  event_id: string;
  ledger: number;
  payload: string;
}

export interface QueryNotificationsParams {
  wallet: string;
  page?: number;
  limit?: number;
  /** Optional list of event types to match (multi-select filter). */
  types?: string[];
  /** Optional read filter: 1 = read only, 0 = unread only. */
  read?: number;
  network?: NetworkName;
}

export interface NotificationsPage {
  notifications: AppNotification[];
  page: number;
  limit: number;
  total: number;
  unread: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Writes one notification row. Idempotent per (wallet, event_id): re-indexing
 * the same Stellar event never produces a duplicate notification.
 * Returns the notification id when a new row was written, otherwise null.
 */
export function recordAppNotification(
  row: InsertAppNotification,
  network?: NetworkName
): number | null {
  const result = getDb(network)
    .prepare(
      `INSERT OR IGNORE INTO notifications
        (wallet, event_type, schedule_id, event_id, ledger, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.wallet,
      row.event_type,
      row.schedule_id,
      row.event_id,
      row.ledger,
      row.payload
    );
  if (result.changes === 0) return null;

  const id = getDb(network)
    .prepare("SELECT last_insert_rowid() AS id")
    .get() as { id: number };
  return id.id;
}

/** Highest notification id currently persisted (fan-out start cursor). */
export function getMaxNotificationId(network?: NetworkName): number {
  const row = getDb(network)
    .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM notifications")
    .get() as { id: number } | undefined;
  return row?.id ?? 0;
}

/** All notifications for any wallet with id greater than `sinceId`. */
export function getAllNotificationsSince(
  sinceId: number,
  limit = 500,
  network?: NetworkName
): AppNotification[] {
  return getDb(network)
    .prepare(
      `SELECT * FROM notifications WHERE id > ? ORDER BY id ASC LIMIT ?`
    )
    .all(sinceId, limit) as AppNotification[];
}

/**
 * Replays the missed notifications for a wallet with id greater than
 * `sinceId` (the SSE Last-Event-ID cursor), ordered ascending.
 */
export function getNotificationsSince(
  wallet: string,
  sinceId: number,
  network?: NetworkName
): AppNotification[] {
  return getDb(network)
    .prepare(
      `SELECT n.*, CASE WHEN r.notification_id IS NULL THEN 0 ELSE 1 END AS read
       FROM notifications n
       LEFT JOIN notification_reads r
         ON r.wallet = n.wallet AND r.notification_id = n.id
       WHERE n.wallet = ? AND n.id > ?
       ORDER BY n.id ASC`
    )
    .all(wallet, sinceId) as AppNotification[];
}

/**
 * Paginated notification history for a wallet, with read state joined in.
 * Supports multi-select event-type filtering and a read/unread filter.
 */
export function queryNotifications(
  params: QueryNotificationsParams
): NotificationsPage {
  const db = getDb(params.network);
  const page = Math.max(params.page ?? 1, 1);
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = (page - 1) * limit;

  const conditions = ["n.wallet = ?"];
  const values: unknown[] = [params.wallet];

  if (params.types && params.types.length > 0) {
    conditions.push(`n.event_type IN (${params.types.map(() => "?").join(", ")})`);
    values.push(...params.types);
  }

  if (params.read === 0) {
    conditions.push("r.notification_id IS NULL");
  } else if (params.read === 1) {
    conditions.push("r.notification_id IS NOT NULL");
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const total = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM notifications n
       LEFT JOIN notification_reads r
         ON r.wallet = n.wallet AND r.notification_id = n.id
       ${where}`
    )
    .get(...values) as { count: number };

  const notifications = db
    .prepare(
      `SELECT n.*, CASE WHEN r.notification_id IS NULL THEN 0 ELSE 1 END AS read
       FROM notifications n
       LEFT JOIN notification_reads r
         ON r.wallet = n.wallet AND r.notification_id = n.id
       ${where}
       ORDER BY n.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...values, limit, offset) as AppNotification[];

  const unread = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM notifications n
       LEFT JOIN notification_reads r
         ON r.wallet = n.wallet AND r.notification_id = n.id
       WHERE n.wallet = ? AND r.notification_id IS NULL`
    )
    .get(params.wallet) as { count: number };

  return {
    notifications,
    page,
    limit,
    total: total.count,
    unread: unread.count,
  };
}

/** Marks the given notification ids read for a wallet (idempotent upsert). */
export function markNotificationsRead(
  wallet: string,
  ids: number[],
  network?: NetworkName
): number {
  const db = getDb(network);
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO notification_reads (wallet, notification_id, read_at)
     VALUES (?, ?, ?)`
  );
  const run = db.transaction((rows: number[]) => {
    let changed = 0;
    for (const id of rows) {
      changed += stmt.run(wallet, id, now).changes;
    }
    return changed;
  });
  return run(ids);
}

/** Marks every notification for a wallet read. Returns the number changed. */
export function markAllNotificationsRead(
  wallet: string,
  network?: NetworkName
): number {
  const db = getDb(network);
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO notification_reads (wallet, notification_id, read_at)
       SELECT ?, id, ? FROM notifications WHERE wallet = ?`
    )
    .run(wallet, now, wallet);
  return result.changes;
}

/** Number of unread notifications for a wallet. */
export function getUnreadCount(
  wallet: string,
  network?: NetworkName
): number {
  const row = getDb(network)
    .prepare(
      `SELECT COUNT(*) AS count
       FROM notifications n
       LEFT JOIN notification_reads r
         ON r.wallet = n.wallet AND r.notification_id = n.id
       WHERE n.wallet = ? AND r.notification_id IS NULL`
    )
    .get(wallet) as { count: number } | undefined;
  return row?.count ?? 0;
}
