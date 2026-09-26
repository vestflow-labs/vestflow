import { describe, it, expect } from "vitest";
import { formatRate } from "../src/utils";

describe("formatRate (#683)", () => {
  it("formats a zero rate", () => {
    expect(formatRate(0n, "XLM", 7)).toBe("0 XLM / day");
  });

  it("formats a sub-second-scale rate at 'sec' granularity", () => {
    // 115 stroops/sec is already meaningful per second — no need to escalate.
    expect(formatRate(115n, "XLM", 7)).toBe("0.000011 XLM / sec");
  });

  it("derives a per-second rate from a monthly total (30-day month)", () => {
    // 3 000 XLM per 30-day month, expressed as a per-second stroop rate.
    const monthlyStroops = 3_000n * 10_000_000n;
    const amtPerSec = monthlyStroops / (30n * 86_400n);
    expect(formatRate(amtPerSec, "XLM", 7)).toBe("0.001157 XLM / sec");
  });

  it("escalates to 'min' when the per-second value truncates to zero", () => {
    expect(formatRate(1n, "XLM", 7)).toBe("0.000006 XLM / min");
  });

  it("escalates to 'hour' when sec and min both truncate to zero", () => {
    expect(formatRate(1n, "TOK", 9)).toBe("0.000003 TOK / hour");
  });

  it("escalates to 'day' when sec, min, and hour all truncate to zero", () => {
    expect(formatRate(1n, "TOK", 10)).toBe("0.000008 TOK / day");
  });

  it("falls back to '0 TOKEN / day' when the rate is negligible at every unit", () => {
    expect(formatRate(1n, "TOK", 18)).toBe("0 TOK / day");
  });

  it("uses plain integer formatting when decimals is 0", () => {
    expect(formatRate(5n, "PTS", 0)).toBe("5 PTS / sec");
  });

  it("throws on a negative rate", () => {
    expect(() => formatRate(-1n, "XLM", 7)).toThrow(/negative/);
  });

  it("throws on invalid decimals", () => {
    expect(() => formatRate(1n, "XLM", -1)).toThrow(/decimals/);
  });
});
