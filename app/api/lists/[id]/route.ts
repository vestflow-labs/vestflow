import { NextRequest, NextResponse } from "next/server";
import { queryDripsList } from "@/indexer/src/db";
import { parseNetwork } from "@/indexer/src/config";
import { withLogging } from "@/lib/requestLogger";

export const GET = withLogging(async function GET(
  request: NextRequest,
  context?: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const id = context?.params ? (await context.params).id : request.nextUrl.pathname.split("/")[3];
  const network = parseNetwork(request.nextUrl.searchParams.get("network") || undefined);

  if (!id) {
    return NextResponse.json({ error: "List ID is required" }, { status: 400 });
  }

  const list = queryDripsList({ listId: id, network });
  if (list === "not_found") {
    return NextResponse.json({ error: "Drips list not found" }, { status: 404 });
  }

  return NextResponse.json(list);
});
