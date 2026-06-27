import { getAllSchedules, getClaimableBulk, NETWORK } from "@/lib/stellar";
import { NextRequest, NextResponse } from "next/server";

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

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const address = request.nextUrl.searchParams.get("address");
    const pageParam = request.nextUrl.searchParams.get("page");
    const limitParam = request.nextUrl.searchParams.get("limit");

    if (!address) {
      return NextResponse.json(
        { error: "Missing required query parameter: address" },
        { status: 400 }
      );
    }

    const page = pageParam ? Math.max(1, parseInt(pageParam, 10)) : 1;
    const limit = limitParam ? Math.max(1, parseInt(limitParam, 10)) : 20;

    const allSchedules = await getAllSchedules();
    const filtered = allSchedules.filter(
      (s) => s.grantor === address || s.beneficiary === address
    );

    const total = filtered.length;
    const totalPages = Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const paginatedSchedules = filtered.slice(start, start + limit);

    if (paginatedSchedules.length === 0) {
      return NextResponse.json(
        {
          schedules: [],
          total,
          page,
          totalPages,
          network: NETWORK,
        },
        {
          headers: {
            "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
          },
        }
      );
    }

    const ids = paginatedSchedules.map((s) => s.id);
    const claimableAmounts = await getClaimableBulk(ids);
    const now = Math.floor(Date.now() / 1000);

    const schedules = paginatedSchedules.map((s, i) => {
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
    });

    return NextResponse.json(
      {
        schedules,
        total,
        page,
        totalPages,
        network: NETWORK,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching schedules by address:", error);
    return NextResponse.json(
      { error: "Failed to fetch schedules" },
      { status: 500 }
    );
  }
}
