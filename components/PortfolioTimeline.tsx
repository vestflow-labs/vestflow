"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useClaimableWorker } from "@/hooks/useClaimableWorker";
import type { ClaimableResult } from "@/lib/portfolio/claimable";
import {
  AXIS_HEIGHT,
  createHatchPattern,
  drawCursor,
  drawScheduleRow,
  drawShimmer,
  drawTimeAxis,
  formatCursorLabel,
  readTimelineColors,
  type TimelineColors,
} from "@/lib/portfolio/render";
import {
  DEFAULT_ROW_GAP,
  DEFAULT_ROW_HEIGHT,
  computeRowLayout,
  fitViewport,
  getRowAtY,
  ledgerToX,
  maxScrollOffset,
  panByPixels,
  visibleRowRange,
  xToLedger,
  zoomAt,
  type Viewport,
} from "@/lib/portfolio/timeline";
import type { TimelineSchedule } from "@/lib/portfolio/types";

export interface PortfolioTimelineProps {
  schedules: TimelineSchedule[];
  loading?: boolean;
  selectedId?: number | null;
  onSelect?: (schedule: TimelineSchedule | null) => void;
  /** Fires (at most once per frame) with claimable amounts at the cursor. */
  onClaimableChange?: (claimable: Map<number, bigint>, cursorLedger: number) => void;
  /** Canvas height in CSS pixels. */
  height?: number;
  rowHeight?: number;
  /** Test seam: pins "now" so rendering is deterministic. */
  now?: number;
}

/** Gap between the axis strip and the first row. */
const CONTENT_TOP = AXIS_HEIGHT + 8;
/** How close (px) a pointer must be to the cursor line to grab it. */
const CURSOR_GRAB_PX = 8;
/** Pointer travel below which a press counts as a click, not a drag. */
const CLICK_SLOP_PX = 4;
/** Used before layout reports a width, so the first paint is still meaningful. */
const FALLBACK_WIDTH = 900;

const ROLE_LABELS: Record<TimelineSchedule["role"], string> = {
  grantor: "granted by you",
  beneficiary: "vesting to you",
  both: "granted by and vesting to you",
};

const TOOLBAR_BUTTON =
  "rounded-md border border-[var(--border-default)] px-2 py-1 text-[var(--foreground)] transition-opacity hover:opacity-70";

/**
 * Interactive portfolio timeline.
 *
 * Every schedule the wallet touches is one row on a single `<canvas>`. Using
 * one canvas rather than a DOM node per schedule is what makes 200+ rows with
 * live pan, zoom and cursor scrubbing viable: there is no layout to invalidate,
 * only rows that intersect the viewport are drawn, and each frame costs the
 * same whether the portfolio holds ten schedules or a thousand.
 *
 * Frames are pull-based. Interaction sets a dirty flag; a `requestAnimationFrame`
 * loop repaints only when that flag is set, so an idle timeline costs nothing.
 */
function PortfolioTimelineImpl({
  schedules,
  loading = false,
  selectedId = null,
  onSelect,
  onClaimableChange,
  height = 420,
  rowHeight = DEFAULT_ROW_HEIGHT,
  now,
}: PortfolioTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [mountedNow] = useState(() => Math.floor(Date.now() / 1000));
  const nowLedger = now ?? mountedNow;

  const layout = useMemo(
    () => computeRowLayout(schedules, { rowHeight, rowGap: DEFAULT_ROW_GAP }),
    [schedules, rowHeight]
  );

  // ── Mutable render state ─────────────────────────────────────────────────
  // Kept in refs, not React state: pan, zoom and cursor updates must repaint
  // the canvas without re-rendering the tree.
  const viewRef = useRef<Viewport>({ startLedger: nowLedger, ledgersPerPixel: 86_400 });
  const sizeRef = useRef({ width: FALLBACK_WIDTH, height });
  const scrollRef = useRef(0);
  const cursorRef = useRef(nowLedger);
  const cursorTargetRef = useRef(nowLedger);
  const hoverRowRef = useRef<number | null>(null);
  const claimableRef = useRef<Map<number, bigint>>(new Map());
  const colorsRef = useRef<TimelineColors>(readTimelineColors(null));
  const hatchRef = useRef<CanvasPattern | null>(null);
  const dirtyRef = useRef(true);
  const interactedRef = useRef(false);
  const reducedMotionRef = useRef(false);
  const shimmerPhaseRef = useRef(0);

  // Latest-render mirrors, refreshed in a commit-time effect so the animation
  // loop and the pointer handlers — both of which run outside React's render —
  // see current values without turning every frame into a re-render.
  const drawRef = useRef<() => void>(() => {});
  const layoutRef = useRef(layout);
  const schedulesRef = useRef(schedules);
  const focusedRowRef = useRef(0);
  const onClaimableChangeRef = useRef(onClaimableChange);

  const [focusedRow, setFocusedRow] = useState(0);
  const [cursorLabel, setCursorLabel] = useState(() =>
    formatCursorLabel(now ?? mountedNow, 86_400)
  );

  // ── Worker plumbing ──────────────────────────────────────────────────────

  const pendingClaimableRef = useRef<{ map: Map<number, bigint>; ledger: number } | null>(
    null
  );
  const flushHandleRef = useRef(0);

  const handleResults = useCallback(
    (results: ClaimableResult[], cursorLedger: number) => {
      const map = new Map<number, bigint>();
      for (const r of results) map.set(r.scheduleId, r.claimableAtCursor);
      claimableRef.current = map;
      dirtyRef.current = true;

      // Coalesce parent notifications to one per frame: a drag produces far
      // more worker responses than the summary panel needs re-renders.
      pendingClaimableRef.current = { map, ledger: cursorLedger };
      if (flushHandleRef.current || typeof requestAnimationFrame === "undefined") return;
      flushHandleRef.current = requestAnimationFrame(() => {
        flushHandleRef.current = 0;
        const pending = pendingClaimableRef.current;
        pendingClaimableRef.current = null;
        if (pending) onClaimableChangeRef.current?.(pending.map, pending.ledger);
      });
    },
    []
  );

  const { requestCursor } = useClaimableWorker(schedules, handleResults);

  const setCursorLedger = useCallback(
    (rawLedger: number, immediate: boolean) => {
      // Pointer X maps to a fractional timestamp; ledger time is whole seconds.
      const ledger = Math.round(rawLedger);
      cursorTargetRef.current = ledger;
      if (immediate || reducedMotionRef.current) cursorRef.current = ledger;
      setCursorLabel(formatCursorLabel(ledger, viewRef.current.ledgersPerPixel));
      requestCursor(ledger);
      dirtyRef.current = true;
    },
    [requestCursor]
  );

  // ── Theme ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const refreshColors = () => {
      colorsRef.current = readTimelineColors(canvasRef.current);
      // The hatch tile bakes in a colour, so rebuild it alongside the palette.
      hatchRef.current = null;
      dirtyRef.current = true;
    };
    refreshColors();

    const observer = new MutationObserver(refreshColors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      reducedMotionRef.current = query.matches;
      if (query.matches) {
        // Snap straight to the target instead of easing towards it.
        cursorRef.current = cursorTargetRef.current;
        shimmerPhaseRef.current = 0;
        dirtyRef.current = true;
      }
    };
    apply();
    query.addEventListener?.("change", apply);
    return () => query.removeEventListener?.("change", apply);
  }, []);

  // ── Sizing ───────────────────────────────────────────────────────────────

  const resize = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const rect = container.getBoundingClientRect();
    const width = Math.round(rect.width || container.clientWidth || FALLBACK_WIDTH);
    const cssHeight = Math.round(rect.height || height);
    sizeRef.current = { width, height: cssHeight };

    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    // Draw in CSS pixels; the backing store keeps the device resolution.
    canvas.getContext("2d")?.setTransform?.(dpr, 0, 0, dpr, 0, 0);

    if (!interactedRef.current) {
      viewRef.current = fitViewport(schedules, width, nowLedger);
    }
    dirtyRef.current = true;
  }, [height, nowLedger, schedules]);

  // ── Drawing ──────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height: canvasHeight } = sizeRef.current;
    const colors = colorsRef.current;
    const view = viewRef.current;

    ctx.clearRect(0, 0, width, canvasHeight);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, canvasHeight);

    if (loading) {
      drawShimmer(ctx, {
        width,
        height: canvasHeight,
        colors,
        phase: shimmerPhaseRef.current,
        rowHeight,
        rowGap: DEFAULT_ROW_GAP,
      });
      return;
    }

    drawTimeAxis(ctx, { view, width, height: canvasHeight, colors });

    if (!hatchRef.current) {
      hatchRef.current = createHatchPattern(ctx, colors.cliff);
    }

    const viewportHeight = canvasHeight - CONTENT_TOP;
    const { start, end } = visibleRowRange(layout, scrollRef.current, viewportHeight);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, CONTENT_TOP, width, Math.max(0, viewportHeight));
    ctx.clip();

    for (let i = start; i < end; i++) {
      const schedule = schedules[i];
      if (!schedule) continue;
      drawScheduleRow(ctx, {
        schedule,
        y: CONTENT_TOP + layout.yPositions[i] - scrollRef.current,
        height: layout.heights[i],
        width,
        colors,
        view,
        hatch: hatchRef.current,
        cursorLedger: cursorRef.current,
        claimable: claimableRef.current.get(schedule.id) ?? 0n,
        selected: schedule.id === selectedId,
        hovered: hoverRowRef.current === i,
      });
    }
    ctx.restore();

    drawCursor(ctx, {
      x: ledgerToX(cursorRef.current, view),
      width,
      height: canvasHeight,
      colors,
      label: formatCursorLabel(cursorRef.current, view.ledgersPerPixel),
    });
  }, [layout, loading, rowHeight, schedules, selectedId]);

  // First paint happens synchronously during commit so the timeline is never
  // blank for a frame, and so its cost lands inside the profiled render.
  useLayoutEffect(() => {
    resize();
    draw();
    dirtyRef.current = false;
  }, [draw, resize]);

  // Refit the view when a fresh data set arrives, unless the user has taken
  // control of pan and zoom.
  useEffect(() => {
    if (interactedRef.current) return;
    viewRef.current = fitViewport(schedules, sizeRef.current.width, nowLedger);
    dirtyRef.current = true;
  }, [schedules, nowLedger]);

  // Seed the worker so rows carry claimable values before the first drag.
  useEffect(() => {
    requestCursor(cursorTargetRef.current);
  }, [schedules, requestCursor]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", resize);
      return () => window.removeEventListener("resize", resize);
    }
    const observer = new ResizeObserver(resize);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [resize]);

  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined") return;
    let handle = 0;
    const loop = () => {
      if (!reducedMotionRef.current) {
        // Ease the cursor towards its target; reduced motion snapped it already.
        const delta = cursorTargetRef.current - cursorRef.current;
        if (Math.abs(delta) > viewRef.current.ledgersPerPixel * 0.5) {
          cursorRef.current += delta * 0.35;
          dirtyRef.current = true;
        } else if (cursorRef.current !== cursorTargetRef.current) {
          cursorRef.current = cursorTargetRef.current;
          dirtyRef.current = true;
        }
        if (loading) {
          shimmerPhaseRef.current = (shimmerPhaseRef.current + 0.012) % 1;
          dirtyRef.current = true;
        }
      }
      if (dirtyRef.current) {
        dirtyRef.current = false;
        drawRef.current();
      }
      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, [loading]);

  useEffect(
    () => () => {
      if (flushHandleRef.current) cancelAnimationFrame(flushHandleRef.current);
    },
    []
  );

  // ── Pointer interaction ──────────────────────────────────────────────────

  const dragRef = useRef<{
    mode: "cursor" | "pan";
    lastX: number;
    lastY: number;
    moved: number;
  } | null>(null);

  const rowAtPoint = useCallback((y: number): number | null => {
    const contentY = y - CONTENT_TOP + scrollRef.current;
    if (contentY < 0) return null;
    return getRowAtY(layoutRef.current, contentY);
  }, []);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = e.currentTarget;
      const { x, y } = localPoint(canvas, e);
      const cursorX = ledgerToX(cursorRef.current, viewRef.current);
      // The axis strip and the cursor line itself grab the cursor; anywhere
      // else in the row area pans the view.
      const grabbingCursor = y <= AXIS_HEIGHT || Math.abs(x - cursorX) <= CURSOR_GRAB_PX;

      dragRef.current = {
        mode: grabbingCursor ? "cursor" : "pan",
        lastX: x,
        lastY: y,
        moved: 0,
      };
      if (!grabbingCursor) canvas.style.cursor = "grabbing";
      canvas.setPointerCapture?.(e.pointerId);
      if (grabbingCursor) setCursorLedger(xToLedger(x, viewRef.current), true);
    },
    [setCursorLedger]
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const { x, y } = localPoint(e.currentTarget, e);
      const drag = dragRef.current;

      if (!drag) {
        const row = rowAtPoint(y);
        if (row !== hoverRowRef.current) {
          hoverRowRef.current = row;
          dirtyRef.current = true;
        }
        return;
      }

      drag.moved += Math.abs(x - drag.lastX) + Math.abs(y - drag.lastY);

      if (drag.mode === "cursor") {
        // Turn pointer X back into a ledger timestamp and let the worker
        // re-project every schedule at that instant.
        setCursorLedger(xToLedger(x, viewRef.current), false);
      } else {
        // Only an actual pan counts as taking control; a plain click should not
        // stop the view from re-fitting when fresh data arrives.
        interactedRef.current = true;
        viewRef.current = panByPixels(viewRef.current, x - drag.lastX);
        const viewportHeight = sizeRef.current.height - CONTENT_TOP;
        scrollRef.current = Math.min(
          maxScrollOffset(layoutRef.current, viewportHeight),
          Math.max(0, scrollRef.current - (y - drag.lastY))
        );
        dirtyRef.current = true;
      }

      drag.lastX = x;
      drag.lastY = y;
    },
    [rowAtPoint, setCursorLedger]
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = e.currentTarget;
      const drag = dragRef.current;
      dragRef.current = null;
      canvas.style.cursor = "crosshair";
      canvas.releasePointerCapture?.(e.pointerId);
      if (!drag || drag.mode !== "pan" || drag.moved > CLICK_SLOP_PX) return;

      // A press that did not travel is a click: hit-test it to a row.
      const { y } = localPoint(canvas, e);
      const row = rowAtPoint(y);
      if (row !== null) setFocusedRow(row);
      onSelect?.(row === null ? null : schedulesRef.current[row] ?? null);
    },
    [onSelect, rowAtPoint]
  );

  const handlePointerLeave = useCallback(() => {
    if (hoverRowRef.current !== null) {
      hoverRowRef.current = null;
      dirtyRef.current = true;
    }
  }, []);

  // Wheel needs a non-passive listener so zooming does not also scroll the page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      interactedRef.current = true;

      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        viewRef.current = zoomAt(viewRef.current, x, e.deltaY > 0 ? 1.15 : 1 / 1.15);
      } else {
        const viewportHeight = sizeRef.current.height - CONTENT_TOP;
        const next = scrollRef.current + e.deltaY;
        const max = maxScrollOffset(layoutRef.current, viewportHeight);
        // Only swallow the scroll while there is timeline left to scroll.
        if (max > 0 && next >= 0 && next <= max) e.preventDefault();
        scrollRef.current = Math.min(max, Math.max(0, next));
      }
      dirtyRef.current = true;
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // ── Keyboard ─────────────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
      const view = viewRef.current;
      const step = view.ledgersPerPixel * (e.shiftKey ? 40 : 8);
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          setCursorLedger(cursorTargetRef.current - step, true);
          break;
        case "ArrowRight":
          e.preventDefault();
          setCursorLedger(cursorTargetRef.current + step, true);
          break;
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const rows = layoutRef.current;
          const next = Math.min(
            Math.max(0, focusedRowRef.current + delta),
            Math.max(0, schedulesRef.current.length - 1)
          );
          setFocusedRow(next);
          hoverRowRef.current = next;
          // Keep the focused row inside the viewport.
          const viewportHeight = sizeRef.current.height - CONTENT_TOP;
          const top = rows.yPositions[next] ?? 0;
          const bottom = top + (rows.heights[next] ?? 0);
          if (top < scrollRef.current) scrollRef.current = top;
          else if (bottom > scrollRef.current + viewportHeight) {
            scrollRef.current = bottom - viewportHeight;
          }
          dirtyRef.current = true;
          break;
        }
        case "Enter":
        case " ":
          e.preventDefault();
          onSelect?.(schedulesRef.current[focusedRowRef.current] ?? null);
          break;
        case "+":
        case "=":
          e.preventDefault();
          interactedRef.current = true;
          viewRef.current = zoomAt(view, sizeRef.current.width / 2, 1 / 1.3);
          dirtyRef.current = true;
          break;
        case "-":
          e.preventDefault();
          interactedRef.current = true;
          viewRef.current = zoomAt(view, sizeRef.current.width / 2, 1.3);
          dirtyRef.current = true;
          break;
        default:
          break;
      }
    },
    [onSelect, setCursorLedger]
  );

  // ── Toolbar actions ──────────────────────────────────────────────────────

  const zoomBy = useCallback((factor: number) => {
    interactedRef.current = true;
    viewRef.current = zoomAt(viewRef.current, sizeRef.current.width / 2, factor);
    dirtyRef.current = true;
  }, []);

  const resetView = useCallback(() => {
    interactedRef.current = false;
    viewRef.current = fitViewport(schedulesRef.current, sizeRef.current.width, nowLedger);
    scrollRef.current = 0;
    dirtyRef.current = true;
  }, [nowLedger]);

  const cursorToNow = useCallback(() => {
    setCursorLedger(nowLedger, true);
  }, [nowLedger, setCursorLedger]);

  const focusedSummary = useMemo(() => {
    const schedule = schedules[focusedRow];
    if (!schedule) return "No schedules on the timeline.";
    return `Row ${focusedRow + 1} of ${schedules.length}: schedule ${schedule.id}, ${schedule.kind}, ${ROLE_LABELS[schedule.role]}. Press Enter for details.`;
  }, [focusedRow, schedules]);

  // Refresh the latest-render mirrors. Declared last so every value it copies
  // is already defined; effects always run before the next frame or pointer
  // event that reads them.
  useLayoutEffect(() => {
    drawRef.current = draw;
    layoutRef.current = layout;
    schedulesRef.current = schedules;
    focusedRowRef.current = focusedRow;
    onClaimableChangeRef.current = onClaimableChange;
  });

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-xs">
        <span className="text-[var(--muted-light)]">Cursor</span>
        <span className="font-medium tabular-nums text-[var(--foreground)]" data-testid="cursor-label">
          {cursorLabel}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={cursorToNow} className={TOOLBAR_BUTTON}>
            Now
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1 / 1.3)}
            aria-label="Zoom in"
            className={TOOLBAR_BUTTON}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1.3)}
            aria-label="Zoom out"
            className={TOOLBAR_BUTTON}
          >
            −
          </button>
          <button type="button" onClick={resetView} className={TOOLBAR_BUTTON}>
            Fit
          </button>
        </div>
      </div>

      <div ref={containerRef} style={{ height }} className="relative w-full">
        <canvas
          ref={canvasRef}
          role="application"
          tabIndex={0}
          aria-label={`Vesting timeline for ${schedules.length} schedules`}
          aria-describedby="portfolio-timeline-help"
          className="block h-full w-full cursor-crosshair touch-none outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onKeyDown={handleKeyDown}
        />
      </div>

      <p id="portfolio-timeline-help" className="sr-only">
        Drag the time axis to move the cursor, drag a row to pan, and hold shift
        or control while scrolling to zoom. Use the arrow keys to move the cursor
        and change rows, and Enter to open a schedule.
      </p>

      {/*
        Screen-reader view of the row the keyboard is on. Deliberately a single
        live region rather than one node per schedule: the canvas exists so the
        DOM stays constant-size no matter how many schedules are in view.
      */}
      <p className="sr-only" role="status" aria-live="polite">
        {focusedSummary}
      </p>
    </div>
  );
}

/** Pointer position relative to the canvas's top-left corner. */
function localPoint(
  canvas: HTMLCanvasElement,
  e: { clientX: number; clientY: number }
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

const PortfolioTimeline = memo(PortfolioTimelineImpl);
export default PortfolioTimeline;
