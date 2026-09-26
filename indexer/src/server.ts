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
  getDripsStreamingTvl,
  getDripsStreamsLastUpdated,
  getGiveSummary,
  getTvlStats,
  queryDripsListMembers,
  queryDripsLists,
  queryDripsSplits,
  queryDripsStreams,
  queryEvents,
  queryGives,
  queryGivesForAccount,
  queryHistory,
  queryStreamConfig,
  queryStreamHistory,
  queryStreamCycles,
  queryTopReceivers,
} from "./db";
import type { EventQueryParams, GiveQueryParams } from "./types";
import { routeWebhookRequest } from "./webhook-api";
import { routeNotificationsRequest } from "./notifications-api";
import { startNotificationFanout } from "./sse";
import {
  getTvlSeries,
  getScheduleHistory,
  getGrantorSummary,
} from "./analytics";
import { cacheKey, cacheGet, cacheSet } from "./analytics-cache";
import { getDatabasePoolConfig } from "./config";
import {
  getCachedTokenDecimals,
  getTokenDecimals,
  stroopsToDisplay,
} from "./token-metadata";
import {
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

function handleHealth(res: http.ServerResponse): void {
  json(res, 200, {
    ok: true,
    checkpoint: getCheckpoint(),
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

      case "/analytics/cycles":
        return handleAnalyticsCycles(res, url.searchParams);

      case "/analytics/top-receivers":
        return handleAnalyticsTopReceivers(res, url.searchParams);

      case "/gives":
        return handleGives(res, url.searchParams);
      case "/analytics/streams/tvl":
        return handleStreamsTvl(res, url.searchParams);

      case "/lists":
        return handleLists(res, url.searchParams);

      case "/streams":
        return handleStreams(res, url.searchParams, req.headers["if-none-match"]);

      case "/splits":
        return handleSplits(res, url.searchParams, req.headers["if-none-match"]);

      default:
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
