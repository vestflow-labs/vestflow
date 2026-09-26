import { timingSafeEqual } from "node:crypto";
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import { getActiveStreamsCount, getCheckpoint } from "./db";
import { getDatabasePoolConfig, getNetworkConfig, type NetworkName } from "./config";
import { getPool } from "./db-postgres";

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type HttpMetric = {
  method: string;
  path: string;
  status: number;
  count: number;
  durationCount: number;
  durationSum: number;
  bucketCounts: number[];
};

const httpMetrics = new Map<string, HttpMetric>();
const latestLedgerCache = new Map<NetworkName, { value: number; expiresAt: number }>();

function escapeLabel(value: string): string {
  return value
    .split("\\")
    .join("\\\\")
    .split("\n")
    .join("\\n")
    .split('"')
    .join('\\"');
}

function metricKey(method: string, path: string, status: number): string {
  return `${method}\u0000${path}\u0000${status}`;
}

function labelsFor(metric: HttpMetric): string {
  return `{method="${escapeLabel(metric.method)}",path="${escapeLabel(metric.path)}",status="${metric.status}"}`;
}

export function metricsRoute(pathname: string): string {
  if (/^\/schedules\/[^/]+\/history$/.test(pathname)) {
    return "/schedules/:id/history";
  }
  if (/^\/analytics\/schedules\/\d+\/history$/.test(pathname)) {
    return "/analytics/schedules/:id/history";
  }
  if (/^\/analytics\/grantors\/[^/]+\/summary$/.test(pathname)) {
    return "/analytics/grantors/:address/summary";
  }
  if (/^\/streams\/history\/[^/]+\/[^/]+\/[^/]+$/.test(pathname)) {
    return "/streams/history/:sender/:receiver/:token";
  }
  if (/^\/streams\/[^/]+\/[^/]+\/[^/]+$/.test(pathname)) {
    return "/streams/:sender/:receiver/:token";
  }
  if (/^\/lists\/[^/]+\/members$/.test(pathname)) {
    return "/lists/:id/members";
  }
  if (/^\/profile\/[^/]+$/.test(pathname)) {
    return "/profile/:address";
  }
  if (/^\/gives\/summary\/[^/]+$/.test(pathname)) {
    return "/gives/summary/:address";
  }
  return pathname;
}

export function recordHttpRequest(
  method: string,
  path: string,
  status: number,
  durationSeconds: number,
): void {
  const key = metricKey(method, path, status);
  let metric = httpMetrics.get(key);
  if (!metric) {
    metric = {
      method,
      path,
      status,
      count: 0,
      durationCount: 0,
      durationSum: 0,
      bucketCounts: HISTOGRAM_BUCKETS.map(() => 0),
    };
    httpMetrics.set(key, metric);
  }
  metric.count += 1;
  metric.durationCount += 1;
  metric.durationSum += Math.max(0, durationSeconds);
  for (let i = 0; i < HISTOGRAM_BUCKETS.length; i += 1) {
    if (durationSeconds <= HISTOGRAM_BUCKETS[i]) {
      for (let j = i; j < metric.bucketCounts.length; j += 1) {
        metric.bucketCounts[j] += 1;
      }
      break;
    }
  }
}

export function resetMetrics(): void {
  httpMetrics.clear();
  latestLedgerCache.clear();
}

function parseLatestLedger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function latestLedger(network: NetworkName): Promise<number | null> {
  const cached = latestLedgerCache.get(network);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const configured = parseLatestLedger(process.env.INDEXER_LATEST_LEDGER);
  if (configured !== null) {
    latestLedgerCache.set(network, {
      value: configured,
      expiresAt: Date.now() + 5_000,
    });
    return configured;
  }

  const configuredTimeout = Number(process.env.METRICS_RPC_TIMEOUT_MS ?? "1000");
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 1_000;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const server = new StellarRpc.Server(
      process.env.INDEXER_METRICS_RPC_URL ?? getNetworkConfig(network).rpcUrl,
    );
    const result = await Promise.race([
      server.getLatestLedger(),
      new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    const sequence =
      result && typeof result === "object" && "sequence" in result
        ? Number(result.sequence)
        : NaN;
    if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
    latestLedgerCache.set(network, {
      value: sequence,
      expiresAt: Date.now() + 5_000,
    });
    return sequence;
  } catch {
    return null;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function indexerLag(network: NetworkName): Promise<number> {
  const checkpoint = getCheckpoint(network);
  const current = await latestLedger(network);
  return current === null ? 0 : Math.max(0, current - checkpoint);
}

function poolConnectionsActive(): number {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) return 0;
  try {
    const pool = getPool();
    return Math.max(0, pool.totalCount - pool.idleCount);
  } catch {
    return 0;
  }
}

function number(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

export function isMetricsAuthorized(authorization: string | undefined): boolean {
  const configured = process.env.METRICS_TOKEN;
  if (!configured) return false;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const expected = Buffer.from(configured);
  const supplied = Buffer.from(match[1]);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function renderPrometheusMetrics(
  network: NetworkName,
): Promise<string> {
  getDatabasePoolConfig();
  const activeStreams = getActiveStreamsCount(network);
  const lag = await indexerLag(network);
  const poolActive = poolConnectionsActive();
  const lines: string[] = [
    "# HELP http_requests_total Total HTTP requests handled by the indexer.",
    "# TYPE http_requests_total counter",
  ];

  for (const metric of httpMetrics.values()) {
    lines.push(`http_requests_total${labelsFor(metric)} ${number(metric.count)}`);
  }

  lines.push(
    "# HELP http_request_duration_seconds HTTP request duration in seconds.",
    "# TYPE http_request_duration_seconds histogram",
  );
  for (const metric of httpMetrics.values()) {
    const labels = labelsFor(metric);
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i += 1) {
      lines.push(
        `http_request_duration_seconds_bucket${labels.slice(0, -1)},le="${HISTOGRAM_BUCKETS[i]}"} ${number(metric.bucketCounts[i])}`,
      );
    }
    lines.push(
      `http_request_duration_seconds_bucket${labels.slice(0, -1)},le="+Inf"} ${number(metric.durationCount)}`,
      `http_request_duration_seconds_sum${labels} ${number(metric.durationSum)}`,
      `http_request_duration_seconds_count${labels} ${number(metric.durationCount)}`,
    );
  }

  lines.push(
    "# HELP active_streams_count Number of active indexed streams.",
    "# TYPE active_streams_count gauge",
    `active_streams_count ${number(activeStreams)}`,
    "# HELP indexer_lag_ledgers Difference between the current and indexed ledgers.",
    "# TYPE indexer_lag_ledgers gauge",
    `indexer_lag_ledgers ${number(lag)}`,
    "# HELP db_pool_connections_active Number of active PostgreSQL pool connections.",
    "# TYPE db_pool_connections_active gauge",
    `db_pool_connections_active ${number(poolActive)}`,
  );

  return `${lines.join("\n")}\n`;
}
