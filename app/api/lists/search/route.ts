import { NextRequest, NextResponse } from "next/server";
import { searchDripsLists } from "@/indexer/src/db";
import { parseNetwork } from "@/indexer/src/config";
import { withLogging } from "@/lib/requestLogger";

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q") || "";
  const limitStr = searchParams.get("limit") || "50";
  const limit = Math.min(Math.max(1, parseInt(limitStr, 10) || 50), 50);
  const cursor = searchParams.get("cursor") || undefined;
  const network = parseNetwork(searchParams.get("network") || undefined);

  if (!q.trim()) {
    return NextResponse.json({ lists: [], next_cursor: null });
  }

  try {
    const page = searchDripsLists({ q, limit, cursor, network });
    if (!page) {
      return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
    }
    return NextResponse.json({ lists: page.items, next_cursor: page.nextCursor });
  } catch (error) {
    console.error("Error searching drips lists:", error);
    return NextResponse.json({ error: "Failed to search lists" }, { status: 500 });
  }
});
