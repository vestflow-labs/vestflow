import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

describe("Drips Lists API (#649, #650)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vestflow-lists-test-"));
    dbPath = path.join(tempDir, "testnet.db");
    process.env.INDEXER_DB_PATH_TESTNET = dbPath;

    const { getDb } = await import("@/indexer/src/db");
    const db = getDb("testnet");

    db.prepare(
      "INSERT INTO drips_lists (id, name, owner, token, total_funding_rate_per_sec, target_rate_per_sec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("list-101", "Alpha Pool", "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", "500", "500", 100);

    db.prepare(
      "INSERT INTO drips_list_members (list_id, address, joined_at) VALUES (?, ?, ?)"
    ).run("list-101", "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCOA", 100);
  });

  afterEach(async () => {
    const { _clearTestDb } = await import("@/indexer/src/db");
    _clearTestDb();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("GET /api/lists returns lists with target_rate_per_sec", async () => {
    const { GET } = await import("@/app/api/lists/route");
    const req = new NextRequest("http://localhost:3000/api/lists?network=testnet");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.lists).toHaveLength(1);
    expect(data.lists[0].id).toBe("list-101");
    expect(data.lists[0].target_rate_per_sec).toBe("500");
  });

  it("GET /api/lists/[id] returns specific list with members", async () => {
    const { GET: getList } = await import("@/app/api/lists/[id]/route");
    const req = new NextRequest("http://localhost:3000/api/lists/list-101?network=testnet");
    const res = await getList(req, { params: Promise.resolve({ id: "list-101" }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Alpha Pool");
    expect(data.target_rate_per_sec).toBe("500");
  });

  it("POST /api/lists/[id]/target-rate updates list target rate", async () => {
    const { POST: updateTarget } = await import("@/app/api/lists/[id]/target-rate/route");
    const req = new NextRequest("http://localhost:3000/api/lists/list-101/target-rate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_rate_per_sec: "1500",
        owner: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM",
        network: "testnet",
      }),
    });

    const res = await updateTarget(req, { params: Promise.resolve({ id: "list-101" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.list.target_rate_per_sec).toBe("1500");
  });
});
