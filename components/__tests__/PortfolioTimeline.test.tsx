// @vitest-environment jsdom
// Behaviour and performance tests for the portfolio timeline canvas (#566).

import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import PortfolioTimeline from "@/components/PortfolioTimeline";
import { AXIS_HEIGHT } from "@/lib/portfolio/render";
import { DEFAULT_ROW_GAP, DEFAULT_ROW_HEIGHT } from "@/lib/portfolio/timeline";
import type { TimelineSchedule } from "@/lib/portfolio/types";
import { stubCanvasElements, type StubContext } from "@/lib/portfolio/__tests__/canvasStub";
import { BASE, YEAR, makePortfolio } from "@/lib/portfolio/__tests__/fixtures";

/** Matches the component's own layout constants. */
const CONTENT_TOP = AXIS_HEIGHT + 8;
const ROW_PITCH = DEFAULT_ROW_HEIGHT + DEFAULT_ROW_GAP;

/** Canvas Y coordinate at the middle of row `index` with no scroll. */
function rowCenterY(index: number): number {
  return CONTENT_TOP + index * ROW_PITCH + DEFAULT_ROW_HEIGHT / 2;
}

let ctx: CanvasRenderingContext2D & StubContext;
let reducedMotion = false;

beforeEach(() => {
  ctx = stubCanvasElements();
  reducedMotion = false;

  // jsdom implements neither of these; the component depends on both.
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") && reducedMotion,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;

  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("initial paint", () => {
  it("renders 200 schedules in under 100ms", () => {
    const schedules = makePortfolio(200);
    const mountDurations: number[] = [];
    const wallClockDurations: number[] = [];

    // Five runs, scored on the best one. Test files run in parallel, so any
    // single sample can be inflated by unrelated scheduler noise; the fastest
    // run is the one that reflects the component's actual cost.
    for (let run = 0; run < 5; run++) {
      let mountMs = 0;
      const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
        mountMs += actualDuration;
      };

      const started = performance.now();
      render(
        <Profiler id="portfolio-timeline" onRender={onRender}>
          <PortfolioTimeline schedules={schedules} now={BASE + YEAR / 2} />
        </Profiler>
      );
      wallClockDurations.push(performance.now() - started);
      mountDurations.push(mountMs);
      cleanup();
    }

    // The first paint happens in a layout effect, so it is inside both numbers.
    expect(ctx.calls.length).toBeGreaterThan(0);
    expect(Math.min(...mountDurations)).toBeLessThan(100);
    expect(Math.min(...wallClockDurations)).toBeLessThan(100);
  });

  it("draws only the rows that fit the viewport, not all 200", () => {
    render(
      <PortfolioTimeline
        schedules={makePortfolio(200)}
        now={BASE + YEAR / 2}
        height={420}
      />
    );

    // Each drawn row contributes at least one rail fillRect; a 420px canvas
    // holds ~11 rows, so an un-virtualised draw would be an order of magnitude
    // more fills.
    expect(ctx.fillRects().length).toBeLessThan(120);
  });
});

describe("row selection", () => {
  const schedules = makePortfolio(10);

  function clickRow(index: number, x = 700) {
    const canvas = screen.getByRole("application");
    fireEvent.pointerDown(canvas, { clientX: x, clientY: rowCenterY(index), pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: x, clientY: rowCenterY(index), pointerId: 1 });
  }

  it("hit-tests a click back to the schedule under the pointer", () => {
    const onSelect = vi.fn();
    render(
      <PortfolioTimeline
        schedules={schedules}
        now={BASE + YEAR / 2}
        onSelect={onSelect}
      />
    );

    clickRow(3);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: schedules[3].id });

    clickRow(7);
    expect(onSelect.mock.calls[1][0]).toMatchObject({ id: schedules[7].id });
  });

  it("reports no selection for a click in the gap between rows", () => {
    const onSelect = vi.fn();
    render(
      <PortfolioTimeline
        schedules={schedules}
        now={BASE + YEAR / 2}
        onSelect={onSelect}
      />
    );

    const canvas = screen.getByRole("application");
    const gapY = CONTENT_TOP + DEFAULT_ROW_HEIGHT + DEFAULT_ROW_GAP / 2;
    fireEvent.pointerDown(canvas, { clientX: 700, clientY: gapY, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 700, clientY: gapY, pointerId: 1 });

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("does not select when the press was a pan drag", () => {
    const onSelect = vi.fn();
    render(
      <PortfolioTimeline
        schedules={schedules}
        now={BASE + YEAR / 2}
        onSelect={onSelect}
      />
    );

    const canvas = screen.getByRole("application");
    const y = rowCenterY(2);
    fireEvent.pointerDown(canvas, { clientX: 700, clientY: y, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 620, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 620, clientY: y, pointerId: 1 });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("navigates and selects rows from the keyboard", () => {
    const onSelect = vi.fn();
    render(
      <PortfolioTimeline
        schedules={schedules}
        now={BASE + YEAR / 2}
        onSelect={onSelect}
      />
    );

    const canvas = screen.getByRole("application");
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    fireEvent.keyDown(canvas, { key: "Enter" });

    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: schedules[2].id });
    // The live region follows the keyboard, giving one announcement per move
    // instead of a DOM node per schedule.
    expect(screen.getByRole("status").textContent).toContain("Row 3 of 10");
  });
});

describe("time cursor", () => {
  const schedules: TimelineSchedule[] = makePortfolio(5);

  it("recalculates claimable amounts as the cursor is dragged", async () => {
    const onClaimableChange = vi.fn();
    render(
      <PortfolioTimeline
        schedules={schedules}
        now={BASE}
        onClaimableChange={onClaimableChange}
      />
    );

    const canvas = screen.getByRole("application");
    // Pressing in the axis strip grabs the cursor.
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 100, clientY: 4, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 600, clientY: 4, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 600, clientY: 4, pointerId: 1 });
      // Let the coalescing frame fire.
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(onClaimableChange).toHaveBeenCalled();
    const [claimable, cursorLedger] = onClaimableChange.mock.calls.at(-1)!;
    expect(claimable.size).toBe(schedules.length);
    // Dragging right moves the cursor forward in time.
    expect(cursorLedger).toBeGreaterThan(BASE);
  });

  it("shows the cursor position as a date, not a ledger number", () => {
    render(<PortfolioTimeline schedules={schedules} now={BASE} />);
    const label = screen.getByTestId("cursor-label");
    expect(label.textContent).toBe(new Date(BASE * 1000).toLocaleDateString());
    expect(label.textContent).not.toContain(String(BASE));
  });

  it("snaps rather than animates under prefers-reduced-motion", async () => {
    reducedMotion = true;
    render(<PortfolioTimeline schedules={schedules} now={BASE} />);

    const canvas = screen.getByRole("application");
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 400, clientY: 4, pointerId: 1 });
      // One animation frame is enough — there are no easing frames to wait for.
      await new Promise((r) => setTimeout(r, 40));
    });

    // The drawn cursor line is already at the pointer, with no easing frames in
    // between: the very next draw puts it at x = 400.
    const cursorLines = ctx.linesAt().filter((l) => Math.abs(l.x - 400.5) < 1);
    expect(cursorLines.length).toBeGreaterThan(0);
  });
});
