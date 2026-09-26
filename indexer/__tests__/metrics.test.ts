import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  _clearTestDb,
  _setTestDb,
} from "../src/db";
import {
  isMetricsAuthorized,
  recordHttpRequest,
  renderPrometheusMetrics,
  resetMetrics,
} from "../src/metrics";
import { createServer } from "../src/server";

const SENDER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN2";
const RECEIVER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM2";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("Prometheus metrics", () => {
  let db: Database.Database;
  let server: ReturnType<typeof createServer>;
  let previousToken: string | undefined;
  let previousLatestLedger: string | undefined;

  beforeEach(async () => {
    previousToken = process.env.METRICS_TOKEN;
    previousLatestLedger = process.env.INDEXER_LATEST_LEDGER;
    process.env.METRICS_TOKEN = "metrics-secret";
    process.env.INDEXER_LATEST_LEDGER = "120";
    resetMetrics();
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE checkpoint (id INTEGER PRIMARY KEY, last_ledger INTEGER NOT NULL);
      INSERT INTO checkpoint (id, last_ledger) VALUES (1, 100);
      CREATE TABLE drips_streams (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        receiver TEXT NOT NULL,
        token TEXT NOT NULL,
        rate_per_second TEXT NOT NULL,
        estimated_end_time INTEGER,
        ended_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO drips_streams
        (id, account, receiver, token, rate_per_second, created_at)
      VALUES ('stream-1', '${SENDER}', '${RECEIVER}', '${TOKEN}', '10', 1);
    `);
    _setTestDb("testnet", db);
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _clearTestDb("testnet");
    db.close();
    resetMetrics();
    if (previousToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = previousToken;
    if (previousLatestLedger === undefined) delete process.env.INDEXER_LATEST_LEDGER;
    else process.env.INDEXER_LATEST_LEDGER = previousLatestLedger;
  });

  it("renders all metrics with request labels", async () => {
    recordHttpRequest("GET", "/health", 200, 0.01);
    const body = await renderPrometheusMetrics("testnet");

    expect(body).toContain("# TYPE http_requests_total counter");
    expect(body).toContain('http_requests_total{method="GET",path="/health",status="200"} 1');
    expect(body).toContain("# TYPE http_request_duration_seconds histogram");
    expect(body).toContain('http_request_duration_seconds_count{method="GET",path="/health",status="200"} 1');
    expect(body).toContain("active_streams_count 1");
    expect(body).toContain("indexer_lag_ledgers 20");
    expect(body).toContain("db_pool_connections_active 0");
  });

  it("serves the protected endpoint with Prometheus content type", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server is not listening");
    const url = `http://127.0.0.1:${address.port}/metrics`;

    const unauthorized = await fetch(url);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(url, {
      headers: { Authorization: "Bearer metrics-secret" },
    });
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("content-type")).toBe("text/plain; version=0.0.4");
    expect(await authorized.text()).toContain("active_streams_count");
  });

  it("requires the configured bearer token", () => {
    expect(isMetricsAuthorized("Bearer metrics-secret")).toBe(true);
    expect(isMetricsAuthorized("Bearer wrong")).toBe(false);
    expect(isMetricsAuthorized(undefined)).toBe(false);
  });
});
