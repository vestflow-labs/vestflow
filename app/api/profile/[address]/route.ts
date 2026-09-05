import {
  getGrantorScheduleIds,
  getBeneficiaryScheduleIds,
  getScheduleBatch,
  getClaimableBulk,
  NETWORK,
} from "@/lib/stellar";
import {
  queryDripsLists,
  queryDripsStreams,
  queryGivesForAccount,
  type DripsStream,
  type DripsList,
} from "@/indexer/src/db";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { getOrSetCache } from "@/lib/redisCache";
import { NextRequest, NextResponse } from "next/server";
import { withLogging } from "@/lib/requestLogger";

const CACHE_TTL_SECONDS = 30;
const rateLimiter = createIpBasedRateLimiter(60000, 30);

interface ProfileScheduleSummary {
  id: number;
  grantor: string;
  beneficiary: string;
  token: string;
  total_amount: string;
  claimed: string;
  start_time: number;
  duration: number;
  kind: string;
  revoked: boolean;
  vestedAmount: string;
  claimableAmount: string;
}

interface ProfileResponse {
  address: string;
  network: string;
  streams: ProfileScheduleSummary[];
  splits: ProfileScheduleSummary[];
  gives: {
    total_given: string;
    total_received: string;
    schedule_count_as_grantor: number;
    schedule_count_as_beneficiary: number;
    records: ReturnType<typeof queryGivesForAccount>;
  };
  outgoing_streams: DripsStream[];
  drips_lists: DripsList[];
  timestamp: number;
}

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

export const GET = withLogging(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const { address } = await params;
    const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
    if (!STELLAR_ADDRESS_RE.test(address)) {
      return NextResponse.json(
        { error: "Invalid Stellar address" },
        { status: 400 }
      );
    }

    const profile = await getOrSetCache(
      `profile:${address}`,
      CACHE_TTL_SECONDS,
      () => buildProfile(address),
    );

    return NextResponse.json(profile, {
      headers: {
        "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    console.error("Error fetching profile:", error);
    return NextResponse.json(
      { error: "Failed to fetch profile" },
      { status: 500 }
    );
  }
});

async function buildProfile(address: string): Promise<ProfileResponse> {
  const now = Math.floor(Date.now() / 1000);

  const [grantorIds, beneficiaryIds] = await Promise.all([
    getGrantorScheduleIds(address),
    getBeneficiaryScheduleIds(address),
  ]);

  const allIds = Array.from(new Set([...grantorIds, ...beneficiaryIds])).sort(
    (a, b) => a - b
  );

  if (allIds.length === 0) {
    const outgoingStreams = queryDripsStreams({ account: address, limit: 100 })?.items ?? [];
    const dripsLists = queryDripsLists({ owner: address, limit: 100 })?.items ?? [];
    const gives = queryGivesForAccount(address);
    return {
      address,
      network: NETWORK,
      streams: [],
      splits: [],
      gives: {
        total_given: "0",
        total_received: "0",
        schedule_count_as_grantor: 0,
        schedule_count_as_beneficiary: 0,
        records: gives,
      },
      outgoing_streams: outgoingStreams,
      drips_lists: dripsLists,
      timestamp: now,
    };
  }

  const [schedules, claimableAmounts] = await Promise.all([
    getScheduleBatch(allIds),
    getClaimableBulk(allIds),
  ]);

  const grantorSet = new Set(grantorIds);
  const beneficiarySet = new Set(beneficiaryIds);

  const streams: ProfileScheduleSummary[] = [];
  const splits: ProfileScheduleSummary[] = [];
  let totalGiven = 0n;
  let totalReceived = 0n;
  const outgoingStreams = queryDripsStreams({ account: address, limit: 100 })?.items ?? [];
  const dripsLists = queryDripsLists({ owner: address, limit: 100 })?.items ?? [];
  const gives = queryGivesForAccount(address);

  for (let i = 0; i < allIds.length; i++) {
    const schedule = schedules[i];
    if (!schedule) continue;

    const claimable = claimableAmounts[i] ?? 0n;
    const vested = vestedAmount(schedule, now);

    const summary: ProfileScheduleSummary = {
      id: schedule.id,
      grantor: schedule.grantor,
      beneficiary: schedule.beneficiary,
      token: schedule.token,
      total_amount: schedule.total_amount.toString(),
      claimed: schedule.claimed.toString(),
      start_time: schedule.start_time,
      duration: schedule.duration,
      kind: schedule.kind,
      revoked: schedule.revoked,
      vestedAmount: vested.toString(),
      claimableAmount: claimable.toString(),
    };

    if (grantorSet.has(schedule.id)) {
      streams.push(summary);
      totalGiven += schedule.total_amount;
    }

    if (beneficiarySet.has(schedule.id)) {
      splits.push(summary);
      totalReceived += schedule.claimed;
    }
  }

  return {
    address,
    network: NETWORK,
    streams,
    splits,
    gives: {
      total_given: totalGiven.toString(),
      total_received: totalReceived.toString(),
      schedule_count_as_grantor: streams.length,
      schedule_count_as_beneficiary: splits.length,
      records: gives,
    },
    outgoing_streams: outgoingStreams,
    drips_lists: dripsLists,
    timestamp: now,
  };
}
