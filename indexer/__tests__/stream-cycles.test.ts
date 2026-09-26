import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { _setTestDb, _clearTestDb, upsertStreamCycle, queryStreamCycles, insertEvent } from "../src/db";

const ACCOUNT_1 = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const ACCOUNT_2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM";
const TOKEN_1 = "TOKEN_A_111111111111111111111111111111111111111111111111111";
const TOKEN_2 = "TOKEN_B_222222222222222222222222222222222222222222222222222";

describe("stream_cycles & stream_received events", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_events (
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
        materialized_at INTEGER,
        raw_topics TEXT NOT NULL,
        raw_value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS stream_cycles (
        account TEXT NOT NULL,
        token TEXT NOT NULL,
        cycle_end_ledger INTEGER NOT NULL,
        cycle_end_timestamp INTEGER NOT NULL,
        amount_received TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account, token, cycle_end_ledger)
      );
    `);
    _setTestDb("testnet", db);
  });

  afterEach(() => {
    _clearTestDb("testnet");
    db.close();
  });

  it("stores first settlement cycle for account", () => {
    upsertStreamCycle({
      account: ACCOUNT_1,
      token: TOKEN_1,
      cycle_end_ledger: 100,
      cycle_end_timestamp: 1700000000,
      amount_received: "500000",
    }, "testnet");

    const cycles = queryStreamCycles({ account: ACCOUNT_1, network: "testnet" });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({
      account: ACCOUNT_1,
      token: TOKEN_1,
      cycle_end_ledger: 100,
      cycle_end_timestamp: 1700000000,
      amount_received: "500000",
    });
  });

  it("upserts on duplicate (account, token, cycle_end_ledger)", () => {
    // First settlement
    upsertStreamCycle({
      account: ACCOUNT_1,
      token: TOKEN_1,
      cycle_end_ledger: 100,
      cycle_end_timestamp: 1700000000,
      amount_received: "500000",
    }, "testnet");

    // Re-settlement / updated amount for same ledger
    upsertStreamCycle({
      account: ACCOUNT_1,
      token: TOKEN_1,
      cycle_end_ledger: 100,
      cycle_end_timestamp: 1700000050,
      amount_received: "750000",
    }, "testnet");

    const cycles = queryStreamCycles({ account: ACCOUNT_1, network: "testnet" });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].amount_received).toBe("750000");
    expect(cycles[0].cycle_end_timestamp).toBe(1700000050);
  });

  it("handles subsequent settlements on different ledgers", () => {
    upsertStreamCycle({
      account: ACCOUNT_1,
      token: TOKEN_1,
      cycle_end_ledger: 100,
      cycle_end_timestamp: 1700000000,
      amount_received: "500000",
    }, "testnet");

    upsertStreamCycle({
      account: ACCOUNT_1,
      token: TOKEN_1,
      cycle_end_ledger: 200,
      cycle_end_timestamp: 1700000600,
      amount_received: "600000",
    }, "testnet");

    const cycles = queryStreamCycles({ account: ACCOUNT_1, network: "testnet" });
    expect(cycles).toHaveLength(2);
    expect(cycles[0].cycle_end_ledger).toBe(200);
    expect(cycles[1].cycle_end_ledger).toBe(100);
  });

  it("handles multi-token settlements", () => {
    upsertStreamCycle({
      account: ACCOUNT_1,
      token: TOKEN_1,
      cycle_end_ledger: 100,
      cycle_end_timestamp: 1700000000,
      amount_received: "500000",
    }, "testnet");

    upsertStreamCycle({
      account: ACCOUNT_1,
      token: TOKEN_2,
      cycle_end_ledger: 100,
      cycle_end_timestamp: 1700000000,
      amount_received: "200000",
    }, "testnet");

    upsertStreamCycle({
      account: ACCOUNT_2,
      token: TOKEN_1,
      cycle_end_ledger: 100,
      cycle_end_timestamp: 1700000000,
      amount_received: "100000",
    }, "testnet");

    const acc1Token1 = queryStreamCycles({ account: ACCOUNT_1, token: TOKEN_1, network: "testnet" });
    expect(acc1Token1).toHaveLength(1);
    expect(acc1Token1[0].amount_received).toBe("500000");

    const acc1Token2 = queryStreamCycles({ account: ACCOUNT_1, token: TOKEN_2, network: "testnet" });
    expect(acc1Token2).toHaveLength(1);
    expect(acc1Token2[0].amount_received).toBe("200000");

    const allAcc1 = queryStreamCycles({ account: ACCOUNT_1, network: "testnet" });
    expect(allAcc1).toHaveLength(2);
  });

  it("automatically projects stream_received contract events into stream_cycles", () => {
    insertEvent({
      id: "ledger100-tx1-event1",
      event_type: "stream_received",
      ledger: 100,
      ledger_closed_at: "2026-09-24T12:00:00Z",
      schedule_id: null,
      proposal_id: null,
      grantor: null,
      beneficiary: ACCOUNT_1,
      amount: "999000",
      token: TOKEN_1,
      created_amount: null,
      raw_topics: JSON.stringify(["strm_recv", ACCOUNT_1, TOKEN_1]),
      raw_value: JSON.stringify([1, "999000"]),
    }, "testnet");

    const cycles = queryStreamCycles({ account: ACCOUNT_1, network: "testnet" });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].account).toBe(ACCOUNT_1);
    expect(cycles[0].amount_received).toBe("999000");
    expect(cycles[0].cycle_end_ledger).toBe(100);
  });
});
