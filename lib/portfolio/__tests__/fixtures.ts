import type { TimelineSchedule, VestingKind } from "../types";

export const DAY = 86_400;
export const YEAR = 365 * DAY;

/** Fixed base timestamp so tests never depend on the wall clock. */
export const BASE = 1_700_000_000;

export function makeSchedule(
  overrides: Partial<TimelineSchedule> & { id: number }
): TimelineSchedule {
  const kind: VestingKind = overrides.kind ?? "Linear";
  return {
    grantor: "GGRANTOR",
    beneficiary: "GBENEFICIARY",
    role: "beneficiary",
    kind,
    start_time: BASE,
    duration: YEAR,
    cliff_duration: 0,
    lockup_duration: 0,
    paused: false,
    paused_duration: 0,
    paused_at: 0,
    revoked: false,
    vested_at_revoke: 0n,
    tokens: [{ token: "CTOKEN", total_amount: 1_000_000n, claimed: 0n }],
    milestones: [],
    ...overrides,
  };
}

/** A portfolio of `count` schedules spread across kinds, start dates and tokens. */
export function makePortfolio(count: number): TimelineSchedule[] {
  const kinds: VestingKind[] = ["Linear", "Cliff", "LinearWithCliff", "Graded"];
  return Array.from({ length: count }, (_, i) => {
    const kind = kinds[i % kinds.length];
    const start = BASE + i * DAY;
    return makeSchedule({
      id: i + 1,
      kind,
      start_time: start,
      duration: YEAR,
      cliff_duration: kind === "Linear" ? 0 : 90 * DAY,
      tokens:
        i % 10 === 0
          ? [
              { token: "CTOKENA", total_amount: 500_000n, claimed: 0n },
              { token: "CTOKENB", total_amount: 250_000n, claimed: 0n },
            ]
          : [{ token: "CTOKEN", total_amount: 1_000_000n, claimed: 0n }],
      milestones:
        kind === "Graded"
          ? [
              { pct: 25, timestamp: start + 90 * DAY },
              { pct: 25, timestamp: start + 180 * DAY },
              { pct: 25, timestamp: start + 270 * DAY },
              { pct: 25, timestamp: start + YEAR },
            ]
          : [],
    });
  });
}
