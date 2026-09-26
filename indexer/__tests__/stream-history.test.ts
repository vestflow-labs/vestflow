import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import http from "http";
import {
  _clearTestDb,
  _setTestDb,
  insertEvent,
} from "../src/db";
import { createServer } from "../src/server";

const SENDER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN2";
const RECEIVER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM2";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function event(
  id: string,
  ledger: number,
  rate: string,
): Parameters<typeof insertEvent>[0] {
  return {
    id,
    event_type: "stream_set",
    ledger,
    ledger_closed_at: new Date(ledger * 1000).toISOString(),
    schedule_id: null,
    proposal_id: null,
    grantor: SENDER,
    beneficiary: null,
    amount: null,
    token: TOKEN,
    created_amount: null,
    raw_topics: JSON.stringify(["stream_set", SENDER, TOKEN]),
    raw_value: JSON.stringify([{ receiver: RECEIVER, rate_per_second: rate }]),
  };
}

async function request(server: http.Server, path: string): Promise<{ status: number; body: any }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  return { status: response.status, body: await response.json() };
}

describe("GET /streams/history/:sender/:receiver/:token", () => {
  let db: Database.Database;
  let server: http.Server;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schedule_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        ledger INTEGER NOT NULL,
        ledger_closed_at TEXT NOT NULL,
        schedule_id INTEGER,
        proposal_id INTEGER,
        grantor TEXT,
        beneficiary TEXT,
        amount TEXT,
        token TEXT,
        created_amount TEXT,
        start_time INTEGER,
        duration INTEGER,
        cliff_duration INTEGER,
        vesting_kind TEXT,
        raw_topics TEXT NOT NULL,
        raw_value TEXT NOT NULL
      );
      CREATE TABLE drips_streams (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        receiver TEXT NOT NULL,
        token TEXT NOT NULL,
        rate_per_second TEXT NOT NULL,
        estimated_end_time INTEGER,
        ended_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE current_streams (
        account TEXT NOT NULL,
        token TEXT NOT NULL,
        receivers_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account, token)
      );
    `);
    _setTestDb("testnet", db);
    insertEvent(event("open", 10, "10"), "testnet");
    insertEvent(event("change", 20, "25"), "testnet");
    insertEvent(event("close", 30, "0"), "testnet");
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _clearTestDb("testnet");
    db.close();
  });

  it("returns chronological updates with pagination", async () => {
    const first = await request(
      server,
      `/streams/history/${SENDER}/${RECEIVER}/${TOKEN}?limit=2`,
    );
    expect(first.status).toBe(200);
    expect(first.body.history).toEqual([
      expect.objectContaining({
        ledger: 10,
        old_rate: "0",
        new_rate: "10",
        action: "open",
      }),
      expect.objectContaining({
        ledger: 20,
        old_rate: "10",
        new_rate: "25",
        action: "rate_change",
      }),
    ]);
    expect(first.body.next_cursor).toBeTruthy();

    const second = await request(
      server,
      `/streams/history/${SENDER}/${RECEIVER}/${TOKEN}?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.history).toEqual([
      expect.objectContaining({
        ledger: 30,
        old_rate: "25",
        new_rate: "0",
        action: "close",
      }),
    ]);
    expect(second.body.next_cursor).toBeNull();
  });

  it("returns 404 for a tuple without history", async () => {
    const result = await request(
      server,
      `/streams/history/${SENDER}/${RECEIVER}/missing`,
    );
    expect(result.status).toBe(404);
  });
});
