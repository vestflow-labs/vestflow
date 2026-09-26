import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { InsertEventRow } from "../src/db";

const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const RECEIVER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM";
const OTHER = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCOA";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXS7Q2QVSBQZBCO7T3WHNM7GC";

function eventRow(overrides: Partial<InsertEventRow> & { id: string; event_type: string }): InsertEventRow {
  return {
    id: overrides.id,
    event_type: overrides.event_type,
    ledger: overrides.ledger ?? 1,
    ledger_closed_at: overrides.ledger_closed_at ?? "2026-08-26T00:00:00.000Z",
    schedule_id: null,
    proposal_id: null,
    grantor: null,
    beneficiary: null,
    amount: null,
    token: TOKEN,
    created_amount: null,
    raw_topics: "[]",
    raw_value: "{}",
    ...overrides,
  };
}

async function run(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vestflow-drips-events-"));
  process.env.INDEXER_DB_PATH_TESTNET = path.join(tempDir, "testnet.db");

  const {
    getDb,
    insertEvent,
    getCurrentStream,
    queryGivesForAccount,
    getCollectedTotal,
  } = await import("../src/db");
  const db = getDb("testnet");

  try {
    const firstConfig = [{ receiver: RECEIVER, rate_per_second: "10" }];
    assert.equal(insertEvent(eventRow({
      id: "evt-stream-1",
      event_type: "stream_set",
      grantor: ACCOUNT,
      raw_value: JSON.stringify(firstConfig),
    }), "testnet"), true);
    assert.deepEqual(JSON.parse(getCurrentStream(ACCOUNT, TOKEN, "testnet")!.receivers_json), firstConfig);

    const closedConfig = [{ receiver: RECEIVER, rate_per_second: "0" }];
    assert.equal(insertEvent(eventRow({
      id: "evt-stream-2",
      event_type: "stream_set",
      grantor: ACCOUNT,
      ledger: 2,
      raw_value: JSON.stringify(closedConfig),
    }), "testnet"), true);
    assert.deepEqual(JSON.parse(getCurrentStream(ACCOUNT, TOKEN, "testnet")!.receivers_json), closedConfig);

    assert.equal(insertEvent(eventRow({
      id: "evt-give-1",
      event_type: "given",
      grantor: ACCOUNT,
      beneficiary: RECEIVER,
      amount: "25",
      ledger: 3,
    }), "testnet"), true);
    assert.equal(insertEvent(eventRow({
      id: "evt-give-2",
      event_type: "given",
      grantor: ACCOUNT,
      beneficiary: OTHER,
      amount: "30",
      ledger: 4,
    }), "testnet"), true);
    const gives = queryGivesForAccount(ACCOUNT, "testnet");
    assert.equal(gives.length, 2);
    assert.deepEqual(gives.map((give) => give.amount_stroops).sort(), ["25", "30"]);

    assert.equal(insertEvent(eventRow({
      id: "evt-collected-1",
      event_type: "collected",
      beneficiary: RECEIVER,
      amount: "40",
      ledger: 5,
    }), "testnet"), true);
    assert.equal(insertEvent(eventRow({
      id: "evt-collected-2",
      event_type: "collected",
      beneficiary: RECEIVER,
      amount: "60",
      ledger: 6,
    }), "testnet"), true);
    assert.equal(getCollectedTotal(RECEIVER, TOKEN, "testnet"), "100");
    assert.equal(insertEvent(eventRow({
      id: "evt-collected-2",
      event_type: "collected",
      beneficiary: RECEIVER,
      amount: "60",
      ledger: 6,
    }), "testnet"), false);
    assert.equal(getCollectedTotal(RECEIVER, TOKEN, "testnet"), "100");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().then(() => console.log("Drips event projection tests passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
