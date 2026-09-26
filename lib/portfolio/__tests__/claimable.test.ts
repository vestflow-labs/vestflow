import { describe, expect, it } from "vitest";
import {
  claimableAt,
  computeClaimableForCursor,
  effectiveElapsed,
  vestedAmountAt,
  vestedBpsAt,
  vestedFractionAt,
} from "../claimable";
import { BASE, DAY, YEAR, makePortfolio, makeSchedule } from "./fixtures";

describe("vested amounts by schedule kind", () => {
  it("vests linearly between start and end", () => {
    const s = makeSchedule({ id: 1 });
    expect(vestedAmountAt(s, BASE - 1)).toBe(0n);
    expect(vestedAmountAt(s, BASE)).toBe(0n);
    expect(vestedAmountAt(s, BASE + YEAR / 2)).toBe(500_000n);
    expect(vestedAmountAt(s, BASE + YEAR)).toBe(1_000_000n);
    expect(vestedAmountAt(s, BASE + 10 * YEAR)).toBe(1_000_000n);
  });

  it("releases a cliff schedule all at once", () => {
    const s = makeSchedule({ id: 1, kind: "Cliff", cliff_duration: 90 * DAY });
    expect(vestedAmountAt(s, BASE + 89 * DAY)).toBe(0n);
    expect(vestedAmountAt(s, BASE + 90 * DAY)).toBe(1_000_000n);
  });

  it("ramps linearly only after the cliff", () => {
    const s = makeSchedule({
      id: 1,
      kind: "LinearWithCliff",
      cliff_duration: YEAR / 4,
      duration: YEAR,
    });
    expect(vestedAmountAt(s, BASE + YEAR / 4 - 1)).toBe(0n);
    // Half of the post-cliff window has elapsed at 5/8 of a year.
    expect(vestedAmountAt(s, BASE + (5 * YEAR) / 8)).toBe(500_000n);
    expect(vestedAmountAt(s, BASE + YEAR)).toBe(1_000_000n);
  });

  it("steps a graded schedule at each tranche", () => {
    const s = makeSchedule({
      id: 1,
      kind: "Graded",
      milestones: [
        { pct: 30, timestamp: BASE + 100 * DAY },
        { pct: 70, timestamp: BASE + 200 * DAY },
      ],
    });
    expect(vestedAmountAt(s, BASE + 99 * DAY)).toBe(0n);
    expect(vestedAmountAt(s, BASE + 100 * DAY)).toBe(300_000n);
    expect(vestedAmountAt(s, BASE + 200 * DAY)).toBe(1_000_000n);
    expect(vestedBpsAt(s, BASE + 100 * DAY)).toBe(3_000n);
  });

  it("freezes a revoked schedule at its recorded vested amount", () => {
    const s = makeSchedule({ id: 1, revoked: true, vested_at_revoke: 420_000n });
    expect(vestedAmountAt(s, BASE + YEAR)).toBe(420_000n);
    expect(vestedFractionAt(s, BASE + YEAR)).toBeCloseTo(0.42, 6);
  });
});

describe("pauses", () => {
  it("excludes accumulated paused time from elapsed", () => {
    const s = makeSchedule({ id: 1, paused_duration: 30 * DAY });
    expect(effectiveElapsed(s, BASE + 100 * DAY)).toBe(70 * DAY);
  });

  it("keeps a currently-paused schedule from vesting further", () => {
    const s = makeSchedule({ id: 1, paused: true, paused_at: BASE + 50 * DAY });
    const atPause = vestedAmountAt(s, BASE + 50 * DAY);
    expect(vestedAmountAt(s, BASE + 200 * DAY)).toBe(atPause);
  });
});

describe("claimable amounts", () => {
  it("subtracts what has already been claimed", () => {
    const s = makeSchedule({
      id: 1,
      tokens: [{ token: "CTOKEN", total_amount: 1_000_000n, claimed: 200_000n }],
    });
    expect(claimableAt(s, BASE + YEAR / 2)).toBe(300_000n);
  });

  it("returns zero while the lockup window is open", () => {
    const s = makeSchedule({ id: 1, lockup_duration: YEAR / 2 });
    expect(claimableAt(s, BASE + YEAR / 4)).toBe(0n);
    expect(vestedAmountAt(s, BASE + YEAR / 4)).toBe(250_000n);
    expect(claimableAt(s, BASE + YEAR / 2)).toBe(500_000n);
  });

  it("never goes negative when more has been claimed than has vested", () => {
    const s = makeSchedule({
      id: 1,
      tokens: [{ token: "CTOKEN", total_amount: 1_000_000n, claimed: 900_000n }],
    });
    expect(claimableAt(s, BASE + YEAR / 4)).toBe(0n);
  });

  it("sums every leg of a multi-token schedule", () => {
    const s = makeSchedule({
      id: 1,
      tokens: [
        { token: "A", total_amount: 1_000_000n, claimed: 0n },
        { token: "B", total_amount: 400_000n, claimed: 100_000n },
      ],
    });
    // Halfway: 500 000 of A and 200 000 − 100 000 already claimed of B.
    expect(claimableAt(s, BASE + YEAR / 2)).toBe(600_000n);
  });
});

describe("fractional cursor positions", () => {
  // Pointer X divided by a float scale never lands on a whole second, and
  // BigInt() rejects fractions outright — so every kind must tolerate one.
  const fraction = 0.4218;

  it.each(["Linear", "Cliff", "LinearWithCliff", "Graded"] as const)(
    "handles a fractional ledger for a %s schedule",
    (kind) => {
      const s = makeSchedule({
        id: 1,
        kind,
        cliff_duration: 90 * DAY,
        milestones: [{ pct: 100, timestamp: BASE + 90 * DAY }],
      });
      const ledger = BASE + YEAR / 2 + fraction;
      expect(() => claimableAt(s, ledger)).not.toThrow();
      expect(claimableAt(s, ledger)).toBe(claimableAt(s, Math.floor(ledger)));
    }
  );

  it("handles a fractional ledger for a multi-token schedule", () => {
    const s = makeSchedule({
      id: 1,
      tokens: [
        { token: "A", total_amount: 1_000_000n, claimed: 0n },
        { token: "B", total_amount: 400_000n, claimed: 0n },
      ],
    });
    const ledger = BASE + YEAR / 3 + fraction;
    expect(claimableAt(s, ledger)).toBe(claimableAt(s, Math.floor(ledger)));
  });

  it("floors elapsed time to whole seconds", () => {
    const s = makeSchedule({ id: 1 });
    expect(effectiveElapsed(s, BASE + 10.9)).toBe(10);
  });
});

describe("cursor recalculation", () => {
  it("returns one result per schedule, keyed by id", () => {
    const schedules = makePortfolio(5);
    const results = computeClaimableForCursor(schedules, BASE + YEAR);
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.scheduleId)).toEqual([1, 2, 3, 4, 5]);
    expect(results.every((r) => typeof r.claimableAtCursor === "bigint")).toBe(true);
  });

  it("computes 200 schedules well inside a 16 ms frame", () => {
    const schedules = makePortfolio(200);
    const cursors = Array.from({ length: 20 }, (_, i) => BASE + i * 30 * DAY);

    // Warm up so the measurement is not dominated by first-call JIT cost.
    for (const cursor of cursors) computeClaimableForCursor(schedules, cursor);

    const started = performance.now();
    for (const cursor of cursors) computeClaimableForCursor(schedules, cursor);
    const perCursorMs = (performance.now() - started) / cursors.length;

    expect(perCursorMs).toBeLessThan(16);
  });
});
