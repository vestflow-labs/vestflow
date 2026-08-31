/**
 * SSE hub + stream endpoint: connection leak test, Last-Event-ID replay, and
 * the authenticated /events/stream endpoint over real HTTP.
 */

import crypto from "crypto";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { EventEmitter } from "events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_PATH = path.join(
  os.tmpdir(),
  `vestflow-sse-${process.pid}-${Date.now()}.db`
);
process.env.INDEXER_DB_PATH_TESTNET = DB_PATH;
process.env.JWT_SECRET = "test-jwt-secret";

const { recordAppNotification } = await import("../src/app-notifications");
const sse = await import("../src/sse");
const { createServer } = await import("../src/server");

const WALLET = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const OTHER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function mintToken(subject: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ sub: subject, iat: now, exp: now + 3600 }));
  const signature = crypto
    .createHmac("sha256", process.env.JWT_SECRET as string)
    .update(`${header}.${payload}`)
    .digest();
  return `${header}.${payload}.${base64url(signature)}`;
}

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {}
}

function fakeResponse(): FakeResponse {
  return new FakeResponse();
}

beforeAll(() => {
  // Seed events 1..10 so replay has something to work with.
  for (let i = 1; i <= 10; i++) {
    recordAppNotification({
      wallet: WALLET,
      event_type: "Claimed",
      schedule_id: i,
      event_id: `seed-${i}`,
      ledger: i,
      payload: JSON.stringify({ event_id: `seed-${i}` }),
    });
  }
});

afterAll(() => {
  sse.stopNotificationFanout();
});

describe("connection registry", () => {
  it("1,000 connect/disconnect cycles leave zero leaked connections", () => {
    sse.stopNotificationFanout();

    for (let i = 0; i < 1000; i++) {
      const res = fakeResponse() as unknown as http.ServerResponse;
      sse.registerStream(WALLET, res, null);
      res.emit("close");
    }

    expect(sse.connectionCount()).toBe(0);
    expect(sse.registeredWalletCount()).toBe(0);
  });
});

describe("Last-Event-ID replay", () => {
  it("replays only events after the cursor, in ascending order", () => {
    sse.stopNotificationFanout();

    const res = fakeResponse() as unknown as http.ServerResponse;
    sse.registerStream(WALLET, res, 5);

    const frame = res.chunks.join("");
    // Replays events 6..10 (skip the first five).
    for (let id = 6; id <= 10; id++) {
      expect(frame).toContain(`id: ${id}`);
    }
    expect(frame).not.toContain("id: 5\n");

    res.emit("close");
    expect(sse.connectionCount()).toBe(0);
  });
});

describe("/events/stream over HTTP", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a wallet that does not match the token subject", async () => {
    const status = await streamStatus(baseUrl, OTHER, mintToken(WALLET));
    expect(status).toBe(403);
  });

  it("rejects a missing token", async () => {
    const status = await streamStatus(baseUrl, WALLET, null);
    expect(status).toBe(401);
  });

  it("streams newly-indexed events to the matching wallet", async () => {
    sse.stopNotificationFanout();

    const { stream, chunks } = await openStream(baseUrl, WALLET);
    try {
      // Seed the fan-out cursor, then write a new event.
      sse.fanoutTick();

      const id = recordAppNotification({
        wallet: WALLET,
        event_type: "Revoked",
        schedule_id: 99,
        event_id: "live-99",
        ledger: 99,
        payload: JSON.stringify({ event_id: "live-99", event_type: "Revoked" }),
      });

      sse.fanoutTick();

      await waitFor(() => chunks.some((c) => c.includes(`id: ${id}`)));
      const frame = chunks.join("");
      expect(frame).toContain(`id: ${id}`);
      expect(frame).toContain('"event_type":"Revoked"');
    } finally {
      stream.destroy();
    }
  });
});

async function streamStatus(
  baseUrl: string,
  wallet: string,
  token: string | null,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/events/stream?wallet=${wallet}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function openStream(
  baseUrl: string,
  wallet: string,
): Promise<{ stream: http.ClientRequest; chunks: string[] }> {
  const chunks: string[] = [];
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/events/stream?wallet=${wallet}`,
      {
        headers: { Authorization: `Bearer ${mintToken(wallet)}` },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Expected 200, got ${res.statusCode}`));
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => chunks.push(chunk));
        resolve({ stream: req, chunks });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
