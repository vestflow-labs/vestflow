import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VestflowClient } from "../src/client";

const ACCOUNT = "GDZ2GDLBPUCEXA3I5U7WN5E3CNQ3JBP5FK464EMLTHPCX6KVB5N4A4YT";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const BALANCE = {
  streamingBalance: 1_000n,
  collectableAmount: 250n,
  streamingRatePerSec: 10n,
};

describe("subscribeToBalance (#852)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("invokes the callback immediately and on each interval", async () => {
    const client = new VestflowClient({ network: "testnet" });
    const getBalance = vi
      .spyOn(client, "getBalance")
      .mockResolvedValue(BALANCE);
    const callback = vi.fn();

    const stop = client.subscribeToBalance(ACCOUNT, CONTRACT, callback, 1_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(BALANCE);
    expect(getBalance).toHaveBeenCalledWith(ACCOUNT, CONTRACT);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(callback).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stops polling after the teardown function is called", async () => {
    const client = new VestflowClient({ network: "testnet" });
    vi.spyOn(client, "getBalance").mockResolvedValue(BALANCE);
    const callback = vi.fn();

    const stop = client.subscribeToBalance(ACCOUNT, CONTRACT, callback, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("defaults to a 10 second interval", async () => {
    const client = new VestflowClient({ network: "testnet" });
    vi.spyOn(client, "getBalance").mockResolvedValue(BALANCE);
    const callback = vi.fn();

    const stop = client.subscribeToBalance(ACCOUNT, CONTRACT, callback);

    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(callback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(2);

    stop();
  });
});
