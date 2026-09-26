import { NextRequest, NextResponse } from "next/server";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { withLogging } from "@/lib/requestLogger";

const rateLimiter = createIpBasedRateLimiter(60 * 1000, 60);

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const token = request.nextUrl.searchParams.get("token");

    if (!token) {
      return NextResponse.json(
        { error: "Token parameter is required" },
        { status: 400 }
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const totalGiven = "0";

    const response = {
      token,
      total_given: totalGiven,
      currency: "stroops",
      last_updated: now,
    };

    return NextResponse.json(response, {
      headers: {
        "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    console.error("Error fetching gives total:", error);
    return NextResponse.json(
      { error: "Failed to fetch gives total" },
      { status: 500 }
    );
  }
});
