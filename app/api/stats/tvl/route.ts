import { NextRequest, NextResponse } from "next/server";

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:3001";

function networkParam(req: NextRequest): "mainnet" | "testnet" | null {
  const value = req.nextUrl.searchParams.get("network");
  if (value == null || value === "") return "testnet";
  return value === "mainnet" || value === "testnet" ? value : null;
}

function indexerUrlFor(network: "mainnet" | "testnet"): string {
  if (network === "mainnet") {
    return process.env.INDEXER_MAINNET_URL ?? INDEXER_URL;
  }
  return process.env.INDEXER_TESTNET_URL ?? INDEXER_URL;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const network = networkParam(req);
  if (network == null) {
    return NextResponse.json(
      { error: "network must be either mainnet or testnet" },
      { status: 400 }
    );
  }

  try {
    const upstream = new URL(`${indexerUrlFor(network)}/stats/tvl`);
    upstream.searchParams.set("network", network);

    const res = await fetch(upstream.toString(), {
      next: { revalidate: 60 },
    });

    const data: unknown = await res.json();
    return NextResponse.json(data, {
      status: res.status,
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
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
