/**
 * In-app notification persistence + read state, exercised against the SQLite
 * DB the indexer uses (temp file). Covers the acceptance criteria for read
 * state (survives across reads), Last-Event-ID replay cursors, and filtering.
 */

import os from "os";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";

const DB_PATH = path.join(
  os.tmpdir(),
  `vestflow-notifications-${process.pid}-${Date.now()}.db`
);
process.env.INDEXER_DB_PATH_TESTNET = DB_PATH;

const {
  getAllNotificationsSince,
  getMaxNotificationId,
  getNotificationsSince,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationsRead,
  queryNotifications,
  recordAppNotification,
} = await import("../src/app-notifications");

const WALLET = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const OTHER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function insert(
  wallet: string,
  eventType: string,
  n: number,
): number | null {
  return recordAppNotification({
    wallet,
    event_type: eventType,
    schedule_id: n,
    event_id: `evt-${wallet.slice(0, 8)}-${n}`,
    ledger: n,
    payload: JSON.stringify({ event_id: `evt-${n}`, event_type: eventType, schedule_id: n }),
  });
}

beforeAll(() => {
  // Seed: 30 Claimed + 20 Revoked for WALLET, 5 Claimed for OTHER.
  for (let i = 1; i <= 30; i++) insert(WALLET, "Claimed", i);
  for (let i = 31; i <= 50; i++) insert(WALLET, "Revoked", i);
  for (let i = 1; i <= 5; i++) insert(OTHER, "Claimed", i);
});

describe("recordAppNotification", () => {
  it("is idempotent per (wallet, event_id)", () => {
    // Re-inserting an already-seeded (wallet, event_id) is a no-op.
    expect(insert(WALLET, "Claimed", 1)).toBeNull();
    expect(insert(WALLET, "Revoked", 31)).toBeNull();
    expect(insert(OTHER, "Claimed", 1)).toBeNull();
  });
});

describe("queryNotifications", () => {
  it("paginates 50 per page with correct totals", () => {
    const page1 = queryNotifications({ wallet: WALLET, page: 1, limit: 50 });
    expect(page1.notifications).toHaveLength(50);
    expect(page1.total).toBe(50);
    expect(page1.unread).toBe(50);
  });

  it("filters by event type (type=Revoked)", () => {
    const revoked = queryNotifications({ wallet: WALLET, types: ["Revoked"], limit: 100 });
    expect(revoked.total).toBe(20);
    expect(revoked.notifications.every((n) => n.event_type === "Revoked")).toBe(true);
  });

  it("supports multi-select type filtering", () => {
    const both = queryNotifications({
      wallet: WALLET,
      types: ["Claimed", "Revoked"],
      limit: 200,
    });
    expect(both.total).toBe(50);
  });

  it("does not leak notifications across wallets", () => {
    const other = queryNotifications({ wallet: OTHER, limit: 200 });
    expect(other.total).toBe(5);
    expect(other.notifications.every((n) => n.wallet === OTHER)).toBe(true);
  });
});

describe("read state", () => {
  it("marks ids read and reflects in unread count + read filter", () => {
    const before = queryNotifications({ wallet: WALLET, limit: 200 });
    const ids = before.notifications.slice(0, 10).map((n) => n.id);
    const changed = markNotificationsRead(WALLET, ids);
    expect(changed).toBe(10);

    expect(getUnreadCount(WALLET)).toBe(40);

    const read = queryNotifications({ wallet: WALLET, read: 1, limit: 200 });
    expect(read.total).toBe(10);

    const unread = queryNotifications({ wallet: WALLET, read: 0, limit: 200 });
    expect(unread.total).toBe(40);
  });

  it("mark-all-read zeroes the unread count", () => {
    const changed = markAllNotificationsRead(WALLET);
    expect(changed).toBe(40);
    expect(getUnreadCount(WALLET)).toBe(0);
  });

  it("mark-read is idempotent", () => {
    const page = queryNotifications({ wallet: WALLET, limit: 1 });
    const id = page.notifications[0].id;
    expect(markNotificationsRead(WALLET, [id])).toBe(0);
  });
});

describe("replay cursors", () => {
  it("getNotificationsSince replays only events after the cursor", () => {
    const page = queryNotifications({ wallet: WALLET, limit: 200 });
    // Notifications are ordered DESC, so ids are descending in the page.
    const ids = page.notifications.map((n) => n.id).sort((a, b) => a - b);
    const cursor = ids[20]; // skip the first 20 (ascending)

    const missed = getNotificationsSince(WALLET, cursor);
    expect(missed).toHaveLength(ids.length - 21);
    expect(missed.every((n) => n.id > cursor)).toBe(true);
  });

  it("getAllNotificationsSince returns globally-ordered rows", () => {
    const since = getMaxNotificationId() - 10;
    const rows = getAllNotificationsSince(since, 100);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].id).toBeGreaterThan(rows[i - 1].id);
    }
  });
});
