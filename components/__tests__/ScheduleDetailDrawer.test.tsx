// @vitest-environment jsdom
// Detail drawer opened by hit-testing a timeline row (#566).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ScheduleDetailDrawer from "@/components/ScheduleDetailDrawer";
import { claimableAt } from "@/lib/portfolio/claimable";
import { stroopsToXlm } from "@/lib/stellar";
import { BASE, DAY, YEAR, makeSchedule } from "@/lib/portfolio/__tests__/fixtures";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(cleanup);

const cursor = BASE + YEAR / 2;

describe("ScheduleDetailDrawer", () => {
  it("renders nothing when no row is selected", () => {
    const { container } = render(
      <ScheduleDetailDrawer schedule={null} cursorLedger={cursor} onClose={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the selected schedule and links to its full page", () => {
    const schedule = makeSchedule({ id: 42, role: "both" });
    render(
      <ScheduleDetailDrawer
        schedule={schedule}
        cursorLedger={cursor}
        onClose={() => {}}
      />
    );

    expect(screen.getByRole("dialog", { name: /Schedule 42 details/ })).toBeTruthy();
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByText("Grantor & beneficiary")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open full schedule/ }).getAttribute("href")).toBe(
      "/app/schedule/42"
    );
  });

  it("falls back to its own calculation when no worker value is supplied", () => {
    const schedule = makeSchedule({ id: 1 });
    render(
      <ScheduleDetailDrawer
        schedule={schedule}
        cursorLedger={cursor}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(stroopsToXlm(claimableAt(schedule, cursor)))).toBeTruthy();
  });

  it("prefers the worker's claimable amount when given one", () => {
    render(
      <ScheduleDetailDrawer
        schedule={makeSchedule({ id: 1 })}
        cursorLedger={cursor}
        claimableAtCursor={123_450_000n}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(stroopsToXlm(123_450_000n))).toBeTruthy();
  });

  it("lists each leg of a multi-token schedule", () => {
    render(
      <ScheduleDetailDrawer
        schedule={makeSchedule({
          id: 3,
          tokens: [
            { token: "CTOKENAAAA", total_amount: 100n, claimed: 0n },
            { token: "CTOKENBBBB", total_amount: 200n, claimed: 0n },
          ],
        })}
        cursorLedger={cursor}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("2 tokens")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tokens" })).toBeTruthy();
  });

  it("lists graded tranches", () => {
    render(
      <ScheduleDetailDrawer
        schedule={makeSchedule({
          id: 4,
          kind: "Graded",
          milestones: [
            { pct: 40, timestamp: BASE + 90 * DAY },
            { pct: 60, timestamp: BASE + 180 * DAY },
          ],
        })}
        cursorLedger={cursor}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "Tranches" })).toBeTruthy();
    expect(screen.getByText("40%")).toBeTruthy();
  });

  it("closes on the close button and on Escape", () => {
    const onClose = vi.fn();
    render(
      <ScheduleDetailDrawer
        schedule={makeSchedule({ id: 1 })}
        cursorLedger={cursor}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Close schedule details/ }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
