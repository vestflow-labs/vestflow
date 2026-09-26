import { NextRequest, NextResponse } from "next/server";
import { queryDripsListMembers } from "@/indexer/src/db";
import { parseNetwork } from "@/indexer/src/config";
import { withLogging } from "@/lib/requestLogger";

export const GET = withLogging(async function GET(
  request: NextRequest,
  context?: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const id = context?.params ? (await context.params).id : request.nextUrl.pathname.split("/")[3];
  const { searchParams } = request.nextUrl;
  const limit = Math.min(Math.max(1, parseInt(searchParams.get("limit") || "50", 10) || 50), 100);
  const cursor = searchParams.get("cursor") || undefined;
  const network = parseNetwork(searchParams.get("network") || undefined);

  if (!id) {
    return NextResponse.json({ error: "List ID is required" }, { status: 400 });
  }

  const page = queryDripsListMembers({ listId: id, limit, cursor, network });
  if (page === "not_found") {
    return NextResponse.json({ error: "Drips list not found" }, { status: 404 });
  }
  if (!page) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }

  return NextResponse.json({ members: page.items, next_cursor: page.nextCursor });
});
