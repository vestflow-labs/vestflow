"use client";

import { useEffect, useState, useRef } from "react";
import { stroopsToXlm } from "@/lib/stellar";

interface IncomingStream {
  ratePerSec: bigint;
}

interface AnimatedClaimableCounterProps {
  baseAmount: bigint;
  incomingStreams: IncomingStream[];
  decimals?: number;
}

export default function AnimatedClaimableCounter({
  baseAmount,
  incomingStreams,
  decimals = 4,
}: AnimatedClaimableCounterProps) {
  const [displayValue, setDisplayValue] = useState(0);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const animationRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const baseTimeRef = useRef<number>(0);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    const listener = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    const totalRatePerSec = incomingStreams.reduce((sum, stream) => sum + stream.ratePerSec, 0n);
    const baseXlm = parseFloat(stroopsToXlm(baseAmount));

    if (prefersReducedMotion) {
      const totalEarned = parseFloat(stroopsToXlm(totalRatePerSec));
      setDisplayValue(baseXlm + totalEarned);
      return;
    }

    startTimeRef.current = Date.now();
    baseTimeRef.current = baseXlm;

    const animate = (currentTime: number) => {
      const elapsedMs = currentTime - startTimeRef.current;
      const elapsedSec = elapsedMs / 1000;
      const earnedThisSession = parseFloat(stroopsToXlm(totalRatePerSec * BigInt(Math.floor(elapsedSec))));
      setDisplayValue(baseTimeRef.current + earnedThisSession);
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [baseAmount, incomingStreams, prefersReducedMotion]);

  const formatted = displayValue.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });

  return <span className="tabular-nums">{formatted}</span>;
}
