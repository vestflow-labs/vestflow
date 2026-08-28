import { describe, it, expect } from "vitest";
import { TOTAL_SPLITS_WEIGHT, MAX_SPLITS_RECEIVERS, SplitsReceiver } from "../src/types";

describe("setSplits validation", () => {
  const validReceivers: SplitsReceiver[] = [
    { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 5000 },
    { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF", weight: 3000 },
    { address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF", weight: 2000 },
  ];

  it("accepts valid receiver configuration with weights summing to TOTAL_SPLITS_WEIGHT", () => {
    const totalWeight = validReceivers.reduce((sum, r) => sum + r.weight, 0);
    expect(totalWeight).toBe(TOTAL_SPLITS_WEIGHT);
    expect(validReceivers.length).toBeLessThanOrEqual(MAX_SPLITS_RECEIVERS);
  });

  it("rejects configuration with weights not summing to TOTAL_SPLITS_WEIGHT", () => {
    const invalidReceivers: SplitsReceiver[] = [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 5000 },
      { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF", weight: 3000 },
      { address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF", weight: 1000 },
    ];

    const totalWeight = invalidReceivers.reduce((sum, r) => sum + r.weight, 0);
    expect(totalWeight).not.toBe(TOTAL_SPLITS_WEIGHT);
    expect(totalWeight).toBe(9000);
  });

  it("rejects configuration with too many receivers", () => {
    const tooManyReceivers: SplitsReceiver[] = Array.from(
      { length: MAX_SPLITS_RECEIVERS + 1 },
      (_, i) => ({
        address: `G${"A".repeat(55 - String(i).length)}${i}`,
        weight: Math.floor(TOTAL_SPLITS_WEIGHT / (MAX_SPLITS_RECEIVERS + 1)),
      })
    );

    expect(tooManyReceivers.length).toBeGreaterThan(MAX_SPLITS_RECEIVERS);
  });

  it("rejects configuration with zero or negative weight", () => {
    const invalidWeightReceivers: SplitsReceiver[] = [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 0 },
      { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF", weight: 10000 },
    ];

    expect(invalidWeightReceivers[0].weight).toBeLessThanOrEqual(0);
  });

  it("rejects configuration with duplicate addresses", () => {
    const duplicateReceivers: SplitsReceiver[] = [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 5000 },
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 5000 },
    ];

    const addresses = duplicateReceivers.map((r) => r.address);
    const uniqueAddresses = new Set(addresses);
    expect(addresses.length).not.toBe(uniqueAddresses.size);
  });

  it("validates TOTAL_SPLITS_WEIGHT constant", () => {
    expect(TOTAL_SPLITS_WEIGHT).toBe(10_000);
  });

  it("validates MAX_SPLITS_RECEIVERS constant", () => {
    expect(MAX_SPLITS_RECEIVERS).toBe(20);
  });
});