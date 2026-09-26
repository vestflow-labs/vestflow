import { NextRequest, NextResponse } from "next/server";
import { queryDripsLists, getDb } from "@/indexer/src/db";
import { parseNetwork } from "@/indexer/src/config";
import { withLogging } from "@/lib/requestLogger";
import { createErrorResponse } from "@/lib/apiError";
import { createVersionedHandler } from "@/lib/versionedRoute";

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const owner = searchParams.get("owner") || undefined;
  const limitStr = searchParams.get("limit") || "50";
  const limit = Math.min(Math.max(1, parseInt(limitStr, 10) || 50), 100);
  const cursor = searchParams.get("cursor") || undefined;
  const network = parseNetwork(searchParams.get("network") || undefined);

  try {
    const page = queryDripsLists({ owner, limit, cursor, network });
    if (!page) {
      return createErrorResponse(
        400,
        "Invalid query parameters",
        request
      );
    }
    return NextResponse.json({ lists: page.items, next_cursor: page.nextCursor });
  } catch (error) {
    console.error("Error querying drips lists:", error);
    return createErrorResponse(
      500,
      "Failed to query lists",
      request
    );
  }
});

export const GET_VERSIONED = createVersionedHandler(GET);
