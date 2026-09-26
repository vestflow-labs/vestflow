// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCountdown, formatCountdown } from "../useCountdown";

describe("useCountdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes days/hours/minutes remaining until the target", () => {
    const now = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const target = now + 2 * 86400 + 3 * 3600 + 22 * 60;
    const { result } = renderHook(() => useCountdown(target));

    expect(result.current).toMatchObject({ days: 2, hours: 3, minutes: 22, expired: false });
  });

  it("reports expired once the target has passed", () => {
    const now = Math.floor(Date.now() / 1000);
    const { result } = renderHook(() => useCountdown(now - 10));
    expect(result.current.expired).toBe(true);
    expect(result.current.totalSeconds).toBe(0);
  });
});

describe("formatCountdown", () => {
  it("formats days and hours", () => {
    expect(formatCountdown({ days: 12, hours: 4, minutes: 0, totalSeconds: 0, expired: false })).toBe(
      "12 days 4 hours"
    );
  });

  it("formats hours and minutes when under a day", () => {
    expect(formatCountdown({ days: 0, hours: 3, minutes: 22, totalSeconds: 0, expired: false })).toBe(
      "3 hours 22 minutes"
    );
  });

  it("formats minutes only when under an hour", () => {
    expect(formatCountdown({ days: 0, hours: 0, minutes: 5, totalSeconds: 0, expired: false })).toBe(
      "5 minutes"
    );
  });

  it("uses singular units", () => {
    expect(formatCountdown({ days: 1, hours: 1, minutes: 0, totalSeconds: 0, expired: false })).toBe(
      "1 day 1 hour"
    );
  });

  it("returns 'now' once expired", () => {
    expect(formatCountdown({ days: 0, hours: 0, minutes: 0, totalSeconds: 0, expired: true })).toBe("now");
  });
});
