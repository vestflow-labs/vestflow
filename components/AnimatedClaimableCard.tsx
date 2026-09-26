"use client";

import { useEffect, useState, useRef } from "react";
import { ScheduleData, stroopsToXlm } from "@/lib/stellar";
import { useCountUp } from "@/hooks/useCountUp";

interface AnimatedClaimableCardProps {
  value: bigint;
  beneficiarySchedules: ScheduleData[];
  enabled: boolean;
}

export default function AnimatedClaimableCard({
  value,
  beneficiarySchedules,
  enabled,
}: AnimatedClaimableCardProps) {
  const [displayValue, setDisplayValue] = useState(0);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const animationRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    const listener = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    const baseXlm = parseFloat(stroopsToXlm(value));
    setDisplayValue(baseXlm);

    if (prefersReducedMotion || !enabled) {
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    let totalRate = 0n;

    for (const s of beneficiarySchedules) {
      if (!s.revoked && s.beneficiary && s.duration > 0) {
        const progress = Math.max(0, Math.min(100, ((now - s.start_time) / s.duration) * 100));
        if (progress < 100) {
          totalRate += s.total_amount / BigInt(s.duration);
        }
      }
    }

    if (totalRate === 0n) {
      return;
    }

    startTimeRef.current = Date.now();
    const ratePerMs = Number(totalRate) / 1e13;

    const tick = () => {
      const elapsed = Date.now() - startTimeRef.current;
      const accrued = ratePerMs * elapsed;
      setDisplayValue(baseXlm + accrued);
      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [value, beneficiarySchedules, enabled, prefersReducedMotion]);

  const formatted = displayValue.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });

  return (
    <div className="card p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Claimable Now</p>
      <p className="text-xl font-bold text-emerald-400 tabular-nums">{formatted}</p>
      <p className="text-xs text-zinc-500">XLM available</p>
    </div>
  );
}
