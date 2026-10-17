/**
 * VestFlow Indexer — Query HTTP Server
 *
 * A minimal Node.js HTTP server exposing read-only access to the indexed
 * event database. Run alongside the poller for local development, or
 * deploy as a long-lived service in production.
 *
 * Endpoints:
 *   GET /health
 *   GET /events?address=G...&event_type=claimed&limit=50&offset=0
 *
 * Plus the authenticated webhook management API (see webhook-api.ts):
 *   POST/GET/DELETE /webhooks…
 */

import http from "http";
import { URL } from "url";
import { createHash } from "node:crypto";
import {
  getCheckpoint,
  getStreamVolume,
  querySplitsByReceiver,
  getDripsStreamingTvl,
  getDripsStreamsLastUpdated,
  getGiveSummary,
  getProtocolTotals,
  getTvlStats,
  queryDripsListMembers,
  queryDripsLists,
  queryDripsSplits,
  queryDripsStreams,
  DEFAULT_EXPIRY_WINDOW_DAYS,
  queryExpiringStreams,
  queryGives,
  queryGivesForAccount,
  queryHistory,
  queryRecentActivity,
  queryStreamConfig,
  queryStreamHistory,
  queryStreamRateChanges,
  queryStreamCycles,
  queryTopReceivers,
  softDeleteGive,
} from "./db";
import type { EventQueryParams, GiveQueryParams } from "./types";
import { extractBearerToken, verifyAuthToken } from "./auth";
import { routeWebhookRequest } from "./webhook-api";
import { routeNotificationsRequest } from "./notifications-api";
import { startNotificationFanout, registerBalanceStream } from "./sse";
import {
  getTvlSeries,
  getScheduleHistory,
  getGrantorSummary,
} from "./analytics";
import { cacheKey, cacheGet, cacheSet } from "./analytics-cache";
import { getDatabasePoolConfig, parseNetwork } from "./config";
import {
  getCachedTokenDecimals,
  getTokenDecimals,
  stroopsToDisplay,
} from "./token-metadata";
import {
  getIndexerLag,
  isMetricsAuthorized,
  metricsRoute,
  recordHttpRequest,
  renderPrometheusMetrics,
} from "./metrics";

const PORT = Number(process.env.INDEXER_PORT ?? "3001");

getDatabasePoolConfig();

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });

  res.end(JSON.stringify(body));
}

/**
 * Compute a strong `ETag` for a response. The value is derived from a hash of
 * the canonical JSON body joined with a caller-supplied last-updated
 * timestamp, so it is stable across identical payloads and changes the instant
 * the underlying data changes.
 */
function computeEtag(body: unknown, lastUpdated: number): string {
  const hash = createHash("sha256")
    .update(String(lastUpdated))
    .update("\0")
    .update(JSON.stringify(body));
  return `"${hash.digest("hex")}"`;
}

/**
 * If the caller sent `If-None-Match` equal to the current `ETag`, answer with
 * 304 Not Modified and no body. Otherwise write a full 200 JSON response with
 * the fresh `ETag`.
 */
function jsonWithEtag(
  res: http.ServerResponse,
  body: unknown,
  lastUpdated: number,
  ifNoneMatch: string | undefined
): void {
  const etag = computeEtag(body, lastUpdated);
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
    ETag: etag,
  };

  if (ifNoneMatch && ifNoneMatch.trim() === etag) {
    res.writeHead(304, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
      ETag: etag,
    });
    res.end();
    return;
  }

  res.writeHead(200, headers);
  res.end(JSON.stringify(body));
}

function numParam(params: URLSearchParams, key: string): number | undefined {
  const value = params.get(key);

  if (value == null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function limitParam(params: URLSearchParams): number | null | undefined {
  const raw = params.get("limit");
  if (raw == null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function networkParam(params: URLSearchParams): "mainnet" | "testnet" | null {
  const network = params.get("network") ?? "testnet";
  return network === "mainnet" || network === "testnet" ? network : null;
}

const STELLAR_ADDRESS = /^G[A-Z2-7]{54,55}$/;

function handleLists(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
): void {
  const limit = limitParam(searchParams);
  const network = networkParam(searchParams);
  if (limit === null)
    return json(res, 400, { error: "limit must be a positive integer" });
  if (!network)
    return json(res, 400, { error: "network must be mainnet or testnet" });
  const page = queryDripsLists({
    owner: searchParams.get("owner") ?? undefined,
    limit,
    cursor: searchParams.get("cursor") ?? undefined,
    network,
  });
  if (!page) return json(res, 400, { error: "cursor is invalid" });
  return json(res, 200, { lists: page.items, next_cursor: page.nextCursor });
}

function handleListMembers(
  res: http.ServerResponse,
  listId: string,
  searchParams: URLSearchParams,
): void {
  const limit = limitParam(searchParams);
  const network = networkParam(searchParams);
  if (limit === null)
    return json(res, 400, { error: "limit must be a positive integer" });
  if (!network)
    return json(res, 400, { error: "network must be mainnet or testnet" });
  const page = queryDripsListMembers({
    listId,
    limit,
    cursor: searchParams.get("cursor") ?? undefined,
    network,
  });
  if (page === "not_found") return json(res, 404, { error: "List not found" });
  if (!page) return json(res, 400, { error: "cursor is invalid" });
  return json(res, 200, { members: page.items, next_cursor: page.nextCursor });
}

function handleStreams(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
  ifNoneMatch?: string,
): void {
  const account = searchParams.get("account");
  const limit = limitParam(searchParams);
  const network = networkParam(searchParams);
  if (!account || !STELLAR_ADDRESS.test(account))
    return json(res, 400, { error: "account must be a valid Stellar address" });
  if (limit === null)
    return json(res, 400, { error: "limit must be a positive integer" });
  if (!network)
    return json(res, 400, { error: "network must be mainnet or testnet" });
  const page = queryDripsStreams({
    account,
    limit,
    cursor: searchParams.get("cursor") ?? undefined,
    network,
  });
  if (!page) return json(res, 400, { error: "cursor is invalid" });
  const body = { streams: page.items, next_cursor: page.nextCursor };
  const lastUpdated = getDripsStreamsLastUpdated(account, network);
  return jsonWithEtag(res, body, lastUpdated, ifNoneMatch);
}

/**
 * Issue #947 — `GET /streams/expiring?account=&windowDays=`.
 *
 * Returns the account's open streams that are projected to finish inside the
 * look-ahead window (default 7 days), soonest first. Open-ended streams and
 * streams that have already ended are excluded; see `queryExpiringStreams`.
 */
function handleStreamsExpiring(res: http.ServerResponse, searchParams: URLSearchParams): void {
  const account = searchParams.get("account");
  const network = networkParam(searchParams);
  if (!account || !STELLAR_ADDRESS.test(account))
    return json(res, 400, { error: "account must be a valid Stellar address" });
  if (!network)
    return json(res, 400, { error: "network must be mainnet or testnet" });

  const rawWindow = searchParams.get("windowDays");
  let windowDays: number | undefined;
  if (rawWindow != null) {
    const parsed = Number(rawWindow);
    if (!Number.isInteger(parsed) || parsed <= 0)
      return json(res, 400, { error: "windowDays must be a positive integer" });
    windowDays = parsed;
  }

  const limit = limitParam(searchParams);
  if (limit === null) return json(res, 400, { error: "limit must be a positive integer" });

  const streams = queryExpiringStreams({ account, windowDays, limit, network });
  return json(res, 200, {
    account,
    network,
    window_days: windowDays ?? DEFAULT_EXPIRY_WINDOW_DAYS,
    streams,
  });
}

function handleSplits(res: http.ServerResponse, searchParams: URLSearchParams, ifNoneMatch?: string): void {
  const account = searchParams.get("account");
  const network = networkParam(searchParams);
  if (!account || !STELLAR_ADDRESS.test(account)) return json(res, 400, { error: "account must be a valid Stellar address" });
  if (!network) return json(res, 400, { error: "network must be mainnet or testnet" });
  const { receivers, hash, last_updated } = queryDripsSplits(account, network);
  const body = { account, network, receivers, hash };
  return jsonWithEtag(res, body, last_updated, ifNoneMatch);
}

function handleStreamsTvl(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
): void {
  const token = searchParams.get("token");
  const network = networkParam(searchParams);
  if (!token) return json(res, 400, { error: "token query param is required" });
  if (!network)
    return json(res, 400, { error: "network must be mainnet or testnet" });
  const key = cacheKey(
    `streams:${network}:${token}`,
    "current",
    "current",
    false,
  );
  const cached = cacheGet<string>(key);
  const total = cached ?? getDripsStreamingTvl(token, network);
  if (!cached) cacheSet(key, total, "current");
  return json(res, 200, { token, total_value_locked: total, cached: !!cached });
}

function buildEventQueryParams(
  searchParams: URLSearchParams,
): EventQueryParams {
  return {
    address: searchParams.get("address") ?? undefined,
    grantor: searchParams.get("grantor") ?? undefined,
    beneficiary: searchParams.get("beneficiary") ?? undefined,
    event_type: searchParams.get("event_type") ?? undefined,
    schedule_id: numParam(searchParams, "schedule_id"),
    from_ledger: numParam(searchParams, "from_ledger"),
    to_ledger: numParam(searchParams, "to_ledger"),
    limit: numParam(searchParams, "limit"),
    offset: numParam(searchParams, "offset"),
  };
}

async function handleMetrics(
  res: http.ServerResponse,
  authorization: string | undefined,
): Promise<void> {
  if (!isMetricsAuthorized(authorization)) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    const body = await renderPrometheusMetrics(
      (process.env.INDEXER_NETWORK === "mainnet" ? "mainnet" : "testnet"),
    );
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (error) {
    console.error("[server] Metrics collection failed:", error);
    res.writeHead(500, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: "Metrics collection failed" }));
  }
}

/**
 * Stellar ledgers close on a ~5 second cadence. Used to convert an indexer
 * ledger lag into a wall-clock "seconds behind chain tip" figure (#1068)
 * without a second RPC round-trip for close times.
 */
const LEDGER_CLOSE_INTERVAL_SECONDS = 5;

/**
 * Indexer lag threshold (seconds) above which /health reports `degraded`.
 */
const DEGRADED_LAG_SECONDS = 60;

/**
 * GET /health — liveness plus indexer lag.
 *
 * `indexer_lag_seconds` is how far behind the chain tip the indexer is;
 * anything over {@link DEGRADED_LAG_SECONDS} flips `status` to `degraded`.
 */
async function handleHealth(res: http.ServerResponse): Promise<void> {
  let network: ReturnType<typeof parseNetwork>;
  try {
    network = parseNetwork(process.env.INDEXER_NETWORK);
  } catch {
    network = "testnet";
  }

  let lagSeconds = 0;
  try {
    const lagLedgers = await getIndexerLag(network);
    lagSeconds = lagLedgers * LEDGER_CLOSE_INTERVAL_SECONDS;
  } catch (error) {
    console.error("[server] Failed to compute indexer lag:", error);
    lagSeconds = 0;
  }

  let checkpoint = 0;
  try {
    checkpoint = getCheckpoint(network);
  } catch (error) {
    console.error("[server] Failed to read checkpoint:", error);
  }

  const status = lagSeconds > DEGRADED_LAG_SECONDS ? "degraded" : "healthy";

  json(res, status === "healthy" ? 200 : 503, {
    ok: status === "healthy",
    status,
    network,
    checkpoint,
    indexer_lag_seconds: lagSeconds,
  });
}

function handleTvl(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
): void {
  try {
    const network = (searchParams.get("network") ?? "testnet") as
      "mainnet" | "testnet";
    if (network !== "mainnet" && network !== "testnet") {
      return json(res, 400, { error: "network must be mainnet or testnet" });
    }
    const stats = getTvlStats(network);
    json(res, 200, stats);
  } catch (error) {
    console.error("[server] TVL query error:", error);
    json(res, 500, { error: "Failed to compute TVL stats" });
  }
}

function handleEvents(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
): void {
  try {
    const events = queryEvents(buildEventQueryParams(searchParams));

    json(res, 200, {
      events,
      checkpoint: getCheckpoint(),
    });
  } catch (error) {
    console.error("[server] Query error:", error);

    json(res, 500, {
      error: "Query failed",
    });
  }
}

function handleHistory(
  res: http.ServerResponse,
  address: string,
  searchParams: URLSearchParams,
): void {
  try {
    const limit = numParam(searchParams, "limit");
    const offset = numParam(searchParams, "offset");
    const asset = searchParams.get("asset") ?? undefined;

    const events = queryHistory({ address, limit, offset, token: asset });

    json(res, 200, {
      events,
      address,
      limit: Math.min(limit ?? 50, 200),
      offset: offset ?? 0,
      checkpoint: getCheckpoint(),
    });
  } catch (error) {
    console.error("[server] History query error:", error);

    json(res, 500, {
      error: "Query failed",
    });
  }
}

/** Normalizes an ISO 8601 timestamp or bare date to a YYYY-MM-DD day string. */
function toDay(value: string): string | null {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function defaultRange(
  searchParams: URLSearchParams,
): { from: string; to: string } | null {
  const toRaw = searchParams.get("to");
  const fromRaw = searchParams.get("from");

  const to = toRaw ? toDay(toRaw) : new Date().toISOString().slice(0, 10);
  if (!to) return null;

  const from = fromRaw
    ? toDay(fromRaw)
    : new Date(Date.parse(`${to}T00:00:00.000Z`) - 29 * 86_400_000)
        .toISOString()
        .slice(0, 10);
  if (!from) return null;

  return { from, to };
}

function handleAnalyticsTvl(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
): void {
  try {
    const token = searchParams.get("token");
    if (!token) {
      return json(res, 400, { error: "token query param is required" });
    }

    const range = defaultRange(searchParams);
    if (!range) {
      return json(res, 400, { error: "from/to must be valid ISO 8601 dates" });
    }

    const network = (searchParams.get("network") ?? "testnet") as
      "mainnet" | "testnet";
    const cumulative = searchParams.get("cumulative") === "true";
    // Warm the decimals cache in the background; never blocks the response
    // (the display conversion below just falls back until it resolves).
    void getTokenDecimals(token, network);
    const decimals = getCachedTokenDecimals(token);

    const key = cacheKey(token, range.from, range.to, cumulative);
    const cached = cacheGet<ReturnType<typeof getTvlSeries>>(key);
    const points =
      cached ?? getTvlSeries(token, range.from, range.to, cumulative);
    if (!cached) cacheSet(key, points, range.to);

    const withDisplay = points.map((p) => ({
      ...p,
      total_locked_display: stroopsToDisplay(
        BigInt(p.total_locked_stroops),
        decimals,
      ),
    }));

    json(res, 200, {
      token,
      from: range.from,
      to: range.to,
      cumulative,
      decimals,
      points: withDisplay,
      cached: !!cached,
    });
  } catch (error) {
    console.error("[server] Analytics TVL error:", error);
    json(res, 500, { error: "Failed to compute TVL series" });
  }
}

function handleAnalyticsProtocolTotals(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
): void {
  try {
    const network = (searchParams.get("network") ?? "testnet") as
      "mainnet" | "testnet";
    if (network !== "mainnet" && network !== "testnet") {
      return json(res, 400, { error: "network must be mainnet or testnet" });
    }
    const totals = getProtocolTotals(network);
    json(res, 200, totals);
  } catch (error) {
    console.error("[server] Protocol totals query error:", error);
    json(res, 500, { error: "Failed to compute protocol totals" });
  }
}

function handleAnalyticsScheduleHistory(
  res: http.ServerResponse,
  scheduleId: number,
  searchParams: URLSearchParams,
): void {
  try {
    const range = defaultRange(searchParams);
    if (!range) {
      return json(res, 400, { error: "from/to must be valid ISO 8601 dates" });
    }

    const points = getScheduleHistory(scheduleId, range.from, range.to);
    json(res, 200, {
      schedule_id: scheduleId,
      from: range.from,
      to: range.to,
      points,
    });
  } catch (error) {
    console.error("[server] Analytics schedule history error:", error);
    json(res, 500, { error: "Failed to compute schedule history" });
  }
}

function handleAnalyticsGrantorSummary(
  res: http.ServerResponse,
  address: string,
): void {
  try {
    const summary = getGrantorSummary(address);
    json(res, 200, summary);
  } catch (error) {
    console.error("[server] Analytics grantor summary error:", error);
    json(res, 500, { error: "Failed to compute grantor summary" });
  }
}

function handleGives(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
): void {
  // Validate address-like params (Stellar public keys are 56 chars, uppercase)
  const sender = searchParams.get("sender") ?? undefined;
  const receiver = searchParams.get("receiver") ?? undefined;
  const token = searchParams.get("token") ?? undefined;

  if (sender && !/^G[A-Z2-7]{54,55}$/.test(sender)) {
    return json(res, 400, { error: "Invalid sender address" });
  }
  if (receiver && !/^G[A-Z2-7]{54,55}$/.test(receiver)) {
    return json(res, 400, { error: "Invalid receiver address" });
  }

  const fromRaw = searchParams.get("from") ?? undefined;
  const toRaw = searchParams.get("to") ?? undefined;

  if (fromRaw && isNaN(new Date(fromRaw).getTime())) {
    return json(res, 400, { error: "Invalid from date" });
  }
  if (toRaw && isNaN(new Date(toRaw).getTime())) {
    return json(res, 400, { error: "Invalid to date" });
  }

  const limitRaw = numParam(searchParams, "limit");
  if (
    limitRaw !== undefined &&
    (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100)
  ) {
    return json(res, 400, {
      error: "limit must be an integer between 1 and 100",
    });
  }

  try {
    const params: GiveQueryParams = {
      sender,
      receiver,
      token: token ?? undefined,
      from: fromRaw,
      to: toRaw,
      limit: limitRaw,
      cursor: searchParams.get("cursor") ?? undefined,
    };
    const gives = queryGives(params);
    return json(res, 200, { gives, count: gives.length });
  } catch (error) {
    console.error("[server] Gives query error:", error);
    return json(res, 500, { error: "Query failed" });
  }
}

/**
 * GET /gives/summary/:address — aggregate give activity for an address
 * across all tokens, computed from the indexed gives table. Addresses with
 * no activity resolve to zero values (HTTP 200), not 404.
 */
function handleGiveSummary(
  res: http.ServerResponse,
  address: string,
  searchParams: URLSearchParams,
): void {
  if (!STELLAR_ADDRESS.test(address)) {
    return json(res, 400, { error: "Invalid Stellar address" });
  }
  const network = networkParam(searchParams);
  if (!network) {
    return json(res, 400, { error: "network must be mainnet or testnet" });
  }

  try {
    const summary = getGiveSummary(address, network);
    return json(res, 200, summary);
  } catch (error) {
    console.error("[server] Give summary query error:", error);
    return json(res, 500, { error: "Query failed" });
  }
}

/**
 * DELETE /gives/:id — soft-delete a give record. Only the give's sender may
 * delete it. Requires `Authorization: Bearer <wallet JWT>`.
 * Returns 404 for an unknown give id and 403 when the caller is not the
 * give sender.
 */
function handleDeleteGive(
  res: http.ServerResponse,
  id: string,
  authorization: string | undefined,
): void {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return json(res, 503, {
      error: "JWT_SECRET is not configured — give deletion is disabled",
    });
  }
  const token = extractBearerToken(authorization);
  const payload = token ? verifyAuthToken(token, secret) : null;
  if (!payload) {
    return json(res, 401, { error: "Missing or invalid bearer token" });
  }

  const result = softDeleteGive(id, payload.sub);
  if (!result.ok) {
    if (result.existingSender === null) {
      return json(res, 404, { error: "Give not found" });
    }
    return json(res, 403, {
      error: "Only the give sender can delete this give",
    });
  }
  return json(res, 200, { ok: true, id });
}

/**
 * GET /profile/:address/recent-activity — the 10 most recent on-chain actions
 * for an address (give, receive, stream_set, collect), most recent first.
 */
function handleRecentActivity(
  res: http.ServerResponse,
  address: string,
  searchParams: URLSearchParams,
): void {
  if (!STELLAR_ADDRESS.test(address)) {
    return json(res, 400, { error: "address must be a valid Stellar address" });
  }
  const network = networkParam(searchParams);
  if (!network) {
    return json(res, 400, { error: "network must be mainnet or testnet" });
  }
  try {
    const events = queryRecentActivity(address, network);
    return json(res, 200, {
      address,
      network,
      events,
      count: events.length,
    });
  } catch (error) {
    console.error("[server] Recent activity query error:", error);
    return json(res, 500, { error: "Query failed" });
  }
}

/**
 * GET /streams/rate-changes/:address — paginated log of stream rate changes
 * for a sender address: timestamp, token, old_rate, new_rate.
 */
function handleRateChanges(
  res: http.ServerResponse,
  address: string,
  searchParams: URLSearchParams,
): void {
  if (!STELLAR_ADDRESS.test(address)) {
    return json(res, 400, { error: "address must be a valid Stellar address" });
  }
  const network = networkParam(searchParams);
  if (!network) {
    return json(res, 400, { error: "network must be mainnet or testnet" });
  }
  const limitRaw = limitParam(searchParams);
  const limit = limitRaw === undefined ? 50 : Math.min(limitRaw, 200);

  try {
    const page = queryStreamRateChanges({
      sender: address,
      limit,
      cursor: searchParams.get("cursor") ?? undefined,
      network,
    });
    return json(res, 200, {
      sender: address,
      network,
      rate_changes: page.items,
      next_cursor: page.next_cursor,
    });
  } catch (error) {
    console.error("[server] Stream rate changes query error:", error);
    return json(res, 500, { error: "Query failed" });
  }
}

/**
 * GET /profile/:address — aggregate an address's streams, splits, gives and
 * Drips lists into a single profile payload. Addresses with no activity
 * resolve to an empty profile (HTTP 200), not 404.
 */
function handleProfile(
  res: http.ServerResponse,
  address: string,
  searchParams: URLSearchParams,
): void {
  if (!STELLAR_ADDRESS.test(address)) {
    return json(res, 400, { error: "address must be a valid Stellar address" });
  }
  const network = networkParam(searchParams);
  if (!network) {
    return json(res, 400, { error: "network must be mainnet or testnet" });
  }

  try {
    const streamsPage = queryDripsStreams({ account: address, limit: 100, network });
    const splits = queryDripsSplits(address, network);
    const gives = queryGivesForAccount(address, network);
    const listsPage = queryDripsLists({ owner: address, limit: 100, network });

    const streams = (streamsPage?.items ?? []).map((s) => ({
      sender: address,
      receiver: s.receiver,
      token: s.token,
      ratePerSec: s.rate_per_second,
      maxEndTime: s.estimated_end_time ?? 0,
    }));
    const receivers = splits.receivers ?? [];
    const lists = listsPage?.items ?? [];

    const totalGiven = gives.reduce(
      (acc, g) => acc + (g.sender === address ? BigInt(g.amount_stroops) : 0n),
      0n,
    );

    return json(res, 200, {
      address,
      network,
      streams,
      splits: { receivers, hash: splits.hash ?? "" },
      gives,
      dripsLists: lists,
      totals: {
        streams: streams.length,
        splitsReceivers: receivers.length,
        gives: gives.length,
        totalGiven: totalGiven.toString(),
        dripsLists: lists.length,
      },
    });
  } catch (error) {
    console.error("[server] Profile query error:", error);
    return json(res, 500, { error: "Query failed" });
  }
}

function handleStreamConfig(
  res: http.ServerResponse,
  sender: string,
  receiver: string,
  token: string,
  searchParams: URLSearchParams,
): void {
  if (!STELLAR_ADDRESS.test(sender) || !STELLAR_ADDRESS.test(receiver)) {
    return json(res, 400, { error: "Invalid Stellar address" });
  }

  const network = networkParam(searchParams);
  if (!network) {
    return json(res, 400, { error: "network must be mainnet or testnet" });
  }

  const config = queryStreamConfig(sender, receiver, token, network);
  if (!config) {
    return json(res, 404, { error: "Stream not found" });
  }

  return json(res, 200, config);
}

function handleStreamHistory(
  res: http.ServerResponse,
  sender: string,
  receiver: string,
  token: string,
  searchParams: URLSearchParams,
): void {
  if (!STELLAR_ADDRESS.test(sender) || !STELLAR_ADDRESS.test(receiver)) {
    return json(res, 400, { error: "Invalid Stellar address" });
  }
  if (!token) {
    return json(res, 400, { error: "token is required" });
  }

  const limit = limitParam(searchParams);
  if (limit === null || (limit !== undefined && limit > 200)) {
    return json(res, 400, { error: "limit must be a positive integer no greater than 200" });
  }
  const network = networkParam(searchParams);
  if (!network) {
    return json(res, 400, { error: "network must be mainnet or testnet" });
  }

  const page = queryStreamHistory({
    sender,
    receiver,
    token,
    limit,
    cursor: searchParams.get("cursor") ?? undefined,
    network,
  });
  if (page === "not_found") {
    return json(res, 404, { error: "Stream history not found" });
  }
  if (page === null) {
    return json(res, 400, { error: "cursor is invalid" });
  }
  return json(res, 200, {
    history: page.items,
    next_cursor: page.nextCursor,
  });
}

function handleAnalyticsCycles(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
): void {
  const network = networkParam(searchParams);
  if (!network) {
    return json(res, 400, { error: "network must be mainnet or testnet" });
  }

  const account = searchParams.get("account") ?? undefined;
  const token = searchParams.get("token") ?? undefined;
  const limit = numParam(searchParams, "limit");
  const from = numParam(searchParams, "from");
  const to = numParam(searchParams, "to");
  const cursor = searchParams.get("cursor") ?? undefined;

  const cycles = queryStreamCycles({
    account,
    token,
    limit,
    from,
    to,
    cursor,
    network,
  });
  return json(res, 200, { cycles });
}

function handleAnalyticsTopReceivers(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
): void {
  const token = searchParams.get("token");
  if (!token) {
    return json(res, 400, { error: "token query param is required" });
  }

  const network = networkParam(searchParams);
  if (!network) {
    return json(res, 400, { error: "network must be mainnet or testnet" });
  }

  const rawLimit = searchParams.get("limit");
  let limit = 10;
  if (rawLimit != null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
      return json(res, 400, { error: "limit must be an integer between 1 and 50" });
    }
    limit = parsed;
  }

  const key = cacheKey(`top-receivers:${network}:${token}`, String(limit), "current", false);
  const cached = cacheGet<ReturnType<typeof queryTopReceivers>>(key);
  const receivers = cached ?? queryTopReceivers(token, limit, network);
  if (!cached) {
    cacheSet(key, receivers, "current");
  }

  return json(res, 200, { receivers, cached: !!cached });
}

/** In-memory TTL for the stream-volume aggregate (#1070): 10 minutes. */
const STREAM_VOLUME_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * GET /analytics/stream-volume?token= — total token volume streamed over the
 * trailing 7 and 30 day windows, plus the number of streams that settled in
 * each window (#1070). Responses are cached for 10 minutes.
 */
function handleStreamVolume(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
): void {
  const token = searchParams.get("token");
  if (!token) {
    return json(res, 400, { error: "token query param is required" });
  }

  const network = networkParam(searchParams);
  if (!network) {
    return json(res, 400, { error: "network must be mainnet or testnet" });
  }

  const key = cacheKey(`stream-volume:${network}:${token}`, "7d", "30d", false);
  const cached = cacheGet<ReturnType<typeof getStreamVolume>>(key);
  const stats = cached ?? getStreamVolume(token, network);
  if (!cached) {
    // `"rolling"` is a non-date marker: the entry opts out of per-ledger
    // invalidation and simply expires after the 10 minute TTL.
    cacheSet(key, stats, "rolling", STREAM_VOLUME_CACHE_TTL_MS);
  }

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=600, stale-while-revalidate=120",
  });
  res.end(JSON.stringify(stats));
}

/**
 * GET /splits/by-receiver/:address — accounts whose current splits
 * configuration routes to `address`, with the weight (bps) and percentage
 * each account assigns it (#1071). Offset-paginated via `limit`/`offset`.
 */
function handleSplitsByReceiver(
  res: http.ServerResponse,
  address: string,
  searchParams: URLSearchParams,
): void {
  if (!STELLAR_ADDRESS.test(address)) {
    return json(res, 400, { error: "address must be a valid Stellar address" });
  }

  const network = networkParam(searchParams);
  if (!network) {
    return json(res, 400, { error: "network must be mainnet or testnet" });
  }

  const limit = limitParam(searchParams);
  const offsetRaw = searchParams.get("offset");
  let offset = 0;
  if (offsetRaw != null) {
    const parsed = Number(offsetRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return json(res, 400, { error: "offset must be a non-negative integer" });
    }
    offset = parsed;
  }
  if (limit === null) {
    return json(res, 400, { error: "limit must be a positive integer" });
  }

  const page = querySplitsByReceiver({
    address,
    limit: limit === undefined ? undefined : Math.min(limit, 100),
    offset,
    network,
  });

  return json(res, 200, {
    address,
    accounts: page.rows,
    total: page.total,
    limit: limit === undefined ? 50 : Math.min(limit, 100),
    offset,
    has_more: offset + page.rows.length < page.total,
  });
}

export function createServer(): http.Server {
  getDatabasePoolConfig();
  return http.createServer(async (req, res) => {
    let url: URL;

    try {
      url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    } catch {
      return json(res, 400, {
        error: "Invalid URL",
      });
    }

    const startedAt = process.hrtime.bigint();
    const requestPath = metricsRoute(url.pathname);
    res.once("finish", () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      recordHttpRequest(
        req.method ?? "GET",
        requestPath,
        res.statusCode,
        durationSeconds,
      );
    });

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      });
      return res.end();
    }

    // Webhook management routes handle their own methods and auth.
    if (url.pathname === "/webhooks" || url.pathname.startsWith("/webhooks/")) {
      try {
        if (await routeWebhookRequest(req, res, url)) return;
      } catch (error) {
        console.error("[server] Webhook route error:", error);
        return json(res, 500, { error: "Webhook request failed" });
      }
    }

    // In-app notification API + SSE stream (own methods and auth).
    if (
      url.pathname === "/events/stream" ||
      url.pathname === "/notifications" ||
      url.pathname.startsWith("/notifications/")
    ) {
      try {
        if (await routeNotificationsRequest(req, res, url)) return;
      } catch (error) {
        console.error("[server] Notification route error:", error);
        return json(res, 500, { error: "Notification request failed" });
      }
    }

    // Balance SSE stream (#1105)
    if (url.pathname === "/sse/balance") {
      const account =
        url.searchParams.get("account") ?? url.searchParams.get("wallet");
      const token = url.searchParams.get("token");

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });

      res.write("retry: 1000\n\n");
      registerBalanceStream(account, token, res);
      return;
    }

    // DELETE /gives/:id — soft-delete a give (sender-only, bearer auth).
    const giveDeleteMatch = url.pathname.match(/^\/gives\/([^/]+)$/);
    if (giveDeleteMatch) {
      if (req.method === "DELETE") {
        return handleDeleteGive(
          res,
          decodeURIComponent(giveDeleteMatch[1]),
          req.headers.authorization,
        );
      }
      return json(res, 405, { error: "Method not allowed" });
    }

    // GET /profile/:address/recent-activity
    const recentActivityMatch = url.pathname.match(
      /^\/profile\/(G[A-Z2-7]{55})\/recent-activity$/,
    );
    if (recentActivityMatch) {
      return handleRecentActivity(
        res,
        recentActivityMatch[1],
        url.searchParams,
      );
    }

    // GET /streams/rate-changes/:address
    const rateChangesMatch = url.pathname.match(
      /^\/streams\/rate-changes\/(G[A-Z2-7]{55})$/,
    );
    if (rateChangesMatch) {
      return handleRateChanges(res, rateChangesMatch[1], url.searchParams);
    }

    if (req.method !== "GET") {
      return json(res, 405, {
        error: "Method not allowed",
      });
    }

    const historyMatch = url.pathname.match(
      /^\/schedules\/([A-Z0-9]{56})\/history$/,
    );
    const scheduleAnalyticsMatch = url.pathname.match(
      /^\/analytics\/schedules\/(\d+)\/history$/,
    );
    const grantorAnalyticsMatch = url.pathname.match(
      /^\/analytics\/grantors\/([A-Z0-9]{56})\/summary$/,
    );
    const listMembersMatch = url.pathname.match(/^\/lists\/([^/]+)\/members$/);
    const profileMatch = url.pathname.match(/^\/profile\/(G[A-Z2-7]{55})$/);
    const giveSummaryMatch = url.pathname.match(/^\/gives\/summary\/([^/]+)$/);
    const streamHistoryMatch = url.pathname.match(
      /^\/streams\/history\/([^/]+)\/([^/]+)\/([^/]+)$/,
    );
    const streamConfigMatch = url.pathname.match(
      /^\/streams\/([^/]+)\/([^/]+)\/([^/]+)$/,
    );
    const splitsByReceiverMatch = url.pathname.match(
      /^\/splits\/by-receiver\/([^/]+)$/,
    );

    switch (url.pathname) {
      case "/metrics":
        return handleMetrics(res, req.headers.authorization);

      case "/health":
        return handleHealth(res);

      case "/events":
        return handleEvents(res, url.searchParams);

      case "/stats/tvl":
        return handleTvl(res, url.searchParams);

      case "/analytics/tvl":
        return handleAnalyticsTvl(res, url.searchParams);

      case "/analytics/protocol/totals":
        return handleAnalyticsProtocolTotals(res, url.searchParams);

      case "/analytics/cycles":
        return handleAnalyticsCycles(res, url.searchParams);

      case "/analytics/top-receivers":
        return handleAnalyticsTopReceivers(res, url.searchParams);

      case "/analytics/stream-volume":
        return handleStreamVolume(res, url.searchParams);

      case "/gives":
        return handleGives(res, url.searchParams);
      case "/analytics/streams/tvl":
        return handleStreamsTvl(res, url.searchParams);

      case "/lists":
        return handleLists(res, url.searchParams);

      case "/streams":
        return handleStreams(res, url.searchParams, req.headers["if-none-match"]);
      case "/streams/expiring":
        return handleStreamsExpiring(res, url.searchParams);

      case "/splits":
        return handleSplits(res, url.searchParams, req.headers["if-none-match"]);

      default:
        if (splitsByReceiverMatch) {
          return handleSplitsByReceiver(
            res,
            decodeURIComponent(splitsByReceiverMatch[1]),
            url.searchParams,
          );
        }
        if (streamHistoryMatch) {
          return handleStreamHistory(
            res,
            decodeURIComponent(streamHistoryMatch[1]),
            decodeURIComponent(streamHistoryMatch[2]),
            decodeURIComponent(streamHistoryMatch[3]),
            url.searchParams,
          );
        }
        if (streamConfigMatch) {
          return handleStreamConfig(
            res,
            decodeURIComponent(streamConfigMatch[1]),
            decodeURIComponent(streamConfigMatch[2]),
            decodeURIComponent(streamConfigMatch[3]),
            url.searchParams,
          );
        }
        if (historyMatch) {
          return handleHistory(res, historyMatch[1], url.searchParams);
        }
        if (scheduleAnalyticsMatch) {
          return handleAnalyticsScheduleHistory(
            res,
            Number(scheduleAnalyticsMatch[1]),
            url.searchParams,
          );
        }
        if (grantorAnalyticsMatch) {
          return handleAnalyticsGrantorSummary(res, grantorAnalyticsMatch[1]);
        }
        if (listMembersMatch) {
          return handleListMembers(
            res,
            decodeURIComponent(listMembersMatch[1]),
            url.searchParams,
          );
        }
        if (profileMatch) {
          return handleProfile(res, profileMatch[1], url.searchParams);
        }
        if (giveSummaryMatch) {
          return handleGiveSummary(
            res,
            decodeURIComponent(giveSummaryMatch[1]),
            url.searchParams,
          );
        }
        return json(res, 404, {
          error: "Not found",
        });
    }
  });
}

// Only bind a port when executed directly — tests import createServer().
if (typeof require !== "undefined" && require.main === module) {
  const server = createServer();

  server.listen(PORT, () => {
    console.log(`[server] Indexer query API → http://localhost:${PORT}`);
    console.log("[server]   GET /health");
    console.log(
      "[server]   GET /events?address=G...&event_type=claimed&limit=50",
    );
    console.log("[server]   POST /webhooks (Bearer wallet JWT)");
    console.log("[server]   GET  /webhooks/:id/deliveries?status=&limit=");
    console.log("[server]   GET  /events/stream?wallet=G… (SSE)");
    console.log("[server]   GET  /notifications?page=&limit=&type=&read=");
    console.log(
      "[server]   POST /notifications/read | /notifications/read-all",
    );
    console.log(
      "[server]   GET  /analytics/tvl?token=<address>&from=&to=&cumulative=true",
    );
    console.log("[server]   GET  /analytics/schedules/:id/history?from=&to=");
    console.log("[server]   GET  /analytics/grantors/:address/summary");
  });

  startNotificationFanout();
}
