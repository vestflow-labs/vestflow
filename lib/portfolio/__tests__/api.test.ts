import { describe, expect, it, vi } from "vitest";
import {
  PORTFOLIO_PAGE_LIMIT,
  fetchPortfolioSchedules,
  mergeSchedules,
  parseTimelineSchedule,
  type ApiScheduleRow,
} from "../api";
import { BASE, DAY } from "./fixtures";

function row(overrides: Partial<ApiScheduleRow> = {}): ApiScheduleRow {
  return {
    id: 1,
    grantor: "GGRANTOR",
    beneficiary: "GBENEFICIARY",
    token: "CTOKEN",
    total_amount: "1000000",
    claimed: "250000",
    start_time: BASE,
    duration: 365 * DAY,
    cliff_duration: 0,
    kind: "Linear",
    revoked: false,
    ...overrides,
  };
}

describe("parseTimelineSchedule", () => {
  it("converts decimal-string amounts into bigints", () => {
    const parsed = parseTimelineSchedule(row(), "grantor");
    expect(parsed?.tokens).toEqual([
      { token: "CTOKEN", total_amount: 1_000_000n, claimed: 250_000n },
    ]);
    expect(parsed?.role).toBe("grantor");
  });

  it("keeps a multi-token schedule's legs separate", () => {
    const parsed = parseTimelineSchedule(
      row({
        tokens: [
          { token: "A", total_amount: "10", claimed_amount: "1" },
          { token: "B", total_amount: "20", claimed: "2" },
        ],
      }),
      "beneficiary"
    );
    expect(parsed?.tokens).toHaveLength(2);
    expect(parsed?.tokens[0].claimed).toBe(1n);
    expect(parsed?.tokens[1].total_amount).toBe(20n);
  });

  it("defaults an unknown kind to Linear and tolerates missing fields", () => {
    const parsed = parseTimelineSchedule({ id: 7, kind: "Sideways" }, "grantor");
    expect(parsed?.kind).toBe("Linear");
    expect(parsed?.start_time).toBe(0);
    expect(parsed?.tokens[0].total_amount).toBe(0n);
    expect(parsed?.milestones).toEqual([]);
  });

  it("drops a row with no usable id", () => {
    expect(parseTimelineSchedule({ grantor: "G" }, "grantor")).toBeNull();
  });
});

describe("mergeSchedules", () => {
  it("deduplicates by schedule id and marks both-sided schedules", () => {
    const merged = mergeSchedules(
      [row({ id: 1 }), row({ id: 2 })],
      [row({ id: 2 }), row({ id: 3 })]
    );
    expect(merged.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(merged.find((s) => s.id === 1)?.role).toBe("grantor");
    expect(merged.find((s) => s.id === 2)?.role).toBe("both");
    expect(merged.find((s) => s.id === 3)?.role).toBe("beneficiary");
  });

  it("accepts schedule_id as well as id", () => {
    const merged = mergeSchedules([{ schedule_id: "42", kind: "Linear" }], []);
    expect(merged[0].id).toBe(42);
  });

  it("orders rows by start time, then id", () => {
    const merged = mergeSchedules(
      [
        row({ id: 3, start_time: BASE + DAY }),
        row({ id: 1, start_time: BASE + 2 * DAY }),
        row({ id: 2, start_time: BASE + DAY }),
      ],
      []
    );
    expect(merged.map((s) => s.id)).toEqual([2, 3, 1]);
  });
});

describe("fetchPortfolioSchedules", () => {
  const address = "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A";

  it("queries both roles in parallel and merges the results", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const id = url.includes("grantor=") ? 1 : 2;
      return {
        ok: true,
        status: 200,
        json: async () => ({ schedules: [row({ id })] }),
      } as Response;
    });

    const merged = await fetchPortfolioSchedules(address, fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes(`grantor=${address}`))).toBe(true);
    expect(urls.some((u) => u.includes(`beneficiary=${address}`))).toBe(true);
    expect(urls.every((u) => u.includes(`limit=${PORTFOLIO_PAGE_LIMIT}`))).toBe(true);
    expect(merged.map((s) => s.id)).toEqual([1, 2]);
  });

  it("still returns the side that succeeded when the other fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("grantor=")) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ schedules: [row({ id: 9 })] }),
      } as Response;
    });

    const merged = await fetchPortfolioSchedules(address, fetchImpl as typeof fetch);
    expect(merged.map((s) => s.id)).toEqual([9]);
    expect(merged[0].role).toBe("beneficiary");
  });

  it("throws when both requests fail", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response
    );
    await expect(
      fetchPortfolioSchedules(address, fetchImpl as typeof fetch)
    ).rejects.toThrow(/503/);
  });
});
