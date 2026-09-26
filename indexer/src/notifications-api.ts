/**
 * VestFlow — in-app notification HTTP API
 *
 * Mounted on the indexer query server alongside the webhook API:
 *
 *   GET  /events/stream?wallet=<address>   SSE stream (replay via Last-Event-ID)
 *   GET  /notifications?page=&limit=&type=&read=
 *   POST /notifications/read               body { event_ids: string[] }
 *   POST /notifications/read-all
 *   GET  /notifications/unread-count
 *
 * All routes require `Authorization: Bearer <wallet JWT>`; the stream also
 * requires the `wallet` query param to match the JWT subject.
 */

import type http from "http";
import { extractBearerToken, verifyAuthToken } from "./auth";
import type { NetworkName } from "./config";
import {
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationsRead,
  queryNotifications,
} from "./app-notifications";
import { registerStream } from "./sse";

const MAX_BODY_BYTES = 64 * 1024;

export interface NotificationsApiOptions {
  network?: NetworkName;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }

  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authenticate(
  req: http.IncomingMessage,
  res: http.ServerResponse
): string | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    json(res, 503, { error: "JWT_SECRET is not configured" });
    return null;
  }

  const token = extractBearerToken(req.headers.authorization);
  const payload = token ? verifyAuthToken(token, secret) : null;
  if (!payload) {
    json(res, 401, { error: "Missing or invalid bearer token" });
    return null;
  }
  return payload.sub;
}

function parseNumber(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ── SSE stream ────────────────────────────────────────────────────────

function handleStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  owner: string
): void {
  const wallet = url.searchParams.get("wallet");
  if (!wallet) {
    return json(res, 400, { error: "wallet query parameter is required" });
  }
  if (wallet !== owner) {
    return json(res, 403, { error: "wallet does not match token subject" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });

  // Reconnect hint + initial comment so headers flush immediately.
  res.write("retry: 1000\n\n");

  // The browser's EventSource sends Last-Event-ID automatically; fetch-based
  // clients send the header explicitly. Fall back to a query param for
  // clients that cannot set headers.
  const lastEventIdHeader = req.headers["last-event-id"];
  const lastEventId = parseNumber(
    Array.isArray(lastEventIdHeader)
      ? lastEventIdHeader[0]
      : lastEventIdHeader ?? url.searchParams.get("lastEventId")
  );

  registerStream(owner, res, lastEventId ?? null);
}

// ── History / read state ──────────────────────────────────────────────

function handleList(
  res: http.ServerResponse,
  url: URL,
  owner: string,
  options: NotificationsApiOptions
): void {
  const typeParam = url.searchParams.get("type");
  const readParam = parseNumber(url.searchParams.get("read"));

  const page = queryNotifications({
    wallet: owner,
    page: parseNumber(url.searchParams.get("page")) ?? 1,
    limit: parseNumber(url.searchParams.get("limit")) ?? 50,
    types: typeParam
      ? typeParam.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined,
    read: readParam === 0 || readParam === 1 ? readParam : undefined,
    network: options.network,
  });

  json(res, 200, page);
}

async function handleMarkRead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  options: NotificationsApiOptions
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return json(res, 400, {
      error: error instanceof Error ? error.message : "Invalid JSON body",
    });
  }

  const rawIds = (body as { event_ids?: unknown })?.event_ids;
  if (!Array.isArray(rawIds)) {
    return json(res, 400, { error: "event_ids must be an array" });
  }

  const ids = rawIds.map((id) => Number(id)).filter((n) => Number.isInteger(n) && n > 0);
  const changed = markNotificationsRead(owner, ids, options.network);

  json(res, 200, { updated: changed, unread: getUnreadCount(owner, options.network) });
}

function handleMarkAllRead(
  res: http.ServerResponse,
  owner: string,
  options: NotificationsApiOptions
): void {
  const changed = markAllNotificationsRead(owner, options.network);
  json(res, 200, { updated: changed, unread: 0 });
}

function handleUnreadCount(
  res: http.ServerResponse,
  owner: string,
  options: NotificationsApiOptions
): void {
  json(res, 200, { unread: getUnreadCount(owner, options.network) });
}

// ── Router ────────────────────────────────────────────────────────────

/**
 * Handles any `/events/stream` or `/notifications…` request. Returns false
 * when the path is not one of these routes so the caller can keep routing.
 */
export async function routeNotificationsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: NotificationsApiOptions = {}
): Promise<boolean> {
  const pathname = url.pathname;
  const isStream = pathname === "/events/stream";
  const isNotifications =
    pathname === "/notifications" || pathname.startsWith("/notifications/");

  if (!isStream && !isNotifications) return false;

  const owner = authenticate(req, res);
  if (!owner) return true;

  const method = req.method ?? "GET";

  if (isStream) {
    if (method !== "GET") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    handleStream(req, res, url, owner);
    return true;
  }

  if (pathname === "/notifications" && method === "GET") {
    handleList(res, url, owner, options);
    return true;
  }
  if (pathname === "/notifications/read" && method === "POST") {
    await handleMarkRead(req, res, owner, options);
    return true;
  }
  if (pathname === "/notifications/read-all" && method === "POST") {
    handleMarkAllRead(res, owner, options);
    return true;
  }
  if (pathname === "/notifications/unread-count" && method === "GET") {
    handleUnreadCount(res, owner, options);
    return true;
  }

  json(res, 405, { error: "Method not allowed" });
  return true;
}
