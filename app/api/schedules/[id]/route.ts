import { getClaimable, getSchedule, NETWORK, vestingProgress } from "@/lib/stellar";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { NextRequest, NextResponse } from "next/server";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

interface EventHistoryItem {
  type: "created" | "claimed" | "revoked";
  timestamp: number;
  amount?: string;
  actor: string;
  ledger?: number;
}

function calculateNextUnlock(schedule: any, now: number): number | null {
  if (schedule.revoked) return null;
  
  const endTime = schedule.start_time + schedule.duration;
  if (now >= endTime) return null;
  
  if (schedule.kind === "Cliff") {
    const cliffTime = schedule.start_time + schedule.cliff_duration;
    if (now < cliffTime) return cliffTime;
    return null;
  }
  
  if (schedule.kind === "LinearWithCliff") {
    const cliffTime = schedule.start_time + schedule.cliff_duration;
    if (now < cliffTime) return cliffTime;
    return endTime;
  }
  
  return endTime;
}

function calculateVestedAmount(schedule: any, now: number): bigint {
  if (schedule.revoked) return schedule.claimed;
  if (now < schedule.start_time) return 0n;

  const elapsed = now - schedule.start_time;

  switch (schedule.kind) {
    case "Cliff": {
      if (elapsed >= schedule.cliff_duration) return schedule.total_amount;
      return 0n;
    }
    case "LinearWithCliff": {
      if (elapsed < schedule.cliff_duration) return 0n;
      if (elapsed >= schedule.duration) return schedule.total_amount;
      const linearDuration = schedule.duration - schedule.cliff_duration;
      const linearElapsed = elapsed - schedule.cliff_duration;
      return (schedule.total_amount * BigInt(linearElapsed)) / BigInt(linearDuration);
    }
    case "Linear":
    default: {
      if (elapsed >= schedule.duration) return schedule.total_amount;
      return (schedule.total_amount * BigInt(elapsed)) / BigInt(schedule.duration);
    }
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const { id } = await params;
    const scheduleId = parseInt(id, 10);
    
    if (isNaN(scheduleId)) {
      return NextResponse.json(
        { error: "Invalid schedule ID" },
        { status: 400 }
      );
    }

    const schedule = await getSchedule(scheduleId);
    
    if (!schedule) {
      return NextResponse.json(
        { error: "Schedule not found" },
        { status: 404 }
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const claimable = await getClaimable(scheduleId);
    const vested = calculateVestedAmount(schedule, now);
    const progress = vestingProgress(schedule, now);
    const nextUnlock = calculateNextUnlock(schedule, now);

    const eventHistory: EventHistoryItem[] = [
      {
        type: "created",
        timestamp: schedule.start_time,
        amount: schedule.total_amount.toString(),
        actor: schedule.grantor,
      }
    ];

    const currentState = {
      status: schedule.revoked 
        ? "revoked" 
        : progress >= 100 
        ? "fully_vested" 
        : now < schedule.start_time 
        ? "pending" 
        : "vesting",
      progress,
      vestedAmount: vested.toString(),
      claimableAmount: claimable.toString(),
      remainingAmount: (schedule.total_amount - schedule.claimed).toString(),
      unclaimedVested: (vested - schedule.claimed).toString(),
    };

    return NextResponse.json(
      {
        schedule: {
          ...schedule,
          total_amount: schedule.total_amount.toString(),
          claimed: schedule.claimed.toString(),
        },
        currentState,
        nextUnlockTimestamp: nextUnlock,
        eventHistory,
        network: NETWORK,
        timestamp: now,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching schedule:", error);
    return NextResponse.json(
      { error: "Failed to fetch schedule" },
      { status: 500 }
    );
  }
}
