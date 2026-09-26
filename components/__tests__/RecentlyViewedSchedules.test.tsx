// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RecentlyViewedSchedules from "../RecentlyViewedSchedules";
import type { ScheduleData } from "@/lib/stellar";

function makeSchedule(overrides: Partial<ScheduleData>): ScheduleData {
  return {
    id: 1,
    grantor: "GGRANTOR",
    beneficiary: "GBENEFICIARY",
    token: "CTOKEN",
    total_amount: 1000_0000000n,
    claimed: 0n,
    start_time: 0,
    duration: 1000,
    cliff_duration: 0,
    lockup_duration: 0,
    kind: "Linear",
    revocable: true,
    revoked: false,
    paused: false,
    paused_duration: 0,
    paused_at: 0,
    requires_milestones: false,
    vested_at_revoke: 0n,
    ...overrides,
  };
}

describe("RecentlyViewedSchedules", () => {
  it("renders nothing when there are no schedules", () => {
    const { container } = render(<RecentlyViewedSchedules schedules={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a link per schedule with its id and amount", () => {
    const schedules = [
      makeSchedule({ id: 3, total_amount: 500_0000000n }),
      makeSchedule({ id: 1, total_amount: 250_0000000n }),
    ];
    render(<RecentlyViewedSchedules schedules={schedules} />);

    const link3 = screen.getByRole("link", { name: /#3/ });
    const link1 = screen.getByRole("link", { name: /#1/ });
    expect(link3).toHaveAttribute("href", "/app/schedule/3");
    expect(link1).toHaveAttribute("href", "/app/schedule/1");
  });
});
