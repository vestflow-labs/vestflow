import { describe, expect, it } from "vitest";
import { formatCycleDuration } from "../src/utils";

describe("formatCycleDuration (#850)", () => {
  it("formats hourly cycles", () => {
    expect(formatCycleDuration(24 * 60 * 60 - 1)).toBe("23 hours");
  });

  it("formats daily cycles", () => {
    expect(formatCycleDuration(24 * 60 * 60)).toBe("1 days");
  });

  it("formats weekly cycles", () => {
    expect(formatCycleDuration(7 * 24 * 60 * 60)).toBe("1 weeks");
  });
});