/**
 * Delivery worker: fan-out, the retry state machine on a mocked clock,
 * dead-lettering, crash recovery and the handshake.
 *
 * The database modules are imported dynamically so the temp SQLite path is
 * in the environment before `db.ts` opens a connection.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const DB_PATH = path.join(
  os.tmpdir(),
  `vestflow-webhook-delivery-${process.pid}-${Date.now()}.db`
);
process.env.INDEXER_DB_PATH_TESTNET = DB_PATH;
process.env.WEBHOOK_ALLOW_INSECURE_URLS = "true";

const KEY = crypto.randomBytes(32);

const { getDb } = await import("../src/db");
const store = await import("../src/webhook-store");
const { WebhookDeliveryWorker, fanOutEvent } = await import(
  "../src/webhook-delivery"
);
const {
  RETRY_SCHEDULE_SECONDS,
  MAX_ATTEMPTS,
  encryptSecret,
  hashSecret,
  verifySignature,
  computeSignature,
} = await import("../src/webhooks");
import type { WebhookEventPayload } from "../src/webhooks";

// ── Fixtures ──────────────────────────────────────────────────────────

// The store stamps rows with the real clock, so the fixture clock starts
// there too; every assertion below is on deltas we advance explicitly.
let clockMs = Date.now();

const nowSeconds = () => Math.floor(clockMs / 1000);
const advanceSeconds = (seconds: number) => {
  clockMs += seconds * 1000;
};

interface MockResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

function mockResponse(
  status: number,
  headers: Record<string, string> = {},
  body = ""
): MockResponse {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

function createRegistration(
  options: {
    eventTypes?: string[];
    verified?: boolean;
    url?: string;
    secret?: string;
  } = {}
) {
  const secret = options.secret ?? "s".repeat(64);
  const id = crypto.randomUUID();
  store.createRegistration({
    id,
    owner_address: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
    endpoint_url: options.url ?? "https://hooks.example.com/vestflow",
    secret_hash: hashSecret(secret),
    secret_encrypted: encryptSecret(secret, KEY),
    event_types: options.eventTypes ?? ["*"],
    challenge: "challenge-token",
  });
  if (options.verified !== false) store.markRegistrationVerified(id);
  return { registration: store.getRegistration(id)!, secret };
}

function eventPayload(overrides: Partial<WebhookEventPayload> = {}): WebhookEventPayload {
  return {
    event_id: "1000-1-0",
    event_type: "claimed",
    network: "testnet",
    ledger: 1000,
    ledger_closed_at: "2026-08-22T00:00:00Z",
    schedule_id: 7,
    proposal_id: null,
    grantor: null,
    beneficiary: "GBENEFICIARY",
    token: "CTOKEN",
    amount: "1000000",
    created_amount: null,
    ...overrides,
  };
}

function makeWorker(fetchImpl: (...args: never[]) => unknown, concurrency = 4) {
  // Seeding fixtures (scrypt hashing) can outrun the snapshot taken in
  // beforeEach; re-sync so rows stamped by the store are already due.
  clockMs = Math.max(clockMs, Date.now());
  return new WebhookDeliveryWorker({
    concurrency,
    network: "testnet",
    encryptionKey: KEY,
    now: () => clockMs,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchImpl: fetchImpl as any,
    onError: () => undefined,
  });
}

beforeEach(() => {
  clockMs = Date.now();
  getDb("testnet").exec(
    "DELETE FROM webhook_deliveries; DELETE FROM webhook_registrations;"
  );
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
  }
});

// ── Fan-out ───────────────────────────────────────────────────────────

describe("fan-out", () => {
  it("queues one delivery per subscribed endpoint without any I/O", () => {
    createRegistration({ eventTypes: ["claimed"] });
    createRegistration({ eventTypes: ["*"] });
    createRegistration({ eventTypes: ["revoked"] });

    expect(fanOutEvent(eventPayload(), "testnet")).toBe(2);
    expect(store.countDeliveriesByStatus("testnet").pending).toBe(2);
  });

  it("is idempotent when the same event is indexed twice", () => {
    createRegistration();
    expect(fanOutEvent(eventPayload(), "testnet")).toBe(1);
    expect(fanOutEvent(eventPayload(), "testnet")).toBe(0);
    expect(store.countDeliveriesByStatus("testnet").pending).toBe(1);
  });

  it("never queues anything for an endpoint that failed the handshake", () => {
    createRegistration({ verified: false });
    expect(fanOutEvent(eventPayload(), "testnet")).toBe(0);
    expect(store.countDeliveriesByStatus("testnet").pending).toBe(0);
  });

  it("skips disabled registrations", () => {
    const { registration } = createRegistration();
    store.disableRegistration(registration.id);
    expect(fanOutEvent(eventPayload(), "testnet")).toBe(0);
  });
});

// ── Successful delivery ───────────────────────────────────────────────

describe("delivery", () => {
  it("signs the request and marks the delivery delivered on 2xx", async () => {
    const { registration, secret } = createRegistration();
    fanOutEvent(eventPayload(), "testnet");

    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200));
    await makeWorker(fetchMock).runOnce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;

    expect(url).toBe(registration.endpoint_url);
    expect(init.method).toBe("POST");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-VestFlow-Event"]).toBe("claimed");
    expect(headers["X-VestFlow-Event-ID"]).toBe("1000-1-0");
    expect(headers["X-VestFlow-Attempt"]).toBe("1");
    expect(
      verifySignature(secret, init.body as string, headers["X-VestFlow-Signature"], {
        nowSeconds: nowSeconds(),
      })
    ).toBe(true);
    expect(JSON.parse(init.body as string)).toMatchObject({
      event_id: "1000-1-0",
      schedule_id: 7,
    });

    const [delivery] = store.listDeliveries({ registrationId: registration.id });
    expect(delivery.status).toBe("delivered");
    expect(delivery.delivered_at).toBe(nowSeconds());
    expect(delivery.attempt_count).toBe(1);
    expect(delivery.last_status_code).toBe(200);
    expect(headers["X-VestFlow-Delivery-ID"]).toBe(delivery.id);
  });

  it("marks the delivery failed when the endpoint answers 410 Gone", async () => {
    const { registration } = createRegistration();
    fanOutEvent(eventPayload(), "testnet");

    const fetchMock = vi.fn().mockResolvedValue(mockResponse(410));
    await makeWorker(fetchMock).runOnce();

    const [delivery] = store.listDeliveries({ registrationId: registration.id });
    expect(delivery.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails a delivery whose registration was disabled after queueing", async () => {
    const { registration } = createRegistration();
    fanOutEvent(eventPayload(), "testnet");
    store.disableRegistration(registration.id);

    const fetchMock = vi.fn();
    await makeWorker(fetchMock).runOnce();

    expect(fetchMock).not.toHaveBeenCalled();
    const [delivery] = store.listDeliveries({ registrationId: registration.id });
    expect(delivery.status).toBe("failed");
    expect(delivery.last_error).toMatch(/disabled or unverified/);
  });

  it("returns deliveries stranded in_flight by a crashed worker to the queue", async () => {
    const { registration } = createRegistration();
    fanOutEvent(eventPayload(), "testnet");

    const [queued] = store.listDeliveries({ registrationId: registration.id });
    getDb("testnet")
      .prepare(
        "UPDATE webhook_deliveries SET status = 'in_flight', claimed_at = ? WHERE id = ?"
      )
      .run(nowSeconds() - 600, queued.id);
    expect(store.countDeliveriesByStatus("testnet").in_flight).toBe(1);

    const fetchMock = vi.fn().mockResolvedValue(mockResponse(204));
    await makeWorker(fetchMock).runOnce();

    const [delivery] = store.listDeliveries({ registrationId: registration.id });
    expect(delivery.status).toBe("delivered");
    expect(store.countDeliveriesByStatus("testnet").in_flight).toBe(0);
  });
});

// ── Retry state machine ───────────────────────────────────────────────

describe("retry, backoff and dead-lettering", () => {
  it("retries with 2^(n-1) second backoff and dead-letters at attempt 10", async () => {
    const { registration } = createRegistration();
    fanOutEvent(eventPayload(), "testnet");

    const fetchMock = vi.fn().mockResolvedValue(mockResponse(500));
    const worker = makeWorker(fetchMock);
    const deliveryIds = new Set<string>();
    const observedDelays: number[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const attemptAt = nowSeconds();
      await worker.runOnce();

      const [delivery] = store.listDeliveries({ registrationId: registration.id });
      deliveryIds.add(
        (fetchMock.mock.calls[attempt - 1][1].headers as Record<string, string>)[
          "X-VestFlow-Delivery-ID"
        ]
      );

      expect(fetchMock).toHaveBeenCalledTimes(attempt);
      expect(delivery.attempt_count).toBe(attempt);
      expect(delivery.last_status_code).toBe(500);

      if (attempt < MAX_ATTEMPTS) {
        expect(delivery.status).toBe("pending");
        observedDelays.push(delivery.next_attempt_at - attemptAt);
        // Nothing is due until the backoff elapses.
        await worker.runOnce();
        expect(fetchMock).toHaveBeenCalledTimes(attempt);
        advanceSeconds(delivery.next_attempt_at - nowSeconds());
      } else {
        expect(delivery.status).toBe("dead_lettered");
        expect(delivery.dead_lettered_at).toBe(nowSeconds());
      }
    }

    expect(observedDelays).toEqual([...RETRY_SCHEDULE_SECONDS]);

    // Dead-lettered deliveries are never picked up again…
    advanceSeconds(100_000);
    await worker.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);

    // …and every attempt carried the same delivery ID.
    expect(deliveryIds.size).toBe(1);
    const [delivery] = store.listDeliveries({ registrationId: registration.id });
    expect([...deliveryIds][0]).toBe(delivery.id);
  });

  it("treats a request timeout like any other retryable failure", async () => {
    const { registration } = createRegistration();
    fanOutEvent(eventPayload(), "testnet");

    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    await makeWorker(fetchMock).runOnce();

    const [delivery] = store.listDeliveries({ registrationId: registration.id });
    expect(delivery.status).toBe("pending");
    expect(delivery.attempt_count).toBe(1);
    expect(delivery.last_error).toBe("request timed out");
    expect(delivery.next_attempt_at).toBe(nowSeconds() + 1);
  });

  it("recovers when an endpoint starts working again mid-schedule", async () => {
    const { registration } = createRegistration();
    fanOutEvent(eventPayload(), "testnet");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValue(mockResponse(200));
    const worker = makeWorker(fetchMock);

    await worker.runOnce();
    advanceSeconds(1);
    await worker.runOnce();
    advanceSeconds(2);
    await worker.runOnce();

    const [delivery] = store.listDeliveries({ registrationId: registration.id });
    expect(delivery.status).toBe("delivered");
    expect(delivery.attempt_count).toBe(3);
    expect(delivery.last_error).toBeNull();
  });

  it("requeues a dead-lettered delivery with the same ID on manual retry", async () => {
    const { registration } = createRegistration();
    fanOutEvent(eventPayload(), "testnet");

    const fetchMock = vi.fn().mockResolvedValue(mockResponse(500));
    const worker = makeWorker(fetchMock);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await worker.runOnce();
      const [current] = store.listDeliveries({ registrationId: registration.id });
      advanceSeconds(Math.max(current.next_attempt_at - nowSeconds(), 0));
    }

    const [dead] = store.listDeliveries({ registrationId: registration.id });
    expect(dead.status).toBe("dead_lettered");

    expect(store.requeueDelivery(dead.id, nowSeconds())).toBe(true);
    fetchMock.mockResolvedValue(mockResponse(200));
    await worker.runOnce();

    const [retried] = store.listDeliveries({ registrationId: registration.id });
    expect(retried.id).toBe(dead.id);
    expect(retried.status).toBe("delivered");
    expect(retried.dead_lettered_at).toBeNull();
  });

  it("filters delivery history by status", async () => {
    const { registration } = createRegistration();
    fanOutEvent(eventPayload({ event_id: "1-1-0" }), "testnet");
    fanOutEvent(eventPayload({ event_id: "2-1-0" }), "testnet");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200))
      .mockResolvedValue(mockResponse(500));
    await makeWorker(fetchMock, 1).runOnce();

    const delivered = store.listDeliveries({
      registrationId: registration.id,
      status: "delivered",
    });
    const pending = store.listDeliveries({
      registrationId: registration.id,
      status: "pending",
    });

    expect(delivered).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(store.listDeliveries({ registrationId: registration.id })).toHaveLength(2);
  });
});

// ── Handshake ─────────────────────────────────────────────────────────

describe("handshake", () => {
  function echoingFetch(secret: string, status = 200) {
    return vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      const sent = init.headers["X-VestFlow-Signature"];
      const timestamp = Number(sent.split(",")[0].slice(2));
      const echo = `t=${timestamp},v1=${computeSignature(secret, init.body, timestamp)}`;
      return mockResponse(status, { "X-VestFlow-Signature": echo });
    });
  }

  it("verifies an endpoint that echoes the challenge signature", async () => {
    const { registration, secret } = createRegistration({ verified: false });

    const result = await makeWorker(echoingFetch(secret)).verifyRegistration(
      registration.id
    );

    expect(result.verified).toBe(true);
    const stored = store.getRegistration(registration.id)!;
    expect(stored.verified_at).not.toBeNull();
    expect(stored.challenge).toBeNull();

    // Events now flow to the endpoint.
    expect(fanOutEvent(eventPayload(), "testnet")).toBe(1);
  });

  it("accepts the echo in a JSON body as well as the header", async () => {
    const { registration, secret } = createRegistration({ verified: false });

    const fetchMock = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      const timestamp = Number(init.headers["X-VestFlow-Signature"].split(",")[0].slice(2));
      return mockResponse(
        200,
        {},
        JSON.stringify({
          signature: `t=${timestamp},v1=${computeSignature(secret, init.body, timestamp)}`,
        })
      );
    });

    const result = await makeWorker(fetchMock).verifyRegistration(registration.id);
    expect(result.verified).toBe(true);
  });

  it("rejects and deletes a rogue endpoint that cannot sign the challenge", async () => {
    const { registration } = createRegistration({ verified: false });

    const result = await makeWorker(
      echoingFetch("an-attacker-guess")
    ).verifyRegistration(registration.id);

    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/signature mismatch/);
    expect(store.getRegistration(registration.id)).toBeNull();
    expect(fanOutEvent(eventPayload(), "testnet")).toBe(0);
  });

  it("rejects an endpoint that answers without the echo, or with a non-200", async () => {
    const silent = createRegistration({ verified: false });
    const silentResult = await makeWorker(
      vi.fn().mockResolvedValue(mockResponse(200))
    ).verifyRegistration(silent.registration.id);
    expect(silentResult.verified).toBe(false);
    expect(silentResult.error).toMatch(/did not echo/);

    const rejecting = createRegistration({ verified: false });
    const rejectingResult = await makeWorker(
      echoingFetch(rejecting.secret, 202)
    ).verifyRegistration(rejecting.registration.id);
    expect(rejectingResult.verified).toBe(false);
    expect(rejectingResult.error).toMatch(/expected 200/);
    expect(store.getRegistration(rejecting.registration.id)).toBeNull();
  });

  it("deletes the registration when the endpoint is unreachable", async () => {
    const { registration } = createRegistration({ verified: false });

    const result = await makeWorker(
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    ).verifyRegistration(registration.id);

    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(store.getRegistration(registration.id)).toBeNull();
  });
});

// ── Worker pool ───────────────────────────────────────────────────────

describe("worker pool", () => {
  it("never exceeds its configured concurrency", async () => {
    for (let index = 0; index < 12; index++) {
      const { registration } = createRegistration();
      store.enqueueDelivery(
        {
          id: crypto.randomUUID(),
          registration_id: registration.id,
          event_id: `evt-${index}`,
          event_type: "claimed",
          payload: JSON.stringify(eventPayload({ event_id: `evt-${index}` })),
        },
        "testnet"
      );
    }

    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return mockResponse(200);
    });

    await makeWorker(fetchMock, 3).runOnce();

    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(3);
    expect(store.countDeliveriesByStatus("testnet").delivered).toBe(12);
  });

  it("drains the queue from start() and stops cleanly", async () => {
    createRegistration();
    fanOutEvent(eventPayload(), "testnet");

    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200));
    const worker = new WebhookDeliveryWorker({
      network: "testnet",
      encryptionKey: KEY,
      pollIntervalMs: 5,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchMock as any,
      onError: () => undefined,
    });

    worker.start();
    await vi.waitFor(() =>
      expect(store.countDeliveriesByStatus("testnet").delivered).toBe(1)
    );
    await worker.stop();

    expect(worker.activeCount).toBe(0);
  });
});
