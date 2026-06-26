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
 */

import http from "http";
import { URL } from "url";
import { getCheckpoint, queryEvents } from "./db";
import type { EventQueryParams } from "./types";

const PORT = Number(process.env.INDEXER_PORT ?? "3001");

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });

  res.end(JSON.stringify(body));
}

function numParam(
  params: URLSearchParams,
  key: string
): number | undefined {
  const value = params.get(key);

  if (value == null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildEventQueryParams(
  searchParams: URLSearchParams
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

function handleHealth(res: http.ServerResponse): void {
  json(res, 200, {
    ok: true,
    checkpoint: getCheckpoint(),
  });
}

function handleEvents(
  res: http.ServerResponse,
  searchParams: URLSearchParams
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

function createServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== "GET") {
      return json(res, 405, {
        error: "Method not allowed",
      });
    }

    let url: URL;

    try {
      url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    } catch {
      return json(res, 400, {
        error: "Invalid URL",
      });
    }

    switch (url.pathname) {
      case "/health":
        return handleHealth(res);

      case "/events":
        return handleEvents(res, url.searchParams);

      default:
        return json(res, 404, {
          error: "Not found",
        });
    }
  });
}

const server = createServer();

server.listen(PORT, () => {
  console.log(`[server] Indexer query API → http://localhost:${PORT}`);
  console.log("[server]   GET /health");
  console.log(
    "[server]   GET /events?address=G...&event_type=claimed&limit=50"
  );
});
