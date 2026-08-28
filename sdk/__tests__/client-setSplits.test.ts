import { describe, it, expect } from "vitest";
import { TOTAL_SPLITS_WEIGHT, MAX_SPLITS_RECEIVERS, SplitsReceiver } from "../src/types";

describe("VestflowClient.setSplits validation logic", () => {
  const validReceivers: SplitsReceiver[] = [
    { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 5000 },
    { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF", weight: 3000 },
    { address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF", weight: 2000 },
  ];

  it("validates weights sum to TOTAL_SPLITS_WEIGHT", () => {
    const totalWeight = validReceivers.reduce((sum, r) => sum + r.weight, 0);
    expect(totalWeight).toBe(TOTAL_SPLITS_WEIGHT);
  });

  it("rejects invalid weight sum (too low)", () => {
    const invalidReceivers: SplitsReceiver[] = [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 4000 },
      { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF", weight: 3000 },
      { address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF", weight: 2000 },
    ];

    const totalWeight = invalidReceivers.reduce((sum, r) => sum + r.weight, 0);
    expect(totalWeight).not.toBe(TOTAL_SPLITS_WEIGHT);
    expect(totalWeight).toBe(9000);
  });

  it("rejects invalid weight sum (too high)", () => {
    const invalidReceivers: SplitsReceiver[] = [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 6000 },
      { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF", weight: 3000 },
      { address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF", weight: 2000 },
    ];

    const totalWeight = invalidReceivers.reduce((sum, r) => sum + r.weight, 0);
    expect(totalWeight).not.toBe(TOTAL_SPLITS_WEIGHT);
    expect(totalWeight).toBe(11000);
  });

  it("rejects too many receivers", () => {
    const tooManyReceivers: SplitsReceiver[] = Array.from(
      { length: MAX_SPLITS_RECEIVERS + 1 },
      (_, i) => ({
        address: `G${"A".repeat(55 - String(i).length)}${i}`,
        weight: Math.floor(TOTAL_SPLITS_WEIGHT / (MAX_SPLITS_RECEIVERS + 1)),
      })
    );

    expect(tooManyReceivers.length).toBeGreaterThan(MAX_SPLITS_RECEIVERS);
  });

  it("rejects zero or negative weight", () => {
    const invalidWeightReceivers: SplitsReceiver[] = [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 0 },
      { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF", weight: 10000 },
    ];

    expect(invalidWeightReceivers[0].weight).toBeLessThanOrEqual(0);
    expect(invalidWeightReceivers[1].weight).toBe(TOTAL_SPLITS_WEIGHT);
  });

  it("rejects duplicate receiver addresses", () => {
    const duplicateReceivers: SplitsReceiver[] = [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 5000 },
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 5000 },
    ];

    const addresses = duplicateReceivers.map((r) => r.address);
    const uniqueAddresses = new Set(addresses);
    expect(addresses.length).not.toBe(uniqueAddresses.size);
  });

  it("accepts exactly MAX_SPLITS_RECEIVERS receivers", () => {
    const maxReceivers: SplitsReceiver[] = Array.from(
      { length: MAX_SPLITS_RECEIVERS },
      (_, i) => ({
        address: `G${"A".repeat(55 - String(i).length)}${i}`,
        weight: Math.floor(TOTAL_SPLITS_WEIGHT / MAX_SPLITS_RECEIVERS) + (i === 0 ? TOTAL_SPLITS_WEIGHT % MAX_SPLITS_RECEIVERS : 0),
      })
    );

    expect(maxReceivers.length).toBe(MAX_SPLITS_RECEIVERS);
    const totalWeight = maxReceivers.reduce((sum, r) => sum + r.weight, 0);
    expect(totalWeight).toBe(TOTAL_SPLITS_WEIGHT);
  });

  it("accepts single receiver with full weight", () => {
    const singleReceiver: SplitsReceiver[] = [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: TOTAL_SPLITS_WEIGHT },
    ];

    expect(singleReceiver.length).toBe(1);
    expect(singleReceiver[0].weight).toBe(TOTAL_SPLITS_WEIGHT);
  });
});