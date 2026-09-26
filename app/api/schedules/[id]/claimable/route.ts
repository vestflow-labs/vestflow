import { getClaimable } from "@/lib/stellar";
import { getOrSetCache } from "@/lib/redisCache";
import { NextRequest, NextResponse } from "next/server";
import { withLogging } from "@/lib/requestLogger";

// Short TTL read-through cache (#206) — see app/api/schedules/[id]/route.ts.
const CACHE_TTL_SECONDS = 20;

export const GET = withLogging(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const scheduleId = parseInt(id, 10);

    if (isNaN(scheduleId)) {
      return NextResponse.json(
        { error: "Invalid schedule ID" },
        { status: 400 }
      );
    }

    const claimable = await getOrSetCache(
      `claimable:${scheduleId}`,
      CACHE_TTL_SECONDS,
      () => getClaimable(scheduleId),
    );

    return NextResponse.json(
      {
        scheduleId,
        claimableAmount: claimable.toString(),
        timestamp: Math.floor(Date.now() / 1000),
      },
      {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching claimable amount:", error);
    return NextResponse.json(
      { error: "Failed to fetch claimable amount" },
      { status: 500 }
    );
  }
});
