// @vitest-environment jsdom
/**
 * The agent chart's flowing connectors (src/lib/coding-agent-flow.ts): the
 * `ct-art-flow` dashes animate stroke-dashoffset, which the compositor cannot
 * run — left running they cost a style recalc and a repaint of the drawing
 * every frame, on every page left open. They run PAUSED (globals.css) and
 * `useSteppedFlow` steps them at FLOW_FPS — the same flow, a quarter of the
 * frames — and not at all while nobody can see them. Moved here from the
 * team tree's test when that drawing went (2026-10-30).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { FLOW_FPS, useSteppedFlow } from "@/lib/coding-agent-flow";

/** A CSS animation as the hook sees it: its name, and every time it is set. */
class FakeAnimation {
  writes: number[] = [];
  constructor(readonly animationName: string) {}
  get currentTime(): number | null { return this.writes.at(-1) ?? null; }
  set currentTime(t: number | null) { if (t !== null) this.writes.push(t); }
}

let flow: FakeAnimation;
let breathe: FakeAnimation;
let getAnimations: ReturnType<typeof vi.fn>;

/** The smallest drawing the hook can step: one SVG in the document, its animations stubbed. */
function drawing() {
  flow = new FakeAnimation("ct-art-flow");
  breathe = new FakeAnimation("ct-art-node");
  getAnimations = vi.fn(() => [flow, breathe]);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  Object.defineProperty(svg, "getAnimations", { value: getAnimations, configurable: true, writable: true });
  document.body.appendChild(svg);
  // One ref object for the hook's life: the effect is keyed on it.
  const ref = { current: svg };
  return { svg, ref };
}

afterEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSteppedFlow", () => {
  it("steps the flow FLOW_FPS times a second to the time since it mounted, and leaves the breathing alone", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { ref } = drawing();
    const { unmount } = renderHook(() => useSteppedFlow(ref));
    // The first step lands at mount.
    expect(flow.writes).toEqual([0]);
    act(() => { vi.advanceTimersByTime(1000); });
    const steps = flow.writes.length - 1;
    expect(steps).toBeGreaterThanOrEqual(FLOW_FPS - 1);
    expect(steps).toBeLessThanOrEqual(FLOW_FPS + 1);
    // Where a running animation would be a second in.
    expect(flow.currentTime).toBeGreaterThan(900);
    expect(flow.currentTime).toBeLessThanOrEqual(1000);
    // The opacity breathing runs on the compositor and is never touched.
    expect(breathe.writes).toEqual([]);
    // Looked up once, not once a step: reading an animation flushes style.
    expect(getAnimations).toHaveBeenCalledTimes(1);
    // Unmounted, the timer goes with it.
    unmount();
    const atUnmount = flow.writes.length;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(flow.writes.length).toBe(atUnmount);
  });

  it("looks the connectors up again after a render, which can add or drop one", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { ref } = drawing();
    const { rerender } = renderHook(() => useSteppedFlow(ref));
    act(() => { vi.advanceTimersByTime(500); });
    expect(getAnimations).toHaveBeenCalledTimes(1);
    const added = new FakeAnimation("ct-art-flow");
    getAnimations.mockImplementation(() => [flow, breathe, added]);
    rerender();
    act(() => { vi.advanceTimersByTime(200); });
    expect(getAnimations).toHaveBeenCalledTimes(2);
    // The new connector joins the same clock.
    expect(added.writes.length).toBeGreaterThan(0);
    expect(added.currentTime).toBe(flow.currentTime);
  });

  it("does not step while the desktop is hidden, and catches up when it is back", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { ref } = drawing();
    renderHook(() => useSteppedFlow(ref));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const hiddenAt = flow.writes.length;
    act(() => { vi.advanceTimersByTime(2000); });
    expect(flow.writes.length).toBe(hiddenAt);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => { vi.advanceTimersByTime(100); });
    // Not resumed from where it stopped: where it would be after 2.1 s.
    expect(flow.currentTime).toBeGreaterThan(2000);
  });

  it("does not step under reduced motion", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { ref } = drawing();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("reduce"), media: query })));
    renderHook(() => useSteppedFlow(ref));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getAnimations).not.toHaveBeenCalled();
    expect(flow.writes).toEqual([]);
  });

  it("steps nothing for a drawing that is not there, or a browser without getAnimations", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const empty = { current: null };
    renderHook(() => useSteppedFlow(empty));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    renderHook(() => useSteppedFlow({ current: svg }));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(vi.getTimerCount()).toBe(0);
  });
});
