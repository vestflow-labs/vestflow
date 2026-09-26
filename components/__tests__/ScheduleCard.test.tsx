// @vitest-environment jsdom
// Snapshot tests for ScheduleCard in all visual states (#464)
//
// Covers: vesting (active), revoked, fully vested, paused.
// Catches unintended visual regressions by comparing rendered HTML snapshots.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import ScheduleCard from "@/components/ScheduleCard";
import type { ScheduleData } from "@/lib/stellar";

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock wallet context so ScheduleCard sees a connected user.
vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({
    publicKey: "GMOCKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHQF",
    isConnected: true,
  }),
}));

// Mock price hook to return a stable value.
vi.mock("@/lib/price", () => ({
  useXlmPrice: () => 0.12,
  formatUsd: (amount: bigint, price: number) =>
    `$${((Number(amount) / 10_000_000) * price).toFixed(2)}`,
}));

// Mock countdown hook.
vi.mock("@/hooks/useCountdown", () => ({
  useCountdown: () => ({ days: 0, hours: 0, minutes: 0, seconds: 0 }),
  formatCountdown: () => "0d 0h 0m",
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);

const BASE_SCHEDULE: ScheduleData = {
  id: 1,
  grantor: "GGRANTORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANHTGK",
  beneficiary: "GMOCKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHQF",
  token: "native",
  total_amount: 100_000_000n, // 10 XLM
  claimed: 0n,
  start_time: NOW - 86400 * 30, // started 30 days ago
  duration: 86400 * 365, // 1 year
  cliff_duration: 0,
  kind: "Linear",
  revocable: true,
  revoked: false,
  paused: false,
  paused_duration: 0,
  paused_at: 0,
  lockup_duration: 0,
  requires_milestones: false,
  vested_at_revoke: 0n,
};

function makeSchedule(overrides: Partial<ScheduleData> = {}): ScheduleData {
  return { ...BASE_SCHEDULE, ...overrides };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ScheduleCard snapshots", () => {
  const onAction = vi.fn();

  beforeEach(() => {
    onAction.mockClear();
  });

  it("renders the vesting (active) state", () => {
    const schedule = makeSchedule();
    const { container } = render(
      <ScheduleCard schedule={schedule} onAction={onAction} />
    );
    expect(container.firstChild).toMatchSnapshot("schedule-vesting");
  });

  it("renders the revoked state", () => {
    const schedule = makeSchedule({
      revoked: true,
      claimed: 30_000_000n,
      vested_at_revoke: 50_000_000n,
    } as any);
    const { container } = render(
      <ScheduleCard schedule={schedule} onAction={onAction} />
    );
    expect(container.firstChild).toMatchSnapshot("schedule-revoked");
  });

  it("renders the fully vested state", () => {
    const schedule = makeSchedule({
      start_time: NOW - 86400 * 400, // started 400 days ago
      duration: 86400 * 365, // 1 year — already past
      claimed: 100_000_000n,
    });
    const { container } = render(
      <ScheduleCard schedule={schedule} onAction={onAction} />
    );
    expect(container.firstChild).toMatchSnapshot("schedule-fully-vested");
  });

  it("renders the paused state", () => {
    const schedule = makeSchedule({
      paused: true,
      paused_at: NOW - 86400 * 5,
      paused_duration: 86400 * 10,
    });
    const { container } = render(
      <ScheduleCard schedule={schedule} onAction={onAction} />
    );
    expect(container.firstChild).toMatchSnapshot("schedule-paused");
  });

  it("renders a cliff schedule in cliff period", () => {
    const schedule = makeSchedule({
      kind: "Cliff",
      cliff_duration: 86400 * 90, // 90-day cliff
      start_time: NOW - 86400 * 30, // 30 days in — still in cliff
    });
    const { container } = render(
      <ScheduleCard schedule={schedule} onAction={onAction} />
    );
    expect(container.firstChild).toMatchSnapshot("schedule-cliff-period");
  });

  it("renders a graded schedule with milestones", () => {
    const schedule = makeSchedule({
      kind: "Graded",
      milestones: [
        { pct: 25, timestamp: NOW - 86400 * 100 },
        { pct: 50, timestamp: NOW - 86400 * 50 },
        { pct: 75, timestamp: NOW + 86400 * 50 },
        { pct: 100, timestamp: NOW + 86400 * 100 },
      ],
    } as any);
    const { container } = render(
      <ScheduleCard schedule={schedule} onAction={onAction} />
    );
    expect(container.firstChild).toMatchSnapshot("schedule-graded");
  });
});
