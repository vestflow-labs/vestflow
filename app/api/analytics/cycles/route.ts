import { NextRequest, NextResponse } from "next/server";
import {
  queryStreamCycles,
  encodeStreamCycleCursor,
  getCollectedTotal,
} from "@/indexer/src/db";
import { parseNetwork } from "@/indexer/src/config";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { withLogging } from "@/lib/requestLogger";
import { createVersionedHandler } from "@/lib/versionedRoute";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

function parseDateBound(value: string | null): number | undefined | null {
  if (value == null || value === "") return undefined;
  // Accept unix seconds…
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== "" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Math.floor(numeric);
  }
  // …or ISO-8601 / date strings.
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

/**
 * GET /api/analytics/cycles?account=G...&token=C...&from=&to=&limit=&cursor=&network=
 *
 * Returns per-cycle settlement amounts from indexed settlement events:
 *   { cycles: Array<{ cycle_end, amount_received, amount_collected }>,
 *     next_cursor }
 *
 * - `from` / `to` filter on the cycle end timestamp (unix seconds or ISO date).
 * - Sorted by cycle_end descending.
 * - Keyset-paginated with limit + cursor.
 */
export const GET = withLogging(async function GET(
  request: NextRequest
): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const params = request.nextUrl.searchParams;
    const account = params.get("account") ?? undefined;
    const token = params.get("token") ?? undefined;
    const cursor = params.get("cursor") ?? undefined;
    const network = parseNetwork(params.get("network") || undefined);

    const rawLimit = params.get("limit");
    let limit = 50;
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

    const from = parseDateBound(params.get("from"));
    if (from === null) {
      return NextResponse.json(
        { error: "from must be a unix timestamp or ISO-8601 date" },
        { status: 400 }
      );
    }
    const to = parseDateBound(params.get("to"));
    if (to === null) {
      return NextResponse.json(
        { error: "to must be a unix timestamp or ISO-8601 date" },
        { status: 400 }
      );
    }
    if (from != null && to != null && from > to) {
      return NextResponse.json(
        { error: "from must not be after to" },
        { status: 400 }
      );
    }

    // Fetch one extra row to detect a following page.
    const rows = queryStreamCycles({
      account,
      token,
      limit: limit + 1,
      from,
      to,
      cursor,
      network,
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const cycles = page.map((row) => {
      let amountCollected = row.amount_received;
      try {
        if (account && token) {
          const total = getCollectedTotal(account, token, network);
          if (total !== "0") amountCollected = total;
        }
      } catch {
        // collected_totals is best-effort enrichment; never fail the request.
      }
      return {
        cycle_end: row.cycle_end_timestamp,
        cycle_end_ledger: row.cycle_end_ledger,
        account: row.account,
        token: row.token,
        amount_received: row.amount_received,
        amount_collected: amountCollected,
      };
    });

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeStreamCycleCursor({
            cycle_end_timestamp: last.cycle_end_timestamp,
            cycle_end_ledger: last.cycle_end_ledger,
          })
        : null;

    return NextResponse.json(
      { cycles, next_cursor: nextCursor },
      {
        headers: { "Cache-Control": "public, max-age=10" },
      }
    );
  } catch (error) {
    console.error("Error in GET /analytics/cycles:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
});

export const GET_VERSIONED = createVersionedHandler(GET);
