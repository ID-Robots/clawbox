"use client";

/**
 * The agent chart's flowing connectors, stepped on a timer.
 *
 * `ct-art-flow` (globals.css) animates stroke-dashoffset, which the
 * compositor cannot run: left running, it had the browser recalculate style
 * and repaint the whole drawing 60 times a second for as long as a chart was
 * on screen — a team done hours ago included, and a window sitting behind
 * others. So the animations run PAUSED in the stylesheet and a timer steps
 * them here, the way the mascot's resting animations are stepped
 * (AMBIENT_FPS in Mascot.tsx, the same rate). The dash travels ~15 px a
 * second at the drawing's full width, so a step is about one pixel: the flow
 * reads the same.
 *
 * Lived in CodingTeamTree.tsx until the 2026-10-30 redesign deleted that
 * drawing (the owner: "the old team chart is a fake image"); the one chart
 * left, CodingAgentDiagram, steps its edges with this.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** How often the connectors' dashes move. */
export const FLOW_FPS = 15;

/** The connectors' animation (globals.css), the one this file steps. */
export const FLOW_ANIMATION = "ct-art-flow";

/**
 * Step the `ct-art-flow` connectors to the time since the drawing mounted,
 * FLOW_FPS times a second. Nothing while the desktop is hidden or the drawing
 * is scrolled out of view, since a step there would repaint what nobody can
 * see; the next step after it comes back lands where a running animation would
 * have been. A paused animation costs nothing between steps. Under reduced
 * motion there are no flow animations to step.
 *
 * The animations are looked up once per commit (a render can add or drop a
 * connector), not per step, and a step only WRITES: reading a CSS animation's
 * state flushes style, and a read between two writes made every step a style
 * recalc per connector — measured at 209 recalcs a second, worse than the 60
 * this replaces. Writes alone are one recalc per step.
 */
export function useSteppedFlow(rootRef: RefObject<SVGSVGElement | null>) {
  const stale = useRef(true);
  useLayoutEffect(() => { stale.current = true; });
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof root.getAnimations !== "function") return;
    let inView = true;
    let io: IntersectionObserver | null = null;
    // Wrapped: an observer that cannot be made only costs the off-screen
    // pause, never the flow.
    try {
      io = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last) inView = last.isIntersecting;
      });
      io.observe(root);
    } catch {
      io = null;
      inView = true;
    }
    // Asked per step rather than once: the owner can turn motion off while the
    // drawing is open, and then there is nothing to step.
    let reduce: MediaQueryList | null = null;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { reduce = null; }
    const started = performance.now();
    let flows: Animation[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (inView && document.visibilityState !== "hidden" && reduce?.matches !== true) {
        if (stale.current) {
          stale.current = false;
          flows = root.getAnimations({ subtree: true })
            .filter((a) => (a as CSSAnimation).animationName === FLOW_ANIMATION);
        }
        const now = performance.now() - started;
        for (const a of flows) a.currentTime = now;
      }
      timer = setTimeout(tick, 1000 / FLOW_FPS);
    };
    tick();
    return () => {
      if (timer !== null) clearTimeout(timer);
      io?.disconnect();
    };
  }, [rootRef]);
}
