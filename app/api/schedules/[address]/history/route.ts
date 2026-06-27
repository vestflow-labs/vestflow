import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/schedules/:address/history
 *
 * Paginated claim and revoke history for a Stellar address (grantor or
 * beneficiary). Proxies to the running indexer query server.
 *
 * Query params:
 *   limit=50       max 200, default 50
 *   offset=0       default 0
 *   asset=C...     filter by asset contract address
 *   network=testnet|mainnet
 */

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:3001";

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
      `${indexerUrlFor(network)}/schedules/${encodeURIComponent(address)}/history`
    );

    const limit = req.nextUrl.searchParams.get("limit");
    const offset = req.nextUrl.searchParams.get("offset");
    const asset = req.nextUrl.searchParams.get("asset");

    if (limit) upstream.searchParams.set("limit", limit);
    if (offset) upstream.searchParams.set("offset", offset);
    if (asset) upstream.searchParams.set("asset", asset);

    const res = await fetch(upstream.toString(), {
      next: { revalidate: 30 },
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
