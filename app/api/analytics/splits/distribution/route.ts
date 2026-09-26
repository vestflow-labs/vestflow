import { NextRequest, NextResponse } from "next/server";
import { getSplitsDistribution } from "@/indexer/src/db";
import { parseNetwork } from "@/indexer/src/config";
import { getOrSetCache } from "@/lib/redisCache";
import { withLogging } from "@/lib/requestLogger";

const CACHE_TTL_SECONDS = 300; // 5 minutes, per acceptance criteria

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  const network = parseNetwork(request.nextUrl.searchParams.get("network") || undefined);

  try {
    const cacheKey = `analytics:splits:distribution:${network}`;
    const buckets = await getOrSetCache(cacheKey, CACHE_TTL_SECONDS, async () =>
      getSplitsDistribution(network),
    );

    // Always returns all five buckets (zero-filled when no splits are
    // configured) — getSplitsDistribution seeds every bucket up front.
    return NextResponse.json(buckets, {
      headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" },
    });
  } catch (error) {
    console.error("Error fetching splits distribution:", error);
    return NextResponse.json({ error: "Failed to fetch splits distribution" }, { status: 500 });
  }
});
