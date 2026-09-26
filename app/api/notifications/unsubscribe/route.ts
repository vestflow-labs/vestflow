import { NextRequest, NextResponse } from "next/server";
import { withLogging } from "@/lib/requestLogger";

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

export const POST = withLogging(async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { subscriptionId } = body;

    if (!subscriptionId) {
      return NextResponse.json(
        { error: "Subscription ID required" },
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
        .prepare("UPDATE notification_subscriptions SET is_active = 0, updated_at = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000), subscriptionId);

      db.close();

      if (result.changes === 0) {
        return NextResponse.json(
          { error: "Subscription not found" },
          { status: 404 }
        );
      }

      return NextResponse.json({
        message: "You have been unsubscribed from notifications.",
      });
    } catch (dbError) {
      db.close();
      console.error("Database error:", dbError);
      return NextResponse.json(
        { error: "Failed to unsubscribe" },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Error unsubscribing:", error);
    return NextResponse.json(
      { error: "Failed to unsubscribe" },
      { status: 500 }
    );
  }
});
