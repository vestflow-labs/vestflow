// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  AXIS_HEIGHT,
  TRANCHE_LABEL_MIN_HEIGHT,
  createHatchPattern,
  drawCursor,
  drawScheduleRow,
  drawTimeAxis,
  formatAxisLabel,
  formatCursorLabel,
  niceTickStep,
  readTimelineColors,
  tokenColor,
  withAlpha,
  type RowDrawOptions,
  type TimelineColors,
} from "../render";
import { ledgerToX, type Viewport } from "../timeline";
import { createStubContext } from "./canvasStub";
import { BASE, DAY, YEAR, makeSchedule } from "./fixtures";

const COLORS: TimelineColors = {
  background: "#000000",
  foreground: "#ffffff",
  muted: "#888888",
  gridLine: "#111111",
  rowRail: "#222222",
  rowRailStrong: "#333333",
  cliff: "#999999",
  cursor: "#ff0000",
  selection: "#8800ff",
  hover: "#101010",
  tokenPalette: ["#aa00ff", "#00bbcc", "#00cc88", "#ffbb00"],
};

const WIDTH = 900;
const view: Viewport = { startLedger: BASE - 10 * DAY, ledgersPerPixel: DAY };

function rowOptions(overrides: Partial<RowDrawOptions> = {}): RowDrawOptions {
  return {
    schedule: makeSchedule({ id: 1 }),
    y: 40,
    height: 28,
    view,
    width: WIDTH,
    colors: COLORS,
    hatch: null,
    cursorLedger: BASE,
    claimable: 0n,
    selected: false,
    hovered: false,
    ...overrides,
  };
}

describe("cliff hatching", () => {
  const HATCH = { pattern: true } as unknown as CanvasPattern;

  it("fills the cliff period with the hatch pattern, bounded to the cliff", () => {
    const ctx = createStubContext();
    const schedule = makeSchedule({
      id: 1,
      kind: "LinearWithCliff",
      cliff_duration: 90 * DAY,
    });
    drawScheduleRow(ctx, rowOptions({ schedule, hatch: HATCH }));

    const hatched = ctx.fillRects().filter((c) => c.fillStyle === HATCH);
    expect(hatched).toHaveLength(1);

    const [x, , width] = hatched[0].args;
    expect(x).toBeCloseTo(ledgerToX(BASE, view), 6);
    expect(x + width).toBeCloseTo(ledgerToX(BASE + 90 * DAY, view), 6);
  });

  it("does not hatch a schedule with no cliff", () => {
    const ctx = createStubContext();
    drawScheduleRow(ctx, rowOptions({ hatch: HATCH }));
    expect(ctx.fillRects().filter((c) => c.fillStyle === HATCH)).toHaveLength(0);
  });

  it("falls back to a solid fill when a pattern cannot be created", () => {
    const ctx = createStubContext();
    const schedule = makeSchedule({
      id: 1,
      kind: "LinearWithCliff",
      cliff_duration: 90 * DAY,
    });
    drawScheduleRow(ctx, rowOptions({ schedule, hatch: null }));

    const cliffFill = ctx
      .fillRects()
      .find((c) => typeof c.fillStyle === "string" && c.fillStyle.startsWith("rgba(153"));
    expect(cliffFill).toBeDefined();
  });

  it("returns null rather than throwing when the context has no pattern support", () => {
    const ctx = createStubContext();
    expect(createHatchPattern(ctx, "#fff")).toBeNull();
  });
});

describe("graded tranche markers", () => {
  const schedule = makeSchedule({
    id: 1,
    kind: "Graded",
    milestones: [
      { pct: 25, timestamp: BASE + 90 * DAY },
      { pct: 75, timestamp: BASE + 180 * DAY },
    ],
  });

  it("draws a vertical tick at each tranche's X position", () => {
    const ctx = createStubContext();
    drawScheduleRow(ctx, rowOptions({ schedule }));

    const expected = schedule.milestones.map(
      (m) => Math.round(ledgerToX(m.timestamp, view)) + 0.5
    );
    const drawn = ctx.linesAt().map((l) => l.x);
    for (const x of expected) expect(drawn).toContain(x);
  });

  it("labels tranches only when the row is tall enough", () => {
    const tall = createStubContext();
    drawScheduleRow(tall, rowOptions({ schedule, height: TRANCHE_LABEL_MIN_HEIGHT }));
    expect(tall.calls.filter((c) => c.method === "fillText")).not.toHaveLength(0);

    const short = createStubContext();
    drawScheduleRow(short, rowOptions({ schedule, height: TRANCHE_LABEL_MIN_HEIGHT - 1 }));
    expect(short.calls.filter((c) => c.method === "fillText")).toHaveLength(0);
  });

  it("draws no markers for non-graded schedules", () => {
    const ctx = createStubContext();
    drawScheduleRow(ctx, rowOptions());
    expect(ctx.calls.filter((c) => c.method === "fillText")).toHaveLength(0);
  });
});

describe("multi-token sub-rows", () => {
  it("draws one band per token inside the row's height", () => {
    const ctx = createStubContext();
    const schedule = makeSchedule({
      id: 1,
      tokens: [
        { token: "CTOKENA", total_amount: 1_000n, claimed: 0n },
        { token: "CTOKENB", total_amount: 1_000n, claimed: 0n },
      ],
    });
    drawScheduleRow(ctx, rowOptions({ schedule, y: 40, height: 28 }));

    // The rail fill is the first fillRect of each band.
    const rails = ctx.fillRects().filter((c) => c.fillStyle === COLORS.rowRail);
    expect(rails).toHaveLength(2);

    const [firstY, , firstH] = [rails[0].args[1], rails[0].args[2], rails[0].args[3]];
    const secondY = rails[1].args[1];
    expect(firstY).toBeCloseTo(41, 6);
    expect(secondY).toBeCloseTo(55, 6);
    expect(firstH).toBeCloseTo(12, 6);
  });

  it("gives each token leg its own colour", () => {
    expect(tokenColor(COLORS, "CTOKENA", 0)).not.toBe(tokenColor(COLORS, "CTOKENB", 1));
    // The same token keeps the same colour wherever it appears.
    expect(tokenColor(COLORS, "CTOKENA", 0)).toBe(tokenColor(COLORS, "CTOKENA", 0));
  });
});

describe("axis and cursor", () => {
  it("picks a tick step that keeps labels apart at any zoom", () => {
    expect(niceTickStep(1)).toBeLessThanOrEqual(300);
    expect(niceTickStep(DAY)).toBeGreaterThanOrEqual(90 * DAY);
    // Five years across a narrow canvas still resolves to a finite step.
    expect(Number.isFinite(niceTickStep((5 * YEAR) / 320))).toBe(true);
  });

  it("labels ticks with clock time when zoomed in and dates when zoomed out", () => {
    expect(formatAxisLabel(BASE, 3600)).toMatch(/\d/);
    expect(formatAxisLabel(BASE, 365 * DAY)).toMatch(/\d{4}/);
  });

  it("shows the cursor as a formatted date, never a raw ledger number", () => {
    const label = formatCursorLabel(BASE, DAY);
    expect(label).not.toContain(String(BASE));
    expect(label).toBe(new Date(BASE * 1000).toLocaleDateString());
  });

  it("draws the cursor as a vertical line below the axis", () => {
    const ctx = createStubContext();
    drawCursor(ctx, { x: 200, width: WIDTH, height: 400, colors: COLORS, label: "x" });
    const line = ctx.linesAt().find((l) => l.x === 200.5);
    expect(line).toBeDefined();
    expect(line!.y0).toBe(AXIS_HEIGHT);
    expect(line!.y1).toBe(400);
  });

  it("skips the cursor entirely when it is off screen", () => {
    const ctx = createStubContext();
    drawCursor(ctx, { x: -50, width: WIDTH, height: 400, colors: COLORS, label: "x" });
    expect(ctx.calls).toHaveLength(0);
  });

  it("draws grid lines across the visible range", () => {
    const ctx = createStubContext();
    drawTimeAxis(ctx, { view, width: WIDTH, height: 400, colors: COLORS });
    expect(ctx.linesAt().length).toBeGreaterThan(1);
  });
});

describe("theme reading", () => {
  it("resolves canvas colours from CSS custom properties", () => {
    const el = document.createElement("div");
    el.style.setProperty("--accent-primary", "#123456");
    el.style.setProperty("--background", "#ffffff");
    document.body.appendChild(el);

    const colors = readTimelineColors(el);
    expect(colors.selection).toBe("#123456");
    expect(colors.background).toBe("#ffffff");
    expect(colors.tokenPalette[0]).toBe("#123456");
  });

  it("falls back to the shipped palette when a variable is missing", () => {
    const colors = readTimelineColors(document.createElement("div"));
    expect(colors.background).toBe("#08090f");
    expect(colors.cursor).toBe("#f87171");
  });

  it("applies alpha to both hex and rgb theme tokens", () => {
    expect(withAlpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(withAlpha("#f00", 1)).toBe("rgba(255, 0, 0, 1)");
    expect(withAlpha("rgba(10, 20, 30, 0.9)", 0.25)).toBe("rgba(10, 20, 30, 0.25)");
    expect(withAlpha("oklch(0.5 0.1 200)", 0.5)).toBe("oklch(0.5 0.1 200)");
  });
});

describe("claimable marker", () => {
  it("marks rows with a claimable amount at the cursor", () => {
    const withClaim = createStubContext();
    drawScheduleRow(withClaim, rowOptions({ claimable: 1n, cursorLedger: BASE + DAY }));
    expect(withClaim.calls.some((c) => c.method === "arc")).toBe(true);

    const without = createStubContext();
    drawScheduleRow(without, rowOptions({ claimable: 0n, cursorLedger: BASE + DAY }));
    expect(without.calls.some((c) => c.method === "arc")).toBe(false);
  });
});
