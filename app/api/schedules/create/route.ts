/**
 * POST /api/schedules/create
 * Protected endpoint for creating vesting schedules.
 * Requires valid JWT token from wallet signature authentication.
 */

import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/middleware/auth";
import { withLogging } from "@/lib/requestLogger";

interface CreateScheduleRequest {
  beneficiary: string;
  token: string;
  totalAmount: string;
  startTime: number;
  duration: number;
  cliff?: number;
  revocable?: boolean;
  metadata?: Record<string, any>;
}

async function handler(
  request: NextRequest,
  publicKey: string
): Promise<NextResponse> {
  try {
    const body = await request.json() as CreateScheduleRequest;

    // Validate required fields
    const { beneficiary, token, totalAmount, startTime, duration, cliff, revocable, metadata } = body;

    if (!beneficiary || !token || !totalAmount || typeof startTime !== "number" || typeof duration !== "number") {
      return NextResponse.json(
        { error: "Missing or invalid required fields" },
        { status: 400 }
      );
    }

    // Validate amounts are positive
    const amount = BigInt(totalAmount);
    if (amount <= 0n) {
      return NextResponse.json(
        { error: "Total amount must be greater than 0" },
        { status: 400 }
      );
    }

    // Validate duration
    if (duration <= 0) {
      return NextResponse.json(
        { error: "Duration must be greater than 0" },
        { status: 400 }
      );
    }

    // TODO: Add business logic here
    // 1. Create transaction on Soroban
    // 2. Store schedule metadata in database
    // 3. Return schedule ID

    console.log("Creating schedule:", {
      grantor: publicKey,
      beneficiary,
      token,
      totalAmount,
      startTime,
      duration,
      cliff: cliff || 0,
      revocable: revocable || false,
      metadata: metadata || {},
    });

    return NextResponse.json(
      {
        ok: true,
        message: "Schedule creation initiated",
        // scheduleId: "...", // Return actual schedule ID after implementation
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error creating schedule:", error);
    return NextResponse.json(
      { error: "Failed to create schedule" },
      { status: 500 }
    );
  }
}

export const POST = withLogging(withAuth(handler));
