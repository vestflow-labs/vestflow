import { NextRequest, NextResponse } from "next/server";
import { sendVerificationEmail } from "@/lib/email";
import { isWebPushConfigured } from "@/lib/webPush";
import { withLogging } from "@/lib/requestLogger";

interface SubscribeRequest {
  email?: string;
  scheduleId: number;
  beneficiaryAddress: string;
  notificationType: string;
  pushSubscription?: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

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
    const body: SubscribeRequest = await request.json();

    const { email, scheduleId, beneficiaryAddress, notificationType, pushSubscription } = body;

    if (!scheduleId || !beneficiaryAddress || !notificationType) {
      return NextResponse.json(
        { error: "Missing required fields: scheduleId, beneficiaryAddress, notificationType" },
        { status: 400 }
      );
    }

    if (!["cliff_reached", "claimable", "revoked", "all"].includes(notificationType)) {
      return NextResponse.json(
        { error: "Invalid notification type" },
        { status: 400 }
      );
    }

    if (!beneficiaryAddress.startsWith("G") || beneficiaryAddress.length !== 56) {
      return NextResponse.json(
        { error: "Invalid Stellar address" },
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

    // Handle Web Push subscription
    if (pushSubscription) {
      if (!isWebPushConfigured()) {
        db.close();
        return NextResponse.json(
          { error: "Web Push is not configured on this server" },
          { status: 501 }
        );
      }

      if (!pushSubscription.endpoint || !pushSubscription.keys?.p256dh || !pushSubscription.keys?.auth) {
        db.close();
        return NextResponse.json(
          { error: "Invalid push subscription: missing endpoint or keys" },
          { status: 400 }
        );
      }

      try {
        db.prepare(
          `INSERT INTO web_push_subscriptions (endpoint, p256dh, auth, schedule_id, beneficiary_address)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             schedule_id = excluded.schedule_id,
             beneficiary_address = excluded.beneficiary_address,
             is_active = 1,
             updated_at = ?`
        ).run(
          pushSubscription.endpoint,
          pushSubscription.keys.p256dh,
          pushSubscription.keys.auth,
          scheduleId,
          beneficiaryAddress,
          Math.floor(Date.now() / 1000)
        );

        db.close();
        return NextResponse.json(
          { message: "Web Push subscription created successfully" },
          { status: 201 }
        );
      } catch (dbError) {
        db.close();
        console.error("Database error:", dbError);
        return NextResponse.json(
          { error: "Failed to create push subscription" },
          { status: 500 }
        );
      }
    }

    // Handle Email subscription
    if (!email) {
      db.close();
      return NextResponse.json(
        { error: "Email is required for email notifications" },
        { status: 400 }
      );
    }

    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      db.close();
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 }
      );
    }

    const verificationToken =
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15);

    try {
      const result = db
        .prepare(
          `INSERT INTO notification_subscriptions (email, schedule_id, beneficiary_address, notification_type, verification_token)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(email.toLowerCase(), scheduleId, beneficiaryAddress, notificationType, verificationToken);

      const subscriptionId = result.lastInsertRowid as number;

      try {
        await sendVerificationEmail(email, subscriptionId, verificationToken);
      } catch (emailError) {
        console.error("Failed to send verification email:", emailError);
        db.close();
        return NextResponse.json(
          { error: "Failed to send verification email. Please try again." },
          { status: 500 }
        );
      }

      db.close();
      return NextResponse.json(
        {
          message: "Subscription created. Please check your email to verify.",
          subscriptionId,
        },
        { status: 201 }
      );
    } catch (dbError) {
      db.close();
      console.error("Database error:", dbError);
      return NextResponse.json(
        { error: "Failed to create subscription" },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Error creating notification subscription:", error);
    return NextResponse.json(
      { error: "Failed to create subscription" },
      { status: 500 }
    );
  }
});
