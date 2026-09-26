/**
 * Webhook management API, exercised over real HTTP against the indexer
 * query server, with a real subscriber endpoint performing the handshake.
 */

import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const DB_PATH = path.join(
  os.tmpdir(),
  `vestflow-webhook-api-${process.pid}-${Date.now()}.db`
);
process.env.INDEXER_DB_PATH_TESTNET = DB_PATH;
process.env.WEBHOOK_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.WEBHOOK_ALLOW_INSECURE_URLS = "true";
process.env.JWT_SECRET = "test-jwt-secret";

const { getDb } = await import("../src/db");
const store = await import("../src/webhook-store");
const { fanOutEvent } = await import("../src/webhook-delivery");
const { computeSignature } = await import("../src/webhooks");
const { createServer } = await import("../src/server");
import type { WebhookEventPayload } from "../src/webhooks";

const OWNER = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const OTHER_OWNER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

// ── Test doubles ──────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mints the same HS256 token the app's wallet login issues. */
function mintToken(subject: string, expiresInSeconds = 3600): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({ sub: subject, iat: now, exp: now + expiresInSeconds })
  );
  const signature = crypto
    .createHmac("sha256", process.env.JWT_SECRET as string)
    .update(`${header}.${payload}`)
    .digest();
  return `${header}.${payload}.${base64url(signature)}`;
}

interface Subscriber {
  url: string;
  close(): Promise<void>;
  /** Secret the endpoint signs with; set before the handshake runs. */
  secret: string;
  /** Status code returned by the handshake. */
  handshakeStatus: number;
  /** Status code returned for every non-handshake request. */
  eventStatus: number;
  received: { deliveryId: string | undefined; body: string }[];
}

/** A subscriber that echoes the handshake signature, like a real one would. */
async function startSubscriber(secret: string): Promise<Subscriber> {
  const state: Partial<Subscriber> = {
    secret,
    handshakeStatus: 200,
    eventStatus: 200,
    received: [],
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const signature = String(req.headers["x-vestflow-signature"] ?? "");
      const timestamp = Number(signature.split(",")[0]?.slice(2));

      if (req.headers["x-vestflow-event"] === "webhook.handshake") {
        const echo = `t=${timestamp},v1=${computeSignature(
          state.secret as string,
          body,
          timestamp
        )}`;
        res.writeHead(state.handshakeStatus as number, {
          "X-VestFlow-Signature": echo,
        });
        return res.end();
      }

      state.received?.push({
        deliveryId: req.headers["x-vestflow-delivery-id"] as string | undefined,
        body,
      });
      res.writeHead(state.eventStatus as number);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  state.url = `http://127.0.0.1:${port}/hook`;
  state.close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  return state as Subscriber;
}

let baseUrl = "";
let apiServer: http.Server;

/** Decoded JSON response body — assertions index into it freely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = any;

async function api(
  pathname: string,
  options: { method?: string; token?: string | null; body?: unknown } = {}
): Promise<{ status: number; body: JsonBody }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = options.token === undefined ? mintToken(OWNER) : options.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function eventPayload(
  overrides: Partial<WebhookEventPayload> = {}
): WebhookEventPayload {
  return {
    event_id: "2000-1-0",
    event_type: "claimed",
    network: "testnet",
    ledger: 2000,
    ledger_closed_at: "2026-08-22T00:00:00Z",
    schedule_id: 3,
    proposal_id: null,
    grantor: null,
    beneficiary: "GBENEFICIARY",
    token: "CTOKEN",
    amount: "500",
    created_amount: null,
    ...overrides,
  };
}

beforeAll(async () => {
  apiServer = createServer();
  await new Promise<void>((resolve) =>
    apiServer.listen(0, "127.0.0.1", resolve)
  );
  baseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
  }
});

beforeEach(() => {
  getDb("testnet").exec(
    "DELETE FROM webhook_deliveries; DELETE FROM webhook_registrations;"
  );
});

// ── Auth ──────────────────────────────────────────────────────────────

describe("authentication", () => {
  it("rejects requests without a bearer token", async () => {
    const response = await api("/webhooks", { token: null });
    expect(response.status).toBe(401);
  });

  it("rejects a forged or expired token", async () => {
    expect((await api("/webhooks", { token: "not-a-jwt" })).status).toBe(401);

    const forged = mintToken(OWNER).split(".");
    forged[2] = base64url(crypto.randomBytes(32));
    expect((await api("/webhooks", { token: forged.join(".") })).status).toBe(401);

    expect((await api("/webhooks", { token: mintToken(OWNER, -60) })).status).toBe(
      401
    );
  });
});

// ── Registration & handshake ──────────────────────────────────────────

describe("POST /webhooks", () => {
  it("registers an endpoint, returns the secret once and withholds events until verified", async () => {
    const subscriber = await startSubscriber("unused");
    try {
      const response = await api("/webhooks", {
        method: "POST",
        body: { endpoint_url: subscriber.url, event_types: ["claimed"] },
      });

      expect(response.status).toBe(201);
      expect(response.body.registration_id).toBeTruthy();
      expect(response.body.challenge).toHaveLength(48);
      expect(response.body.secret).toHaveLength(64);
      expect(response.body.verified).toBe(false);

      // Unverified: a rogue registration receives nothing.
      expect(fanOutEvent(eventPayload(), "testnet")).toBe(0);

      const stored = store.getRegistration(response.body.registration_id)!;
      expect(stored.secret_hash).not.toContain(response.body.secret);
      expect(stored.secret_encrypted).not.toContain(response.body.secret);
      expect(stored.owner_address).toBe(OWNER);
    } finally {
      await subscriber.close();
    }
  });

  it("verifies immediately when the operator supplies the shared secret", async () => {
    const secret = crypto.randomBytes(32).toString("hex");
    const subscriber = await startSubscriber(secret);
    try {
      const response = await api("/webhooks", {
        method: "POST",
        body: { endpoint_url: subscriber.url, event_types: ["*"], secret },
      });

      expect(response.status).toBe(201);
      expect(response.body.verified).toBe(true);
      expect(response.body.registration.verified).toBe(true);
      expect(fanOutEvent(eventPayload(), "testnet")).toBe(1);
    } finally {
      await subscriber.close();
    }
  });

  it("discards a registration whose endpoint cannot sign the challenge", async () => {
    const subscriber = await startSubscriber("the-wrong-secret");
    try {
      const response = await api("/webhooks", {
        method: "POST",
        body: {
          endpoint_url: subscriber.url,
          event_types: ["*"],
          secret: crypto.randomBytes(32).toString("hex"),
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Handshake failed/);
      expect((await api("/webhooks")).body.registrations).toHaveLength(0);
    } finally {
      await subscriber.close();
    }
  });

  it("validates the endpoint URL, event types and secret length", async () => {
    const badUrl = await api("/webhooks", {
      method: "POST",
      body: { endpoint_url: "ftp://example.com/x", event_types: ["*"] },
    });
    expect(badUrl.status).toBe(400);

    const badEvents = await api("/webhooks", {
      method: "POST",
      body: { endpoint_url: "https://hooks.example.com/x", event_types: ["nope"] },
    });
    expect(badEvents.status).toBe(400);
    expect(badEvents.body.error).toMatch(/Unknown event type/);

    const shortSecret = await api("/webhooks", {
      method: "POST",
      body: {
        endpoint_url: "https://hooks.example.com/x",
        event_types: ["*"],
        secret: "short",
      },
    });
    expect(shortSecret.status).toBe(400);

    const missingUrl = await api("/webhooks", {
      method: "POST",
      body: { event_types: ["*"] },
    });
    expect(missingUrl.status).toBe(400);
  });
});

describe("POST /webhooks/:id/verify", () => {
  it("runs the handshake on demand and starts the event flow", async () => {
    const subscriber = await startSubscriber("placeholder");
    try {
      const registered = await api("/webhooks", {
        method: "POST",
        body: { endpoint_url: subscriber.url, event_types: ["claimed"] },
      });
      // The operator configures the returned secret on their endpoint…
      subscriber.secret = registered.body.secret;

      const verified = await api(
        `/webhooks/${registered.body.registration_id}/verify`,
        { method: "POST" }
      );

      expect(verified.status).toBe(200);
      expect(verified.body.verified).toBe(true);
      expect(fanOutEvent(eventPayload(), "testnet")).toBe(1);

      // Verifying again is a no-op, not an error.
      const again = await api(
        `/webhooks/${registered.body.registration_id}/verify`,
        { method: "POST" }
      );
      expect(again.status).toBe(200);
      expect(again.body.verified).toBe(true);
    } finally {
      await subscriber.close();
    }
  });

  it("deletes the registration when the handshake is refused", async () => {
    const subscriber = await startSubscriber("placeholder");
    subscriber.handshakeStatus = 500;
    try {
      const registered = await api("/webhooks", {
        method: "POST",
        body: { endpoint_url: subscriber.url, event_types: ["*"] },
      });
      subscriber.secret = registered.body.secret;

      const verified = await api(
        `/webhooks/${registered.body.registration_id}/verify`,
        { method: "POST" }
      );

      expect(verified.status).toBe(400);
      expect(verified.body.verified).toBe(false);
      expect(store.getRegistration(registered.body.registration_id)).toBeNull();
    } finally {
      await subscriber.close();
    }
  });
});

// ── Lifecycle & history ───────────────────────────────────────────────

describe("registration lifecycle", () => {
  async function registerVerified(eventTypes: string[] = ["*"]) {
    const secret = crypto.randomBytes(32).toString("hex");
    const subscriber = await startSubscriber(secret);
    const response = await api("/webhooks", {
      method: "POST",
      body: { endpoint_url: subscriber.url, event_types: eventTypes, secret },
    });
    return { subscriber, id: response.body.registration_id as string, secret };
  }

  it("lists and reads back only the caller's registrations", async () => {
    const { subscriber, id } = await registerVerified();
    try {
      const list = await api("/webhooks");
      expect(list.body.registrations).toHaveLength(1);
      expect(list.body.registrations[0]).toMatchObject({ id, verified: true });
      expect(list.body.registrations[0].secret).toBeUndefined();

      const mine = await api(`/webhooks/${id}`);
      expect(mine.status).toBe(200);

      const theirs = await api(`/webhooks/${id}`, { token: mintToken(OTHER_OWNER) });
      expect(theirs.status).toBe(404);
      expect((await api("/webhooks", { token: mintToken(OTHER_OWNER) })).body
        .registrations).toHaveLength(0);
    } finally {
      await subscriber.close();
    }
  });

  it("disables a registration on DELETE and stops the event flow", async () => {
    const { subscriber, id } = await registerVerified();
    try {
      expect(fanOutEvent(eventPayload({ event_id: "1-1-0" }), "testnet")).toBe(1);

      const deleted = await api(`/webhooks/${id}`, { method: "DELETE" });
      expect(deleted.status).toBe(204);

      expect(fanOutEvent(eventPayload({ event_id: "2-1-0" }), "testnet")).toBe(0);
      expect(store.getRegistration(id)?.disabled_at).toBeTruthy();

      // History survives the disable.
      const history = await api(`/webhooks/${id}/deliveries`);
      expect(history.body.deliveries).toHaveLength(1);
    } finally {
      await subscriber.close();
    }
  });

  it("returns delivery history with status filtering", async () => {
    const { subscriber, id } = await registerVerified();
    try {
      fanOutEvent(eventPayload({ event_id: "10-1-0" }), "testnet");
      fanOutEvent(eventPayload({ event_id: "11-1-0" }), "testnet");
      const [first] = store.listDeliveries({ registrationId: id });
      getDb("testnet")
        .prepare("UPDATE webhook_deliveries SET status = 'delivered' WHERE id = ?")
        .run(first.id);

      const all = await api(`/webhooks/${id}/deliveries`);
      expect(all.status).toBe(200);
      expect(all.body.deliveries).toHaveLength(2);
      expect(all.body.deliveries[0]).toMatchObject({
        registration_id: id,
        event_type: "claimed",
      });
      expect(all.body.deliveries[0].payload.event_id).toBeTruthy();

      const delivered = await api(`/webhooks/${id}/deliveries?status=delivered`);
      expect(delivered.body.deliveries).toHaveLength(1);
      expect(delivered.body.deliveries[0].id).toBe(first.id);

      const limited = await api(`/webhooks/${id}/deliveries?limit=1`);
      expect(limited.body.deliveries).toHaveLength(1);

      const invalid = await api(`/webhooks/${id}/deliveries?status=nonsense`);
      expect(invalid.status).toBe(400);

      const theirs = await api(`/webhooks/${id}/deliveries`, {
        token: mintToken(OTHER_OWNER),
      });
      expect(theirs.status).toBe(404);
    } finally {
      await subscriber.close();
    }
  });

  it("requeues a dead-lettered delivery and refuses anything else", async () => {
    const { subscriber, id } = await registerVerified();
    try {
      fanOutEvent(eventPayload({ event_id: "20-1-0" }), "testnet");
      const [delivery] = store.listDeliveries({ registrationId: id });

      const pendingRetry = await api(
        `/webhooks/${id}/deliveries/${delivery.id}/retry`,
        { method: "POST" }
      );
      expect(pendingRetry.status).toBe(409);

      getDb("testnet")
        .prepare(
          `UPDATE webhook_deliveries
           SET status = 'dead_lettered', attempt_count = 10, dead_lettered_at = 1
           WHERE id = ?`
        )
        .run(delivery.id);

      const retried = await api(
        `/webhooks/${id}/deliveries/${delivery.id}/retry`,
        { method: "POST" }
      );
      expect(retried.status).toBe(202);
      expect(retried.body.delivery).toMatchObject({
        id: delivery.id,
        status: "pending",
        attempt_count: 0,
        dead_lettered_at: null,
      });

      const unknown = await api(
        `/webhooks/${id}/deliveries/${crypto.randomUUID()}/retry`,
        { method: "POST" }
      );
      expect(unknown.status).toBe(404);
    } finally {
      await subscriber.close();
    }
  });
});

describe("POST /webhooks/test", () => {
  async function registerVerified(token = mintToken(OWNER)) {
    const secret = crypto.randomBytes(32).toString("hex");
    const subscriber = await startSubscriber(secret);
    const response = await api("/webhooks", {
      method: "POST",
      token,
      body: { endpoint_url: subscriber.url, event_types: ["*"], secret },
    });
    return { subscriber, id: response.body.registration_id as string };
  }

  it("delivers a signed test event and reports the 2xx status", async () => {
    const { subscriber, id } = await registerVerified();
    try {
      const response = await api("/webhooks/test", {
        method: "POST",
        body: { endpoint_url: subscriber.url },
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, status: 200 });
      expect(subscriber.received).toHaveLength(1);
      expect(JSON.parse(subscriber.received[0].body)).toEqual({
        type: "webhook.test",
        registration_id: id,
      });

      // A test is not a queued delivery.
      expect(store.listDeliveries({ registrationId: id })).toHaveLength(0);
    } finally {
      await subscriber.close();
    }
  });

  it("reports the status and an error when the endpoint does not answer 2xx", async () => {
    const { subscriber } = await registerVerified();
    subscriber.eventStatus = 500;
    try {
      const response = await api("/webhooks/test", {
        method: "POST",
        body: { endpoint_url: subscriber.url },
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: false,
        status: 500,
        error: "endpoint responded 500",
      });
    } finally {
      await subscriber.close();
    }
  });

  it("only targets URLs the caller has registered and verified", async () => {
    const theirs = await registerVerified(mintToken(OTHER_OWNER));
    const unverified = await startSubscriber("unused");
    try {
      const arbitrary = await api("/webhooks/test", {
        method: "POST",
        body: { endpoint_url: "http://127.0.0.1:1/not-registered" },
      });
      expect(arbitrary.status).toBe(404);

      const otherOwners = await api("/webhooks/test", {
        method: "POST",
        body: { endpoint_url: theirs.subscriber.url },
      });
      expect(otherOwners.status).toBe(404);
      expect(theirs.subscriber.received).toHaveLength(0);

      await api("/webhooks", {
        method: "POST",
        body: { endpoint_url: unverified.url, event_types: ["*"] },
      });
      const notVerified = await api("/webhooks/test", {
        method: "POST",
        body: { endpoint_url: unverified.url },
      });
      expect(notVerified.status).toBe(409);
      expect(unverified.received).toHaveLength(0);

      const missing = await api("/webhooks/test", { method: "POST", body: {} });
      expect(missing.status).toBe(400);
    } finally {
      await theirs.subscriber.close();
      await unverified.close();
    }
  });
});

describe("routing", () => {
  it("answers 404 for unknown ids and webhook paths, 405 for bad methods", async () => {
    expect((await api(`/webhooks/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await api("/webhooks/abc/nope/deep/path")).status).toBe(404);
    expect((await api("/webhooks", { method: "DELETE" })).status).toBe(405);
  });

  it("still serves the read-only query endpoints", async () => {
    const health = await api("/health", { token: null });
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);

    const events = await api("/events?limit=1", { token: null });
    expect(events.status).toBe(200);
    expect(Array.isArray(events.body.events)).toBe(true);
  });

  it("answers CORS preflight for the management API", async () => {
    const response = await fetch(`${baseUrl}/webhooks`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "Authorization"
    );
  });
});
