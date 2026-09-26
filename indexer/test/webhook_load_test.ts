/**
 * Webhook delivery load test
 *
 *   10,000 synthetic events × 10 registered endpoints = 100,000 deliveries.
 *   The mock receiver answers 200 for 90% of them and 500 for a fixed 10%
 *   (every 10th event, so the failing set is deterministic and those
 *   deliveries exhaust all 10 attempts).
 *
 * Expected end state:
 *   - 90,000 deliveries `delivered`
 *   - 10,000 deliveries `dead_lettered`, each with attempt_count = 10
 *   -      0 deliveries left `pending` or `in_flight`
 *   - every attempt of a delivery carried the same X-VestFlow-Delivery-ID
 *
 * Run:  npm run test:webhook-load
 * Env:  WEBHOOK_LOAD_EVENTS, WEBHOOK_LOAD_ENDPOINTS, WEBHOOK_LOAD_CONCURRENCY
 *
 * The backoff unit is compressed (WEBHOOK_LOAD_BACKOFF_MS, default 1ms) so
 * the 10-attempt schedule completes in seconds instead of ~8.5 minutes; the
 * uncompressed 2^(n-1) second schedule is asserted by the unit tests.
 */

import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";

const EVENT_COUNT = Number(process.env.WEBHOOK_LOAD_EVENTS ?? "10000");
const ENDPOINT_COUNT = Number(process.env.WEBHOOK_LOAD_ENDPOINTS ?? "10");
const CONCURRENCY = Number(process.env.WEBHOOK_LOAD_CONCURRENCY ?? "200");
const BACKOFF_BASE_MS = Number(process.env.WEBHOOK_LOAD_BACKOFF_MS ?? "1");
/** Every Nth event fails permanently → exactly 10% of deliveries. */
const FAILURE_MODULUS = 10;

const DB_PATH = path.join(os.tmpdir(), `vestflow-webhook-load-${Date.now()}.db`);
process.env.INDEXER_DB_PATH_TESTNET = DB_PATH;
process.env.WEBHOOK_ALLOW_INSECURE_URLS = "true";
process.env.WEBHOOK_ENCRYPTION_KEY =
  process.env.WEBHOOK_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString("hex");

import { getDb } from "../src/db";
import { WebhookDeliveryWorker, fanOutEvent } from "../src/webhook-delivery";
import {
  countDeliveriesByStatus,
  createRegistration,
  markRegistrationVerified,
} from "../src/webhook-store";
import { encryptSecret, hashSecret, verifySignature } from "../src/webhooks";
import type { WebhookEventPayload } from "../src/webhooks";

const NETWORK = "testnet" as const;

function shouldFail(eventIndex: number): boolean {
  return eventIndex % FAILURE_MODULUS === 0;
}

function eventIndexOf(eventId: string): number {
  return Number(eventId.split("-")[0]);
}

interface Receiver {
  baseUrl: string;
  requests: number;
  /** delivery id → set of attempt numbers seen (checks ID stability). */
  attempts: Map<string, Set<string>>;
  signatureFailures: number;
  close(): Promise<void>;
}

async function startReceiver(secret: string): Promise<Receiver> {
  const state = {
    requests: 0,
    attempts: new Map<string, Set<string>>(),
    signatureFailures: 0,
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      state.requests++;

      const signature = String(req.headers["x-vestflow-signature"] ?? "");
      if (!verifySignature(secret, body, signature)) {
        state.signatureFailures++;
        res.writeHead(401);
        return res.end();
      }

      const deliveryId = String(req.headers["x-vestflow-delivery-id"] ?? "");
      const attempt = String(req.headers["x-vestflow-attempt"] ?? "");
      const seen = state.attempts.get(deliveryId) ?? new Set<string>();
      seen.add(attempt);
      state.attempts.set(deliveryId, seen);

      const eventId = String(req.headers["x-vestflow-event-id"] ?? "");
      res.writeHead(shouldFail(eventIndexOf(eventId)) ? 500 : 200);
      res.end();
    });
  });

  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get requests() {
      return state.requests;
    },
    get attempts() {
      return state.attempts;
    },
    get signatureFailures() {
      return state.signatureFailures;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function seedRegistrations(baseUrl: string, secret: string): string[] {
  const ids: string[] = [];
  for (let index = 0; index < ENDPOINT_COUNT; index++) {
    const id = crypto.randomUUID();
    createRegistration(
      {
        id,
        owner_address: "GLOADTEST",
        endpoint_url: `${baseUrl}/endpoint-${index}`,
        secret_hash: hashSecret(secret),
        secret_encrypted: encryptSecret(secret),
        event_types: ["*"],
        challenge: "seeded",
      },
      NETWORK
    );
    // The handshake itself is covered by the unit and API suites; this run
    // measures delivery throughput, so registrations start verified.
    markRegistrationVerified(id, NETWORK);
    ids.push(id);
  }
  return ids;
}

function synthesizeEvent(index: number): WebhookEventPayload {
  return {
    event_id: `${index}-1-0`,
    event_type: "claimed",
    network: NETWORK,
    ledger: index,
    ledger_closed_at: new Date().toISOString(),
    schedule_id: index % 500,
    proposal_id: null,
    grantor: null,
    beneficiary: "GBENEFICIARY",
    token: "CTOKEN",
    amount: String(1000 + index),
    created_amount: null,
  };
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const secret = crypto.randomBytes(32).toString("hex");
  const receiver = await startReceiver(secret);
  const expectedDeliveries = EVENT_COUNT * ENDPOINT_COUNT;
  const expectedDeadLettered =
    Math.floor((EVENT_COUNT - 1) / FAILURE_MODULUS + 1) * ENDPOINT_COUNT;
  const expectedDelivered = expectedDeliveries - expectedDeadLettered;

  console.log(
    `[load] ${EVENT_COUNT} events × ${ENDPOINT_COUNT} endpoints = ${expectedDeliveries} deliveries`
  );
  console.log(`[load] db: ${DB_PATH}`);

  seedRegistrations(receiver.baseUrl, secret);

  const fanOutStart = Date.now();
  let queued = 0;
  for (let index = 0; index < EVENT_COUNT; index++) {
    queued += fanOutEvent(synthesizeEvent(index), NETWORK);
  }
  const fanOutMs = Date.now() - fanOutStart;
  console.log(
    `[load] fan-out queued ${queued} deliveries in ${formatDuration(fanOutMs)} ` +
      `(${Math.round(queued / (fanOutMs / 1000))}/s)`
  );

  const worker = new WebhookDeliveryWorker({
    concurrency: CONCURRENCY,
    backoffBaseMs: BACKOFF_BASE_MS,
    network: NETWORK,
    pollIntervalMs: 50,
    onError: (message, error) => console.error(`[load] ${message}`, error),
  });

  const drainStart = Date.now();
  const timeoutMs = Number(process.env.WEBHOOK_LOAD_TIMEOUT_MS ?? "1800000");
  let lastLogged = 0;
  let timedOut = false;
  for (;;) {
    await worker.runOnce();
    const counts = countDeliveriesByStatus(NETWORK);
    if (counts.pending === 0 && counts.in_flight === 0) break;
    if (Date.now() - drainStart > timeoutMs) {
      timedOut = true;
      break;
    }

    const settled = counts.delivered + counts.dead_lettered + counts.failed;
    if (settled - lastLogged >= 10_000) {
      lastLogged = settled;
      console.log(
        `[load]   ${settled}/${expectedDeliveries} settled after ${formatDuration(
          Date.now() - drainStart
        )}`
      );
    }
  }
  const drainMs = Date.now() - drainStart;

  const counts = countDeliveriesByStatus(NETWORK);
  const db = getDb(NETWORK);
  const deadLetteredAttempts = db
    .prepare(
      `SELECT DISTINCT attempt_count FROM webhook_deliveries WHERE status = 'dead_lettered'`
    )
    .all() as { attempt_count: number }[];
  const deliveredAttempts = db
    .prepare(
      `SELECT MAX(attempt_count) AS max FROM webhook_deliveries WHERE status = 'delivered'`
    )
    .get() as { max: number };

  console.log("");
  console.log(`[load] drained in ${formatDuration(drainMs)}`);
  console.log(
    `[load] HTTP requests received: ${receiver.requests} ` +
      `(${Math.round(receiver.requests / (drainMs / 1000))}/s)`
  );
  console.log(`[load] status counts:`, counts);

  const failures: string[] = [];
  const expect = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };

  expect(!timedOut, `drain did not finish within ${formatDuration(timeoutMs)}`);

  expect(
    counts.delivered === expectedDelivered,
    `expected ${expectedDelivered} delivered, got ${counts.delivered}`
  );
  expect(
    counts.dead_lettered === expectedDeadLettered,
    `expected ${expectedDeadLettered} dead_lettered, got ${counts.dead_lettered}`
  );
  expect(counts.pending === 0, `expected 0 pending, got ${counts.pending}`);
  expect(counts.in_flight === 0, `expected 0 in_flight, got ${counts.in_flight}`);
  expect(counts.failed === 0, `expected 0 failed, got ${counts.failed}`);
  expect(
    deadLetteredAttempts.length === 1 && deadLetteredAttempts[0].attempt_count === 10,
    `dead-lettered deliveries must have exactly 10 attempts, got ${JSON.stringify(
      deadLetteredAttempts
    )}`
  );
  expect(
    deliveredAttempts.max === 1,
    `successful deliveries should need one attempt, got ${deliveredAttempts.max}`
  );
  expect(
    receiver.signatureFailures === 0,
    `${receiver.signatureFailures} requests carried an invalid signature`
  );
  expect(
    receiver.attempts.size === expectedDeliveries,
    `expected ${expectedDeliveries} distinct delivery IDs, got ${receiver.attempts.size}`
  );

  // A dead-lettered delivery must have reused one ID across all 10 attempts.
  const retried = [...receiver.attempts.values()].filter((set) => set.size > 1);
  expect(
    retried.length === expectedDeadLettered &&
      retried.every((set) => set.size === 10),
    `expected ${expectedDeadLettered} delivery IDs retried exactly 10 times, got ${retried.length}`
  );

  await receiver.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
  }

  if (failures.length > 0) {
    console.error("\n[load] FAILED");
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }

  console.log("\n[load] PASSED — all deliveries settled correctly");
  process.exit(0);
}

main().catch((error) => {
  console.error("[load] crashed:", error);
  process.exit(1);
});
