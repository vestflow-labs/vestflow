/**
 * VestFlow — Server-Sent Events hub
 *
 * Maintains the in-memory `walletAddress → Set<Response>` index of live SSE
 * connections. The poller and query server run as separate processes, so the
 * hub cannot observe an in-process "event indexed" callback; instead a fan-out
 * loop drains the `notifications` table (written by the poller) and streams
 * each new row to every connection registered for its wallet.
 *
 * This is the server-side-filtering fan-out described in the issue: an event
 * is only written to connections that actually belong to the affected wallet,
 * rather than broadcast to all clients and filtered client-side.
 */

import type http from "http";
import {
  getAllNotificationsSince,
  getMaxNotificationId,
  getNotificationsSince,
  type AppNotification,
} from "./app-notifications";

/** SSE frame writer — `id:` carries the global cursor, `data:` the JSON body. */
function writeSseEvent(res: http.ServerResponse, id: number, data: string): void {
  res.write(`id: ${id}\ndata: ${data}\n\n`);
}

const registry = new Map<string, Set<http.ServerResponse>>();
const MAX_BUFFERED_EVENTS = 100;

/** Number of live SSE responses across all wallets. */
export function connectionCount(): number {
  let count = 0;
  for (const set of registry.values()) count += set.size;
  return count;
}

/** Number of wallets with at least one live connection. */
export function registeredWalletCount(): number {
  return registry.size;
}

/**
 * Registers a connection for a wallet, replaying any events missed since
 * `lastEventId` before the live stream takes over. Removes the connection from
 * the registry when the response closes (no leak).
 */
export function registerStream(
  wallet: string,
  res: http.ServerResponse,
  lastEventId: number | null
): void {
  if (lastEventId != null) {
    const missed = getNotificationsSince(wallet, lastEventId);
    for (const notification of missed) {
      writeSseEvent(res, notification.id, JSON.stringify(notification));
    }
  }

  let set = registry.get(wallet);
  if (!set) {
    set = new Set();
    registry.set(wallet, set);
  }
  set.add(res);

  const cleanup = () => {
    set.delete(res);
    if (set.size === 0) {
      registry.delete(wallet);
    }
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
}

/**
 * Writes a notification to every connection registered for its wallet.
 * Returns the number of connections that received the frame.
 */
export function broadcastToWallet(wallet: string, notification: AppNotification): number {
  const set = registry.get(wallet);
  if (!set || set.size === 0) return 0;

  const data = JSON.stringify(notification);
  for (const res of set) {
    try {
      writeSseEvent(res, notification.id, data);
    } catch {
      // The close/error listener will reap the dead connection.
    }
  }
  return set.size;
}

// ── Fan-out loop ──────────────────────────────────────────────────────

let lastSeenId: number | null = null;
let fanoutTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeat = 0;

const FANOUT_INTERVAL_MS = Number(process.env.SSE_FANOUT_INTERVAL_MS ?? "500");
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Drains new notifications for every wallet and heartbeats live connections. */
export function fanoutTick(): void {
  const now = Date.now();

  if (lastSeenId == null) {
    lastSeenId = getMaxNotificationId();
  }

  const batch = getAllNotificationsSince(lastSeenId, MAX_BUFFERED_EVENTS);
  for (const notification of batch) {
    broadcastToWallet(notification.wallet, notification);
    if (notification.id > lastSeenId) lastSeenId = notification.id;
  }

  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    for (const set of registry.values()) {
      for (const res of set) {
        try {
          res.write(": ping\n\n");
        } catch {
          // Ignore — dead connections are reaped by the close listener.
        }
      }
    }
  }
}

/** Starts the periodic fan-out/heartbeat loop (idempotent). */
export function startNotificationFanout(intervalMs = FANOUT_INTERVAL_MS): void {
  if (fanoutTimer) return;
  fanoutTimer = setInterval(fanoutTick, intervalMs);
  if (typeof fanoutTimer.unref === "function") fanoutTimer.unref();
}

/** Stops the fan-out loop and clears the registry (used by tests). */
export function stopNotificationFanout(): void {
  if (fanoutTimer) {
    clearInterval(fanoutTimer);
    fanoutTimer = null;
  }
  lastSeenId = null;
  registry.clear();
}
