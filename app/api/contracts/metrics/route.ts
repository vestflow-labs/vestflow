import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { withLogging } from "@/lib/requestLogger";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const filePath = path.join(process.cwd(), "contracts", "metrics.json");
    const fileContent = await fs.readFile(filePath, "utf-8");
    const metrics = JSON.parse(fileContent);

    return NextResponse.json(metrics, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    console.error("Error fetching contract metrics:", error);
    return NextResponse.json(
      { error: "Failed to fetch contract metrics" },
      { status: 503 }
    );
  }
});
