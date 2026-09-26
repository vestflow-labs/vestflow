import {
  getAllSchedules,
  getClaimableBulk
} from "@/lib/stellar";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { NextRequest, NextResponse } from "next/server";
import { withLogging } from "@/lib/requestLogger";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

interface ProtocolStats {
  total_value_locked: string; // Total amount still locked in contract
  total_claimed: string; // Total amount claimed by beneficiaries
  active_schedules: number; // Schedules not yet fully vested or revoked
  unique_beneficiaries: number; // Number of unique beneficiaries
  total_schedules: number; // Total schedules created
  total_revoked: number; // Total revoked schedules
  tvl_usd: string; // Estimated USD value (XLM price)
  last_updated: number; // Unix timestamp
}

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) return rateLimitResponse;
  try {
    const now = Math.floor(Date.now() / 1000);

    // Get all schedules to compute stats
    const allSchedules = await getAllSchedules();

    if (!allSchedules || allSchedules.length === 0) {
      const emptyStats: ProtocolStats = {
        total_value_locked: "0",
        total_claimed: "0",
        active_schedules: 0,
        unique_beneficiaries: 0,
        total_schedules: 0,
        total_revoked: 0,
        tvl_usd: "0",
        last_updated: now,
      };

      return NextResponse.json(emptyStats, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        },
      });
    }

    // Fetch claimable amounts for all schedules
    const scheduleIds = allSchedules.map((s) => s.id);
    const claimableAmounts = await getClaimableBulk(scheduleIds);

    // Compute stats
    let totalValueLocked = 0n;
    let totalClaimed = 0n;
    let activeSchedules = 0;
    const beneficiaries = new Set<string>();
    let totalRevoked = 0;

    allSchedules.forEach((schedule, index) => {
      const claimable = claimableAmounts[index] || 0n;
      const claimed = BigInt(schedule.claimed);
      const totalAmount = BigInt(schedule.total_amount);
      const locked = totalAmount - claimed;

      if (!schedule.revoked) {
        totalValueLocked += locked;

        // Schedule is active if not fully vested, not revoked
        const isFullyVested = now >= schedule.start_time + schedule.duration;
        if (!isFullyVested) {
          activeSchedules++;
        }
      }

      totalClaimed += claimed;
      beneficiaries.add(schedule.beneficiary);

      if (schedule.revoked) {
        totalRevoked++;
      }
    });

    const xlmPriceUsd = 0.12; // Estimated XLM USD price
    const tvlUsd = (Number(totalValueLocked) / 10_000_000) * xlmPriceUsd;

    const stats: ProtocolStats = {
      total_value_locked: totalValueLocked.toString(),
      total_claimed: totalClaimed.toString(),
      active_schedules: activeSchedules,
      unique_beneficiaries: beneficiaries.size,
      total_schedules: allSchedules.length,
      total_revoked: totalRevoked,
      tvl_usd: tvlUsd.toFixed(2),
      last_updated: now,
    };

    return NextResponse.json(stats, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    console.error("Error fetching analytics stats:", error);
    return NextResponse.json(
      { error: "Failed to compute analytics stats due to RPC or internal failure." },
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  }
});

