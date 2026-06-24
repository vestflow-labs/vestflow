"use client";
import { useEffect, useState } from "react";
import { ScheduleData, stroopsToXlm } from "@/lib/stellar";
import { getThemeColors } from "@/lib/theme";

interface Props {
  schedule: ScheduleData;
}

export default function VestingChart({ schedule }: Props) {
  const [colors, setColors] = useState(getThemeColors());

  useEffect(() => {
    // Update colors when theme changes
    const updateColors = () => setColors(getThemeColors());
    setColors(getThemeColors());
    
    // Listen for changes to theme
    const observer = new MutationObserver(() => {
      setColors(getThemeColors());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    
    return () => observer.disconnect();
  }, []);
  const { id, start_time, duration, cliff_duration, total_amount, kind } = schedule;
  const end_time = start_time + duration;
  const now = Math.floor(Date.now() / 1000);

  const W = 400;
  const H = 150;
  const PAD = { top: 12, right: 16, bottom: 28, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Fraction vested (0–1) at unix timestamp t
  function vestedFrac(t: number): number {
    if (t <= start_time) return 0;
    if (t >= end_time) return 1;
    const elapsed = t - start_time;
    if (kind === "Cliff") {
      return elapsed >= cliff_duration ? 1 : 0;
    }
    // Linear — may have a waiting cliff before linear ramp begins
    if (cliff_duration > 0 && elapsed < cliff_duration) return 0;
    const vestStart = cliff_duration > 0 ? cliff_duration : 0;
    const vestDuration = duration - vestStart;
    return Math.min(1, (elapsed - vestStart) / vestDuration);
  }

  const toX = (t: number) => PAD.left + ((t - start_time) / duration) * plotW;
  const toY = (frac: number) => PAD.top + plotH * (1 - frac);

  // Sample 50 evenly-spaced points
  const pts: { x: number; y: number }[] = Array.from({ length: 51 }, (_, i) => {
    const t = start_time + (i / 50) * duration;
    return { x: toX(t), y: toY(vestedFrac(t)) };
  });

  // For cliff kinds, inject sharp step at the cliff boundary so the path is a true step function
  if (cliff_duration > 0 && cliff_duration < duration) {
    const cliffT = start_time + cliff_duration;
    const stepBefore = { x: toX(cliffT) - 0.5, y: toY(0) };
    const stepAfter = { x: toX(cliffT), y: toY(kind === "Cliff" ? 1 : 0) };
    // Insert in sorted x order
    const insertIdx = pts.findIndex(p => p.x >= stepBefore.x);
    if (insertIdx !== -1) {
      pts.splice(insertIdx, 0, stepBefore, stepAfter);
    }
  }

  const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaD = `${pathD} L${toX(end_time)},${toY(0)} L${toX(start_time)},${toY(0)} Z`;

  const nowInRange = now > start_time && now < end_time;
  const nowX = nowInRange ? toX(now) : null;

  const cliffT = start_time + cliff_duration;
  const showCliff = cliff_duration > 0 && cliff_duration < duration;
  const cliffDotY = toY(vestedFrac(cliffT));

  // Unique gradient IDs per schedule so multiple charts on the same page don't conflict
  const gLine = `vl-${id}`;
  const gArea = `va-${id}`;

  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", year: "2-digit" });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label="Vesting curve chart">
      <defs>
        <linearGradient id={gLine} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={colors.accentPrimary} />
          <stop offset="100%" stopColor={colors.accentSecondary} />
        </linearGradient>
        <linearGradient id={gArea} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors.accentPrimary} stopOpacity="0.25" />
          <stop offset="100%" stopColor={colors.accentPrimary} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map(f => (
        <line
          key={f}
          x1={PAD.left} y1={toY(f)}
          x2={PAD.left + plotW} y2={toY(f)}
          stroke={colors.borderSubtle}
          strokeWidth={f === 0 || f === 1 ? 1.5 : 1}
        />
      ))}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} stroke={colors.borderSubtle} strokeWidth={1.5} />

      {/* Area fill */}
      <path d={areaD} fill={`url(#${gArea})`} />

      {/* Curve */}
      <path d={pathD} fill="none" stroke={`url(#${gLine})`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* Cliff marker dot */}
      {showCliff && (
        <>
          <line x1={toX(cliffT)} y1={PAD.top} x2={toX(cliffT)} y2={PAD.top + plotH} stroke={colors.accentPrimary} strokeWidth={1} strokeDasharray="3,3" opacity={0.4} />
          <circle cx={toX(cliffT)} cy={cliffDotY} r={4} fill={colors.accentPrimary} stroke="var(--background)" strokeWidth={1.5} />
          <text x={toX(cliffT)} y={H - 4} fill={colors.accentPrimary} fontSize={8} textAnchor="middle" fontFamily="sans-serif">Cliff</text>
        </>
      )}

      {/* Current-time dashed line */}
      {nowX !== null && (
        <>
          <line x1={nowX} y1={PAD.top} x2={nowX} y2={PAD.top + plotH} stroke={colors.accentSecondary} strokeWidth={1.5} strokeDasharray="4,3" />
          <text x={nowX + 3} y={PAD.top + 9} fill={colors.accentSecondary} fontSize={8} fontFamily="sans-serif">Now</text>
        </>
      )}

      {/* Y-axis labels */}
      <text x={PAD.left - 4} y={toY(0) + 4} fill={colors.mutedLight} fontSize={8} textAnchor="end" fontFamily="monospace">0</text>
      <text x={PAD.left - 4} y={toY(0.5) + 4} fill={colors.mutedLight} fontSize={8} textAnchor="end" fontFamily="monospace">
        {(Number(total_amount) / 2 / 10_000_000).toFixed(0)}
      </text>
      <text x={PAD.left - 4} y={toY(1) + 4} fill={colors.mutedLight} fontSize={8} textAnchor="end" fontFamily="monospace">
        {stroopsToXlm(total_amount)}
      </text>

      {/* X-axis labels */}
      <text x={toX(start_time)} y={H - 4} fill={colors.mutedLight} fontSize={8} textAnchor="middle" fontFamily="sans-serif">{fmt(start_time)}</text>
      <text x={toX(end_time)} y={H - 4} fill={colors.mutedLight} fontSize={8} textAnchor="middle" fontFamily="sans-serif">{fmt(end_time)}</text>
    </svg>
  );
}
