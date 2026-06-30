import { NextRequest, NextResponse } from "next/server";
import { createEndpointSpecificRateLimiter } from "@/lib/rateLimit";

const rateLimiter = createEndpointSpecificRateLimiter(60000, 10, "verify");

function getDb() {
  try {
    const Database = require("better-sqlite3");
    const path = require("path");
    const dbPath = process.env.INDEXER_DB_PATH || path.join(process.cwd(), "vestflow-events.db");
    return new Database(dbPath);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const token = searchParams.get("token");

    if (!token) {
      return NextResponse.json(
        { error: "Verification token required" },
        { status: 400 }
      );
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json(
        { error: "Database not available" },
        { status: 500 }
      );
    }

    try {
      const result = db
        .prepare(
          `UPDATE notification_subscriptions 
           SET verified = 1, is_active = 1, updated_at = ? 
           WHERE verification_token = ? AND verified = 0`
        )
        .run(Math.floor(Date.now() / 1000), token);

      db.close();

      if (result.changes === 0) {
        return NextResponse.json(
          { error: "Invalid or expired verification token" },
          { status: 400 }
        );
      }

      return NextResponse.json({
        message: "Email verified successfully. You will now receive notifications.",
      });
    } catch (dbError) {
      db.close();
      console.error("Database error:", dbError);
      return NextResponse.json(
        { error: "Failed to verify email" },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Error verifying email:", error);
    return NextResponse.json(
      { error: "Failed to verify email" },
      { status: 500 }
    );
  }
}
