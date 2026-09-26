import { NextRequest, NextResponse } from "next/server";
import { CONTRACT_ID, getContractVersion, NETWORK } from "@/lib/stellar";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { withLogging } from "@/lib/requestLogger";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const version = await getContractVersion();
    return NextResponse.json(
      {
        version,
        contract_id: CONTRACT_ID,
        network: NETWORK,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching contract version:", error);
    return NextResponse.json(
      { error: "Failed to fetch contract version" },
      { status: 500 }
    );
  }
});
