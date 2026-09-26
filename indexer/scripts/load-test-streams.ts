#!/usr/bin/env ts-node
/**
 * GET /streams load test (#860 acceptance criteria).
 *
 * Seeds 10,000 Drips stream records (spread over 200 accounts, so each
 * account holds one full 50-row page) into a throwaway SQLite database,
 * starts the query server on an ephemeral port, then hits
 * `GET /streams?account=<address>` from 500 concurrent connections with
 * autocannon and asserts p99 < 50ms.
 *
 * Usage:
 *   npm run test:streams-load
 * Env:  LOAD_TEST_STREAMS, LOAD_TEST_CONNECTIONS, LOAD_TEST_REQUESTS
 */

import fs from "fs";
import os from "os";
import path from "path";
import autocannon from "autocannon";
import { StrKey } from "@stellar/stellar-sdk";
import { getDb } from "../src/db";
import { createServer } from "../src/server";

const STREAM_COUNT = Number(process.env.LOAD_TEST_STREAMS ?? 10_000);
const CONNECTIONS = Number(process.env.LOAD_TEST_CONNECTIONS ?? 500);
const REQUESTS = Number(process.env.LOAD_TEST_REQUESTS ?? 10_000);
const ACCOUNT_COUNT = 200;
const P99_BUDGET_MS = 50;
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const DB_PATH = path.join(os.tmpdir(), `vestflow-streams-load-${Date.now()}.db`);
process.env.INDEXER_DB_PATH_TESTNET = DB_PATH;

/** Deterministic, valid G-address for the given index. */
function accountAddress(index: number): string {
  const key = Buffer.alloc(32);
  key.writeUInt32BE(index);
  return StrKey.encodeEd25519PublicKey(key);
}

function seed(): string[] {
  const db = getDb("testnet");
  const accounts = Array.from({ length: ACCOUNT_COUNT }, (_, i) => accountAddress(i));
  console.log(`Seeding ${STREAM_COUNT} streams across ${ACCOUNT_COUNT} accounts…`);

  const insert = db.prepare(
    `INSERT OR REPLACE INTO drips_streams
      (id, account, receiver, token, rate_per_second, estimated_end_time, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < STREAM_COUNT; i++) {
      const account = accounts[i % ACCOUNT_COUNT];
      const receiver = accounts[(i + 1) % ACCOUNT_COUNT];
      insert.run(`stream-${i}`, account, receiver, TOKEN, "1000", 1_700_000_000 + i);
    }
  });
  tx();
  console.log(`Seeded ${STREAM_COUNT} stream rows.`);
  return accounts;
}

async function run(): Promise<void> {
  const [account] = seed();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  console.log(
    `\nRunning GET /streams load test (${CONNECTIONS} concurrent connections, ${REQUESTS} requests, p99 < ${P99_BUDGET_MS}ms required)…\n`
  );

  const result = await autocannon({
    url: `http://127.0.0.1:${port}/streams?account=${account}`,
    connections: CONNECTIONS,
    amount: REQUESTS,
  });

  server.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
  }

  const { latency } = result;
  console.log(`  p50=${latency.p50}ms p99=${latency.p99}ms avg=${latency.average}ms max=${latency.max}ms`);
  console.log(
    `  ${result.requests.total} requests, ${result.non2xx} non-2xx, ${result.errors} errors, ${result.timeouts} timeouts`
  );

  if (result.non2xx > 0 || result.errors > 0 || result.timeouts > 0) {
    console.error("\nFAILED: GET /streams returned non-2xx responses, errors or timeouts under load.");
    process.exit(1);
  }

  if (latency.p99 >= P99_BUDGET_MS) {
    console.error(`\nFAILED: GET /streams p99=${latency.p99}ms exceeded the ${P99_BUDGET_MS}ms budget.`);
    process.exit(1);
  }

  console.log(`\nGET /streams within the ${P99_BUDGET_MS}ms p99 budget.`);
}

run().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
