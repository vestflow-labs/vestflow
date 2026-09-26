#!/usr/bin/env tsx
// Load test for /api/schedules — 100 concurrent requests (#465)
//
// Uses autocannon to benchmark the schedules API endpoint.
//
// Usage:
//   npx tsx scripts/load-test-schedules.ts [--url http://localhost:3000]
//
// Prerequisites:
//   npm install --save-dev autocannon
//   The app must be running (npm run dev)

import autocannon from "autocannon";

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const BASE_URL = urlIdx >= 0 ? args[urlIdx + 1] : "http://localhost:3000";

const TARGET = `${BASE_URL}/api/schedules`;

interface AutocannonResult {
  title: string;
  url: string;
  requests: { average: number; total: number };
  latency: { average: number; p50: number; p99: number };
  throughput: { average: number };
  errors: number;
  duration: number;
}

async function run() {
  console.log(`\n🏋️  Load testing: ${TARGET}`);
  console.log(`   100 concurrent connections, 10s duration\n`);

  const instance = autocannon({
    url: TARGET,
    connections: 100,
    duration: 10,
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  // Print progress.
  autocannon.track(instance, { renderProgressBar: false });

  return new Promise<AutocannonResult>((resolve, reject) => {
    instance.on("done", (result: AutocannonResult) => {
      resolve(result);
    });
    instance.on("error", reject);
  });
}

run()
  .then((result) => {
    console.log("\n── Results ──────────────────────────────────────────");
    console.log(`  Requests/sec (avg): ${result.requests.average}`);
    console.log(`  Total requests:     ${result.requests.total}`);
    console.log(`  Latency avg:        ${result.latency.average}ms`);
    console.log(`  Latency p50:        ${result.latency.p50}ms`);
    console.log(`  Latency p99:        ${result.latency.p99}ms`);
    console.log(`  Throughput avg:     ${(result.throughput.average / 1024 / 1024).toFixed(2)} MB/s`);
    console.log(`  Errors:             ${result.errors}`);
    console.log(`  Duration:           ${result.duration}s`);
    console.log("────────────────────────────────────────────────────\n");

    // Fail CI if error rate exceeds 1%.
    if (result.errors > result.requests.total * 0.01) {
      console.error(`❌ Error rate ${(result.errors / result.requests.total * 100).toFixed(1)}% exceeds 1% threshold`);
      process.exit(1);
    }

    // Fail CI if p99 latency exceeds 2 seconds.
    if (result.latency.p99 > 2000) {
      console.error(`❌ p99 latency ${result.latency.p99}ms exceeds 2000ms threshold`);
      process.exit(1);
    }

    console.log("✅ Load test passed");
  })
  .catch((err) => {
    console.error("Load test failed:", err);
    process.exit(1);
  });
