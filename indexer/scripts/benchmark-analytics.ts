#!/usr/bin/env ts-node
/**
 * Analytics performance benchmark (#565 acceptance criteria).
 *
 * Seeds 10,000 schedules × 100 days of pre-materialized snapshot rows
 * directly into the snapshot tables (bypassing event replay — this
 * benchmarks query performance, not ingestion throughput), starts the
 * query server on an ephemeral port, then hits each /analytics/* endpoint
 * 100 times with autocannon and asserts p99 < 100ms.
 *
 * Usage:
 *   INDEXER_DB_PATH=/tmp/bench.db npx ts-node scripts/benchmark-analytics.ts
 */

import autocannon from "autocannon";
import { getDb } from "../src/db";
import { createServer } from "../src/server";

const SCHEDULE_COUNT = Number(process.env.BENCH_SCHEDULES ?? 10_000);
const DAY_COUNT = Number(process.env.BENCH_DAYS ?? 100);
const P99_BUDGET_MS = 100;
const TOKEN = "CBENCHMARKTOKEN0000000000000000000000000000000000000000";
const GRANTOR = "GBENCHMARKGRANTOR000000000000000000000000000000000000000";

function dayString(offset: number): string {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function seed(): void {
  const db = getDb();
  console.log(`Seeding ${SCHEDULE_COUNT} schedules × ${DAY_COUNT} days…`);

  const insertSnapshot = db.prepare(
    `INSERT OR REPLACE INTO schedule_daily_snapshots
      (schedule_id, day, total_vested_stroops, total_claimed_stroops, claimable_stroops, locked_stroops)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertTvl = db.prepare(
    `INSERT OR REPLACE INTO token_daily_tvl
      (token_address, day, total_locked_stroops, active_schedule_count)
     VALUES (?, ?, ?, ?)`
  );
  const insertGrantorStats = db.prepare(
    `INSERT OR REPLACE INTO grantor_daily_stats
      (grantor_address, day, active_schedule_count, total_distributed_stroops)
     VALUES (?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (let day = 0; day < DAY_COUNT; day++) {
      const dayStr = dayString(day);
      insertTvl.run(TOKEN, dayStr, String(SCHEDULE_COUNT * 1_000_000), SCHEDULE_COUNT);
      insertGrantorStats.run(GRANTOR, dayStr, SCHEDULE_COUNT, String(SCHEDULE_COUNT * 500_000));
      for (let s = 0; s < SCHEDULE_COUNT; s++) {
        insertSnapshot.run(s, dayStr, "1000000", "500000", "200000", "300000");
      }
    }
  });
  tx();
  console.log(`Seeded ${SCHEDULE_COUNT * DAY_COUNT} schedule-day rows.`);
}

async function benchmarkEndpoint(url: string): Promise<number> {
  const result = await autocannon({
    url,
    connections: 10,
    amount: 100,
  });
  const p99 = result.latency.p99;
  console.log(`  ${url} → p99=${p99}ms avg=${result.latency.average}ms`);
  return p99;
}

async function run(): Promise<void> {
  seed();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://localhost:${port}`;

  console.log("\nRunning benchmarks (100 requests each, p99 < 100ms required)…\n");

  const results = {
    tvl: await benchmarkEndpoint(`${base}/analytics/tvl?token=${TOKEN}&from=${dayString(0)}&to=${dayString(DAY_COUNT - 1)}`),
    tvlCumulative: await benchmarkEndpoint(
      `${base}/analytics/tvl?token=${TOKEN}&from=${dayString(0)}&to=${dayString(DAY_COUNT - 1)}&cumulative=true`
    ),
    scheduleHistory: await benchmarkEndpoint(
      `${base}/analytics/schedules/1/history?from=${dayString(0)}&to=${dayString(DAY_COUNT - 1)}`
    ),
    grantorSummary: await benchmarkEndpoint(`${base}/analytics/grantors/${GRANTOR}/summary`),
  };

  server.close();

  const failures = Object.entries(results).filter(([, p99]) => p99 >= P99_BUDGET_MS);
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.map(([name, p99]) => `${name}=${p99}ms`).join(", ")} exceeded ${P99_BUDGET_MS}ms budget.`);
    process.exit(1);
  }

  console.log(`\nAll endpoints within the ${P99_BUDGET_MS}ms p99 budget.`);
}

run().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
