import { useEffect, useState, useRef } from "react";

interface StreamInfo {
  ratePerSec: bigint;
}

export function useStreamingCounter(
  baseAmount: number,
  streams: StreamInfo[],
  enabled = true
): number {
  const [value, setValue] = useState(baseAmount);
  const refRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const baseValueRef = useRef<number>(baseAmount);
  const prefersReducedMotionRef = useRef(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    prefersReducedMotionRef.current = mediaQuery.matches;

    const listener = (e: MediaQueryListEvent) => {
      prefersReducedMotionRef.current = e.matches;
    };
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    baseValueRef.current = baseAmount;
    setValue(baseAmount);
  }, [baseAmount]);

  useEffect(() => {
    if (!enabled || prefersReducedMotionRef.current) {
      const totalRatePerSec = streams.reduce((sum, s) => sum + s.ratePerSec, 0n);
      setValue(baseValueRef.current + Number(totalRatePerSec) / 1e7);
      return;
    }

    startTimeRef.current = Date.now();

    const totalRatePerSec = streams.reduce((sum, s) => sum + s.ratePerSec, 0n);
    const ratePerMs = Number(totalRatePerSec) / 1e10;

    const tick = () => {
      const elapsed = Date.now() - startTimeRef.current;
      setValue(baseValueRef.current + ratePerMs * elapsed);
      refRef.current = requestAnimationFrame(tick);
    };

    refRef.current = requestAnimationFrame(tick);

    return () => {
      if (refRef.current !== null) {
        cancelAnimationFrame(refRef.current);
      }
    };
  }, [streams, enabled]);

  return value;
}
