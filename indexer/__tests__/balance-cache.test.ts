import { beforeEach, describe, expect, it } from "vitest";
import {
  clearBalanceCache,
  getOrSetBalanceCache,
  invalidateBalanceCache,
} from "../src/balance-cache";

describe("stream balance cache", () => {
  beforeEach(() => {
    clearBalanceCache();
  });

  it("keeps a cache hit until the matching squeeze invalidates it", async () => {
    let calls = 0;
    const fetchBalance = async () => {
      calls += 1;
      return {
        streamingBalance: String(calls),
        collectableAmount: "0",
        streamingRatePerSec: "1",
      };
    };

    const first = await getOrSetBalanceCache("receiver", "token", "testnet", fetchBalance);
    const second = await getOrSetBalanceCache("receiver", "token", "testnet", fetchBalance);
    expect(second).toEqual(first);
    expect(calls).toBe(1);

    await getOrSetBalanceCache("other", "token", "testnet", fetchBalance);
    invalidateBalanceCache("receiver", "token", "testnet");
    const refreshed = await getOrSetBalanceCache("receiver", "token", "testnet", fetchBalance);
    expect(refreshed.streamingBalance).toBe("3");
    expect(calls).toBe(3);

    const untouched = await getOrSetBalanceCache("other", "token", "testnet", fetchBalance);
    expect(untouched.streamingBalance).toBe("2");
    expect(calls).toBe(3);
  });
});
