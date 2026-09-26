import { describe, expect, it } from "vitest";
import {
  COORD_LIMIT,
  DEFAULT_ROW_GAP,
  DEFAULT_ROW_HEIGHT,
  MAX_LEDGERS_PER_PIXEL,
  MIN_LEDGERS_PER_PIXEL,
  clampViewport,
  clipSpan,
  computeRowLayout,
  fitViewport,
  getRowAtY,
  ledgerToX,
  maxScrollOffset,
  panByPixels,
  scheduleBounds,
  subRowBands,
  visibleRowRange,
  xToLedger,
  zoomAt,
  type Viewport,
} from "../timeline";
import { BASE, DAY, YEAR, makePortfolio, makeSchedule } from "./fixtures";

const view: Viewport = { startLedger: BASE, ledgersPerPixel: DAY };

describe("time ⇄ x transform", () => {
  it("maps a ledger to a pixel offset and back", () => {
    expect(ledgerToX(BASE, view)).toBe(0);
    expect(ledgerToX(BASE + 10 * DAY, view)).toBe(10);
    expect(xToLedger(10, view)).toBe(BASE + 10 * DAY);
  });

  it("round-trips at sub-pixel zoom levels", () => {
    const zoomedIn: Viewport = { startLedger: BASE, ledgersPerPixel: 3.6 };
    const ledger = BASE + 1234;
    expect(xToLedger(ledgerToX(ledger, zoomedIn), zoomedIn)).toBeCloseTo(ledger, 6);
  });

  it("clamps zoom into the supported range", () => {
    expect(clampViewport({ startLedger: 0, ledgersPerPixel: 1e-9 }).ledgersPerPixel).toBe(
      MIN_LEDGERS_PER_PIXEL
    );
    expect(clampViewport({ startLedger: 0, ledgersPerPixel: 1e12 }).ledgersPerPixel).toBe(
      MAX_LEDGERS_PER_PIXEL
    );
  });
});

describe("pan and zoom", () => {
  it("keeps the ledger under the anchor fixed while zooming", () => {
    const anchorX = 320;
    const anchorLedger = xToLedger(anchorX, view);
    for (const factor of [0.25, 0.5, 2, 4]) {
      const zoomed = zoomAt(view, anchorX, factor);
      expect(ledgerToX(anchorLedger, zoomed)).toBeCloseTo(anchorX, 6);
    }
  });

  it("pans without changing the scale", () => {
    const panned = panByPixels(view, 50);
    expect(panned.ledgersPerPixel).toBe(view.ledgersPerPixel);
    expect(ledgerToX(BASE, panned)).toBeCloseTo(50, 6);
  });

  it("shows a five-year span without coordinate overflow", () => {
    const width = 320;
    const schedules = [
      makeSchedule({ id: 1, start_time: BASE, duration: 5 * YEAR }),
    ];
    const fiveYear = fitViewport(schedules, width, BASE);

    const x0 = ledgerToX(BASE, fiveYear);
    const x1 = ledgerToX(BASE + 5 * YEAR, fiveYear);
    expect(Number.isFinite(x0)).toBe(true);
    expect(Number.isFinite(x1)).toBe(true);
    // The whole schedule fits on the canvas, and is still wide enough to see.
    expect(x1 - x0).toBeGreaterThan(width * 0.8);
    expect(x1).toBeLessThanOrEqual(width + 1);
  });

  it("clips spans that run far off screen at deep zoom", () => {
    const width = 900;
    // One hour across the canvas: a five-year schedule is ~40 million px wide.
    const deepZoom: Viewport = { startLedger: BASE, ledgersPerPixel: 3600 / width };
    const rawEnd = ledgerToX(BASE + 5 * YEAR, deepZoom);
    expect(rawEnd).toBeGreaterThan(COORD_LIMIT);

    const span = clipSpan(ledgerToX(BASE, deepZoom), rawEnd, width);
    expect(span).not.toBeNull();
    expect(span!.x1).toBeLessThanOrEqual(width + 1);
    expect(span!.x0).toBeGreaterThanOrEqual(-1);
  });

  it("skips spans entirely outside the canvas", () => {
    expect(clipSpan(-500, -100, 900)).toBeNull();
    expect(clipSpan(2000, 3000, 900)).toBeNull();
    expect(clipSpan(NaN, 10, 900)).toBeNull();
  });

  it("gives an empty portfolio a usable axis", () => {
    const bounds = scheduleBounds([], BASE);
    expect(bounds.min).toBeLessThan(BASE);
    expect(bounds.max).toBeGreaterThan(BASE);
    const fitted = fitViewport([], 900, BASE);
    expect(fitted.ledgersPerPixel).toBeGreaterThan(0);
  });
});

describe("row layout and hit-testing", () => {
  const schedules = makePortfolio(200);
  const layout = computeRowLayout(schedules, {
    rowHeight: DEFAULT_ROW_HEIGHT,
    rowGap: DEFAULT_ROW_GAP,
  });

  it("stacks rows on a fixed pitch and ends flush with the last row", () => {
    expect(layout.yPositions).toHaveLength(200);
    expect(layout.yPositions[0]).toBe(0);
    expect(layout.yPositions[1]).toBe(DEFAULT_ROW_HEIGHT + DEFAULT_ROW_GAP);
    expect(layout.totalHeight).toBe(
      200 * DEFAULT_ROW_HEIGHT + 199 * DEFAULT_ROW_GAP
    );
  });

  it("binary searches a Y coordinate back to its row", () => {
    for (const index of [0, 1, 57, 199]) {
      const top = layout.yPositions[index];
      expect(getRowAtY(layout, top)).toBe(index);
      expect(getRowAtY(layout, top + DEFAULT_ROW_HEIGHT - 0.5)).toBe(index);
    }
  });

  it("returns null in the gaps between rows and outside the content", () => {
    const gapY = layout.yPositions[0] + DEFAULT_ROW_HEIGHT + 1;
    expect(getRowAtY(layout, gapY)).toBeNull();
    expect(getRowAtY(layout, -5)).toBeNull();
    expect(getRowAtY(layout, layout.totalHeight + 10)).toBeNull();
    expect(getRowAtY(computeRowLayout([]), 0)).toBeNull();
  });

  it("virtualises: only rows intersecting the viewport are in range", () => {
    const viewportHeight = 400;
    const { start, end } = visibleRowRange(layout, 0, viewportHeight);
    expect(start).toBe(0);
    // 400px of viewport at a 34px pitch is ~12 rows, not 200.
    expect(end - start).toBeLessThan(15);

    const scrolled = visibleRowRange(layout, 1000, viewportHeight);
    expect(scrolled.start).toBeGreaterThan(25);
    expect(layout.yPositions[scrolled.start] + DEFAULT_ROW_HEIGHT).toBeGreaterThanOrEqual(
      1000
    );
    expect(layout.yPositions[scrolled.end - 1]).toBeLessThanOrEqual(1400);
  });

  it("reports a scroll range that never goes negative", () => {
    expect(maxScrollOffset(layout, 400)).toBe(layout.totalHeight - 400);
    expect(maxScrollOffset(computeRowLayout([]), 400)).toBe(0);
  });
});

describe("multi-token sub-rows", () => {
  it("splits one row's height budget evenly per token", () => {
    const schedule = makeSchedule({
      id: 1,
      tokens: [
        { token: "A", total_amount: 1n, claimed: 0n },
        { token: "B", total_amount: 1n, claimed: 0n },
        { token: "C", total_amount: 1n, claimed: 0n },
      ],
    });
    const bands = subRowBands(schedule, 100, 30);
    expect(bands).toHaveLength(3);
    expect(bands.map((b) => b.y)).toEqual([100, 110, 120]);
    expect(bands.every((b) => b.height === 10)).toBe(true);
  });

  it("gives a single-token schedule the whole row", () => {
    const bands = subRowBands(makeSchedule({ id: 1 }), 40, 28);
    expect(bands).toEqual([{ y: 40, height: 28 }]);
  });
});
