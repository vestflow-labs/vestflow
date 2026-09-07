import assert from "assert";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OWNER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM";
const MEMBER_ONE = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCOA";
const MEMBER_TWO = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDG";

async function request(server: http.Server, pathname: string): Promise<{ status: number; body: any }> {
  const address = server.address();
  assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function requestWithHeaders(
  server: http.Server,
  pathname: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const address = server.address();
  assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, { headers });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

async function run(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vestflow-drips-api-"));
  process.env.INDEXER_DB_PATH_TESTNET = path.join(tempDir, "testnet.db");

  const { getDb } = await import("../src/db");
  const { createServer } = await import("../src/server");
  const db = getDb("testnet");
  db.prepare("INSERT INTO drips_lists (id, name, owner, token, total_funding_rate_per_sec, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("list-1", "Team", OWNER, "TOKEN", "55", 100);
  db.prepare("INSERT INTO drips_list_members (list_id, address, joined_at) VALUES (?, ?, ?)")
    .run("list-1", MEMBER_ONE, 10);
  db.prepare("INSERT INTO drips_list_members (list_id, address, joined_at) VALUES (?, ?, ?)")
    .run("list-1", MEMBER_TWO, 20);
  db.prepare("INSERT INTO drips_streams (id, account, receiver, token, rate_per_second, estimated_end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("stream-1", ACCOUNT, MEMBER_ONE, "TOKEN", "8", Math.floor(Date.now() / 1000) + 3600, 100);
  db.prepare("INSERT INTO drips_streaming_balances (account, token, balance) VALUES (?, ?, ?)")
    .run(ACCOUNT, "TOKEN", "123");

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const lists = await request(server, "/lists?limit=1");
    assert.equal(lists.status, 200);
    assert.deepEqual(lists.body.lists[0], {
      id: "list-1", name: "Team", owner: OWNER, token: "TOKEN",
      total_funding_rate_per_sec: "55", target_rate_per_sec: "0", member_count: 2,
    });

    const members = await request(server, "/lists/list-1/members?limit=1");
    assert.equal(members.status, 200);
    assert.deepEqual(members.body.members, [{ address: MEMBER_ONE, joined_at: 10 }]);
    assert(members.body.next_cursor);
    const memberPageTwo = await request(server, `/lists/list-1/members?cursor=${encodeURIComponent(members.body.next_cursor)}`);
    assert.deepEqual(memberPageTwo.body.members, [{ address: MEMBER_TWO, joined_at: 20 }]);
    assert.equal((await request(server, "/lists/missing/members")).status, 404);

    const streams = await request(server, `/streams?account=${ACCOUNT}`);
    assert.equal(streams.status, 200);
    assert.equal(streams.body.streams.length, 1);
    assert.equal((await request(server, "/streams")).status, 400);

    // ── ETag caching: GET /streams ───────────────────────────────────────
    const streamsBase = `/streams?account=${ACCOUNT}&network=testnet`;
    const first = await requestWithHeaders(server, streamsBase);
    assert.equal(first.status, 200);
    assert(first.headers.get("etag"), "first /streams response must carry an ETag");
    const firstEtag = first.headers.get("etag")!;
    assert.equal(first.body.streams.length, 1);

    // Unchanged data + matching If-None-Match -> 304, no body.
    const notModified = await requestWithHeaders(server, streamsBase, {
      "If-None-Match": firstEtag,
    });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.body, null, "304 must not carry a body");
    assert.equal(notModified.headers.get("etag"), firstEtag);

    // Non-matching If-None-Match -> 200 with a fresh ETag.
    const stale = await requestWithHeaders(server, streamsBase, {
      "If-None-Match": '"stale-etag"',
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("etag"), firstEtag);

    // Changed data -> the ETag changes.
    db.prepare("INSERT INTO drips_streams (id, account, receiver, token, rate_per_second, estimated_end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("stream-2", ACCOUNT, MEMBER_TWO, "TOKEN", "12", Math.floor(Date.now() / 1000) + 3600, 200);
    const changed = await requestWithHeaders(server, streamsBase);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), firstEtag, "ETag must change when data changes");
    assert.equal(changed.body.streams.length, 2);

    // ── ETag caching: GET /splits ────────────────────────────────────────
    db.prepare("INSERT INTO current_streams (account, token, receivers_json, updated_at) VALUES (?, ?, ?, ?)")
      .run(ACCOUNT, "TOKEN", JSON.stringify([{ receiver: MEMBER_ONE, rate_per_second: "55" }]), 100);
    const splitsBase = `/splits?account=${ACCOUNT}&network=testnet`;
    const splitsFirst = await requestWithHeaders(server, splitsBase);
    assert.equal(splitsFirst.status, 200);
    assert(splitsFirst.headers.get("etag"), "first /splits response must carry an ETag");
    const splitsEtag = splitsFirst.headers.get("etag")!;
    assert.equal(splitsFirst.body.receivers.length, 1);

    const splitsNotModified = await requestWithHeaders(server, splitsBase, {
      "If-None-Match": splitsEtag,
    });
    assert.equal(splitsNotModified.status, 304);
    assert.equal(splitsNotModified.body, null);

    // Changed splits data -> the ETag changes.
    db.prepare("UPDATE current_streams SET receivers_json = ?, updated_at = ? WHERE account = ? AND token = ?")
      .run(JSON.stringify([{ receiver: MEMBER_ONE, rate_per_second: "70" }, { receiver: MEMBER_TWO, rate_per_second: "30" }]), 200, ACCOUNT, "TOKEN");
    const splitsChanged = await requestWithHeaders(server, splitsBase);
    assert.equal(splitsChanged.status, 200);
    assert.notEqual(splitsChanged.headers.get("etag"), splitsEtag, "splits ETag must change when data changes");
    assert.equal(splitsChanged.body.receivers.length, 2);

    // ── ETag: unchanged splits + stale If-None-Match -> 304 ──────────────
    const splitsAgain = await requestWithHeaders(server, splitsBase, {
      "If-None-Match": splitsChanged.headers.get("etag")!,
    });
    assert.equal(splitsAgain.status, 304);

    const tvl = await request(server, "/analytics/streams/tvl?token=TOKEN");
    assert.equal(tvl.status, 200);
    assert.equal(tvl.body.total_value_locked, "123");
    assert.equal((await request(server, "/analytics/streams/tvl?token=NONE")).body.total_value_locked, "0");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().then(() => console.log("Drips API tests passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
