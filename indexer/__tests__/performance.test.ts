// @vitest-environment node
/**
 * Performance tests — batch insert, duplicate detection, and concurrent safety.
 *
 * Uses _setTestDb / _clearTestDb to inject an in-memory SQLite instance into
 * the module-level cache so every internal getDb() call in db.ts uses it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createTestDb,
  makeScheduleCreatedEvent,
  makeClaimedEvent,
  countRows,
  type TestDb,
} from "./helpers/createTestDb";
import * as dbModule from "../src/db";
import type { InsertEventRow } from "../src/db";

vi.mock("../src/config", () => ({
  parseNetwork: vi.fn().mockReturnValue("testnet"),
  getNetworkConfig: vi.fn().mockReturnValue({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX",
  }),
}));

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
  dbModule._setTestDb("testnet", testDb.db as any);
});

afterEach(() => {
  dbModule._clearTestDb("testnet");
  testDb.close();
});

// ── Event fixture helper ───────────────────────────────────────────────────
//
// Alternates schedule_created (even i) and claimed (odd i).
// Every event gets a unique ledger and schedule_id so none collide on the
// dedup index, and a unique id so none collide on the primary key.

function makeEvents(count: number, startLedger = 1000): InsertEventRow[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? makeScheduleCreatedEvent({
          id: `${startLedger + i}-1-1`,
          ledger: startLedger + i,
          schedule_id: startLedger + i,           // globally unique schedule_id
          grantor: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          beneficiary: "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A",
        })
      : makeClaimedEvent({
          id: `${startLedger + i}-1-1`,
          ledger: startLedger + i,
          schedule_id: startLedger + i,           // globally unique schedule_id
        })
  );
}

// ─────────────────────────────────────────────────────────────────────
describe("Batch insert performance", () => {
  it("inserts 1 000 events in < 5 s", () => {
    const events = makeEvents(1000);
    const t0 = Date.now();
    const n = dbModule.insertEventsBatch(events, "testnet");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(n).toBe(1000);
    expect(countRows(testDb.db)).toBe(1000);
  });

  it("inserts 10 000 events in batches of 1 000 in < 20 s", () => {
    const allEvents = makeEvents(10_000);
    const t0 = Date.now();
    let total = 0;
    for (let i = 0; i < allEvents.length; i += 1000) {
      total += dbModule.insertEventsBatch(allEvents.slice(i, i + 1000), "testnet");
    }
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(total).toBe(10_000);
    expect(countRows(testDb.db)).toBe(10_000);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("Duplicate detection at scale", () => {
  it("re-inserting 500 events with different IDs produces zero new rows", () => {
    const events = makeEvents(500);
    expect(dbModule.insertEventsBatch(events, "testnet")).toBe(500);

    // Replay: same logical content, only the Stellar event ID differs
    const replay = events.map((e) => ({ ...e, id: e.id.replace("-1-1", "-R-1") }));
    expect(dbModule.insertEventsBatch(replay, "testnet")).toBe(0);
    expect(countRows(testDb.db)).toBe(500);
  });

  it("dedup index lookup is fast on a large table (< 100 ms per check)", () => {
    // Pre-fill 10k rows
    const seed = makeEvents(10_000);
    dbModule.insertEventsBatch(seed, "testnet");

    // A replay of one existing event with a different ID
    const dup = { ...seed[4999], id: "dup-check-1" };
    const t0 = Date.now();
    const result = dbModule.insertEvent(dup, "testnet");
    const elapsed = Date.now() - t0;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("Replay queue throughput", () => {
  it("enqueues 1 000 ranges in < 2 s", () => {
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      dbModule.enqueueReplayRange(i * 1000 + 1, (i + 1) * 1000, "testnet");
    }
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(dbModule.getPendingReplayCount("testnet")).toBe(1000);
  });

  it("bulk status update on 1 000 rows is < 500 ms", () => {
    for (let i = 0; i < 1000; i++) {
      dbModule.enqueueReplayRange(i * 1000 + 1, (i + 1) * 1000, "testnet");
    }

    const t0 = Date.now();
    testDb.db
      .prepare("UPDATE replay_queue SET status = 'completed' WHERE id <= 500")
      .run();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(dbModule.getPendingReplayCount("testnet")).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("Indexed query performance", () => {
  beforeEach(() => {
    dbModule.insertEventsBatch(makeEvents(10_000), "testnet");
  });

  it("ledger-range query returns results in < 100 ms", () => {
    const t0 = Date.now();
    const rows = testDb.db
      .prepare("SELECT * FROM schedule_events WHERE ledger BETWEEN ? AND ?")
      .all(1000, 1100) as any[];
    expect(Date.now() - t0).toBeLessThan(100);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("COUNT by event_type returns in < 100 ms", () => {
    const t0 = Date.now();
    const row = testDb.db
      .prepare("SELECT COUNT(*) AS n FROM schedule_events WHERE event_type = ?")
      .get("claimed") as { n: number };
    expect(Date.now() - t0).toBeLessThan(100);
    expect(row.n).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("Concurrent safety (simulated)", () => {
  it("10 concurrent insertEventsBatch calls totalling 1 000 rows all land correctly", async () => {
    // Each batch gets its own ledger range so there are no duplicates
    const batches: InsertEventRow[][] = Array.from({ length: 10 }, (_, b) =>
      makeEvents(100, b * 1000 + 1)       // batch b: ledgers b*1000+1 .. b*1000+100
    );

    const results = await Promise.all(
      batches.map(
        (batch) =>
          new Promise<number>((resolve) =>
            setTimeout(
              () => resolve(dbModule.insertEventsBatch(batch, "testnet")),
              Math.random() * 50
            )
          )
      )
    );

    const total = results.reduce((s, n) => s + n, 0);
    expect(total).toBe(1000);
    expect(countRows(testDb.db)).toBe(1000);
  });
});
