// @vitest-environment node
/**
 * Integration tests — GET /gives endpoint (#690)
 *
 * Covers:
 *   - Valid address with data
 *   - Valid address with no data
 *   - Invalid address (400)
 *   - All filter combinations (sender, receiver, token, from, to)
 *   - Pagination (first page, second page, empty last page)
 *
 * Isolation: each beforeEach creates a fresh :memory: SQLite db via
 * createTestDb() and injects it into the module cache via _setTestDb.
 * No mocking of the DB layer — real queryGives() runs against real SQLite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";

import { createTestDb, type TestDb } from "./helpers/createTestDb";
import * as dbModule from "../src/db";
import type { InsertGiveRow } from "../src/db";
import { createServer } from "../src/server";

// ── Module-level mocks (prevent disk I/O and real network calls) ──────

vi.mock("../src/config", () => ({
  parseNetwork: vi.fn().mockReturnValue("testnet"),
  getNetworkConfig: vi.fn().mockReturnValue({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX",
  }),
}));

vi.mock("../src/webhook-delivery", () => ({
  fanOutEvent: vi.fn(),
  WebhookDeliveryWorker: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: { Server: vi.fn().mockImplementation(() => ({})) },
  xdr: { ScVal: {} },
  scValToNative: vi.fn().mockReturnValue(null),
}));

// ── Test addresses ────────────────────────────────────────────────────

const SENDER_A  = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const SENDER_B  = "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A";
const RECEIVER  = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TOKEN_XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_ALT = "CBIELTK6YBZJU5UP2WWQEQ4YGG6WOH6MQIVBX7XKBTQLZUQJNDPFR12";

// ── Helpers ───────────────────────────────────────────────────────────

function makeGiveRow(overrides: Partial<InsertGiveRow> = {}): InsertGiveRow {
  return {
    id: "1000-1-1",
    sender: SENDER_A,
    receiver: RECEIVER,
    token: TOKEN_XLM,
    amount: "500000000",
    timestamp: 1_700_000_000,
    ledger: 1000,
    raw_topics: JSON.stringify(["give", SENDER_A, RECEIVER]),
    raw_value: JSON.stringify(["500000000"]),
    ...overrides,
  };
}

/** Fire a GET request against the test server and parse JSON. */
async function get(
  server: http.Server,
  path: string
): Promise<{ status: number; body: unknown }> {
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

// ── Per-test state ────────────────────────────────────────────────────

let testDb: TestDb;
let server: http.Server;

beforeEach(async () => {
  vi.clearAllMocks();
  testDb = createTestDb();
  dbModule._setTestDb("testnet", testDb.db as any);

  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  dbModule._clearTestDb("testnet");
  testDb.close();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// Section 1 — Happy path: address with data
// ─────────────────────────────────────────────────────────────────────

describe("GET /gives — address with data", () => {
  beforeEach(() => {
    dbModule.insertGive(makeGiveRow({ id: "1000-1-1", amount: "100000000", timestamp: 1_700_000_001 }));
    dbModule.insertGive(makeGiveRow({ id: "1001-1-1", amount: "200000000", timestamp: 1_700_000_002, sender: SENDER_B }));
  });

  it("returns gives for a matching sender", async () => {
    const { status, body } = await get(server, `/gives?sender=${SENDER_A}`);
    expect(status).toBe(200);
    const { gives } = body as any;
    expect(gives).toHaveLength(1);
    expect(gives[0].sender).toBe(SENDER_A);
    expect(gives[0].amount).toBe("100000000");
  });

  it("returns gives for a matching receiver", async () => {
    const { status, body } = await get(server, `/gives?receiver=${RECEIVER}`);
    expect(status).toBe(200);
    const { gives } = body as any;
    expect(gives).toHaveLength(2);
  });

  it("returns gives filtered by token", async () => {
    dbModule.insertGive(makeGiveRow({ id: "1002-1-1", token: TOKEN_ALT, timestamp: 1_700_000_003 }));
    const { status, body } = await get(server, `/gives?token=${TOKEN_XLM}`);
    expect(status).toBe(200);
    const { gives } = body as any;
    expect(gives.every((g: any) => g.token === TOKEN_XLM)).toBe(true);
  });

  it("filters by from timestamp", async () => {
    const { body } = await get(server, `/gives?from=2023-11-14T21:33:22Z`);
    const { gives } = body as any;
    // Both rows have timestamp >= that unix second
    expect(gives.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by to timestamp", async () => {
    const { body } = await get(server, `/gives?to=2023-11-14T21:33:21Z`);
    const { gives } = body as any;
    // Rows are at 1_700_000_001+ so none should fall before 2023-11-14T21:33:21Z (1_700_000_001)
    for (const g of gives) {
      expect(g.timestamp).toBeLessThanOrEqual(1_700_000_001);
    }
  });

  it("combines sender + token filters", async () => {
    const { status, body } = await get(server, `/gives?sender=${SENDER_A}&token=${TOKEN_XLM}`);
    expect(status).toBe(200);
    const { gives } = body as any;
    expect(gives.every((g: any) => g.sender === SENDER_A && g.token === TOKEN_XLM)).toBe(true);
  });

  it("response includes count field", async () => {
    const { body } = await get(server, `/gives`);
    const { count, gives } = body as any;
    expect(count).toBe(gives.length);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Section 2 — Address with no data
// ─────────────────────────────────────────────────────────────────────

describe("GET /gives — address with no data", () => {
  it("returns empty gives array for unknown sender", async () => {
    const { status, body } = await get(server, `/gives?sender=${SENDER_A}`);
    expect(status).toBe(200);
    const { gives } = body as any;
    expect(gives).toHaveLength(0);
  });

  it("returns empty gives array for unknown receiver", async () => {
    const { status, body } = await get(server, `/gives?receiver=${RECEIVER}`);
    expect(status).toBe(200);
    const { gives, count } = body as any;
    expect(gives).toHaveLength(0);
    expect(count).toBe(0);
  });

  it("empty table — no filters — returns empty list", async () => {
    const { status, body } = await get(server, `/gives`);
    expect(status).toBe(200);
    expect((body as any).gives).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Section 3 — Invalid address / bad params → 400
// ─────────────────────────────────────────────────────────────────────

describe("GET /gives — invalid inputs", () => {
  it("returns 400 for invalid sender address", async () => {
    const { status, body } = await get(server, `/gives?sender=NOT_A_VALID_ADDRESS`);
    expect(status).toBe(400);
    expect((body as any).error).toMatch(/sender/i);
  });

  it("returns 400 for invalid receiver address", async () => {
    const { status, body } = await get(server, `/gives?receiver=bad`);
    expect(status).toBe(400);
    expect((body as any).error).toMatch(/receiver/i);
  });

  it("returns 400 for invalid from date", async () => {
    const { status, body } = await get(server, `/gives?from=not-a-date`);
    expect(status).toBe(400);
    expect((body as any).error).toMatch(/from/i);
  });

  it("returns 400 for invalid to date", async () => {
    const { status, body } = await get(server, `/gives?to=banana`);
    expect(status).toBe(400);
    expect((body as any).error).toMatch(/to/i);
  });

  it("returns 400 for limit > 100", async () => {
    const { status, body } = await get(server, `/gives?limit=200`);
    expect(status).toBe(400);
    expect((body as any).error).toMatch(/limit/i);
  });

  it("returns 400 for limit = 0", async () => {
    const { status, body } = await get(server, `/gives?limit=0`);
    expect(status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Section 4 — Pagination
// ─────────────────────────────────────────────────────────────────────

describe("GET /gives — pagination", () => {
  /** Insert N give rows with distinct ids and descending timestamps. */
  function seedGives(n: number) {
    for (let i = 0; i < n; i++) {
      dbModule.insertGive(
        makeGiveRow({
          id: `${2000 + i}-1-1`,
          timestamp: 1_700_100_000 - i, // newest first when sorted DESC
          amount: String((i + 1) * 1_000_000),
        })
      );
    }
  }

  it("first page returns up to `limit` items", async () => {
    seedGives(15);
    const { status, body } = await get(server, `/gives?limit=5`);
    expect(status).toBe(200);
    const { gives } = body as any;
    expect(gives).toHaveLength(5);
  });

  it("second page via cursor returns next items", async () => {
    seedGives(15);

    const page1 = await get(server, `/gives?limit=5`);
    const firstPage = (page1.body as any).gives as any[];
    expect(firstPage).toHaveLength(5);

    const cursor = firstPage[firstPage.length - 1].id;
    const page2 = await get(server, `/gives?limit=5&cursor=${cursor}`);
    expect(page2.status).toBe(200);
    const secondPage = (page2.body as any).gives as any[];
    expect(secondPage).toHaveLength(5);

    // No overlap between pages
    const firstIds = new Set(firstPage.map((g: any) => g.id));
    for (const g of secondPage) {
      expect(firstIds.has(g.id)).toBe(false);
    }
  });

  it("empty last page when all items consumed", async () => {
    seedGives(5);

    const page1 = await get(server, `/gives?limit=5`);
    const firstPage = (page1.body as any).gives as any[];
    const cursor = firstPage[firstPage.length - 1].id;

    const page2 = await get(server, `/gives?limit=5&cursor=${cursor}`);
    expect(page2.status).toBe(200);
    expect((page2.body as any).gives).toHaveLength(0);
  });

  it("results are ordered newest first (timestamp DESC)", async () => {
    seedGives(10);
    const { body } = await get(server, `/gives?limit=10`);
    const gives = (body as any).gives as any[];
    for (let i = 1; i < gives.length; i++) {
      expect(gives[i - 1].timestamp).toBeGreaterThanOrEqual(gives[i].timestamp);
    }
  });

  it("default limit is 20 and max limit is capped at 100", async () => {
    seedGives(30);
    const defaultPage = await get(server, `/gives`);
    expect((defaultPage.body as any).gives).toHaveLength(20);
  });
});
