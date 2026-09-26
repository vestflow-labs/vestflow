// @vitest-environment node
/**
 * Hourly stream snapshots written by the materialization worker (#844)
 *
 * Covers:
 *   - Single hour (one row per token, later runs in the hour overwrite it)
 *   - Multi-hour (one row per hour the worker runs in)
 *   - Gap fill (hours with no run repeat the previous hour's values)
 *
 * Runs the real materialize() against a fresh :memory: SQLite db injected
 * via _setTestDb, with the clock pinned so hours are deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createTestDb, type TestDb } from "./helpers/createTestDb";
import * as dbModule from "../src/db";
import { materialize } from "../src/analytics";

const SENDER_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const SENDER_B = "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A";
const RECEIVER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TOKEN_XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_ALT = "CBIELTK6YBZJU5UP2WWQEQ4YGG6WOH6MQIVBX7XKBTQLZUQJNDPFR12";

const HOUR = 3_600;
const H0 = 1_767_225_600; // 2026-01-01T00:00:00Z

let helpers: TestDb;
let streamCount = 0;

function addStream(
  token: string,
  ratePerSecond: string,
  ends: { ended_at?: number; estimated_end_time?: number } = {}
): void {
  streamCount++;
  helpers.db
    .prepare(
      `INSERT INTO drips_streams
        (id, account, receiver, token, rate_per_second, estimated_end_time, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `stream-${streamCount}`,
      SENDER_A,
      RECEIVER,
      token,
      ratePerSecond,
      ends.estimated_end_time ?? null,
      ends.ended_at ?? null,
      H0
    );
}

function setBalance(account: string, token: string, balance: string): void {
  helpers.db
    .prepare(
      `INSERT INTO drips_streaming_balances (account, token, balance)
       VALUES (?, ?, ?)
       ON CONFLICT (account, token) DO UPDATE SET balance = excluded.balance`
    )
    .run(account, token, balance);
}

/** Runs the materialization worker as if the clock read `seconds`. */
function materializeAt(seconds: number): void {
  vi.setSystemTime(seconds * 1000);
  materialize("testnet");
}

function snapshots(token: string) {
  return helpers.db
    .prepare(
      `SELECT hour, active_stream_count, total_rate_per_sec, total_balance
       FROM stream_hourly_snapshots
       WHERE token = ?
       ORDER BY hour ASC`
    )
    .all(token);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  helpers = createTestDb();
  dbModule._setTestDb("testnet", helpers.db);
});

afterEach(() => {
  vi.useRealTimers();
  dbModule._clearTestDb("testnet");
  helpers.close();
});

describe("stream_hourly_snapshots (#844)", () => {
  it("single hour: writes one row per token with active streams, total rate and balance", () => {
    addStream(TOKEN_XLM, "10");
    addStream(TOKEN_XLM, "5", { estimated_end_time: H0 + 10 * HOUR });
    addStream(TOKEN_XLM, "100", { ended_at: H0 - HOUR }); // closed
    addStream(TOKEN_XLM, "200", { estimated_end_time: H0 - 1 }); // ran out
    addStream(TOKEN_ALT, "7");
    setBalance(SENDER_A, TOKEN_XLM, "1000");
    setBalance(SENDER_B, TOKEN_XLM, "500");

    materializeAt(H0 + 60);
    // A later run in the same hour updates the row instead of adding one.
    addStream(TOKEN_XLM, "1");
    materializeAt(H0 + 30 * 60);

    expect(snapshots(TOKEN_XLM)).toEqual([
      { hour: H0, active_stream_count: 3, total_rate_per_sec: "16", total_balance: "1500" },
    ]);
    expect(snapshots(TOKEN_ALT)).toEqual([
      { hour: H0, active_stream_count: 1, total_rate_per_sec: "7", total_balance: "0" },
    ]);
  });

  it("multi-hour: writes a row for every hour the worker runs in", () => {
    addStream(TOKEN_XLM, "10");
    setBalance(SENDER_A, TOKEN_XLM, "1000");
    materializeAt(H0 + 5 * 60);

    addStream(TOKEN_XLM, "20");
    setBalance(SENDER_A, TOKEN_XLM, "4000");
    materializeAt(H0 + HOUR + 5 * 60);

    expect(snapshots(TOKEN_XLM)).toEqual([
      { hour: H0, active_stream_count: 1, total_rate_per_sec: "10", total_balance: "1000" },
      { hour: H0 + HOUR, active_stream_count: 2, total_rate_per_sec: "30", total_balance: "4000" },
    ]);
  });

  it("gap fill: hours with no run repeat the previous hour's values", () => {
    addStream(TOKEN_XLM, "10");
    setBalance(SENDER_A, TOKEN_XLM, "1000");
    materializeAt(H0);

    // Nothing runs for the next two hours; by the next run the stream has closed.
    helpers.db.prepare("UPDATE drips_streams SET ended_at = ?").run(H0 + 3 * HOUR);
    setBalance(SENDER_A, TOKEN_XLM, "0");
    materializeAt(H0 + 3 * HOUR + 60);

    const previous = { active_stream_count: 1, total_rate_per_sec: "10", total_balance: "1000" };
    expect(snapshots(TOKEN_XLM)).toEqual([
      { hour: H0, ...previous },
      { hour: H0 + HOUR, ...previous },
      { hour: H0 + 2 * HOUR, ...previous },
      { hour: H0 + 3 * HOUR, active_stream_count: 0, total_rate_per_sec: "0", total_balance: "0" },
    ]);
  });
});
