import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VestflowClient } from "../src/client";

const ACCOUNT = "GDZ2GDLBPUCEXA3I5U7WN5E3CNQ3JBP5FK464EMLTHPCX6KVB5N4A4YT";

function mockFetchOnce(response: { ok: boolean; status: number; json: () => Promise<any> }) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getSplits (#686)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns configured receivers and hash", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        receivers: [
          { address: "GBBBB...", weight_bps: 6_000 },
          { address: "GCCCC...", weight_bps: 4_000 },
        ],
        hash: "0xsplitshash",
      }),
    });

    const client = new VestflowClient({ network: "testnet" });
    const result = await client.getSplits(ACCOUNT);

    expect(result).toEqual({
      receivers: [
        { address: "GBBBB...", weightBps: 6_000 },
        { address: "GCCCC...", weightBps: 4_000 },
      ],
      hash: "0xsplitshash",
    });
  });

  it("returns an empty receivers array with no config (404)", async () => {
    mockFetchOnce({ ok: false, status: 404, json: async () => ({ error: "not found" }) });

    const client = new VestflowClient({ network: "testnet" });
    const result = await client.getSplits(ACCOUNT);

    expect(result).toEqual({ receivers: [], hash: "" });
  });

  it("throws on an unexpected indexer error", async () => {
    mockFetchOnce({ ok: false, status: 500, json: async () => ({}) });

    const client = new VestflowClient({ network: "testnet" });
    await expect(client.getSplits(ACCOUNT)).rejects.toThrow(/500/);
  });

  it("requests the /splits endpoint with the account as a query param", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ receivers: [], hash: "" }),
    });

    const client = new VestflowClient({ network: "testnet", indexerUrl: "http://indexer.local" });
    await client.getSplits(ACCOUNT);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://indexer.local/splits?account=${ACCOUNT}`
    );
  });
});
