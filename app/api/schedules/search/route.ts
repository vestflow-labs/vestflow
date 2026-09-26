import {
  getClaimableBulk,
  getScheduleBatch,
  getGrantorScheduleIds,
  getBeneficiaryScheduleIds,
  getScheduleCount,
  NETWORK,
} from "@/lib/stellar";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { NextRequest, NextResponse } from "next/server";
import { withLogging } from "@/lib/requestLogger";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

function vestedAmount(schedule: {
  total_amount: bigint;
  claimed: bigint;
  start_time: number;
  duration: number;
  cliff_duration: number;
  kind: string;
  revoked: boolean;
}, now: number): bigint {
  if (schedule.revoked) return schedule.claimed;
  if (now < schedule.start_time) return 0n;
  const elapsed = now - schedule.start_time;
  switch (schedule.kind) {
    case "Cliff":
      if (elapsed >= schedule.cliff_duration) return schedule.total_amount;
      return 0n;
    case "LinearWithCliff":
      if (elapsed < schedule.cliff_duration) return 0n;
      if (elapsed >= schedule.duration) return schedule.total_amount;
      const linearDuration = schedule.duration - schedule.cliff_duration;
      const linearElapsed = elapsed - schedule.cliff_duration;
      return (schedule.total_amount * BigInt(linearElapsed)) / BigInt(linearDuration);
    case "Linear":
    default:
      if (elapsed >= schedule.duration) return schedule.total_amount;
      return (schedule.total_amount * BigInt(elapsed)) / BigInt(schedule.duration);
  }
}

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const q = request.nextUrl.searchParams.get("q");
    if (!q || q.trim().length === 0) {
      return NextResponse.json({ error: "Missing query parameter: q" }, { status: 400 });
    }

    const query = q.trim().toUpperCase();
    const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

    // If the query looks like a full Stellar address, do a targeted lookup
    if (STELLAR_ADDRESS_RE.test(query)) {
      const [grantorIds, beneficiaryIds] = await Promise.all([
        getGrantorScheduleIds(query),
        getBeneficiaryScheduleIds(query),
      ]);
      const ids = Array.from(new Set([...grantorIds, ...beneficiaryIds])).sort((a, b) => a - b);

      if (ids.length === 0) {
        return NextResponse.json(
          { schedules: [], total: 0, network: NETWORK },
          { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=300" } }
        );
      }

      const totalSchedules = await getScheduleCount();
      const paginatedIds = ids.slice(0, 50);
      const paginatedSchedules = await getScheduleBatch(paginatedIds);
      const claimableAmounts = await getClaimableBulk(paginatedIds);
      const now = Math.floor(Date.now() / 1000);

      const schedules = paginatedSchedules
        .map((s, i) => {
          if (!s) return null;
          const vested = vestedAmount(s, now);
          const claimable = claimableAmounts[i] ?? 0n;
          return {
            id: s.id,
            grantor: s.grantor,
            beneficiary: s.beneficiary,
            token: s.token,
            total_amount: s.total_amount.toString(),
            claimed: s.claimed.toString(),
            start_time: s.start_time,
            duration: s.duration,
            cliff_duration: s.cliff_duration,
            kind: s.kind,
            revocable: s.revocable,
            revoked: s.revoked,
            vestedAmount: vested.toString(),
            claimableAmount: claimable.toString(),
          };
        })
        .filter(Boolean);

      return NextResponse.json(
        { schedules, total: ids.length, total_schedules: totalSchedules, network: NETWORK },
        { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=300" } }
      );
    }

    return NextResponse.json(
      { schedules: [], total: 0, total_schedules: await getScheduleCount(), network: NETWORK },
      { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=300" } }
    );
  } catch (error) {
    console.error("Error searching schedules:", error);
    return NextResponse.json({ error: "Failed to search schedules" }, { status: 500 });
  }
});
