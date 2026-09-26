"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface PieSlice {
  address: string;
  weightBps: number;
  percentage: number;
  color: string;
  label: string;
}

const SLICE_COLORS = [
  "#7c3aed",
  "#06b6d4",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
  "#e11d48",
];

function truncateAddress(address: string, prefixLen = 6, suffixLen = 4): string {
  if (address.length <= prefixLen + suffixLen + 3) return address;
  return `${address.slice(0, prefixLen)}...${address.slice(-suffixLen)}`;
}

function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return [
    "M", cx, cy,
    "L", start.x, start.y,
    "A", r, r, 0, largeArcFlag, 0, end.x, end.y,
    "Z",
  ].join(" ");
}

function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

interface PieArc extends PieSlice {
  startAngle: number;
  endAngle: number;
  sweepAngle: number;
}

const CX = 100;
const CY = 100;
const RADIUS = 90;

function buildArcs(slices: PieSlice[], totalBps: number): PieArc[] {
  let cumulativeAngle = 0;
  return slices.map((slice) => {
    const startAngle = cumulativeAngle;
    const sweepAngle = totalBps > 0 ? (slice.weightBps / totalBps) * 360 : 0;
    cumulativeAngle += sweepAngle;
    return { ...slice, startAngle, endAngle: cumulativeAngle, sweepAngle };
  });
}

interface PieSvgProps {
  arcs: PieArc[];
  selectedAddress?: string | null;
  onSelect?: (address: string | null) => void;
  hoveredIndex: number | null;
  onHover: (index: number | null) => void;
  className?: string;
  /** Font size of in-slice percentage labels, in viewBox units. */
  labelFontSize?: number;
  /** Minimum slice sweep (degrees) that gets an in-slice label. */
  minLabelSweep?: number;
}

function PieSvg({
  arcs,
  selectedAddress,
  onSelect,
  hoveredIndex,
  onHover,
  className,
  labelFontSize = 8,
  minLabelSweep = 15,
}: PieSvgProps) {
  const cx = CX;
  const cy = CY;
  const r = RADIUS;

  return (
    <svg
      viewBox="0 0 200 200"
      className={className}
      role="img"
      aria-label="Splits pie chart"
    >
      {arcs.map((arc, i) => {
        const isHovered = hoveredIndex === i;
        const isSelected = selectedAddress === arc.address;
        const midAngle = arc.startAngle + arc.sweepAngle / 2;
        const labelRadius = r * 0.65;
        const labelPos = polarToCartesian(cx, cy, labelRadius, midAngle);

        return (
          <g key={arc.address + i}>
            <path
              d={describeArc(cx, cy, r, arc.startAngle, arc.endAngle)}
              fill={arc.color}
              opacity={isSelected ? 1 : isHovered ? 0.9 : 0.75}
              stroke="var(--background)"
              strokeWidth={isSelected ? 2 : 1}
              style={{
                cursor: "pointer",
                transition: "opacity 0.15s, stroke-width 0.15s",
                transform: isHovered ? "scale(1.03)" : undefined,
                transformOrigin: `${cx}px ${cy}px`,
              }}
              onMouseEnter={() => onHover(i)}
              onMouseLeave={() => onHover(null)}
              onClick={() =>
                onSelect?.(
                  selectedAddress === arc.address ? null : arc.address,
                )
              }
              role="button"
              aria-label={`${arc.label}: ${arc.percentage.toFixed(1)}%`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect?.(
                    selectedAddress === arc.address ? null : arc.address,
                  );
                }
              }}
            />
            {arc.sweepAngle > minLabelSweep && (
              <text
                x={labelPos.x}
                y={labelPos.y}
                textAnchor="middle"
                dominantBaseline="central"
                fill="white"
                fontSize={labelFontSize}
                fontWeight="bold"
                pointerEvents="none"
                aria-hidden="true"
              >
                {arc.percentage.toFixed(0)}%
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

interface SplitsPieFullscreenProps {
  arcs: PieArc[];
  selectedAddress?: string | null;
  onSelect?: (address: string | null) => void;
  onClose: () => void;
}

/**
 * Viewport-filling view of the splits pie chart (#807) with larger labels
 * and a legend listing every receiver's full address and weight.
 */
function SplitsPieFullscreen({
  arcs,
  selectedAddress,
  onSelect,
  onClose,
}: SplitsPieFullscreenProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previousFocus = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Splits pie chart (fullscreen)"
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4"
    >
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex h-full w-full flex-col rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">Splits Distribution</h2>
            <p className="text-sm text-zinc-400">
              {arcs.length} receiver{arcs.length !== 1 ? "s" : ""}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors shrink-0 min-h-[44px] min-w-[44px]"
            aria-label="Exit fullscreen"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-1 min-h-0 flex-col lg:flex-row gap-6 p-4 sm:p-6 overflow-y-auto lg:overflow-hidden">
          <div className="flex flex-1 min-h-[16rem] min-w-0 items-center justify-center">
            <PieSvg
              arcs={arcs}
              selectedAddress={selectedAddress}
              onSelect={onSelect}
              hoveredIndex={hoveredIndex}
              onHover={setHoveredIndex}
              labelFontSize={11}
              minLabelSweep={10}
              className="h-full max-h-[75vh] w-full max-w-[75vh] aspect-square"
            />
          </div>

          <div
            className="flex flex-col gap-2 lg:w-[26rem] lg:shrink-0 lg:overflow-y-auto"
            role="list"
            aria-label="Splits receivers legend"
          >
            {arcs.map((arc, i) => {
              const isSelected = selectedAddress === arc.address;
              const isHovered = hoveredIndex === i;
              return (
                <button
                  key={arc.address + i}
                  type="button"
                  role="listitem"
                  onClick={() =>
                    onSelect?.(selectedAddress === arc.address ? null : arc.address)
                  }
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors w-full min-h-[44px] ${
                    isSelected
                      ? "bg-white/10 border border-white/20"
                      : isHovered
                        ? "bg-white/5 border border-transparent"
                        : "hover:bg-white/5 border border-transparent"
                  }`}
                  aria-label={`${arc.address}: ${arc.percentage.toFixed(2)}% (${arc.weightBps} basis points)`}
                  aria-selected={isSelected}
                >
                  <span
                    className="w-4 h-4 rounded-full shrink-0"
                    style={{ backgroundColor: arc.color }}
                    aria-hidden="true"
                  />
                  <span className="font-mono text-xs sm:text-sm text-zinc-200 break-all min-w-0">
                    {arc.address}
                  </span>
                  <span className="ml-auto flex flex-col items-end shrink-0 tabular-nums">
                    <span className="text-sm font-semibold text-zinc-100">
                      {arc.percentage.toFixed(2)}%
                    </span>
                    <span className="text-xs text-zinc-500">{arc.weightBps} bps</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

interface SplitsPieChartProps {
  receivers: Array<{ address: string; weightBps: number }>;
  selectedAddress?: string | null;
  onSelect?: (address: string | null) => void;
}

export default function SplitsPieChart({
  receivers,
  selectedAddress,
  onSelect,
}: SplitsPieChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const closeFullscreen = useCallback(() => setIsFullscreen(false), []);

  const totalBps = useMemo(
    () => receivers.reduce((sum, r) => sum + r.weightBps, 0),
    [receivers],
  );

  const slices: PieSlice[] = useMemo(() => {
    return receivers.map((receiver, i) => ({
      address: receiver.address,
      weightBps: receiver.weightBps,
      percentage: totalBps > 0 ? (receiver.weightBps / totalBps) * 100 : 0,
      color: SLICE_COLORS[i % SLICE_COLORS.length],
      label: truncateAddress(receiver.address),
    }));
  }, [receivers, totalBps]);

  if (receivers.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-zinc-500 text-sm">
        No splits configured
      </div>
    );
  }

  const arcs = buildArcs(slices, totalBps);

  return (
    <div className="relative">
    <div className="flex justify-end mb-2">
      <button
        type="button"
        onClick={() => setIsFullscreen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-1.5 min-h-[36px] transition-colors"
        aria-label="Open splits pie chart in fullscreen"
      >
        <span aria-hidden="true">⛶</span>
        Fullscreen
      </button>
    </div>
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <PieSvg
        arcs={arcs}
        selectedAddress={selectedAddress}
        onSelect={onSelect}
        hoveredIndex={hoveredIndex}
        onHover={setHoveredIndex}
        className="w-48 h-48 shrink-0"
      />

      <div className="flex flex-col gap-2 text-sm min-w-0" role="list" aria-label="Splits receivers">
        {arcs.map((arc, i) => {
          const isSelected = selectedAddress === arc.address;
          return (
            <button
              key={arc.address + i}
              type="button"
              onClick={() =>
                onSelect?.(selectedAddress === arc.address ? null : arc.address)
              }
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors w-full min-h-[44px] ${
                isSelected
                  ? "bg-white/10 border border-white/20"
                  : "hover:bg-white/5 border border-transparent"
              }`}
              role="listitem"
              aria-label={`${arc.label}: ${arc.percentage.toFixed(1)}% (${arc.weightBps} basis points)`}
              aria-selected={isSelected}
            >
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: arc.color }}
                aria-hidden="true"
              />
              <span className="font-mono text-xs text-zinc-300 truncate">
                {arc.label}
              </span>
              <span className="ml-auto text-xs text-zinc-500 tabular-nums shrink-0">
                {arc.percentage.toFixed(1)}%
              </span>
            </button>
          );
        })}
      </div>
    </div>

    {isFullscreen && (
      <SplitsPieFullscreen
        arcs={arcs}
        selectedAddress={selectedAddress}
        onSelect={onSelect}
        onClose={closeFullscreen}
      />
    )}
    </div>
  );
}
