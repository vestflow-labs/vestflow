import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import http from "http";
import { _setTestDb, _clearTestDb } from "../src/db";
import { createServer } from "../src/server";

const SENDER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN2";
const RECEIVER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM2";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("GET /streams/:sender/:receiver/:token", () => {
  let db: Database.Database;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    db = new Database(":memory:");
    // Load schema
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
      CREATE TABLE IF NOT EXISTS drips_streaming_balances (
        account TEXT NOT NULL,
        token TEXT NOT NULL,
        balance TEXT NOT NULL DEFAULT '0',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account, token)
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

  it("returns stream details for a valid sender+receiver+token combo", async () => {
    const now = Math.floor(Date.now() / 1000);
    const maxEndTime = now + 86400;

    db.prepare(
      `INSERT INTO drips_streams (id, account, receiver, token, rate_per_second, estimated_end_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("stream-1", SENDER, RECEIVER, TOKEN, "1000", maxEndTime, now);

    db.prepare(
      `INSERT INTO drips_streaming_balances (account, token, balance) VALUES (?, ?, ?)`
    ).run(SENDER, TOKEN, "50000");

    const res = await fetch(`http://127.0.0.1:${port}/streams/${SENDER}/${RECEIVER}/${TOKEN}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      sender: SENDER,
      receiver: RECEIVER,
      token: TOKEN,
      rate: "1000",
      start_time: now,
      balance: "50000",
      max_end_time: maxEndTime,
    });
  });

  it("returns 404 when no stream configured between them", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/streams/${SENDER}/${RECEIVER}/${TOKEN}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Stream not found");
  });

  it("returns 400 for invalid Stellar addresses", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/streams/invalid_sender/${RECEIVER}/${TOKEN}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid Stellar address");
  });
});
