"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A figure that counts up (or down) to each new value instead of jumping:
 * the run's tokens climb while it works, and a number that snaps from 26k
 * to 31k reads as a glitch where one that rolls there reads as progress.
 * The first value is shown at once; a change tweens over `durationMs` on
 * animation frames. `format` turns the tweened number into the text.
 * Motion honours prefers-reduced-motion: the figure then jumps.
 */
export default function AnimatedNumber({ value, format = (n) => String(Math.round(n)), durationMs = 700, className, testId }: {
  value: number;
  format?: (n: number) => string;
  durationMs?: number;
  className?: string;
  testId?: string;
}) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const frame = useRef<number | null>(null);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof requestAnimationFrame !== "function") {
      from.current = value;
      setShown(value);
      return;
    }
    const began = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - began) / durationMs);
      // Ease out: fast at first, settling on the figure.
      const eased = 1 - (1 - p) * (1 - p);
      const at = start + (value - start) * eased;
      from.current = at;
      setShown(p >= 1 ? value : at);
      if (p < 1) frame.current = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame.current = requestAnimationFrame(tick);
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, [value, durationMs]);
  return <span className={className} data-testid={testId} data-value={value} data-tweening={shown !== value || undefined}>{format(shown)}</span>;
}
