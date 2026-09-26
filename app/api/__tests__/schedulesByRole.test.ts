// @vitest-environment node
// Role-scoped querying of GET /api/schedules (#566).
//
// The portfolio timeline fetches the grantor and beneficiary views in
// parallel, so each side must resolve only its own index and the response must
// carry enough of the schedule for a client to project it forward on its own.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../schedules/route";
import {
  getBeneficiaryScheduleIds,
  getClaimableBulk,
  getGrantorScheduleIds,
  getScheduleBatch,
} from "@/lib/stellar";

const GRANTOR = "GCSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A";
const BENEFICIARY = "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A";

function schedule(id: number) {
  return {
    id,
    grantor: GRANTOR,
    beneficiary: BENEFICIARY,
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    total_amount: 1_000_000_000n,
    claimed: 0n,
    start_time: 1_700_000_000,
    duration: 864_000,
    cliff_duration: 86_400,
    lockup_duration: 43_200,
    kind: "Graded",
    revocable: true,
    revoked: false,
    paused: true,
    paused_duration: 600,
    paused_at: 1_700_000_500,
    vested_at_revoke: 12_345n,
    milestones: [{ pct: 50, timestamp: 1_700_500_000 }],
  };
}

vi.mock("@/lib/stellar", () => ({
  NETWORK: "testnet",
  getGrantorScheduleIds: vi.fn(),
  getBeneficiaryScheduleIds: vi.fn(),
  getScheduleBatch: vi.fn(),
  getClaimableBulk: vi.fn(),
}));

vi.mock("@/lib/rateLimit", () => ({
  createIpBasedRateLimiter: () => () => Promise.resolve(null),
}));

const mockIds = (fn: unknown, ids: number[]) =>
  (fn as ReturnType<typeof vi.fn>).mockResolvedValue(ids);

beforeEach(() => {
  vi.clearAllMocks();
  mockIds(getGrantorScheduleIds, [1, 2]);
  mockIds(getBeneficiaryScheduleIds, [2, 3]);
  (getScheduleBatch as ReturnType<typeof vi.fn>).mockImplementation(
    async (ids: number[]) => ids.map(schedule)
  );
  (getClaimableBulk as ReturnType<typeof vi.fn>).mockImplementation(
    async (ids: number[]) => ids.map(() => 0n)
  );
});

function request(query: string) {
  return new NextRequest(`http://localhost:3000/api/schedules?${query}`);
}

const idsOf = (body: { schedules: { id: number }[] }) => body.schedules.map((s) => s.id);

describe("GET /api/schedules role filters", () => {
  it("returns only grantor schedules for ?grantor", async () => {
    const res = await GET(request(`grantor=${GRANTOR}&limit=100`));
    expect(res.status).toBe(200);
    expect(idsOf(await res.json())).toEqual([1, 2]);
    expect(getBeneficiaryScheduleIds).not.toHaveBeenCalled();
  });

  it("returns only beneficiary schedules for ?beneficiary", async () => {
    const res = await GET(request(`beneficiary=${BENEFICIARY}&limit=100`));
    expect(idsOf(await res.json())).toEqual([2, 3]);
    expect(getGrantorScheduleIds).not.toHaveBeenCalled();
  });

  it("still unions both roles for ?address", async () => {
    const res = await GET(request(`address=${GRANTOR}&limit=100`));
    expect(idsOf(await res.json())).toEqual([1, 2, 3]);
    expect(getGrantorScheduleIds).toHaveBeenCalled();
    expect(getBeneficiaryScheduleIds).toHaveBeenCalled();
  });

  it("includes the fields a client needs to project a schedule forward", async () => {
    const res = await GET(request(`grantor=${GRANTOR}`));
    const body = await res.json();

    expect(body.schedules[0]).toMatchObject({
      lockup_duration: 43_200,
      paused: true,
      paused_duration: 600,
      paused_at: 1_700_000_500,
      vested_at_revoke: "12345",
      milestones: [{ pct: 50, timestamp: 1_700_500_000 }],
    });
  });

  it("caps an oversized limit rather than batching without bound", async () => {
    mockIds(
      getGrantorScheduleIds,
      Array.from({ length: 600 }, (_, i) => i + 1)
    );

    const res = await GET(request(`grantor=${GRANTOR}&limit=100000`));
    const body = await res.json();

    expect(body.schedules).toHaveLength(500);
    expect(body.total).toBe(600);
    expect(getScheduleBatch).toHaveBeenCalledWith(
      expect.objectContaining({ length: 500 })
    );
  });

  it("rejects a request with no address at all", async () => {
    const res = await GET(request("limit=10"));
    expect(res.status).toBe(400);
  });

  it("rejects a malformed address", async () => {
    const res = await GET(request("grantor=not-a-stellar-address"));
    expect(res.status).toBe(400);
  });
});
