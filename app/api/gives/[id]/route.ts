import { NextRequest, NextResponse } from "next/server";
import { getGiveById } from "@/indexer/src/db";
import { parseNetwork } from "@/indexer/src/config";
import { withLogging } from "@/lib/requestLogger";

// A give's id is a Stellar event id: "<ledger>-<txIndex>-<eventIndex>",
// not a plain integer — so "numeric" here means each hyphen-separated
// component is numeric, matching the ids this indexer actually assigns.
const GIVE_ID_PATTERN = /^\d+-\d+-\d+$/;

export const GET = withLogging(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const network = parseNetwork(request.nextUrl.searchParams.get("network") || undefined);

  if (!GIVE_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid give id" }, { status: 400 });
  }

  try {
    const give = getGiveById(id, network);
    if (!give) {
      return NextResponse.json({ error: "Give not found" }, { status: 404 });
    }
    return NextResponse.json(give);
  } catch (error) {
    console.error("Error fetching give:", error);
    return NextResponse.json({ error: "Failed to fetch give" }, { status: 500 });
  }
});
