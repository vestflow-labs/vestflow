import { NextRequest, NextResponse } from "next/server";
import { updateDripsListTargetRate } from "@/indexer/src/db";
import { parseNetwork } from "@/indexer/src/config";
import { withLogging } from "@/lib/requestLogger";

export const POST = withLogging(async function POST(
  request: NextRequest,
  context?: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const id = context?.params ? (await context.params).id : request.nextUrl.pathname.split("/")[3];
  const body = await request.json().catch(() => ({}));
  const { target_rate_per_sec, owner, network: networkParam } = body;
  const network = parseNetwork(networkParam || undefined);

  if (!id || target_rate_per_sec === undefined) {
    return NextResponse.json(
      { error: "List ID and target_rate_per_sec are required" },
      { status: 400 }
    );
  }

  const result = updateDripsListTargetRate({
    listId: id,
    owner,
    targetRatePerSec: target_rate_per_sec.toString(),
    network,
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error || "Update failed" }, { status: 400 });
  }

  return NextResponse.json({ success: true, list: result.list });
});
