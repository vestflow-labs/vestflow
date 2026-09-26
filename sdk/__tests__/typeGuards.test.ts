import { describe, it, expect } from "vitest";
import { isScheduleRevoked } from "../src/types";
import type { ScheduleData, RevokedSchedule } from "../src/types";

function makeSchedule(overrides: Partial<ScheduleData> = {}): ScheduleData {
  return {
    id: 1,
    grantor: "GABC",
    beneficiary: "GDEF",
    token: "native",
    total_amount: 1_000_000_000n,
    claimed: 0n,
    start_time: 1_000_000,
    duration: 86_400 * 365,
    cliff_duration: 0,
    kind: "Linear",
    revocable: true,
    revoked: false,
    paused: false,
    paused_duration: 0,
    paused_at: 0,
    ...overrides,
  };
}

describe("isScheduleRevoked (#444)", () => {
  it("returns false for an active schedule", () => {
    expect(isScheduleRevoked(makeSchedule({ revoked: false }))).toBe(false);
  });

  it("returns true for a revoked schedule", () => {
    expect(isScheduleRevoked(makeSchedule({ revoked: true }))).toBe(true);
  });

  it("narrows the type so revoked: true is guaranteed", () => {
    const s = makeSchedule({ revoked: true });
    if (isScheduleRevoked(s)) {
      const revoked: RevokedSchedule = s;
      expect(revoked.revoked).toBe(true);
    } else {
      throw new Error("Expected schedule to be revoked");
    }
  });

  it("returns false when revoked is explicitly false", () => {
    const s = makeSchedule({ revoked: false });
    expect(isScheduleRevoked(s)).toBe(false);
  });
});
