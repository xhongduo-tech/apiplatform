/**
 * use-count-up.ts
 * Animates a number from 0 to the target value using requestAnimationFrame.
 * Returns the current display value.
 */
import { useState, useEffect, useRef } from "react";

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

export function useCountUp(
  target: number,
  duration = 900,
  enabled = true,
  formatter?: (n: number) => string,
): string {
  const [display, setDisplay] = useState("0");
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || target === 0) {
      setDisplay(formatter ? formatter(target) : String(target));
      return;
    }

    // Respect reduced motion preference
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setDisplay(formatter ? formatter(target) : target.toLocaleString());
      return;
    }

    startRef.current = null;

    const tick = (timestamp: number) => {
      if (startRef.current === null) startRef.current = timestamp;
      const elapsed = timestamp - startRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const current = Math.round(easeOutQuart(progress) * target);
      setDisplay(formatter ? formatter(current) : current.toLocaleString());
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [target, duration, enabled]);

  return display;
}
