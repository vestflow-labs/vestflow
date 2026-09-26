import { NextRequest, NextResponse } from "next/server";
import { queryDripsLists } from "@/indexer/src/db";
import { parseNetwork } from "@/indexer/src/config";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { withLogging } from "@/lib/requestLogger";
import { createVersionedHandler } from "@/lib/versionedRoute";

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

const rateLimiter = createIpBasedRateLimiter(60000, 30);

/**
 * GET /api/lists/funded-by/:address?limit=20&cursor=...&network=testnet
 *
 * Returns all drips lists the given address is currently funding —
 * each with the list ID, name, member count, and the funder's total rate.
 *
 * Response shape:
 *   { lists: Array<{ id, name, member_count, total_rate, target_rate_per_sec, token }>,
 *     next_cursor, funder, network }
 */
export const GET = withLogging(async function GET(
  request: NextRequest,
  context?: { params: Promise<{ address: string }> }
): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) return rateLimitResponse;

  const address = context?.params
    ? (await context.params).address
    : request.nextUrl.pathname.split("/")[4];

  if (!address || !STELLAR_ADDRESS_RE.test(address)) {
    return NextResponse.json(
      { error: "Invalid Stellar address format" },
      { status: 400 }
    );
  }

  const rawLimit = request.nextUrl.searchParams.get("limit");
  let limit = 20;
  if (rawLimit != null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return NextResponse.json(
        { error: "limit must be an integer between 1 and 100" },
        { status: 400 }
      );
    }
    limit = parsed;
  }
  const cursor =
    request.nextUrl.searchParams.get("cursor") ?? undefined;
  const network = parseNetwork(
    request.nextUrl.searchParams.get("network") || undefined
  );

  try {
    const page = queryDripsLists({
      owner: address,
      limit,
      cursor,
      network,
    });
    if (page === null) {
      return NextResponse.json(
        { error: "cursor is invalid" },
        { status: 400 }
      );
    }

    const lists = page.items.map((list) => ({
      id: list.id,
      name: list.name,
      member_count: list.member_count,
      total_rate: list.total_funding_rate_per_sec,
      total_funding_rate_per_sec: list.total_funding_rate_per_sec,
      target_rate_per_sec: list.target_rate_per_sec,
      token: list.token,
    }));

    return NextResponse.json(
      { lists, next_cursor: page.nextCursor, funder: address },
      { headers: { "Cache-Control": "public, max-age=10" } }
    );
  } catch (error) {
    console.error("Error querying funded lists:", error);
    return NextResponse.json(
      { error: "Failed to query funded lists" },
      { status: 500 }
    );
  }
});

export const GET_VERSIONED = createVersionedHandler(GET);
