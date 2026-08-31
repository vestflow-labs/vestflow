"use client";

import { useMemo, useState } from "react";

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

  const cx = 100;
  const cy = 100;
  const r = 90;
  let cumulativeAngle = 0;

  const arcs = slices.map((slice) => {
    const startAngle = cumulativeAngle;
    const sweepAngle = (slice.weightBps / totalBps) * 360;
    cumulativeAngle += sweepAngle;
    return {
      ...slice,
      startAngle,
      endAngle: cumulativeAngle,
      sweepAngle,
    };
  });

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <svg
        viewBox="0 0 200 200"
        className="w-48 h-48 shrink-0"
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
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
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
              {arc.sweepAngle > 15 && (
                <text
                  x={labelPos.x}
                  y={labelPos.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="white"
                  fontSize="8"
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
  );
}
