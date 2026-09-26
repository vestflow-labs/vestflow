import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { _setTestDb, _clearTestDb, insertSqueezeEvent, querySqueezeEvents, insertEvent } from "../src/db";
import {
  clearBalanceCache,
  getOrSetBalanceCache,
} from "../src/balance-cache";

const SENDER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const RECEIVER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const HASH_1 = "hash_abc_123_xyz";

describe("squeeze_events & double-squeeze duplicate detection", () => {
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
      CREATE TABLE IF NOT EXISTS squeeze_events (
        id TEXT PRIMARY KEY,
        receiver TEXT NOT NULL,
        sender TEXT NOT NULL,
        token TEXT NOT NULL,
        amount_stroops TEXT NOT NULL,
        cycle_id INTEGER NOT NULL,
        ledger INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        history_hash TEXT,
        is_duplicate INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_squeeze_events_receiver_sender_history
        ON squeeze_events (receiver, sender, history_hash);
    `);
    _setTestDb("testnet", db);
    clearBalanceCache();
  });

  afterEach(() => {
    _clearTestDb("testnet");
    clearBalanceCache();
    db.close();
  });

  it("inserts a single squeeze event with is_duplicate = 0", () => {
    const result = insertSqueezeEvent({
      id: "squeeze-1",
      receiver: RECEIVER,
      sender: SENDER,
      token: TOKEN,
      amount_stroops: "50000",
      cycle_id: 1,
      ledger: 105,
      timestamp: 1700000000,
      history_hash: HASH_1,
    }, "testnet");

    expect(result.isDuplicate).toBe(false);

    const rows = querySqueezeEvents({ receiver: RECEIVER, network: "testnet" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "squeeze-1",
      receiver: RECEIVER,
      sender: SENDER,
      token: TOKEN,
      amount_stroops: "50000",
      cycle_id: 1,
      ledger: 105,
      timestamp: 1700000000,
      history_hash: HASH_1,
      is_duplicate: 0,
    });
  });

  it("detects duplicate squeeze attempt for same (receiver, sender, history_hash)", () => {
    // First squeeze
    const res1 = insertSqueezeEvent({
      id: "squeeze-1",
      receiver: RECEIVER,
      sender: SENDER,
      token: TOKEN,
      amount_stroops: "50000",
      cycle_id: 1,
      ledger: 105,
      timestamp: 1700000000,
      history_hash: HASH_1,
    }, "testnet");
    expect(res1.isDuplicate).toBe(false);

    // Second squeeze with same receiver, sender, history_hash (different event ID)
    const res2 = insertSqueezeEvent({
      id: "squeeze-2",
      receiver: RECEIVER,
      sender: SENDER,
      token: TOKEN,
      amount_stroops: "50000",
      cycle_id: 1,
      ledger: 106,
      timestamp: 1700000010,
      history_hash: HASH_1,
    }, "testnet");
    expect(res2.isDuplicate).toBe(true);

    const rows = querySqueezeEvents({ receiver: RECEIVER, network: "testnet" });
    expect(rows).toHaveLength(2);
    const dup = rows.find((r) => r.id === "squeeze-2");
    expect(dup?.is_duplicate).toBe(1);
  });

  it("automatically projects squeezed contract events into squeeze_events", () => {
    insertEvent({
      id: "ledger105-tx2-event1",
      event_type: "squeezed",
      ledger: 105,
      ledger_closed_at: "2026-09-24T12:00:00Z",
      schedule_id: null,
      proposal_id: null,
      grantor: SENDER,
      beneficiary: RECEIVER,
      amount: "123456",
      token: TOKEN,
      created_amount: null,
      raw_topics: JSON.stringify(["squeezed", RECEIVER, SENDER, TOKEN]),
      raw_value: JSON.stringify(["123456", 2, HASH_1]),
    }, "testnet");

    const rows = querySqueezeEvents({ receiver: RECEIVER, network: "testnet" });
    expect(rows).toHaveLength(1);
    expect(rows[0].receiver).toBe(RECEIVER);
    expect(rows[0].sender).toBe(SENDER);
    expect(rows[0].amount_stroops).toBe("123456");
    expect(rows[0].cycle_id).toBe(2);
    expect(rows[0].history_hash).toBe(HASH_1);
    expect(rows[0].is_duplicate).toBe(0);
  });

  it("invalidates only the matching balance cache entry", async () => {
    let receiverCalls = 0;
    let otherCalls = 0;
    const fetchReceiver = async () => {
      receiverCalls += 1;
      return {
        streamingBalance: String(receiverCalls),
        collectableAmount: "0",
        streamingRatePerSec: "1",
      };
    };
    const fetchOther = async () => {
      otherCalls += 1;
      return {
        streamingBalance: String(otherCalls),
        collectableAmount: "0",
        streamingRatePerSec: "1",
      };
    };

    await getOrSetBalanceCache(RECEIVER, TOKEN, "testnet", fetchReceiver);
    await getOrSetBalanceCache(RECEIVER, TOKEN, "testnet", fetchReceiver);
    await getOrSetBalanceCache(SENDER, TOKEN, "testnet", fetchOther);
    expect(receiverCalls).toBe(1);
    expect(otherCalls).toBe(1);

    insertEvent({
      id: "ledger105-tx2-event2",
      event_type: "squeezed",
      ledger: 105,
      ledger_closed_at: "2026-09-24T12:00:01Z",
      schedule_id: null,
      proposal_id: null,
      grantor: SENDER,
      beneficiary: RECEIVER,
      amount: "123456",
      token: TOKEN,
      created_amount: null,
      raw_topics: JSON.stringify(["squeezed", RECEIVER, SENDER, TOKEN]),
      raw_value: JSON.stringify(["123456", 3, "hash-2"]),
    }, "testnet");

    const refreshed = await getOrSetBalanceCache(RECEIVER, TOKEN, "testnet", fetchReceiver);
    const untouched = await getOrSetBalanceCache(SENDER, TOKEN, "testnet", fetchOther);
    expect(refreshed.streamingBalance).toBe("2");
    expect(untouched.streamingBalance).toBe("1");
    expect(receiverCalls).toBe(2);
    expect(otherCalls).toBe(1);
  });
});
