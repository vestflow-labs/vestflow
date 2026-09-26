import { NextRequest, NextResponse } from "next/server";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";

/**
 * GET /api/gives/summary/:address
 *
 * Aggregate give activity for a Stellar address, computed from the indexed
 * gives table across all tokens:
 *   { total_given, total_received, unique_senders, unique_receivers,
 *     give_count, receive_count }
 *
 * Proxies to the running indexer query server.
 * Returns zero values (not 404) when the address has no activity.
 */

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:3001";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

function indexerUrlFor(network: string | null): string {
  if (network === "mainnet") {
    return process.env.INDEXER_MAINNET_URL ?? INDEXER_URL;
  }
  return process.env.INDEXER_TESTNET_URL ?? INDEXER_URL;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(req);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const { address } = await params;

    if (!address || !/^G[A-Z2-7]{55}$/.test(address)) {
      return NextResponse.json(
        { error: "Invalid Stellar address" },
        { status: 400 }
      );
    }

    const network = req.nextUrl.searchParams.get("network");
    if (network != null && network !== "mainnet" && network !== "testnet") {
      return NextResponse.json(
        { error: "network must be either mainnet or testnet" },
        { status: 400 }
      );
    }

    const upstream = new URL(
      `${indexerUrlFor(network)}/gives/summary/${encodeURIComponent(address)}`
    );
    if (network) upstream.searchParams.set("network", network);

    const res = await fetch(upstream.toString(), {
      next: { revalidate: 30 },
    });

    const data: unknown = await res.json();
    return NextResponse.json(data, {
      status: res.status,
      headers: {
        "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
      },
    });
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
