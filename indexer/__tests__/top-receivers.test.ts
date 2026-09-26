import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import http from "http";
import { _setTestDb, _clearTestDb, queryTopReceivers } from "../src/db";
import { createServer } from "../src/server";

const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const SENDER_1 = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const SENDER_2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM";
const RCV_1 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCOA";
const RCV_2 = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDG";
const RCV_3 = "GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEO";

describe("GET /analytics/top-receivers", () => {
  let db: Database.Database;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS drips_streams (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        receiver TEXT NOT NULL,
        token TEXT NOT NULL,
        rate_per_second TEXT NOT NULL,
        estimated_end_time INTEGER,
        ended_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS checkpoint (
        id INTEGER PRIMARY KEY,
        last_ledger INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO checkpoint (id, last_ledger) VALUES (1, 100);
    `);
    _setTestDb("testnet", db);

    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    port = (addr && typeof addr !== "string") ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _clearTestDb("testnet");
    db.close();
  });

  it("calculates top N receivers ordered by total incoming streaming rate", () => {
    const now = Math.floor(Date.now() / 1000);
    const future = now + 86400;

    // RCV_1 receives 500 from SENDER_1 + 300 from SENDER_2 = 800 total (2 senders)
    db.prepare(`INSERT INTO drips_streams (id, account, receiver, token, rate_per_second, estimated_end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("s1", SENDER_1, RCV_1, TOKEN, "500", future, now);
    db.prepare(`INSERT INTO drips_streams (id, account, receiver, token, rate_per_second, estimated_end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("s2", SENDER_2, RCV_1, TOKEN, "300", future, now);

    // RCV_2 receives 1200 from SENDER_1 (1 sender)
    db.prepare(`INSERT INTO drips_streams (id, account, receiver, token, rate_per_second, estimated_end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("s3", SENDER_1, RCV_2, TOKEN, "1200", future, now);

    // RCV_3 receives 100 from SENDER_2 (1 sender)
    db.prepare(`INSERT INTO drips_streams (id, account, receiver, token, rate_per_second, estimated_end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("s4", SENDER_2, RCV_3, TOKEN, "100", future, now);

    const top2 = queryTopReceivers(TOKEN, 2, "testnet");
    expect(top2).toHaveLength(2);
    expect(top2[0]).toEqual({
      account: RCV_2,
      total_incoming_rate_per_sec: "1200",
      sender_count: 1,
    });
    expect(top2[1]).toEqual({
      account: RCV_1,
      total_incoming_rate_per_sec: "800",
      sender_count: 2,
    });
  });

  it("returns HTTP 400 when token query param is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/analytics/top-receivers`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("token query param is required");
  });

  it("handles limit param with default 10 and max 50 via API endpoint", async () => {
    const now = Math.floor(Date.now() / 1000);
    const future = now + 86400;

    db.prepare(`INSERT INTO drips_streams (id, account, receiver, token, rate_per_second, estimated_end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("s1", SENDER_1, RCV_1, TOKEN, "500", future, now);

    const resDefault = await fetch(`http://127.0.0.1:${port}/analytics/top-receivers?token=${TOKEN}`);
    expect(resDefault.status).toBe(200);
    const bodyDefault = await resDefault.json();
    expect(bodyDefault.receivers).toHaveLength(1);
    expect(bodyDefault.receivers[0]).toEqual({
      account: RCV_1,
      total_incoming_rate_per_sec: "500",
      sender_count: 1,
    });

    const resInvalidLimit = await fetch(`http://127.0.0.1:${port}/analytics/top-receivers?token=${TOKEN}&limit=100`);
    expect(resInvalidLimit.status).toBe(400);
    const bodyInvalid = await resInvalidLimit.json();
    expect(bodyInvalid.error).toBe("limit must be an integer between 1 and 50");
  });

  it("caches the result for 60 seconds", async () => {
    const now = Math.floor(Date.now() / 1000);
    const future = now + 86400;

    db.prepare(`INSERT INTO drips_streams (id, account, receiver, token, rate_per_second, estimated_end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("s1", SENDER_1, RCV_1, TOKEN, "500", future, now);

    const first = await fetch(`http://127.0.0.1:${port}/analytics/top-receivers?token=${TOKEN}&limit=5`);
    expect(first.status).toBe(200);
    const bodyFirst = await first.json();
    expect(bodyFirst.cached).toBe(false);

    const second = await fetch(`http://127.0.0.1:${port}/analytics/top-receivers?token=${TOKEN}&limit=5`);
    expect(second.status).toBe(200);
    const bodySecond = await second.json();
    expect(bodySecond.cached).toBe(true);
  });
});
