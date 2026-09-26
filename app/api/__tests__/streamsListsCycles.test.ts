// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

vi.mock("@/lib/rateLimit", () => ({
  createIpBasedRateLimiter: () => () => Promise.resolve(null),
}));

const FUNDER = "G" + "A".repeat(55);
const RECEIVER = "G" + "B".repeat(55);
const SENDER_TWO = "G" + "C".repeat(55);
const OTHER = "G" + "D".repeat(55);
const FRESH = "G" + "F".repeat(55);
const TOKEN = "C" + "E".repeat(55);

describe("Backend streams/lists/cycles (#821, #822, #823, #824)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vestflow-821-824-"));
    dbPath = path.join(tempDir, "testnet.db");
    process.env.INDEXER_DB_PATH_TESTNET = dbPath;

    const { getDb } = await import("@/indexer/src/db");
    const db = getDb("testnet");
    const now = Math.floor(Date.now() / 1000);

    // ── drips_streams: two active incoming streams for RECEIVER ──
    const insertStream = db.prepare(
      `INSERT INTO drips_streams
        (id, account, receiver, token, rate_per_second, estimated_end_time, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertStream.run("s-1", FUNDER, RECEIVER, TOKEN, "100", now + 86400, null, now - 100);
    insertStream.run("s-2", SENDER_TWO, RECEIVER, TOKEN, "200", now + 172800, null, now - 50);
    // Ended stream — must be excluded from incoming.
    insertStream.run("s-3", FUNDER, RECEIVER, TOKEN, "50", now + 86400, now - 10, now - 200);
    // Outgoing stream from RECEIVER — must not appear as incoming.
    insertStream.run("s-4", RECEIVER, OTHER, TOKEN, "75", now + 86400, null, now - 20);

    // ── stream_cycles: three settlement cycles ──
    const insertCycle = db.prepare(
      `INSERT INTO stream_cycles
        (account, token, cycle_end_ledger, cycle_end_timestamp, amount_received)
       VALUES (?, ?, ?, ?, ?)`
    );
    insertCycle.run(RECEIVER, TOKEN, 100, 1000, "500000");
    insertCycle.run(RECEIVER, TOKEN, 200, 2000, "600000");
    insertCycle.run(RECEIVER, TOKEN, 300, 3000, "700000");

    // ── drips_lists: two lists funded by FUNDER ──
    const insertList = db.prepare(
      `INSERT INTO drips_lists
        (id, name, owner, token, total_funding_rate_per_sec, target_rate_per_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insertList.run("list-1", "Alpha Pool", FUNDER, TOKEN, "500", "500", 100);
    insertList.run("list-2", "Beta Pool", FUNDER, TOKEN, "900", "900", 200);
    insertList.run("list-3", "Other Pool", OTHER, TOKEN, "100", "100", 300);
    const insertMember = db.prepare(
      "INSERT INTO drips_list_members (list_id, address, joined_at) VALUES (?, ?, ?)"
    );
    insertMember.run("list-1", RECEIVER, 100);
    insertMember.run("list-1", SENDER_TWO, 101);
    insertMember.run("list-2", RECEIVER, 102);
  });

  afterEach(async () => {
    const { _clearTestDb } = await import("@/indexer/src/db");
    _clearTestDb();
    delete process.env.INDEXER_DB_PATH_TESTNET;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Issue #821: GET /api/streams/incoming", () => {
    it("returns active incoming streams with sender, token, rate and start time", async () => {
      const { GET } = await import("@/app/api/streams/incoming/route");
      const req = new NextRequest(
        `http://localhost:3000/api/streams/incoming?account=${RECEIVER}&network=testnet`
      );
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.streams).toHaveLength(2);
      for (const s of body.streams) {
        expect(s.sender).toBeTruthy();
        expect(s.token).toBe(TOKEN);
        expect(s.rate ?? s.rate_per_sec).toBeTruthy();
        expect(typeof s.start_time).toBe("number");
      }
      const senders = body.streams.map((s: { sender: string }) => s.sender);
      expect(senders).toContain(FUNDER);
      expect(senders).toContain(SENDER_TWO);
    });

    it("returns an empty array when the address has no incoming streams", async () => {
      const { GET } = await import("@/app/api/streams/incoming/route");
      const req = new NextRequest(
        `http://localhost:3000/api/streams/incoming?account=${FRESH}&network=testnet`
      );
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.streams).toEqual([]);
    });

    it("returns 400 for an invalid address", async () => {
      const { GET } = await import("@/app/api/streams/incoming/route");
      const req = new NextRequest(
        "http://localhost:3000/api/streams/incoming?account=not-an-address"
      );
      const res = await GET(req);

      expect(res.status).toBe(400);
    });

    it("paginates with limit and cursor", async () => {
      const { GET } = await import("@/app/api/streams/incoming/route");
      const first = await GET(
        new NextRequest(
          `http://localhost:3000/api/streams/incoming?account=${RECEIVER}&limit=1&network=testnet`
        )
      );
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(firstBody.streams).toHaveLength(1);
      expect(firstBody.next_cursor).toBeTruthy();

      const second = await GET(
        new NextRequest(
          `http://localhost:3000/api/streams/incoming?account=${RECEIVER}&limit=1&cursor=${encodeURIComponent(firstBody.next_cursor)}&network=testnet`
        )
      );
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody.streams).toHaveLength(1);
      expect(secondBody.streams[0].sender).not.toBe(
        firstBody.streams[0].sender
      );
    });
  });

  describe("Issue #822: GET /api/analytics/cycles", () => {
    it("returns per-cycle data sorted by cycle_end descending", async () => {
      const { GET } = await import("@/app/api/analytics/cycles/route");
      const req = new NextRequest(
        `http://localhost:3000/api/analytics/cycles?account=${RECEIVER}&token=${encodeURIComponent(TOKEN)}&network=testnet`
      );
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cycles).toHaveLength(3);
      expect(body.cycles[0].cycle_end).toBe(3000);
      expect(body.cycles[2].cycle_end).toBe(1000);
      for (const c of body.cycles) {
        expect(c.amount_received).toBeTruthy();
        expect(c.amount_collected).toBeTruthy();
      }
    });

    it("supports from/to date range filtering", async () => {
      const { GET } = await import("@/app/api/analytics/cycles/route");
      const req = new NextRequest(
        `http://localhost:3000/api/analytics/cycles?account=${RECEIVER}&from=1500&to=2500&network=testnet`
      );
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cycles).toHaveLength(1);
      expect(body.cycles[0].cycle_end).toBe(2000);
    });

    it("paginates with limit and cursor", async () => {
      const { GET } = await import("@/app/api/analytics/cycles/route");
      const first = await GET(
        new NextRequest(
          `http://localhost:3000/api/analytics/cycles?account=${RECEIVER}&limit=2&network=testnet`
        )
      );
      const firstBody = await first.json();
      expect(firstBody.cycles).toHaveLength(2);
      expect(firstBody.next_cursor).toBeTruthy();

      const second = await GET(
        new NextRequest(
          `http://localhost:3000/api/analytics/cycles?account=${RECEIVER}&limit=2&cursor=${encodeURIComponent(firstBody.next_cursor)}&network=testnet`
        )
      );
      const secondBody = await second.json();
      expect(secondBody.cycles).toHaveLength(1);
      expect(secondBody.cycles[0].cycle_end).toBe(1000);
    });
  });

  describe("Issue #823: POST /api/streams/simulate", () => {
    const validBody = {
      sender: FUNDER,
      token: TOKEN,
      balance: "30000000",
      receivers: [
        { address: RECEIVER, share: 1 },
        { address: SENDER_TWO, share: 3 },
      ],
    };

    it("returns max_end_time, per-receiver daily amounts and an estimated fee", async () => {
      const { POST } = await import("@/app/api/streams/simulate/route");
      const req = new NextRequest("http://localhost:3000/api/streams/simulate", {
        method: "POST",
        body: JSON.stringify(validBody),
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.max_end_time).toBe("number");
      expect(body.max_end_time).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(body.receivers).toHaveLength(2);
      for (const r of body.receivers) {
        expect(r.address).toBeTruthy();
        expect(r.daily_amount).toBeTruthy();
      }
      expect(body.estimated_fee).toBeTruthy();
      expect(body.cached).toBe(false);
    });

    it("caches identical configs for 5 seconds", async () => {
      const { POST } = await import("@/app/api/streams/simulate/route");
      // Distinct balance so the module-level 5s cache from the previous
      // test cannot collide with this config.
      const cacheBody = { ...validBody, balance: "60000000" };
      const makeReq = () =>
        new NextRequest("http://localhost:3000/api/streams/simulate", {
          method: "POST",
          body: JSON.stringify(cacheBody),
        });
      const first = await POST(makeReq());
      expect((await first.json()).cached).toBe(false);
      const second = await POST(makeReq());
      const secondBody = await second.json();
      expect(secondBody.cached).toBe(true);
      expect(secondBody.max_end_time).toBeTruthy();
    });

    it("returns 400 for an invalid config", async () => {
      const { POST } = await import("@/app/api/streams/simulate/route");
      const cases = [
        { ...validBody, sender: "bad" },
        { ...validBody, receivers: [] },
        { ...validBody, balance: "0" },
        { ...validBody, token: "bad" },
      ];
      for (const c of cases) {
        const res = await POST(
          new NextRequest("http://localhost:3000/api/streams/simulate", {
            method: "POST",
            body: JSON.stringify(c),
          })
        );
        expect(res.status).toBe(400);
      }
    });
  });

  describe("Issue #824: GET /api/lists/funded-by/:address", () => {
    it("returns lists funded by the address with member counts and total rates", async () => {
      const { GET } = await import(
        "@/app/api/lists/funded-by/[address]/route"
      );
      const req = new NextRequest(
        `http://localhost:3000/api/lists/funded-by/${FUNDER}?network=testnet`
      );
      const res = await GET(req, {
        params: Promise.resolve({ address: FUNDER }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.lists).toHaveLength(2);
      const alpha = body.lists.find((l: { id: string }) => l.id === "list-1");
      expect(alpha.name).toBe("Alpha Pool");
      expect(alpha.member_count).toBe(2);
      expect(alpha.total_rate ?? alpha.total_funding_rate_per_sec).toBe("500");
    });

    it("returns an empty array when the address funds no lists", async () => {
      const { GET } = await import(
        "@/app/api/lists/funded-by/[address]/route"
      );
      const req = new NextRequest(
        `http://localhost:3000/api/lists/funded-by/${RECEIVER}?network=testnet`
      );
      const res = await GET(req, {
        params: Promise.resolve({ address: RECEIVER }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.lists).toEqual([]);
    });

    it("returns 400 for an invalid address", async () => {
      const { GET } = await import(
        "@/app/api/lists/funded-by/[address]/route"
      );
      const req = new NextRequest(
        "http://localhost:3000/api/lists/funded-by/not-an-address"
      );
      const res = await GET(req, {
        params: Promise.resolve({ address: "not-an-address" }),
      });

      expect(res.status).toBe(400);
    });

    it("paginates with limit and cursor", async () => {
      const { GET } = await import(
        "@/app/api/lists/funded-by/[address]/route"
      );
      const first = await GET(
        new NextRequest(
          `http://localhost:3000/api/lists/funded-by/${FUNDER}?limit=1&network=testnet`
        ),
        { params: Promise.resolve({ address: FUNDER }) }
      );
      const firstBody = await first.json();
      expect(firstBody.lists).toHaveLength(1);
      expect(firstBody.next_cursor).toBeTruthy();

      const second = await GET(
        new NextRequest(
          `http://localhost:3000/api/lists/funded-by/${FUNDER}?limit=1&cursor=${encodeURIComponent(firstBody.next_cursor)}&network=testnet`
        ),
        { params: Promise.resolve({ address: FUNDER }) }
      );
      const secondBody = await second.json();
      expect(secondBody.lists).toHaveLength(1);
      expect(secondBody.lists[0].id).not.toBe(firstBody.lists[0].id);
    });
  });
});
