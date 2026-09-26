/**
 * Geometry for the portfolio timeline canvas.
 *
 * Everything the canvas needs to answer "where does this go?" and "what did I
 * click?" lives here as pure functions, with no canvas or DOM access. Keeping
 * the transform and the row layout out of the render loop means both can be
 * unit-tested directly, and the renderer stays a thin drawing pass.
 *
 * Two coordinate spaces are in play:
 *
 *  - **Time → X.** `x = (ledger - startLedger) / ledgersPerPixel`. Pan moves
 *    `startLedger`; zoom scales `ledgersPerPixel`. Every draw goes through
 *    {@link ledgerToX}, so a single float transform covers a one-hour view and
 *    a five-year view alike.
 *  - **Row → Y.** Rows are laid out top-down into `yPositions`, in content
 *    space (unscrolled). The visible slice and hit-testing are both binary
 *    searches over that array.
 */

import type { TimelineSchedule } from "./types";
import { endLedger, isMultiToken } from "./types";

export interface Viewport {
  /** Ledger (Unix seconds) at canvas x = 0. */
  startLedger: number;
  /** Seconds of ledger time per CSS pixel. Larger = zoomed further out. */
  ledgersPerPixel: number;
}

/**
 * Zoom bounds.
 *
 * The lower bound keeps a one-hour window readable on a narrow canvas without
 * letting a five-year schedule's width explode past the range where canvas
 * coordinates stay exact. The upper bound comfortably covers a five-year span
 * on a 320 px viewport (≈ 493 000 s/px) with room to spare.
 */
export const MIN_LEDGERS_PER_PIXEL = 0.25;
export const MAX_LEDGERS_PER_PIXEL = 4_000_000;

/**
 * Hard cap applied to every X coordinate before it reaches the 2D context.
 *
 * Canvas implementations lose precision (and some drop the primitive entirely)
 * once coordinates run into the millions, which is exactly what happens when a
 * multi-year schedule is drawn at one-hour zoom. Clipping spans to just off
 * screen keeps the rendered result identical while the numbers stay small.
 */
export const COORD_LIMIT = 1e6;

export interface RowLayoutOptions {
  /** Height of a single schedule row, in CSS pixels. */
  rowHeight: number;
  /** Vertical space between rows. */
  rowGap: number;
  /** Padding above the first row. */
  paddingTop?: number;
}

export interface RowLayout {
  /** Top edge of each row in content space, ascending. */
  yPositions: number[];
  /** Height of each row, parallel to `yPositions`. */
  heights: number[];
  /** Full scrollable height, including the trailing gap-free bottom edge. */
  totalHeight: number;
}

export const DEFAULT_ROW_HEIGHT = 28;
export const DEFAULT_ROW_GAP = 6;

// ── Time ⇄ X ────────────────────────────────────────────────────────────────

/** Project a ledger timestamp onto canvas X. */
export function ledgerToX(ledger: number, view: Viewport): number {
  return (ledger - view.startLedger) / view.ledgersPerPixel;
}

/** Inverse of {@link ledgerToX} — used to turn pointer X into a cursor ledger. */
export function xToLedger(x: number, view: Viewport): number {
  return view.startLedger + x * view.ledgersPerPixel;
}

/** Clamp a viewport's zoom into the supported range. */
export function clampViewport(view: Viewport): Viewport {
  const ledgersPerPixel = clamp(
    view.ledgersPerPixel,
    MIN_LEDGERS_PER_PIXEL,
    MAX_LEDGERS_PER_PIXEL
  );
  const startLedger = Number.isFinite(view.startLedger) ? view.startLedger : 0;
  return { startLedger, ledgersPerPixel };
}

/**
 * Zoom by `factor` while holding the ledger under `anchorX` in place.
 *
 * `factor > 1` zooms out (more seconds per pixel). Anchoring on the pointer is
 * what makes wheel-zoom feel like the map zooms rather than jumps.
 */
export function zoomAt(view: Viewport, anchorX: number, factor: number): Viewport {
  const anchorLedger = xToLedger(anchorX, view);
  const zoomed = clampViewport({
    startLedger: view.startLedger,
    ledgersPerPixel: view.ledgersPerPixel * factor,
  });
  // Re-solve startLedger so anchorLedger lands back on anchorX.
  return {
    startLedger: anchorLedger - anchorX * zoomed.ledgersPerPixel,
    ledgersPerPixel: zoomed.ledgersPerPixel,
  };
}

/** Pan the view by a pixel delta. Dragging right (`dx > 0`) moves time backwards. */
export function panByPixels(view: Viewport, dx: number): Viewport {
  return {
    startLedger: view.startLedger - dx * view.ledgersPerPixel,
    ledgersPerPixel: view.ledgersPerPixel,
  };
}

/** Earliest and latest ledger any schedule touches, plus "now" so the cursor is reachable. */
export function scheduleBounds(
  schedules: readonly TimelineSchedule[],
  now: number = Math.floor(Date.now() / 1000)
): { min: number; max: number } {
  if (schedules.length === 0) {
    // A day either side of now, so an empty portfolio still has a sane axis.
    return { min: now - 86_400, max: now + 86_400 };
  }
  let min = Infinity;
  let max = -Infinity;
  for (const s of schedules) {
    if (s.start_time < min) min = s.start_time;
    const end = endLedger(s);
    if (end > max) max = end;
  }
  if (now < min) min = now;
  if (now > max) max = now;
  if (max <= min) max = min + 86_400;
  return { min, max };
}

/**
 * Build the viewport that shows every schedule, with a small margin.
 *
 * `width` is the canvas width in CSS pixels; a zero or negative width falls
 * back to a one-day-per-view zoom so the first frame before layout settles
 * still produces finite coordinates.
 */
export function fitViewport(
  schedules: readonly TimelineSchedule[],
  width: number,
  now: number = Math.floor(Date.now() / 1000)
): Viewport {
  const { min, max } = scheduleBounds(schedules, now);
  if (!(width > 0)) {
    return clampViewport({ startLedger: min, ledgersPerPixel: 86_400 });
  }
  const span = max - min;
  const margin = span * 0.04;
  const view = clampViewport({
    startLedger: min - margin,
    ledgersPerPixel: (span + margin * 2) / width,
  });
  return view;
}

/**
 * Clip a horizontal span to the drawable range.
 *
 * Returns `null` when the span lies entirely off screen — the caller skips the
 * draw — and otherwise returns coordinates guaranteed to be finite and small
 * enough for the 2D context to render exactly.
 */
export function clipSpan(
  x0: number,
  x1: number,
  width: number
): { x0: number; x1: number } | null {
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  // One pixel of slack so strokes that straddle the edge still show up.
  const left = -1;
  const right = width + 1;
  if (hi < left || lo > right) return null;
  return {
    x0: clamp(lo, Math.max(left, -COORD_LIMIT), Math.min(right, COORD_LIMIT)),
    x1: clamp(hi, Math.max(left, -COORD_LIMIT), Math.min(right, COORD_LIMIT)),
  };
}

// ── Row → Y ─────────────────────────────────────────────────────────────────

/**
 * Lay rows out top-down.
 *
 * Every schedule gets the same height budget — a multi-token schedule splits
 * that budget into sub-rows rather than growing — but the layout is stored as
 * explicit positions and heights so hit-testing never assumes a uniform pitch.
 */
export function computeRowLayout(
  schedules: readonly TimelineSchedule[],
  opts: RowLayoutOptions = { rowHeight: DEFAULT_ROW_HEIGHT, rowGap: DEFAULT_ROW_GAP }
): RowLayout {
  const rowHeight = Math.max(1, opts.rowHeight);
  const rowGap = Math.max(0, opts.rowGap);
  const yPositions: number[] = new Array(schedules.length);
  const heights: number[] = new Array(schedules.length);

  let y = opts.paddingTop ?? 0;
  for (let i = 0; i < schedules.length; i++) {
    yPositions[i] = y;
    heights[i] = rowHeight;
    y += rowHeight + rowGap;
  }
  // Drop the trailing gap so the content ends flush with the last row.
  const totalHeight = schedules.length > 0 ? y - rowGap : opts.paddingTop ?? 0;
  return { yPositions, heights, totalHeight };
}

/**
 * Index of the row containing `contentY`, or `null` for the gaps between rows.
 *
 * Binary search over `yPositions`: with 200+ rows this runs in ~8 comparisons
 * per pointer event instead of a linear scan.
 */
export function getRowAtY(layout: RowLayout, contentY: number): number | null {
  const { yPositions, heights } = layout;
  if (yPositions.length === 0 || !Number.isFinite(contentY)) return null;

  let lo = 0;
  let hi = yPositions.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (yPositions[mid] <= contentY) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) return null;
  return contentY < yPositions[candidate] + heights[candidate] ? candidate : null;
}

/**
 * Half-open `[start, end)` range of rows intersecting the viewport.
 *
 * This is the virtualisation: at 200 schedules only the ~20 rows on screen are
 * drawn each frame, so frame cost is bound by viewport height, not row count.
 */
export function visibleRowRange(
  layout: RowLayout,
  scrollOffset: number,
  viewportHeight: number
): { start: number; end: number } {
  const { yPositions, heights } = layout;
  const n = yPositions.length;
  if (n === 0 || viewportHeight <= 0) return { start: 0, end: 0 };

  const top = Math.max(0, scrollOffset);
  const bottom = scrollOffset + viewportHeight;

  // First row whose bottom edge is at or below the viewport top.
  let lo = 0;
  let hi = n - 1;
  let start = n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (yPositions[mid] + heights[mid] >= top) {
      start = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (start >= n) return { start: 0, end: 0 };

  // First row that starts past the viewport bottom.
  lo = start;
  hi = n - 1;
  let end = n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (yPositions[mid] > bottom) {
      end = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return { start, end };
}

/** Largest scroll offset that still shows content, never negative. */
export function maxScrollOffset(layout: RowLayout, viewportHeight: number): number {
  return Math.max(0, layout.totalHeight - viewportHeight);
}

/**
 * Sub-row rectangles for a multi-token schedule.
 *
 * The row's height budget is divided evenly, so a two-token schedule reads as
 * two half-height bars stacked inside the same slot a single-token row uses.
 */
export function subRowBands(
  s: TimelineSchedule,
  rowY: number,
  rowHeight: number
): { y: number; height: number }[] {
  if (!isMultiToken(s)) return [{ y: rowY, height: rowHeight }];
  const n = s.tokens.length;
  const bandHeight = rowHeight / n;
  return s.tokens.map((_, i) => ({ y: rowY + i * bandHeight, height: bandHeight }));
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}
