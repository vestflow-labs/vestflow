import { describe, it, expect } from "vitest";
import {
  xlmToStroops,
  stroopsToXlm,
  vestingProgress,
  type ScheduleData,
} from "../stellar";

/** Build a ScheduleData with sensible defaults, overridable per-test. */
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

  it("converts integer amount with no decimal point", () => {
    expect(xlmToStroops("1")).toBe(10_000_000n);
  });

  it("converts integer amount written with trailing .0", () => {
    expect(xlmToStroops("1.0")).toBe(10_000_000n);
  });

  it("converts a fractional amount", () => {
    expect(xlmToStroops("0.5")).toBe(5_000_000n);
  });

  it("converts a multi-decimal fractional amount", () => {
    expect(xlmToStroops("1.234567")).toBe(12_345_670n);
  });

  it("truncates digits beyond 7 decimal places", () => {
    // "1.23456789" → fraction "23456789" padded/sliced to 7 → "2345678"
    expect(xlmToStroops("1.23456789")).toBe(12_345_678n);
  });

  it("converts a large integer amount", () => {
    expect(xlmToStroops("1000000")).toBe(10_000_000_000_000n);
  });

  it("converts zero", () => {
    expect(xlmToStroops("0")).toBe(0n);
  });

  it("throws on letters in the input", () => {
    expect(() => xlmToStroops("abc")).toThrow("Invalid amount");
  });

  it("throws on multiple decimal points", () => {
    expect(() => xlmToStroops("1.2.3")).toThrow("Invalid amount");
  });

  it("throws on empty string", () => {
    expect(() => xlmToStroops("")).toThrow("Invalid amount");
  });

  it("throws on negative value", () => {
    expect(() => xlmToStroops("-1")).toThrow("Invalid amount");
  });

  it("throws on whitespace-only string", () => {
    expect(() => xlmToStroops("   ")).toThrow("Invalid amount");
  });
});

describe("stroopsToXlm", () => {
  it("converts 10_000_000 stroops to 1 XLM", () => {
    const result = stroopsToXlm(10_000_000n);
    expect(parseFloat(result.replace(/,/g, ""))).toBeCloseTo(1, 4);
  });

  it("converts 0 stroops to 0 XLM", () => {
    const result = stroopsToXlm(0n);
    expect(parseFloat(result.replace(/,/g, ""))).toBe(0);
  });

  it("converts 5_000_000 stroops to 0.5 XLM", () => {
    const result = stroopsToXlm(5_000_000n);
    expect(parseFloat(result.replace(/,/g, ""))).toBeCloseTo(0.5, 4);
  });

  it("returns a string", () => {
    expect(typeof stroopsToXlm(10_000_000n)).toBe("string");
  });

  it("respects maximumFractionDigits of 4 — sub-0.0001 amounts display as 0", () => {
    // 1 stroop = 0.0000001 XLM, which rounds to 0 at 4 decimal places
    const result = stroopsToXlm(1n);
    expect(parseFloat(result.replace(/,/g, ""))).toBe(0);
  });

  it("converts 100_000_000_000n stroops (10 000 XLM)", () => {
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
    // Time-based would be 100% at now=5000, but revocation froze it at 70%.
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
