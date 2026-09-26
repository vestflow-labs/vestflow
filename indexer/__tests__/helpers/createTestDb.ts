/**
 * Test database helper
 *
 * Creates a fresh in-memory SQLite database with the full production schema
 * applied. Each call returns an independent instance so test suites never
 * share state even when running in the same worker.
 *
 * Usage
 * -----
 *   import { createTestDb } from "./helpers/createTestDb";
 *   import * as dbModule from "../../src/db";
 *   import { vi } from "vitest";
 *
 *   vi.mock("../../src/db", async () => {
 *     const real = await vi.importActual<typeof import("../../src/db")>("../../src/db");
 *     return { ...real };           // start with real impl
 *   });
 *
 *   let helpers: ReturnType<typeof createTestDb>;
 *
 *   beforeEach(() => {
 *     helpers = createTestDb();
 *     vi.spyOn(dbModule, "getDb").mockReturnValue(helpers.db);
 *   });
 *
 *   afterEach(() => helpers.close());
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const SCHEMA_PATH = path.resolve(__dirname, "../../schema.sql");

export interface TestDb {
  db: Database.Database;
  close: () => void;
}

export function createTestDb(): TestDb {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Apply the full production schema
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schema);

  // Add the deduplication index (normally added by db.ts ensureEventDedupIndex on first open).
  // Must use COALESCE so that NULL values in nullable columns are treated as equivalent
  // (prevents the same logical event being inserted twice with different Stellar IDs).
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_dedup ON schedule_events (
      ledger,
      event_type,
      COALESCE(schedule_id, -1),
      COALESCE(proposal_id, -1),
      COALESCE(grantor, ''),
      COALESCE(beneficiary, ''),
      COALESCE(amount, ''),
      COALESCE(token, '')
    )
  `);

  return {
    db,
    close: () => {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

// ── Fixture factories ──────────────────────────────────────────────────────

export interface EventFixture {
  id: string;
  event_type: string;
  ledger: number;
  ledger_closed_at: string;
  schedule_id: number | null;
  proposal_id: number | null;
  grantor: string | null;
  beneficiary: string | null;
  amount: string | null;
  token: string | null;
  created_amount: string | null;
  raw_topics: string;
  raw_value: string;
}

export function makeScheduleCreatedEvent(overrides: Partial<EventFixture> = {}): EventFixture {
  return {
    id: "1000-1-1",
    event_type: "schedule_created",
    ledger: 1000,
    ledger_closed_at: "2024-01-01T00:00:00Z",
    schedule_id: 1,
    proposal_id: null,
    grantor: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    beneficiary: "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A",
    amount: null,
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    created_amount: "1000000000",
    raw_topics: JSON.stringify(["created", 1]),
    raw_value: JSON.stringify(["GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A"]),
    ...overrides,
  };
}

export function makeClaimedEvent(overrides: Partial<EventFixture> = {}): EventFixture {
  return {
    id: "1001-1-1",
    event_type: "claimed",
    ledger: 1001,
    ledger_closed_at: "2024-01-01T00:00:05Z",
    schedule_id: 1,
    proposal_id: null,
    grantor: null,
    beneficiary: "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A",
    amount: "100000000",
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    created_amount: null,
    raw_topics: JSON.stringify(["claimed", "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A"]),
    raw_value: JSON.stringify([1, "100000000"]),
    ...overrides,
  };
}

/** Insert an event row directly into the given db (bypasses the module cache). */
export function insertRaw(db: Database.Database, event: EventFixture): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO schedule_events
      (id, event_type, ledger, ledger_closed_at, schedule_id, proposal_id,
       grantor, beneficiary, amount, token, created_amount, raw_topics, raw_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.event_type, event.ledger, event.ledger_closed_at,
    event.schedule_id, event.proposal_id,
    event.grantor, event.beneficiary, event.amount, event.token, event.created_amount,
    event.raw_topics, event.raw_value,
  );
  return result.changes > 0;
}

export function countRows(db: Database.Database, table = "schedule_events"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
