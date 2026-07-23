import { NextRequest, NextResponse } from "next/server";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

/**
 * GET /api/events — proxy to the running indexer query server.
 *
 * Accepted query params (all optional):
 *   address=G...        match grantor OR beneficiary
 *   grantor=G...
 *   beneficiary=G...
 *   event_type=claimed|schedule_created|revoked
 *   schedule_id=42
 *   from_ledger=123456
 *   to_ledger=234567
 *   limit=50            max 200
 *   offset=0
 *   network=testnet|mainnet
 *
 * In local development: start the indexer first (cd indexer && npm run dev:all).
 * In production: set INDEXER_URL to point at the deployed indexer service.
 */

const INDEXER_URL =
  process.env.INDEXER_URL ?? "http://localhost:3001";

function indexerUrlFor(network: string | null): string {
  if (network === "mainnet") {
    return process.env.INDEXER_MAINNET_URL ?? INDEXER_URL;
  }
  return process.env.INDEXER_TESTNET_URL ?? INDEXER_URL;
}

const ALLOWED_PARAMS = new Set([
  "address",
  "grantor",
  "beneficiary",
  "event_type",
  "schedule_id",
  "from_ledger",
  "to_ledger",
  "limit",
  "offset",
  "network",
]);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(req);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const network = req.nextUrl.searchParams.get("network");
    if (network != null && network !== "mainnet" && network !== "testnet") {
      return NextResponse.json(
        { error: "network must be either mainnet or testnet" },
        { status: 400 }
      );
    }
    const upstream = new URL(`${indexerUrlFor(network)}/events`);

    // Forward only known, safe params — avoids passing arbitrary values
    // to the indexer query layer.
    for (const [key, value] of req.nextUrl.searchParams.entries()) {
      if (ALLOWED_PARAMS.has(key)) {
        upstream.searchParams.set(key, value);
      }
    }

    const res = await fetch(upstream.toString(), {
      next: { revalidate: 30 }, // Cache for 30s; events are append-only
    });

    const data: unknown = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      {
        error:
          "Indexer service unavailable. " +
          "Run `cd indexer && npm run dev:all` to start it locally.",
      },
      { status: 503 }
    );
  }
}
