import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetGrantorScheduleIds = vi.fn();
const mockGetBeneficiaryScheduleIds = vi.fn();
const mockGetScheduleBatch = vi.fn();
const mockGetClaimableBulk = vi.fn();

vi.mock("@/lib/stellar", () => ({
  getGrantorScheduleIds: (...args: unknown[]) => mockGetGrantorScheduleIds(...args),
  getBeneficiaryScheduleIds: (...args: unknown[]) => mockGetBeneficiaryScheduleIds(...args),
  getScheduleBatch: (...args: unknown[]) => mockGetScheduleBatch(...args),
  getClaimableBulk: (...args: unknown[]) => mockGetClaimableBulk(...args),
  NETWORK: "testnet",
}));

vi.mock("@/lib/redisCache", () => ({
  getOrSetCache: async <T>(_key: string, _ttl: number, fetcher: () => Promise<T>): Promise<T> => {
    return fetcher();
  },
}));

vi.mock("@/lib/rateLimit", () => ({
  createIpBasedRateLimiter: () => async () => null,
}));

const VALID_ADDRESS = "GBZC6YRFWINCGYH6FFIK3VY4KF3WZJQR7CD3S5Y4GVNIKU5RM3JY7YEX";

function createMockRequest(address: string) {
  const url = new URL(`http://localhost/api/profile/${address}`);
  return {
    nextUrl: url,
    method: "GET",
    headers: {
      get: () => null,
    },
  } as any;
}

function createMockParams(address: string) {
  return { params: Promise.resolve({ address }) };
}

describe("GET /api/profile/:address (#672)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for invalid Stellar address", async () => {
    const { GET } = await import("../[address]/route");
    const request = createMockRequest("invalid-address");
    const response = await GET(request, createMockParams("invalid-address"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid Stellar address");
  });

  it("returns 400 for address starting with wrong letter", async () => {
    const { GET } = await import("../[address]/route");
    const invalidAddr = "A" + "B".repeat(55);
    const request = createMockRequest(invalidAddr);
    const response = await GET(request, createMockParams(invalidAddr));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid Stellar address");
  });

  it("returns 200 with empty arrays for address with no activity", async () => {
    mockGetGrantorScheduleIds.mockResolvedValue([]);
    mockGetBeneficiaryScheduleIds.mockResolvedValue([]);

    const { GET } = await import("../[address]/route");
    const request = createMockRequest(VALID_ADDRESS);
    const response = await GET(request, createMockParams(VALID_ADDRESS));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.address).toBe(VALID_ADDRESS);
    expect(body.network).toBe("testnet");
    expect(body.streams).toEqual([]);
    expect(body.splits).toEqual([]);
    expect(body.gives.total_given).toBe("0");
    expect(body.gives.total_received).toBe("0");
    expect(body.gives.schedule_count_as_grantor).toBe(0);
    expect(body.gives.schedule_count_as_beneficiary).toBe(0);
    expect(body).toHaveProperty("timestamp");
  });

  it("returns streams for schedules where address is grantor", async () => {
    mockGetGrantorScheduleIds.mockResolvedValue([1, 2]);
    mockGetBeneficiaryScheduleIds.mockResolvedValue([]);
    mockGetScheduleBatch.mockResolvedValue([
      {
        id: 1,
        grantor: VALID_ADDRESS,
        beneficiary: "GBENNY11111111111111111111111111111111111111111111111",
        token: "TOK1",
        total_amount: 1000n,
        claimed: 200n,
        start_time: 1000,
        duration: 100,
        cliff_duration: 10,
        kind: "Linear",
        revoked: false,
        paused: false,
      },
      {
        id: 2,
        grantor: VALID_ADDRESS,
        beneficiary: "GBENNY22222222222222222222222222222222222222222222222",
        token: "TOK2",
        total_amount: 500n,
        claimed: 0n,
        start_time: 2000,
        duration: 200,
        cliff_duration: 0,
        kind: "Cliff",
        revoked: false,
        paused: false,
      },
    ]);
    mockGetClaimableBulk.mockResolvedValue([100n, 500n]);

    const { GET } = await import("../[address]/route");
    const request = createMockRequest(VALID_ADDRESS);
    const response = await GET(request, createMockParams(VALID_ADDRESS));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.streams).toHaveLength(2);
    expect(body.splits).toHaveLength(0);
    expect(body.gives.total_given).toBe("1500");
    expect(body.gives.schedule_count_as_grantor).toBe(2);
  });

  it("returns splits for schedules where address is beneficiary", async () => {
    mockGetGrantorScheduleIds.mockResolvedValue([]);
    mockGetBeneficiaryScheduleIds.mockResolvedValue([10]);
    mockGetScheduleBatch.mockResolvedValue([
      {
        id: 10,
        grantor: "GBRATOR111111111111111111111111111111111111111111111",
        beneficiary: VALID_ADDRESS,
        token: "TOKX",
        total_amount: 10000n,
        claimed: 3000n,
        start_time: 500,
        duration: 500,
        cliff_duration: 50,
        kind: "Linear",
        revoked: false,
        paused: false,
      },
    ]);
    mockGetClaimableBulk.mockResolvedValue([500n]);

    const { GET } = await import("../[address]/route");
    const request = createMockRequest(VALID_ADDRESS);
    const response = await GET(request, createMockParams(VALID_ADDRESS));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.streams).toHaveLength(0);
    expect(body.splits).toHaveLength(1);
    expect(body.gives.total_received).toBe("3000");
    expect(body.gives.schedule_count_as_beneficiary).toBe(1);
  });

  it("returns both streams and splits for address with both roles", async () => {
    mockGetGrantorScheduleIds.mockResolvedValue([1]);
    mockGetBeneficiaryScheduleIds.mockResolvedValue([2]);
    mockGetScheduleBatch.mockResolvedValue([
      {
        id: 1,
        grantor: VALID_ADDRESS,
        beneficiary: "GBOTHER111111111111111111111111111111111111111111111",
        token: "TOKA",
        total_amount: 1000n,
        claimed: 0n,
        start_time: 1000,
        duration: 100,
        cliff_duration: 0,
        kind: "Linear",
        revoked: false,
        paused: false,
      },
      {
        id: 2,
        grantor: "GBGRANT1111111111111111111111111111111111111111111111",
        beneficiary: VALID_ADDRESS,
        token: "TOKB",
        total_amount: 2000n,
        claimed: 500n,
        start_time: 500,
        duration: 200,
        cliff_duration: 20,
        kind: "LinearWithCliff",
        revoked: false,
        paused: false,
      },
    ]);
    mockGetClaimableBulk.mockResolvedValue([100n, 200n]);

    const { GET } = await import("../[address]/route");
    const request = createMockRequest(VALID_ADDRESS);
    const response = await GET(request, createMockParams(VALID_ADDRESS));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.streams).toHaveLength(1);
    expect(body.splits).toHaveLength(1);
    expect(body.gives.total_given).toBe("1000");
    expect(body.gives.total_received).toBe("500");
  });

  it("includes vested and claimable amounts in response", async () => {
    mockGetGrantorScheduleIds.mockResolvedValue([1]);
    mockGetBeneficiaryScheduleIds.mockResolvedValue([]);
    mockGetScheduleBatch.mockResolvedValue([
      {
        id: 1,
        grantor: VALID_ADDRESS,
        beneficiary: "GBENNY",
        token: "TOK",
        total_amount: 1000n,
        claimed: 100n,
        start_time: 0,
        duration: 100,
        cliff_duration: 0,
        kind: "Linear",
        revoked: false,
        paused: false,
      },
    ]);
    mockGetClaimableBulk.mockResolvedValue([50n]);

    const { GET } = await import("../[address]/route");
    const request = createMockRequest(VALID_ADDRESS);
    const response = await GET(request, createMockParams(VALID_ADDRESS));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.streams[0]).toHaveProperty("vestedAmount");
    expect(body.streams[0]).toHaveProperty("claimableAmount");
    expect(body.streams[0].claimableAmount).toBe("50");
  });

  it("returns correct response shape", async () => {
    mockGetGrantorScheduleIds.mockResolvedValue([]);
    mockGetBeneficiaryScheduleIds.mockResolvedValue([]);

    const { GET } = await import("../[address]/route");
    const request = createMockRequest(VALID_ADDRESS);
    const response = await GET(request, createMockParams(VALID_ADDRESS));
    const body = await response.json();

    expect(body).toHaveProperty("address");
    expect(body).toHaveProperty("network");
    expect(body).toHaveProperty("streams");
    expect(body).toHaveProperty("splits");
    expect(body).toHaveProperty("gives");
    expect(body).toHaveProperty("timestamp");
    expect(Array.isArray(body.streams)).toBe(true);
    expect(Array.isArray(body.splits)).toBe(true);
  });

  it("sets cache-control headers", async () => {
    mockGetGrantorScheduleIds.mockResolvedValue([]);
    mockGetBeneficiaryScheduleIds.mockResolvedValue([]);

    const { GET } = await import("../[address]/route");
    const request = createMockRequest(VALID_ADDRESS);
    const response = await GET(request, createMockParams(VALID_ADDRESS));

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=30, stale-while-revalidate=300");
  });
});
