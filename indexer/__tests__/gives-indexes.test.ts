// @vitest-environment node
/**
 * Query plans for GET /gives filtered by sender/receiver + token (#843)
 *
 * Runs EXPLAIN QUERY PLAN on the exact statement queryGives() prepares, so
 * the assertions follow the real query rather than a copy of its SQL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

import { createTestDb, type TestDb } from "./helpers/createTestDb";
import * as dbModule from "../src/db";
import type { GiveQueryParams } from "../src/types";

const SENDER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const RECEIVER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

let helpers: TestDb;

beforeEach(() => {
  helpers = createTestDb();
  dbModule._setTestDb("testnet", helpers.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  dbModule._clearTestDb("testnet");
  helpers.close();
});

/** EXPLAIN QUERY PLAN details for the statement queryGives() prepares. */
function planFor(params: GiveQueryParams): string {
  const prepare = vi.spyOn(helpers.db, "prepare");
  dbModule.queryGives({ ...params, network: "testnet" });
  const sql = prepare.mock.calls[prepare.mock.calls.length - 1][0] as string;
  prepare.mockRestore();

  const placeholders = (sql.match(/\?/g) ?? []).length;
  const rows = helpers.db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...new Array(placeholders).fill(null)) as { detail: string }[];
  return rows.map((row) => row.detail).join("\n");
}

describe("gives token indexes (#843)", () => {
  it("serves sender + token from idx_gives_sender_token_timestamp", () => {
    const plan = planFor({ sender: SENDER, token: TOKEN });
    expect(plan).toContain("idx_gives_sender_token_timestamp");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("serves receiver + token from idx_gives_receiver_token_timestamp", () => {
    const plan = planFor({ receiver: RECEIVER, token: TOKEN });
    expect(plan).toContain("idx_gives_receiver_token_timestamp");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("keeps using the index with a date range", () => {
    const plan = planFor({
      sender: SENDER,
      token: TOKEN,
      from: "2024-01-01T00:00:00Z",
      to: "2024-12-31T23:59:59Z",
    });
    expect(plan).toContain("idx_gives_sender_token_timestamp");
  });

  it("is idempotent: re-applying the schema keeps one of each index", () => {
    const schema = fs.readFileSync(
      path.resolve(__dirname, "../schema.sql"),
      "utf8"
    );
    expect(() => helpers.db.exec(schema)).not.toThrow();

    const names = (
      helpers.db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'gives' AND name LIKE '%token_timestamp'`
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(names.sort()).toEqual([
      "idx_gives_receiver_token_timestamp",
      "idx_gives_sender_token_timestamp",
    ]);
  });
});
