import { NextRequest, NextResponse } from "next/server";
import { queryTopReceivers } from "@/indexer/src/db";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const token = request.nextUrl.searchParams.get("token");
    if (!token) {
      return NextResponse.json(
        { error: "Missing required query parameter: token" },
        { status: 400 }
      );
    }

    const rawLimit = request.nextUrl.searchParams.get("limit");
    let limit = 10;
    if (rawLimit != null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
        return NextResponse.json(
          { error: "limit must be an integer between 1 and 50" },
          { status: 400 }
        );
      }
      limit = parsed;
    }

    const receivers = queryTopReceivers(token, limit);
    return NextResponse.json(
      { receivers },
      { headers: { "Cache-Control": "public, max-age=60, s-maxage=60" } }
    );
  } catch (error) {
    console.error("Error in GET /analytics/top-receivers:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
