import crypto from "crypto";
import {
  getClaimableBulk,
  getScheduleBatch,
  getGrantorScheduleIds,
  getBeneficiaryScheduleIds,
  NETWORK,
} from "@/lib/stellar";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { NextRequest, NextResponse } from "next/server";
import { withLogging } from "@/lib/requestLogger";
import { createErrorResponse } from "@/lib/apiError";
import { createVersionedHandler } from "@/lib/versionedRoute";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

/**
 * Upper bound on `limit`.
 *
 * The portfolio timeline renders every schedule at once rather than paging, so
 * it asks for a large page; the cap keeps a hand-crafted request from turning
 * into an unbounded batch simulation.
 */
const MAX_LIMIT = 500;

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

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    // `address` returns both roles; `grantor` / `beneficiary` narrow to one
    // side, which is what the portfolio timeline fetches in parallel.
    const grantorParam = request.nextUrl.searchParams.get("grantor");
    const beneficiaryParam = request.nextUrl.searchParams.get("beneficiary");
    const addressParam = request.nextUrl.searchParams.get("address");
    const address = addressParam ?? grantorParam ?? beneficiaryParam;
    const pageParam = request.nextUrl.searchParams.get("page");
    const limitParam = request.nextUrl.searchParams.get("limit");

    if (!address) {
      return createErrorResponse(
        400,
        "Missing required query parameter: address, grantor or beneficiary",
        request
      );
    }

    // Both role params at once is only meaningful for the same wallet; two
    // different addresses would silently query just one of them.
    if (grantorParam && beneficiaryParam && grantorParam !== beneficiaryParam) {
      return createErrorResponse(
        400,
        "grantor and beneficiary must refer to the same address",
        request
      );
    }

    const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
    if (!STELLAR_ADDRESS_RE.test(address)) {
      return createErrorResponse(
        400,
        "Invalid Stellar address format",
        request
      );
    }

    const page = pageParam ? Math.max(1, parseInt(pageParam, 10)) : 1;
    const limit = limitParam
      ? Math.min(MAX_LIMIT, Math.max(1, parseInt(limitParam, 10)))
      : 20;

    // Only fetch the side that was asked for — a grantor-only query should not
    // pay for the beneficiary index lookup. `address` keeps its both-roles
    // meaning.
    const roleScoped = addressParam === null;
    const wantsGrantor = !roleScoped || grantorParam !== null;
    const wantsBeneficiary = !roleScoped || beneficiaryParam !== null;

    const grantorIds = wantsGrantor ? await getGrantorScheduleIds(address) : [];
    const beneficiaryIds = wantsBeneficiary
      ? await getBeneficiaryScheduleIds(address)
      : [];
    const ids = Array.from(new Set([...grantorIds, ...beneficiaryIds])).sort(
      (a, b) => a - b
    );

    const total = ids.length;
    const totalPages = Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const paginatedIds = ids.slice(start, start + limit);

    let payload: Record<string, unknown>;

    if (paginatedIds.length === 0) {
      payload = {
        schedules: [],
        total,
        page,
        totalPages,
        network: NETWORK,
      };
    } else {
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
            // Fields below let a client project the schedule forward itself
            // (the portfolio timeline recomputes claimable at an arbitrary
            // cursor without another round-trip).
            lockup_duration: s.lockup_duration,
            paused: s.paused,
            paused_duration: s.paused_duration,
            paused_at: s.paused_at,
            vested_at_revoke: s.vested_at_revoke.toString(),
            milestones: s.milestones ?? [],
            vestedAmount: vested.toString(),
            claimableAmount: claimable.toString(),
          };
        })
        .filter(Boolean);

      payload = {
        schedules,
        total,
        page,
        totalPages,
        network: NETWORK,
      };
    }

    const jsonString = JSON.stringify(payload);
    const etag = `"${crypto.createHash("md5").update(jsonString).digest("hex")}"`;
    const ifNoneMatch = request.headers.get("if-none-match");

    if (
      ifNoneMatch &&
      (ifNoneMatch === etag ||
        ifNoneMatch === `W/${etag}` ||
        ifNoneMatch.replace(/^W\//, "") === etag.replace(/^W\//, ""))
    ) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        },
      });
    }

    return new NextResponse(jsonString, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: etag,
        "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    console.error("Error fetching schedules by address:", error);
    return createErrorResponse(
      500,
      "Failed to fetch schedules",
      request
    );
  }
});

export const GET_VERSIONED = createVersionedHandler(GET);

