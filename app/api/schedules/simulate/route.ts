import { getClaimable, getClaimableAtTimestamp, getVestedAmountAt, NETWORK } from "@/lib/stellar";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { NextRequest, NextResponse } from "next/server";
import { withLogging } from "@/lib/requestLogger";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

export const POST = withLogging(async function POST(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
    }

    const { schedule_id, address, timestamp } = body as Record<string, unknown>;

    const scheduleId = Number(schedule_id);
    if (!Number.isFinite(scheduleId) || scheduleId <= 0) {
      return NextResponse.json({ error: "Invalid or missing schedule_id" }, { status: 400 });
    }

    if (address != null && (typeof address !== "string" || !/^G[A-Z2-7]{55}$/.test(address))) {
      return NextResponse.json({ error: "Invalid Stellar address format" }, { status: 400 });
    }

    const publicKey = address || undefined;
    const now = Math.floor(Date.now() / 1000);

    let claimableAmount: bigint;
    let vestedAmount: bigint;

    if (timestamp != null) {
      const ts = Number(timestamp);
      if (!Number.isFinite(ts) || ts <= 0) {
        return NextResponse.json({ error: "Invalid timestamp" }, { status: 400 });
      }
      [claimableAmount, vestedAmount] = await Promise.all([
        getClaimableAtTimestamp(scheduleId, ts, publicKey),
        getVestedAmountAt(scheduleId, ts, publicKey),
      ]);
    } else {
      [claimableAmount, vestedAmount] = await Promise.all([
        getClaimable(scheduleId, publicKey),
        getVestedAmountAt(scheduleId, now, publicKey),
      ]);
    }

    return NextResponse.json({
      schedule_id: scheduleId,
      address: publicKey ?? null,
      claimable_amount: claimableAmount.toString(),
      vested_amount: vestedAmount.toString(),
      simulated_at: now,
      simulated_at_timestamp: timestamp ?? null,
      network: NETWORK,
    });
  } catch (error) {
    console.error("Error simulating claim:", error);
    return NextResponse.json({ error: "Simulation failed" }, { status: 500 });
  }
});
