// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getSchedules } from "../schedules/route";
import { GET as getScheduleHistory } from "../schedules/[id]/history/route";
import { GET as getAnalyticsStats } from "../analytics/stats/route";
import { GET as getContractVersion } from "../contracts/version/route";
import { GET as getContractMetrics } from "../contracts/metrics/route";
import { promises as fs } from "fs";

vi.mock("fs/promises", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

vi.mock("@/lib/stellar", () => ({
  NETWORK: "testnet",
  CONTRACT_ID: "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX",
  getSchedulesByGrantor: vi.fn().mockResolvedValue([1]),
  getSchedulesByBeneficiary: vi.fn().mockResolvedValue([]),
  // /api/schedules resolves ids through the *_ScheduleIds views.
  getGrantorScheduleIds: vi.fn().mockResolvedValue([1]),
  getBeneficiaryScheduleIds: vi.fn().mockResolvedValue([]),
  getScheduleBatch: vi.fn().mockResolvedValue([
    {
      id: 1,
      grantor: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      beneficiary: "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A",
      token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      total_amount: 1000000000n,
      claimed: 200000000n,
      start_time: 1700000000,
      duration: 864000,
      cliff_duration: 86400,
      lockup_duration: 0,
      kind: "Linear",
      revocable: true,
      revoked: false,
      paused: false,
      paused_duration: 0,
      paused_at: 0,
      vested_at_revoke: 0n,
      milestones: [],
    },
  ]),
  getClaimableBulk: vi.fn().mockResolvedValue([100000000n]),
  getAllSchedules: vi.fn().mockResolvedValue([
    {
      id: 1,
      grantor: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      beneficiary: "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A",
      token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      total_amount: 1000000000n,
      claimed: 200000000n,
      start_time: 1700000000,
      duration: 864000,
      cliff_duration: 86400,
      kind: "Linear",
      revocable: true,
      revoked: false,
    },
  ]),
  getSchedule: vi.fn().mockImplementation((id: number) => {
    if (id === 1) {
      return Promise.resolve({
        id: 1,
        grantor: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        beneficiary: "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A",
        token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        total_amount: 1000000000n,
        claimed: 200000000n,
        start_time: 1700000000,
        duration: 864000,
        cliff_duration: 86400,
        kind: "Linear",
        revocable: true,
        revoked: false,
        paused: false,
        vested_at_revoke: 0n,
      });
    }
    return Promise.resolve(null);
  }),
  getContractVersion: vi.fn().mockResolvedValue(1),
}));

vi.mock("@/lib/rateLimit", () => ({
  createIpBasedRateLimiter: () => () => Promise.resolve(null),
}));

describe("Backend Features (#428, #429, #430, #431)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Issue #428: ETag header & conditional GET caching", () => {
    it("returns 200 OK with ETag header on first GET request", async () => {
      const req = new NextRequest(
        "http://localhost:3000/api/schedules?address=GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A"
      );
      const res = await getSchedules(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toBeTruthy();
      const body = await res.json();
      expect(body.schedules).toHaveLength(1);
    });

    it("returns 304 Not Modified when If-None-Match header matches ETag", async () => {
      const initialReq = new NextRequest(
        "http://localhost:3000/api/schedules?address=GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A"
      );
      const initialRes = await getSchedules(initialReq);
      const etag = initialRes.headers.get("ETag");

      expect(etag).toBeTruthy();

      const conditionalReq = new NextRequest(
        "http://localhost:3000/api/schedules?address=GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A",
        {
          headers: {
            "If-None-Match": etag!,
          },
        }
      );
      const conditionalRes = await getSchedules(conditionalReq);

      expect(conditionalRes.status).toBe(304);
      expect(conditionalRes.headers.get("ETag")).toBe(etag);
    });
  });

  describe("Issue #429: GET /api/schedules/[id]/history endpoint", () => {
    it("returns 400 Bad Request for invalid schedule ID", async () => {
      const req = new NextRequest("http://localhost:3000/api/schedules/invalid/history");
      const res = await getScheduleHistory(req, { params: Promise.resolve({ id: "invalid" }) });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid schedule ID");
    });

    it("returns event history for a valid schedule ID", async () => {
      const req = new NextRequest("http://localhost:3000/api/schedules/1/history");
      const res = await getScheduleHistory(req, { params: Promise.resolve({ id: "1" }) });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schedule_id).toBe(1);
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events[0].type).toBe("created");
    });

    it("returns 404 Not Found for non-existent schedule ID", async () => {
      const req = new NextRequest("http://localhost:3000/api/schedules/999/history");
      const res = await getScheduleHistory(req, { params: Promise.resolve({ id: "999" }) });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Schedule not found");
    });
  });

  describe("Issue #430: /api/analytics/stats error boundary", () => {
    it("returns protocol stats when RPC calls succeed", async () => {
      const req = new NextRequest("http://localhost:3000/api/analytics/stats");
      const res = await getAnalyticsStats(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const body = await res.json();
      expect(body.total_schedules).toBe(1);
    });

    it("returns JSON error response instead of HTML on unhandled RPC failure", async () => {
      const stellarModule = await import("@/lib/stellar");
      vi.spyOn(stellarModule, "getAllSchedules").mockRejectedValueOnce(new Error("Soroban RPC connection refused"));

      const req = new NextRequest("http://localhost:3000/api/analytics/stats");
      const res = await getAnalyticsStats(req);

      expect(res.status).toBe(503);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const body = await res.json();
      expect(body.error).toBe("Failed to compute analytics stats due to RPC or internal failure.");
    });
  });

  describe("Issue #431: GET /api/contracts/version endpoint", () => {
    it("returns the contract version and metadata", async () => {
      const req = new NextRequest("http://localhost:3000/api/contracts/version");
      const res = await getContractVersion(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const body = await res.json();
      expect(body.version).toBe(1);
      expect(body.contract_id).toBeTruthy();
      expect(body.network).toBe("testnet");
    });
  });

  describe("Issue #432: GET /api/contracts/metrics endpoint", () => {
    it("returns contract metrics from metrics.json", async () => {
      const mockMetrics = {
        wasm_bytes: 12345,
        optimized_wasm_bytes: 6789,
        create_schedule_worst_case_storage_entries: 4,
      };
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mockMetrics));

      const req = new NextRequest("http://localhost:3000/api/contracts/metrics");
      const res = await getContractMetrics(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const body = await res.json();
      expect(body.wasm_bytes).toBe(12345);
      expect(body.create_schedule_worst_case_storage_entries).toBe(4);
    });

    it("returns 503 when metrics.json is missing or invalid", async () => {
      (fs.readFile as any).mockRejectedValue(new Error("File not found"));

      const req = new NextRequest("http://localhost:3000/api/contracts/metrics");
      const res = await getContractMetrics(req);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("Failed to fetch contract metrics");
    });
  });
});
