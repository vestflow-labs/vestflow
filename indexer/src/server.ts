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
 *   GET /gives/summary/:address
 */

import http from "http";
import { URL } from "url";
import { getCheckpoint, getGiveSummary, queryEvents, queryHistory } from "./db";
import { parseNetwork } from "./config";
import type { EventQueryParams } from "./types";

const PORT = Number(process.env.INDEXER_PORT ?? "3001");

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...(headers ?? {}),
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

function handleHistory(
  res: http.ServerResponse,
  address: string,
  searchParams: URLSearchParams
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

function handleGiveSummary(
  res: http.ServerResponse,
  address: string,
  searchParams: URLSearchParams
): void {
  if (!STELLAR_ADDRESS_RE.test(address)) {
    return json(res, 400, {
      error: "Invalid Stellar address",
    });
  }

  try {
    const networkParam = searchParams.get("network");
    const network =
      networkParam == null || networkParam === ""
        ? undefined
        : parseNetwork(networkParam);
    const summary = getGiveSummary(address, network);

    json(
      res,
      200,
      summary,
      {
        "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
      }
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported network")) {
      return json(res, 400, {
        error: "network must be either mainnet or testnet",
      });
    }
    console.error("[server] Give summary query error:", error);

    json(res, 500, {
      error: "Query failed",
    });
  }
}

export function createServer(): http.Server {
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

    const historyMatch = url.pathname.match(
      /^\/schedules\/([A-Z0-9]{56})\/history$/
    );
    const giveSummaryMatch = url.pathname.match(
      /^\/gives\/summary\/([^/]+)$/
    );

    switch (url.pathname) {
      case "/health":
        return handleHealth(res);

      case "/events":
        return handleEvents(res, url.searchParams);

      default:
        if (historyMatch) {
          return handleHistory(res, historyMatch[1], url.searchParams);
        }
        if (giveSummaryMatch) {
          return handleGiveSummary(
            res,
            decodeURIComponent(giveSummaryMatch[1]),
            url.searchParams
          );
        }
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
  console.log("[server]   GET /gives/summary/:address");
});
