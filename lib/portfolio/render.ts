/**
 * Canvas drawing primitives for the portfolio timeline.
 *
 * Split out of the React component so the render loop stays a short dispatch
 * and every drawing decision — tick spacing, cliff hatching, tranche markers,
 * per-token bands — can be exercised directly against a 2D context.
 *
 * All colours come from the app's CSS custom properties, read through
 * `getComputedStyle`, so the canvas follows the light/dark theme the rest of
 * the UI uses instead of hard-coding a palette.
 */

import {
  clipSpan,
  ledgerToX,
  subRowBands,
  type Viewport,
} from "./timeline";
import {
  cliffEndLedger,
  endLedger,
  trancheLedgers,
  type TimelineSchedule,
} from "./types";

export interface TimelineColors {
  background: string;
  foreground: string;
  muted: string;
  gridLine: string;
  rowRail: string;
  rowRailStrong: string;
  cliff: string;
  cursor: string;
  selection: string;
  hover: string;
  /** Cycled per token leg so a multi-token schedule reads as distinct bands. */
  tokenPalette: string[];
}

const FALLBACK_COLORS: TimelineColors = {
  background: "#08090f",
  foreground: "#f0f0f0",
  muted: "#71717a",
  gridLine: "rgba(255,255,255,0.08)",
  rowRail: "rgba(255,255,255,0.05)",
  rowRailStrong: "rgba(255,255,255,0.12)",
  cliff: "#a1a1a6",
  cursor: "#f87171",
  selection: "#a78bfa",
  hover: "rgba(255,255,255,0.06)",
  tokenPalette: ["#a78bfa", "#06b6d4", "#10b981", "#fbbf24"],
};

/**
 * Read the theme tokens the canvas needs.
 *
 * Resolution happens against the supplied element (the canvas itself) so any
 * scoped overrides on an ancestor are honoured. Falls back to the dark palette
 * when there is no DOM — the same values the stylesheet ships.
 */
export function readTimelineColors(el: Element | null): TimelineColors {
  if (typeof window === "undefined" || !el) return FALLBACK_COLORS;
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;

  return {
    background: read("--background", FALLBACK_COLORS.background),
    foreground: read("--foreground", FALLBACK_COLORS.foreground),
    muted: read("--muted-light", FALLBACK_COLORS.muted),
    gridLine: read("--border-subtle", FALLBACK_COLORS.gridLine),
    rowRail: read("--card-bg", FALLBACK_COLORS.rowRail),
    rowRailStrong: read("--border-default", FALLBACK_COLORS.rowRailStrong),
    cliff: read("--neutral-400", FALLBACK_COLORS.cliff),
    cursor: read("--accent-error", FALLBACK_COLORS.cursor),
    selection: read("--accent-primary", FALLBACK_COLORS.selection),
    hover: read("--overlay-light", FALLBACK_COLORS.hover),
    tokenPalette: [
      read("--accent-primary", FALLBACK_COLORS.tokenPalette[0]),
      read("--accent-secondary", FALLBACK_COLORS.tokenPalette[1]),
      read("--accent-success", FALLBACK_COLORS.tokenPalette[2]),
      read("--accent-warning", FALLBACK_COLORS.tokenPalette[3]),
    ],
  };
}

/** Stable colour for a token address, so a token keeps its band colour across rows. */
export function tokenColor(colors: TimelineColors, token: string, index: number): string {
  const palette = colors.tokenPalette.length ? colors.tokenPalette : FALLBACK_COLORS.tokenPalette;
  if (!token) return palette[index % palette.length];
  let hash = 0;
  for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
  return palette[(hash + index) % palette.length];
}

/**
 * A 4×4 diagonal-line tile used to hatch cliff periods.
 *
 * Returns `null` when the context cannot produce a pattern (some headless 2D
 * implementations); callers fall back to a flat translucent fill so the cliff
 * is still visibly distinct from the vesting body.
 */
export function createHatchPattern(
  ctx: CanvasRenderingContext2D,
  color: string
): CanvasPattern | null {
  if (typeof document === "undefined" || typeof ctx.createPattern !== "function") return null;
  const tile = document.createElement("canvas");
  tile.width = 4;
  tile.height = 4;
  const tileCtx = tile.getContext("2d");
  if (!tileCtx) return null;
  tileCtx.strokeStyle = color;
  tileCtx.lineWidth = 1;
  tileCtx.beginPath();
  tileCtx.moveTo(0, 4);
  tileCtx.lineTo(4, 0);
  tileCtx.moveTo(-1, 1);
  tileCtx.lineTo(1, -1);
  tileCtx.moveTo(3, 5);
  tileCtx.lineTo(5, 3);
  tileCtx.stroke();
  try {
    return ctx.createPattern(tile, "repeat");
  } catch {
    return null;
  }
}

// ── Axis ────────────────────────────────────────────────────────────────────

/** Candidate axis steps, in seconds, from a minute to five years. */
const TICK_STEPS = [
  60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600,
  86_400, 2 * 86_400, 7 * 86_400, 14 * 86_400, 30 * 86_400, 90 * 86_400,
  182 * 86_400, 365 * 86_400, 2 * 365 * 86_400, 5 * 365 * 86_400,
  10 * 365 * 86_400,
];

/**
 * Smallest step that keeps labels at least `minLabelPx` apart.
 *
 * Driving tick density off the current zoom is what lets one axis serve both a
 * one-hour and a five-year view without the labels colliding or thinning out.
 */
export function niceTickStep(ledgersPerPixel: number, minLabelPx = 90): number {
  const minStep = ledgersPerPixel * minLabelPx;
  for (const step of TICK_STEPS) {
    if (step >= minStep) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/** Axis label wording follows the tick step: clock time when zoomed in, years when out. */
export function formatAxisLabel(ledger: number, step: number): string {
  const d = new Date(ledger * 1000);
  if (step < 86_400) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (step < 180 * 86_400) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export const AXIS_HEIGHT = 26;

export function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  opts: { view: Viewport; width: number; height: number; colors: TimelineColors }
): void {
  const { view, width, height, colors } = opts;
  const step = niceTickStep(view.ledgersPerPixel);
  const startLedger = view.startLedger;
  const endLedgerVisible = startLedger + width * view.ledgersPerPixel;
  const first = Math.floor(startLedger / step) * step;

  ctx.save();
  ctx.fillStyle = colors.muted;
  ctx.strokeStyle = colors.gridLine;
  ctx.lineWidth = 1;
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";

  for (let ledger = first; ledger <= endLedgerVisible; ledger += step) {
    const x = Math.round(ledgerToX(ledger, view)) + 0.5;
    if (x < -1 || x > width + 1) continue;
    ctx.beginPath();
    ctx.moveTo(x, AXIS_HEIGHT);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillText(formatAxisLabel(ledger, step), x + 4, AXIS_HEIGHT / 2);
  }

  ctx.strokeStyle = colors.rowRailStrong;
  ctx.beginPath();
  ctx.moveTo(0, AXIS_HEIGHT + 0.5);
  ctx.lineTo(width, AXIS_HEIGHT + 0.5);
  ctx.stroke();
  ctx.restore();
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface RowDrawOptions {
  schedule: TimelineSchedule;
  /** Row top edge in canvas space (scroll already applied). */
  y: number;
  height: number;
  view: Viewport;
  width: number;
  colors: TimelineColors;
  hatch: CanvasPattern | null;
  /** Ledger the time cursor sits at; the row fills up to this point. */
  cursorLedger: number;
  /** Projected claimable amount at the cursor, from the worker. */
  claimable: bigint;
  selected: boolean;
  hovered: boolean;
}

/** Below this row height, tranche amount labels are dropped as unreadable. */
export const TRANCHE_LABEL_MIN_HEIGHT = 24;

/**
 * Draw one schedule row: rail, cliff hatch, vesting body, and type-specific
 * decoration.
 *
 * A multi-token schedule splits the same height budget into one band per
 * token, so it occupies the same slot as any other row while still showing
 * each asset separately.
 */
export function drawScheduleRow(ctx: CanvasRenderingContext2D, opts: RowDrawOptions): void {
  const { schedule, y, height, width, colors, selected, hovered } = opts;

  if (hovered || selected) {
    ctx.fillStyle = selected ? withAlpha(colors.selection, 0.14) : colors.hover;
    ctx.fillRect(0, y - 2, width, height + 4);
  }

  const bands = subRowBands(schedule, y, height);
  for (let i = 0; i < bands.length; i++) {
    drawBand(ctx, opts, bands[i], i);
  }

  if (schedule.kind === "Graded") {
    drawTrancheMarkers(ctx, opts);
  }

  drawClaimableMarker(ctx, opts);

  if (selected) {
    ctx.strokeStyle = colors.selection;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, y - 1.5, width - 1, height + 3);
  }
}

function drawBand(
  ctx: CanvasRenderingContext2D,
  opts: RowDrawOptions,
  band: { y: number; height: number },
  bandIndex: number
): void {
  const { schedule, view, width, colors, hatch, cursorLedger } = opts;
  const leg = schedule.tokens[Math.min(bandIndex, schedule.tokens.length - 1)];
  const color = tokenColor(colors, leg?.token ?? "", bandIndex);

  const start = schedule.start_time;
  const end = endLedger(schedule);
  const cliff = Math.min(cliffEndLedger(schedule), end);

  // Inset multi-token bands slightly so the separation is visible.
  const inset = schedule.tokens.length > 1 ? 1 : 0;
  const bandY = band.y + inset;
  const bandH = Math.max(1, band.height - inset * 2);

  const track = clipSpan(ledgerToX(start, view), ledgerToX(end, view), width);
  if (!track) return;

  // Rail: the schedule's full extent, drawn even when nothing has vested.
  ctx.fillStyle = colors.rowRail;
  ctx.fillRect(track.x0, bandY, Math.max(1, track.x1 - track.x0), bandH);

  // Cliff: hatched, bounded strictly to [start, cliffEnd].
  if (cliff > start) {
    const cliffSpan = clipSpan(ledgerToX(start, view), ledgerToX(cliff, view), width);
    if (cliffSpan && cliffSpan.x1 > cliffSpan.x0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cliffSpan.x0, bandY, cliffSpan.x1 - cliffSpan.x0, bandH);
      ctx.clip();
      ctx.fillStyle = hatch ?? withAlpha(colors.cliff, 0.25);
      ctx.fillRect(cliffSpan.x0, bandY, cliffSpan.x1 - cliffSpan.x0, bandH);
      ctx.restore();
    }
  }

  // Vesting body: gradient from the cliff release to the end of vesting.
  if (end > cliff) {
    const bodySpan = clipSpan(ledgerToX(cliff, view), ledgerToX(end, view), width);
    if (bodySpan && bodySpan.x1 > bodySpan.x0) {
      ctx.fillStyle = createBodyFill(ctx, bodySpan.x0, bodySpan.x1, color);
      ctx.fillRect(bodySpan.x0, bandY, bodySpan.x1 - bodySpan.x0, bandH);
    }
  }

  // Elapsed portion up to the cursor, so the row reads as a progress bar.
  const filledTo = Math.min(Math.max(cursorLedger, start), end);
  if (filledTo > start) {
    const fill = clipSpan(ledgerToX(start, view), ledgerToX(filledTo, view), width);
    if (fill && fill.x1 > fill.x0) {
      ctx.fillStyle = withAlpha(color, 0.35);
      ctx.fillRect(fill.x0, bandY, fill.x1 - fill.x0, bandH);
    }
  }

  if (schedule.revoked) {
    ctx.strokeStyle = withAlpha(colors.cursor, 0.8);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(track.x0, bandY + bandH / 2);
    ctx.lineTo(track.x1, bandY + bandH / 2);
    ctx.stroke();
  }
}

/**
 * Vertical ticks at each graded tranche unlock, with amount labels when the row
 * is tall enough to fit them.
 */
function drawTrancheMarkers(ctx: CanvasRenderingContext2D, opts: RowDrawOptions): void {
  const { schedule, y, height, view, width, colors } = opts;
  const ledgers = trancheLedgers(schedule);
  if (ledgers.length === 0) return;

  ctx.save();
  ctx.strokeStyle = withAlpha(colors.foreground, 0.7);
  ctx.lineWidth = 1;
  ctx.fillStyle = colors.muted;
  ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "top";

  const showLabels = height >= TRANCHE_LABEL_MIN_HEIGHT;
  for (let i = 0; i < ledgers.length; i++) {
    const rawX = ledgerToX(ledgers[i], view);
    if (rawX < -1 || rawX > width + 1) continue;
    const x = Math.round(rawX) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + height);
    ctx.stroke();
    if (showLabels) {
      const pct = schedule.milestones.find((m) => m.timestamp === ledgers[i])?.pct ?? 0;
      ctx.fillText(`${formatPct(pct)}%`, x + 2, y + 2);
    }
  }
  ctx.restore();
}

/**
 * Dot on the cursor line for rows with something claimable at that instant.
 *
 * This is the visible payoff of the worker pass: scrubbing the cursor lights up
 * exactly the schedules that would have tokens available at that moment.
 */
function drawClaimableMarker(ctx: CanvasRenderingContext2D, opts: RowDrawOptions): void {
  const { schedule, y, height, view, width, colors, cursorLedger, claimable } = opts;
  if (claimable <= 0n) return;
  const x = ledgerToX(cursorLedger, view);
  if (!Number.isFinite(x) || x < -1 || x > width + 1) return;

  const radius = Math.min(3, height / 4);
  ctx.save();
  ctx.fillStyle = tokenColor(colors, schedule.tokens[0]?.token ?? "", 0);
  ctx.beginPath();
  ctx.arc(x, y + height / 2, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ── Cursor & loading ────────────────────────────────────────────────────────

export function drawCursor(
  ctx: CanvasRenderingContext2D,
  opts: { x: number; width: number; height: number; colors: TimelineColors; label: string }
): void {
  const { x, width, height, colors, label } = opts;
  if (!Number.isFinite(x) || x < -1 || x > width + 1) return;

  const px = Math.round(x) + 0.5;
  ctx.save();
  ctx.strokeStyle = colors.cursor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, AXIS_HEIGHT);
  ctx.lineTo(px, height);
  ctx.stroke();

  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const textWidth = measureText(ctx, label) + 10;
  // Flip the label to the left edge when the cursor nears the right border.
  const boxX = px + textWidth > width ? px - textWidth - 2 : px + 2;
  ctx.fillStyle = colors.cursor;
  ctx.fillRect(boxX, 2, textWidth, AXIS_HEIGHT - 6);
  ctx.fillStyle = colors.background;
  ctx.fillText(label, boxX + 5, 2 + (AXIS_HEIGHT - 6) / 2);
  ctx.restore();
}

/** Formats the cursor read-out as a date rather than a raw ledger number. */
export function formatCursorLabel(ledger: number, ledgersPerPixel: number): string {
  const d = new Date(ledger * 1000);
  if (ledgersPerPixel < 3600) {
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
  return d.toLocaleDateString();
}

/**
 * Loading placeholder: banded rows with a sweeping highlight.
 *
 * `phase` runs 0→1; callers hold it at 0 under reduced motion so the shimmer
 * becomes a static skeleton.
 */
export function drawShimmer(
  ctx: CanvasRenderingContext2D,
  opts: {
    width: number;
    height: number;
    colors: TimelineColors;
    phase: number;
    rowHeight: number;
    rowGap: number;
  }
): void {
  const { width, height, colors, phase, rowHeight, rowGap } = opts;
  ctx.save();
  ctx.fillStyle = colors.rowRail;
  for (let y = AXIS_HEIGHT + 12; y < height; y += rowHeight + rowGap) {
    const barWidth = width * (0.45 + 0.4 * ((Math.sin(y) + 1) / 2));
    ctx.fillRect(16, y, barWidth, rowHeight);
  }
  const sweepX = -width * 0.3 + phase * width * 1.6;
  const gradient = ctx.createLinearGradient(sweepX, 0, sweepX + width * 0.3, 0);
  if (gradient) {
    gradient.addColorStop(0, withAlpha(colors.foreground, 0));
    gradient.addColorStop(0.5, withAlpha(colors.foreground, 0.06));
    gradient.addColorStop(1, withAlpha(colors.foreground, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, AXIS_HEIGHT, width, height - AXIS_HEIGHT);
  }
  ctx.restore();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function createBodyFill(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  color: string
): string | CanvasGradient {
  if (typeof ctx.createLinearGradient !== "function") return withAlpha(color, 0.6);
  const gradient = ctx.createLinearGradient(x0, 0, x1, 0);
  if (!gradient) return withAlpha(color, 0.6);
  gradient.addColorStop(0, withAlpha(color, 0.25));
  gradient.addColorStop(1, withAlpha(color, 0.85));
  return gradient;
}

function measureText(ctx: CanvasRenderingContext2D, text: string): number {
  if (typeof ctx.measureText !== "function") return text.length * 6;
  const measured = ctx.measureText(text)?.width;
  return Number.isFinite(measured) && measured > 0 ? measured : text.length * 6;
}

function formatPct(pct: number): string {
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

/**
 * Apply an alpha to a theme colour.
 *
 * Theme tokens arrive as hex or `rgb()/rgba()` strings depending on which
 * variable they came from, so both forms are handled; anything unexpected is
 * returned untouched rather than producing an invalid fill style.
 */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const a = Math.max(0, Math.min(1, alpha));

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const raw = hex[1];
    const full =
      raw.length === 3
        ? raw
            .split("")
            .map((ch) => ch + ch)
            .join("")
        : raw;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a})`;
    }
  }

  return c;
}
