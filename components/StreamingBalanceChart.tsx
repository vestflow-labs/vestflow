"use client";

import { useEffect, useMemo, useState } from "react";
import { stroopsToXlm } from "@/lib/stellar";
import { getThemeColors } from "@/lib/theme";

interface CyclePoint {
  cycle_end: number;
  amount_received: string;
  amount_collected: string;
}

interface StreamingBalanceChartProps {
  account: string;
  token: string;
  days?: number;
}

function formatDateLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function StreamingBalanceChart({
  account,
  token,
  days = 30,
}: StreamingBalanceChartProps) {
  const [colors, setColors] = useState(getThemeColors());
  const [points, setPoints] = useState<CyclePoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setColors(getThemeColors());
    const observer = new MutationObserver(() => {
      setColors(getThemeColors());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!account || !token) {
      setPoints([]);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        setError(null);
        const from = Math.floor(Date.now() / 1000) - days * 86400;
        const url =
          `/api/analytics/cycles?account=${encodeURIComponent(account)}` +
          `&token=${encodeURIComponent(token)}&from=${from}&limit=100`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load cycle history");
        const data = await res.json();
        if (cancelled) return;
        const cycles: CyclePoint[] = Array.isArray(data.cycles)
          ? data.cycles
          : [];
        // API returns descending by cycle_end; chart needs ascending.
        cycles.sort((a, b) => a.cycle_end - b.cycle_end);
        setPoints(cycles);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load history");
          setPoints([]);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [account, token, days]);

  const chartData = useMemo(() => {
    if (!points) return null;
    return points.map((c) => ({
      t: c.cycle_end,
      // Balance at each cycle end: prefer collected total, fall back to received.
      v: Number(BigInt(c.amount_collected ?? c.amount_received ?? "0")) / 10_000_000,
      raw: c.amount_collected ?? c.amount_received ?? "0",
    }));
  }, [points]);

  if (points === null) {
    return (
      <div
        className="h-44 flex items-center justify-center text-sm text-zinc-500 animate-pulse"
        role="status"
        aria-label="Loading streaming balance history"
      >
        Loading balance history…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-44 flex items-center justify-center text-sm text-red-400" role="alert">
        {error}
      </div>
    );
  }

  if (!chartData || chartData.length < 2) {
    return (
      <div className="h-44 flex flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm text-zinc-400 font-medium">Not enough history yet</p>
        <p className="text-xs text-zinc-500">
          Balance history appears after at least 2 settlement cycles.
        </p>
      </div>
    );
  }

  const W = 560;
  const H = 220;
  const PAD = { top: 12, right: 16, bottom: 30, left: 56 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const tMin = chartData[0].t;
  const tMax = chartData[chartData.length - 1].t;
  const tSpan = Math.max(1, tMax - tMin);
  const vMax = Math.max(...chartData.map((d) => d.v), 0);
  const vCeil = vMax > 0 ? vMax * 1.1 : 1;

  const toX = (t: number) => PAD.left + ((t - tMin) / tSpan) * plotW;
  const toY = (v: number) => PAD.top + plotH * (1 - v / vCeil);

  const pts = chartData.map((d) => ({ x: toX(d.t), y: toY(d.v) }));
  const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const areaD = `${pathD} L${pts[pts.length - 1].x.toFixed(2)},${toY(0)} L${pts[0].x.toFixed(2)},${toY(0)} Z`;

  const gid = `sb-${account.slice(0, 6)}-${token.slice(0, 6)}`.replace(/[^a-zA-Z0-9-]/g, "");
  const accentPrimary = colors.accentPrimary || "#7c3aed";
  const accentSecondary = colors.accentSecondary || "#06b6d4";
  const gridColor = colors.borderSubtle || "rgba(128,128,128,0.2)";
  const labelColor = colors.mutedLight || "#71717a";

  const yTicks = [0, 0.5, 1].map((f) => ({ f, v: vCeil * f }));
  const xTicks = [0, Math.floor((chartData.length - 1) / 2), chartData.length - 1].filter(
    (v, i, arr) => arr.indexOf(v) === i
  );

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Streaming balance over the past ${days} days: ${chartData.length} data points`}
      >
        <defs>
          <linearGradient id={`${gid}-line`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={accentPrimary} />
            <stop offset="100%" stopColor={accentSecondary} />
          </linearGradient>
          <linearGradient id={`${gid}-area`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accentPrimary} stopOpacity="0.25" />
            <stop offset="100%" stopColor={accentPrimary} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {yTicks.map(({ f, v }) => (
          <line
            key={f}
            x1={PAD.left}
            y1={toY(v)}
            x2={PAD.left + plotW}
            y2={toY(v)}
            stroke={gridColor}
            strokeWidth={1}
          />
        ))}

        <path d={areaD} fill={`url(#${gid}-area)`} />
        <path
          d={pathD}
          fill="none"
          stroke={`url(#${gid}-line)`}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={accentPrimary} stroke="var(--background)" strokeWidth={1}>
            <title>{`${formatDateLabel(chartData[i].t)}: ${stroopsToXlm(BigInt(chartData[i].raw))}`}</title>
          </circle>
        ))}

        {yTicks.map(({ f, v }) => (
          <text
            key={f}
            x={PAD.left - 6}
            y={toY(v) + 4}
            fill={labelColor}
            fontSize={9}
            textAnchor="end"
            fontFamily="monospace"
          >
            {v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0)}
          </text>
        ))}

        {xTicks.map((idx) => (
          <text
            key={idx}
            x={toX(chartData[idx].t)}
            y={H - 8}
            fill={labelColor}
            fontSize={9}
            textAnchor="middle"
            fontFamily="sans-serif"
          >
            {formatDateLabel(chartData[idx].t)}
          </text>
        ))}
      </svg>
      <p className="text-xs text-zinc-500 mt-1">
        Balance at each cycle end · {chartData.length} cycles · past {days} days
      </p>
    </div>
  );
}
