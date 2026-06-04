import { useEffect, useRef, useState } from "react";

/**
 * Animates a numeric value counting up from 0 (or previous value) to `target`.
 *
 * @param target   The destination number.
 * @param duration Animation duration in milliseconds (default 1200ms).
 * @param enabled  Only animate when true — useful for delaying until data loads.
 */
export function useCountUp(
  target: number,
  duration = 1200,
  enabled = true
): number {
  const [value, setValue] = useState(0);
  const prevTarget = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const from = prevTarget.current;
    const to = target;
    prevTarget.current = to;

    if (from === to) {
      setValue(to);
      return;
    }

    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(from + (to - from) * eased);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setValue(to);
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, enabled]);

  return value;
}
