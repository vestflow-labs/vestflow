import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetDb = vi.fn();
const mockGetCheckpoint = vi.fn();

vi.mock("@/indexer/src/db", () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
  getCheckpoint: (...args: unknown[]) => mockGetCheckpoint(...args),
}));

vi.mock("@/indexer/src/config", () => ({
  parseNetwork: () => "testnet",
}));

function mockStellarRpc(latestLedgerSequence: number) {
  return {
    rpc: {
      Server: vi.fn().mockImplementation(() => ({
        getLatestLedger: vi.fn().mockResolvedValue({ sequence: latestLedgerSequence }),
      })),
    },
  };
}

describe("GET /health (#675)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetCheckpoint.mockReturnValue(100);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with status ok when all checks pass", async () => {
    mockGetDb.mockReturnValue({ prepare: vi.fn().mockReturnValue({ get: vi.fn() }) });
    vi.doMock("@stellar/stellar-sdk", () => mockStellarRpc(110));

    const { GET } = await import("@/app/health/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.db_connected).toBe(true);
    expect(body.rpc_connected).toBe(true);
    expect(body.indexer_lag_ledgers).toBe(10);
  });

  it("returns 503 with status degraded when DB check fails", async () => {
    mockGetDb.mockImplementation(() => {
      throw new Error("DB connection failed");
    });
    vi.doMock("@stellar/stellar-sdk", () => mockStellarRpc(110));

    const { GET } = await import("@/app/health/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.db_connected).toBe(false);
    expect(body.rpc_connected).toBe(true);
  });

  it("returns 503 with status degraded when RPC check fails", async () => {
    mockGetDb.mockReturnValue({ prepare: vi.fn().mockReturnValue({ get: vi.fn() }) });
    vi.doMock("@stellar/stellar-sdk", () => ({
      rpc: {
        Server: vi.fn().mockImplementation(() => ({
          getLatestLedger: vi.fn().mockRejectedValue(new Error("RPC unreachable")),
        })),
      },
    }));

    const { GET } = await import("@/app/health/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.db_connected).toBe(true);
    expect(body.rpc_connected).toBe(false);
  });

  it("returns 503 when both DB and RPC fail", async () => {
    mockGetDb.mockImplementation(() => {
      throw new Error("DB failed");
    });
    vi.doMock("@stellar/stellar-sdk", () => ({
      rpc: {
        Server: vi.fn().mockImplementation(() => ({
          getLatestLedger: vi.fn().mockRejectedValue(new Error("RPC failed")),
        })),
      },
    }));

    const { GET } = await import("@/app/health/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.db_connected).toBe(false);
    expect(body.rpc_connected).toBe(false);
  });

  it("returns 0 indexer_lag when RPC is unreachable", async () => {
    mockGetDb.mockReturnValue({ prepare: vi.fn().mockReturnValue({ get: vi.fn() }) });
    vi.doMock("@stellar/stellar-sdk", () => ({
      rpc: {
        Server: vi.fn().mockImplementation(() => ({
          getLatestLedger: vi.fn().mockRejectedValue(new Error("timeout")),
        })),
      },
    }));

    const { GET } = await import("@/app/health/route");
    const response = await GET();
    const body = await response.json();

    expect(body.indexer_lag_ledgers).toBe(0);
    expect(body.rpc_connected).toBe(false);
  });

  it("calculates indexer lag correctly", async () => {
    mockGetDb.mockReturnValue({ prepare: vi.fn().mockReturnValue({ get: vi.fn() }) });
    mockGetCheckpoint.mockReturnValue(500);
    vi.doMock("@stellar/stellar-sdk", () => mockStellarRpc(525));

    const { GET } = await import("@/app/health/route");
    const response = await GET();
    const body = await response.json();

    expect(body.indexer_lag_ledgers).toBe(25);
  });

  it("returns no-store cache header", async () => {
    mockGetDb.mockReturnValue({ prepare: vi.fn().mockReturnValue({ get: vi.fn() }) });
    vi.doMock("@stellar/stellar-sdk", () => mockStellarRpc(110));

    const { GET } = await import("@/app/health/route");
    const response = await GET();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns correct response shape", async () => {
    mockGetDb.mockReturnValue({ prepare: vi.fn().mockReturnValue({ get: vi.fn() }) });
    vi.doMock("@stellar/stellar-sdk", () => mockStellarRpc(110));

    const { GET } = await import("@/app/health/route");
    const response = await GET();
    const body = await response.json();

    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("indexer_lag_ledgers");
    expect(body).toHaveProperty("rpc_connected");
    expect(body).toHaveProperty("db_connected");
    expect(typeof body.indexer_lag_ledgers).toBe("number");
    expect(typeof body.rpc_connected).toBe("boolean");
    expect(typeof body.db_connected).toBe("boolean");
  });
});
