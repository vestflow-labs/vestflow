import { describe, it, expect } from "vitest";
import {
  xlmToStroops,
  stroopsToXlm,
  vestingProgress,
  type ScheduleData,
} from "../stellar";


function makeSchedule(overrides: Partial<ScheduleData> = {}): ScheduleData {
  return {
    id: 1,
    grantor: "G".padEnd(56, "A"),
    beneficiary: "G".padEnd(56, "B"),
    token: "C".padEnd(56, "C"),
    total_amount: 1_000n,
    claimed: 0n,
    start_time: 0,
    duration: 1_000,
    cliff_duration: 0,
    lockup_duration: 0,
    kind: "Linear",
    revocable: true,
    revoked: false,
    vested_at_revoke: 0n,
    ...overrides,
  };
}

describe("xlmToStroops", () => {
  it("converts minimum representable amount: 0.0000001 XLM = 1 stroop", () => {
    expect(xlmToStroops("0.0000001")).toBe(1n);
  });
  it("converts 1 XLM to 10_000_000 stroops", () => {
    expect(xlmToStroops("1")).toBe(10_000_000n);
  });
  it("converts 1.5 XLM to 15_000_000 stroops", () => {
    expect(xlmToStroops("1.5")).toBe(15_000_000n);
  });
  it("converts large amounts correctly", () => {
    const result = stroopsToXlm(100_000_000_000n);
    expect(parseFloat(result.replace(/,/g, ""))).toBeCloseTo(10_000, 0);
  });
});

describe("vestingProgress", () => {
  it("returns the time-based percentage for an active linear schedule", () => {
    const s = makeSchedule({ start_time: 0, duration: 1_000 });
    expect(vestingProgress(s, 500)).toBe(50);
  });
  it("returns 0 before the schedule start time", () => {
    const s = makeSchedule({ start_time: 1_000, duration: 1_000 });
    expect(vestingProgress(s, 500)).toBe(0);
  });
  it("caps active progress at 100", () => {
    const s = makeSchedule({ start_time: 0, duration: 1_000 });
    expect(vestingProgress(s, 5_000)).toBe(100);
  });
  // --- Issue #273: revoked schedules freeze at the revocation point ---
  it("returns the vested-at-revoke percentage for a revoked schedule, ignoring elapsed time", () => {
    const s = makeSchedule({
      start_time: 0,
      duration: 1_000,
      revoked: true,
      total_amount: 1_000n,
      vested_at_revoke: 700n,
    });
    expect(vestingProgress(s, 5_000)).toBe(70);
  });
  it("returns 0 for a revoked schedule with nothing vested at revoke", () => {
    const s = makeSchedule({
      revoked: true,
      total_amount: 1_000n,
      vested_at_revoke: 0n,
    });
    expect(vestingProgress(s, 500)).toBe(0);
  });
  it("returns 0 for a revoked schedule with zero total amount", () => {
    const s = makeSchedule({
      revoked: true,
      total_amount: 0n,
      vested_at_revoke: 0n,
    });
    expect(vestingProgress(s, 500)).toBe(0);
  });
});