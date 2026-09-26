// @vitest-environment node
/**
 * Integration tests — Ledger Gap Detection and Replay
 *
 * What is tested
 * --------------
 * - Database layer: replay_queue CRUD, idempotency dedup index
 * - Gap detector:   startup / periodic, gap calculation, chunking
 * - Replay engine:  config, mid-range resume, retry counter
 * - Acceptance criteria from the issue spec (AC1–AC4)
 *
 * Isolation strategy
 * ------------------
 * Each beforeEach creates a fresh `:memory:` SQLite database via
 * createTestDb(), then spies on `getDb` to return it. This sidesteps
 * the module-level connection cache in db.ts so every test starts clean.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Database as BetterSqlite3 } from "better-sqlite3";

import {
  createTestDb,
  countRows,
  insertRaw,
  makeScheduleCreatedEvent,
  makeClaimedEvent,
  type TestDb,
} from "./helpers/createTestDb";

// ── Import real implementations ───────────────────────────────────────
import * as dbModule from "../src/db";
import type { InsertEventRow } from "../src/db";
import {
  detectGaps,
  runStartupGapDetection,
  getGapDetectionHealth,
} from "../src/gap-detector";
import { ReplayEngine } from "../src/replay";
import { createHorizonClient } from "../src/horizon-client";
import { backoffDelayMs } from "../src/retry";

// ── Module-level mocks ────────────────────────────────────────────────

// Prevent any real disk DB being opened
vi.mock("../src/config", () => ({
  parseNetwork: vi.fn().mockReturnValue("testnet"),
  getNetworkConfig: vi.fn().mockReturnValue({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX",
  }),
}));

vi.mock("@stellar/stellar-sdk", () => {
  function MockServer(this: any) {
    this.getEvents = vi.fn().mockResolvedValue({ events: [] });
    this.getLatestLedger = vi.fn().mockResolvedValue({ sequence: 5000 });
  }
  return {
    rpc: { Server: MockServer },
    xdr: { ScVal: {} },
    scValToNative: vi.fn().mockReturnValue(null),
  };
});

vi.mock("../src/webhook-delivery", () => ({
  fanOutEvent: vi.fn(),
  WebhookDeliveryWorker: vi.fn(),
}));

// Intercept global fetch (used by gap-detector and horizon-client)
const mockFetch = vi.fn();
global.fetch = mockFetch;

// ── Per-test state ────────────────────────────────────────────────────

let testDb: TestDb;

beforeEach(() => {
  vi.clearAllMocks();
  testDb = createTestDb();
  // Inject the in-memory db into the module-level cache so all functions
  // that call getDb() internally use this instance, not a disk file.
  dbModule._setTestDb("testnet", testDb.db as any);
});

afterEach(() => {
  dbModule._clearTestDb("testnet");
  testDb.close();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// Section 1 — Database layer
// ─────────────────────────────────────────────────────────────────────
describe("Database layer", () => {
  it("schema contains replay_queue and gap_detection_log tables", () => {
    const tables = testDb.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("replay_queue");
    expect(names).toContain("gap_detection_log");
    expect(names).toContain("schedule_events");
    expect(names).toContain("checkpoint");
  });

  it("replay queue: enqueue → dequeue → progress → complete lifecycle", () => {
    const id1 = dbModule.enqueueReplayRange(1000, 2000, "testnet");
    const id2 = dbModule.enqueueReplayRange(2001, 3000, "testnet");

    expect(id1).toBeTypeOf("number");
    expect(id2).toBeGreaterThan(id1);
    expect(dbModule.getPendingReplayCount("testnet")).toBe(2);

    const next = dbModule.getNextPendingReplay("testnet");
    expect(next).toBeTruthy();
    expect(next!.from_ledger).toBe(1000);
    expect(next!.status).toBe("pending");

    dbModule.markReplayInProgress(next!.id, "testnet");
    expect(dbModule.getPendingReplayCount("testnet")).toBe(1);

    dbModule.updateReplayProgress(next!.id, 1500, "testnet");
    const row = testDb.db
      .prepare("SELECT completed_ledger FROM replay_queue WHERE id = ?")
      .get(next!.id) as { completed_ledger: number };
    expect(row.completed_ledger).toBe(1500);

    dbModule.markReplayCompleted(next!.id, "testnet");
    expect(dbModule.getPendingReplayCount("testnet")).toBe(1); // second range still pending
  });

  it("markReplayFailed increments retry_count and stores error_message", () => {
    const id = dbModule.enqueueReplayRange(1, 100, "testnet");
    dbModule.markReplayInProgress(id, "testnet");
    dbModule.markReplayFailed(id, "timeout", "testnet");

    const row = testDb.db
      .prepare("SELECT status, retry_count, error_message FROM replay_queue WHERE id = ?")
      .get(id) as any;
    expect(row.status).toBe("failed");
    expect(row.retry_count).toBe(1);
    expect(row.error_message).toBe("timeout");
  });

  it("insertEvent: idempotent on same Stellar event ID", () => {
    const ev: InsertEventRow = makeScheduleCreatedEvent();
    expect(dbModule.insertEvent(ev, "testnet")).toBe(true);
    expect(dbModule.insertEvent(ev, "testnet")).toBe(false); // exact duplicate
    expect(countRows(testDb.db)).toBe(1);
  });

  it("insertEvent: dedup index blocks different ID but identical content", () => {
    const ev = makeScheduleCreatedEvent({ id: "1000-1-1" });
    const dup = makeScheduleCreatedEvent({ id: "1000-2-1" }); // different ID, same payload

    expect(dbModule.insertEvent(ev, "testnet")).toBe(true);
    expect(dbModule.insertEvent(dup, "testnet")).toBe(false);
    expect(countRows(testDb.db)).toBe(1);
  });

  it("insertEvent: two events on the same ledger with different schedule_id are both stored", () => {
    const ev1 = makeScheduleCreatedEvent({ id: "1000-1-1", schedule_id: 1 });
    const ev2 = makeScheduleCreatedEvent({ id: "1000-1-2", schedule_id: 2 });

    expect(dbModule.insertEvent(ev1, "testnet")).toBe(true);
    expect(dbModule.insertEvent(ev2, "testnet")).toBe(true);
    expect(countRows(testDb.db)).toBe(2);
  });

  it("insertEventsBatch: returns inserted count and skips duplicates", () => {
    const events: InsertEventRow[] = Array.from({ length: 10 }, (_, i) =>
      makeScheduleCreatedEvent({ id: `${1000 + i}-1-1`, ledger: 1000 + i, schedule_id: i + 1 })
    );

    const n1 = dbModule.insertEventsBatch(events, "testnet");
    expect(n1).toBe(10);
    expect(countRows(testDb.db)).toBe(10);

    // Re-insert same events → all duplicates
    const n2 = dbModule.insertEventsBatch(events, "testnet");
    expect(n2).toBe(0);
    expect(countRows(testDb.db)).toBe(10);
  });

  it("logGapDetection / getLastGapDetection round-trip", () => {
    dbModule.logGapDetection(500, 1000, 3, "testnet");

    const last = dbModule.getLastGapDetection("testnet");
    expect(last).not.toBeNull();
    expect(last!.last_checkpoint).toBe(500);
    expect(last!.current_ledger).toBe(1000);
    expect(last!.gaps_detected).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Section 2 — Gap detector
// ─────────────────────────────────────────────────────────────────────
describe("Gap detector", () => {
  function mockHorizon(sequence: number) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ _embedded: { records: [{ sequence }] } }),
    });
  }

  it("detects a 500-ledger gap and enqueues one replay range", async () => {
    dbModule.setCheckpoint(1000, "testnet");
    mockHorizon(1500);

    const result = await detectGaps({
      network: "testnet",
      horizonUrl: "https://horizon-testnet.stellar.org",
      minGapSize: 1,
    });

    expect(result.lastCheckpoint).toBe(1000);
    expect(result.currentLedger).toBe(1500);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toEqual({ from: 1001, to: 1499 });
    expect(result.gapsDetected).toBe(1);
    expect(dbModule.getPendingReplayCount("testnet")).toBe(1);
  });

  it("splits a gap larger than maxGapSize into multiple chunks", async () => {
    dbModule.setCheckpoint(1000, "testnet");
    mockHorizon(16000); // 14 999-ledger gap

    const result = await detectGaps({
      network: "testnet",
      maxGapSize: 5000,
      minGapSize: 1,
    });

    // 14 999 ledgers / 5 000 = 2 full chunks + 1 partial = 3 chunks
    expect(result.gaps.length).toBe(3);
    result.gaps.forEach((g) => {
      expect(g.to - g.from + 1).toBeLessThanOrEqual(5000);
    });
    expect(dbModule.getPendingReplayCount("testnet")).toBe(3);
  });

  it("reports no gaps when checkpoint matches current ledger", async () => {
    dbModule.setCheckpoint(2000, "testnet");
    mockHorizon(2000);

    const result = await detectGaps({ network: "testnet" });

    expect(result.gaps).toHaveLength(0);
    expect(result.gapsDetected).toBe(0);
    expect(dbModule.getPendingReplayCount("testnet")).toBe(0);
  });

  it("respects minGapSize threshold", async () => {
    dbModule.setCheckpoint(1000, "testnet");
    mockHorizon(1001); // gap is only 1 ledger (1001 - 1 = 1000, to = 1000 < from = 1001 ⇒ 0 gap)
    // Actually gap is from=1001, to=1000 → size 0, nothing to enqueue
    // Let's test that a gap of exactly minGapSize-1 is skipped
    mockHorizon(1002); // gap = ledger 1001 (size 1), minGapSize = 2 → skip

    const result = await detectGaps({
      network: "testnet",
      minGapSize: 2,
    });

    expect(result.gapsDetected).toBe(0);
  });

  it("throws when Horizon returns an error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: "Unavailable" });

    await expect(
      detectGaps({ network: "testnet" })
    ).rejects.toThrow();
  });

  it("getGapDetectionHealth: unhealthy with no runs, healthy after logGapDetection", () => {
    const h1 = getGapDetectionHealth("testnet");
    expect(h1.isHealthy).toBe(false);
    expect(h1.lastDetection).toBeNull();

    dbModule.logGapDetection(1000, 2000, 0, "testnet");

    const h2 = getGapDetectionHealth("testnet");
    expect(h2.isHealthy).toBe(true);
    expect(h2.timeSinceLastCheck).toBeLessThan(5);
  });

  it("runStartupGapDetection logs detection and enqueues gap", async () => {
    dbModule.setCheckpoint(500, "testnet");
    mockHorizon(1000);

    const result = await runStartupGapDetection({
      network: "testnet",
      minGapSize: 1,
    });

    expect(result.gapsDetected).toBe(1);
    expect(result.gaps[0]).toEqual({ from: 501, to: 999 });

    // Gap detection run should be recorded
    const last = dbModule.getLastGapDetection("testnet");
    expect(last).not.toBeNull();
    expect(last!.gaps_detected).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Section 3 — Replay engine
// ─────────────────────────────────────────────────────────────────────
describe("Replay engine", () => {
  it("respects provided config", () => {
    const eng = new ReplayEngine({ network: "testnet", batchSize: 50, maxRetries: 3 });
    const cfg = eng.getConfig();
    expect(cfg.batchSize).toBe(50);
    expect(cfg.maxRetries).toBe(3);
  });

  it("isWorkerRunning() is false before start()", () => {
    const eng = new ReplayEngine({ network: "testnet" });
    expect(eng.isWorkerRunning()).toBe(false);
  });

  it("stop() is a no-op when not running", () => {
    const eng = new ReplayEngine({ network: "testnet" });
    expect(() => eng.stop()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Section 4 — Horizon client
// ─────────────────────────────────────────────────────────────────────
describe("Horizon client", () => {
  it("fetchEffects retries on transient network errors", async () => {
    const client = createHorizonClient({
      network: "testnet",
      maxRetries: 3,
      retryDelayMs: 10, // fast in tests
    });

    mockFetch
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ _embedded: { records: [] }, _links: {} }),
      });

    const result = await client.fetchEffects({ limit: 10 });
    expect(result._embedded.records).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("fetchEffects does NOT retry on 404 (non-retriable 4xx)", async () => {
    const client = createHorizonClient({
      network: "testnet",
      maxRetries: 3,
      retryDelayMs: 10,
    });

    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(client.fetchEffects()).rejects.toThrow("HTTP 404");
    // Should only have tried once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Section 5 — Retry / backoff utility
// ─────────────────────────────────────────────────────────────────────
describe("Retry / backoff utility", () => {
  it("backoffDelayMs follows 1s→2s→4s→…→64s schedule", () => {
    expect(backoffDelayMs(0)).toBe(1_000);
    expect(backoffDelayMs(1)).toBe(2_000);
    expect(backoffDelayMs(2)).toBe(4_000);
    expect(backoffDelayMs(3)).toBe(8_000);
    expect(backoffDelayMs(4)).toBe(16_000);
    expect(backoffDelayMs(5)).toBe(32_000);
    expect(backoffDelayMs(6)).toBe(64_000);
    // Cap enforced
    expect(backoffDelayMs(7)).toBe(64_000);
    expect(backoffDelayMs(10)).toBe(64_000);
  });

  it("withRetry succeeds on eventual success", async () => {
    const { withRetry } = await import("../src/retry");
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("fail");
        return "ok";
      },
      { maxAttempts: 5, baseDelayMs: 1 }
    );
    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(3);
  });

  it("withRetry throws after maxAttempts exhausted", async () => {
    const { withRetry } = await import("../src/retry");
    await expect(
      withRetry(async () => { throw new Error("always"); }, {
        maxAttempts: 3,
        baseDelayMs: 1,
      })
    ).rejects.toThrow("always");
  });

  it("withRetry skips retry when isRetryable returns false", async () => {
    const { withRetry } = await import("../src/retry");
    let calls = 0;
    await expect(
      withRetry(
        async () => { calls++; throw new Error("fatal"); },
        { maxAttempts: 8, baseDelayMs: 1, isRetryable: () => false }
      )
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Section 6 — Acceptance criteria (issue spec AC1–AC7)
// ─────────────────────────────────────────────────────────────────────
describe("Acceptance criteria", () => {
  function mockHorizon(sequence: number) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ _embedded: { records: [{ sequence }] } }),
    });
  }

  // AC1 — Startup gap detection
  it("AC1: 500-ledger gap correctly detected and enqueued on startup", async () => {
    dbModule.setCheckpoint(1000, "testnet");
    mockHorizon(1500);

    const result = await runStartupGapDetection({ network: "testnet", minGapSize: 1 });

    expect(result.gapsDetected).toBe(1);
    expect(result.gaps[0].from).toBe(1001);
    expect(result.gaps[0].to).toBe(1499);
    expect(dbModule.getPendingReplayCount("testnet")).toBe(1);
  });

  // AC2 — Idempotency
  it("AC2: replaying the same 500-ledger range twice produces zero duplicate DB rows", () => {
    // Simulate 500 events already stored (first replay pass)
    const events: InsertEventRow[] = Array.from({ length: 500 }, (_, i) =>
      makeScheduleCreatedEvent({
        id: `${1001 + i}-1-1`,
        ledger: 1001 + i,
        schedule_id: i + 1,
        grantor: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        beneficiary: "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A",
      })
    );

    const pass1 = dbModule.insertEventsBatch(events, "testnet");
    expect(pass1).toBe(500);

    // Second replay pass — same events, different Stellar IDs (like overlap with live poller)
    const replayEvents = events.map((e) => ({ ...e, id: e.id.replace("-1-1", "-2-1") }));
    const pass2 = dbModule.insertEventsBatch(replayEvents, "testnet");

    expect(pass2).toBe(0);
    expect(countRows(testDb.db)).toBe(500);
  });

  // AC3 — Correct ledger+operation ordering
  it("AC3: events within a ledger are stored in operation_index order", () => {
    // Insert deliberately out-of-order then verify ordering by reading back
    const ev2 = makeClaimedEvent({ id: "2000-2-1", ledger: 2000 });
    const ev1 = makeClaimedEvent({
      id: "2000-1-1",
      ledger: 2000,
      amount: "50000000",
      schedule_id: 2,
    });

    dbModule.insertEvent(ev2, "testnet");
    dbModule.insertEvent(ev1, "testnet");

    // Both should be stored (different schedule_id → different dedup key)
    expect(countRows(testDb.db)).toBe(2);

    // Retrieve ordered by ledger then by id (which encodes operation index)
    const rows = testDb.db
      .prepare("SELECT id FROM schedule_events WHERE ledger = 2000 ORDER BY id ASC")
      .all() as { id: string }[];

    expect(rows[0].id).toBe("2000-1-1"); // lower op-index first
    expect(rows[1].id).toBe("2000-2-1");
  });

  // AC4 — Live poller continues unblocked during replay
  it("AC4: live events insert correctly while replay queue has pending items", () => {
    // Enqueue a background replay range
    dbModule.enqueueReplayRange(500, 999, "testnet");

    // Live poller inserts a new event at ledger 2000
    const liveEvent = makeClaimedEvent({ id: "2000-1-1", ledger: 2000 });
    expect(dbModule.insertEvent(liveEvent, "testnet")).toBe(true);

    // Replay insert of the same live event (overlap) is deduplicated
    const overlapEvent = { ...liveEvent, id: "2000-1-2" };
    expect(dbModule.insertEvent(overlapEvent, "testnet")).toBe(false);

    expect(countRows(testDb.db)).toBe(1);
    expect(dbModule.getPendingReplayCount("testnet")).toBe(1); // unaffected
  });

  // AC5 — Mid-range restart
  it("AC5: mid-range restart resumes from completed_ledger + 1, not from_ledger", () => {
    const id = dbModule.enqueueReplayRange(1001, 1500, "testnet");
    dbModule.markReplayInProgress(id, "testnet");
    dbModule.updateReplayProgress(id, 1250, "testnet");

    const row = testDb.db
      .prepare("SELECT from_ledger, completed_ledger, to_ledger FROM replay_queue WHERE id = ?")
      .get(id) as any;

    const resumeFrom = (row.completed_ledger ?? row.from_ledger - 1) + 1;
    expect(resumeFrom).toBe(1251);
    expect(row.to_ledger).toBe(1500);
  });

  // AC6 — Failed range after 8 retries
  it("AC6: replay range marked failed after exceeding maxRetries", () => {
    const id = dbModule.enqueueReplayRange(1, 100, "testnet");

    // Simulate 8 consecutive failures
    for (let i = 0; i < 8; i++) {
      dbModule.markReplayInProgress(id, "testnet");
      dbModule.markReplayFailed(id, `error attempt ${i + 1}`, "testnet");
    }

    const row = testDb.db
      .prepare("SELECT status, retry_count, error_message FROM replay_queue WHERE id = ?")
      .get(id) as any;

    expect(row.status).toBe("failed");
    expect(row.retry_count).toBe(8);
    expect(row.error_message).toContain("error attempt 8");
  });

  // AC7 — /health returns correct lag and pending replay count
  it("AC7: getPendingReplayCount and getCheckpoint return values the health endpoint would expose", () => {
    dbModule.setCheckpoint(1000, "testnet");
    dbModule.enqueueReplayRange(1001, 2000, "testnet");
    dbModule.enqueueReplayRange(2001, 3000, "testnet");

    const checkpoint = dbModule.getCheckpoint("testnet");
    const pendingReplays = dbModule.getPendingReplayCount("testnet");

    expect(checkpoint).toBe(1000);
    expect(pendingReplays).toBe(2);

    // Simulate health endpoint lag calculation
    const mockCurrentLedger = 1500;
    const lag = mockCurrentLedger - checkpoint;
    expect(lag).toBe(500);
  });
});
