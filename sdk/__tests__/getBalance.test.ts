import { describe, it, expect, vi, beforeEach } from "vitest";

const mockScValToNative = vi.fn();

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    scValToNative: mockScValToNative,
  };
});

const { VestflowClient } = await import("../src/client");

const ACCOUNT = "GDZ2GDLBPUCEXA3I5U7WN5E3CNQ3JBP5FK464EMLTHPCX6KVB5N4A4YT";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("getBalance (#682)", () => {
  beforeEach(() => {
    mockScValToNative.mockReset();
  });

  it("returns zeros when the account has no streams", async () => {
    const client = new VestflowClient({ network: "testnet" });
    vi.spyOn(client as any, "simulate").mockRejectedValue(new Error("no streams"));

    const result = await client.getBalance(ACCOUNT, CONTRACT);

    expect(result).toEqual({
      streamingBalance: 0n,
      collectableAmount: 0n,
      streamingRatePerSec: 0n,
    });
  });

  it("returns the parsed balance for an active stream", async () => {
    const client = new VestflowClient({ network: "testnet" });
    vi.spyOn(client as any, "simulate").mockResolvedValue({} as any);
    mockScValToNative.mockReturnValue({
      streaming_balance: 1_000n,
      collectable_amount: 250n,
      streaming_rate_per_sec: 10n,
    });

    const result = await client.getBalance(ACCOUNT, CONTRACT);

    expect(result).toEqual({
      streamingBalance: 1_000n,
      collectableAmount: 250n,
      streamingRatePerSec: 10n,
    });
  });

  it("reflects a zeroed-out collectable amount right after a collect", async () => {
    const client = new VestflowClient({ network: "testnet" });
    vi.spyOn(client as any, "simulate").mockResolvedValue({} as any);
    mockScValToNative.mockReturnValue({
      streaming_balance: 500n,
      collectable_amount: 0n,
      streaming_rate_per_sec: 10n,
    });

    const result = await client.getBalance(ACCOUNT, CONTRACT);

    expect(result.collectableAmount).toBe(0n);
    expect(result.streamingBalance).toBe(500n);
    expect(result.streamingRatePerSec).toBe(10n);
  });

  it("defaults missing fields to zero", async () => {
    const client = new VestflowClient({ network: "testnet" });
    vi.spyOn(client as any, "simulate").mockResolvedValue({} as any);
    mockScValToNative.mockReturnValue({});

    const result = await client.getBalance(ACCOUNT, CONTRACT);

    expect(result).toEqual({
      streamingBalance: 0n,
      collectableAmount: 0n,
      streamingRatePerSec: 0n,
    });
  });
});
