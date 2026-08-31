/**
 * Shared notification types and presentation constants.
 *
 * These mirror the indexer's `notifications` table and the payload JSON the
 * poller writes for each indexed event. The `event_type` values are the
 * user-facing names used throughout the toast queue and notification center.
 */

export type NotificationEventType =
  | "VestingStarted"
  | "CliffReached"
  | "FullyVested"
  | "Claimed"
  | "Revoked"
  | "PausedSchedule"
  | "ResumedSchedule";

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * Exponential SSE reconnect delay: 1s, 2s, 4s, 8s, … capped at 30s.
 * `attempt` is the number of consecutive failed reconnects.
 */
export function backoffDelayMs(
  attempt: number,
  base = BACKOFF_BASE_MS,
  max = BACKOFF_MAX_MS,
): number {
  const exp = Math.max(attempt, 0);
  return Math.min(base * 2 ** exp, max);
}

export const NOTIFICATION_EVENT_TYPES: NotificationEventType[] = [
  "VestingStarted",
  "CliffReached",
  "FullyVested",
  "Claimed",
  "Revoked",
  "PausedSchedule",
  "ResumedSchedule",
];

/** A single in-app notification as served by the indexer API / SSE stream. */
export interface AppNotification {
  id: number;
  wallet: string;
  event_type: string;
  schedule_id: number | null;
  event_id: string;
  ledger: number;
  payload: string;
  created_at: number;
  read: number;
}

/** Decoded `payload` JSON written by the poller. */
export interface NotificationPayload {
  event_id: string;
  event_type: string;
  schedule_id: number | null;
  ledger: number;
  ledger_closed_at: string;
  grantor: string | null;
  beneficiary: string | null;
  token: string | null;
  amount: string | null;
}

export function parseNotificationPayload(notification: AppNotification): NotificationPayload | null {
  try {
    return JSON.parse(notification.payload) as NotificationPayload;
  } catch {
    return null;
  }
}

interface EventVisual {
  label: string;
  /** Tailwind text/border/background accent classes. */
  color: string;
  icon: string;
}

export const EVENT_VISUALS: Record<string, EventVisual> = {
  VestingStarted: { label: "Vesting started", color: "teal", icon: "🎉" },
  CliffReached: { label: "Cliff reached", color: "blue", icon: "⛰️" },
  FullyVested: { label: "Fully vested", color: "green", icon: "✅" },
  Claimed: { label: "Claimed", color: "green", icon: "💰" },
  Revoked: { label: "Revoked", color: "red", icon: "🚫" },
  PausedSchedule: { label: "Schedule paused", color: "amber", icon: "⏸️" },
  ResumedSchedule: { label: "Schedule resumed", color: "teal", icon: "▶️" },
};

export function visualFor(type: string): EventVisual {
  return EVENT_VISUALS[type] ?? { label: type, color: "zinc", icon: "🔔" };
}

/** Human-readable summary for a notification, used by toasts and the list. */
export function notificationTitle(notification: AppNotification): string {
  const payload = parseNotificationPayload(notification);
  const scheduleId = payload?.schedule_id ?? notification.schedule_id;
  const suffix = scheduleId != null ? ` (schedule ${scheduleId})` : "";
  return `${visualFor(notification.event_type).label}${suffix}`;
}

/** Messages sent from the main thread into the SharedWorker. */
export type WorkerRequest =
  | { type: "CONNECT"; wallet: string; token: string; url: string; lastEventId: number | null; unread: number }
  | { type: "MARK_READ"; ids: number[] }
  | { type: "MARK_ALL_READ" }
  | { type: "SET_UNREAD"; count: number }
  | { type: "DISCONNECT" };

/** Messages broadcast from the SharedWorker to every connected port. */
export type WorkerMessage =
  | { type: "BACKFILL"; notifications: AppNotification[] }
  | { type: "NOTIFICATION"; notification: AppNotification }
  | { type: "UNREAD"; count: number }
  | { type: "CONNECTED" }
  | { type: "ERROR"; message: string };
