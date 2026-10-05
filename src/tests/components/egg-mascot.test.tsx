// The fresh-box egg (src/components/EggMascot.tsx), on its own: its idle bounce
// is stepped by a timer that writes the sprite's background position directly,
// while the hatch's burst frames are React's. The two write the same style
// property, so the hand-over between them is what these tests hold.
//
// The Mascot suite (mascot-pet-body.test.tsx) covers which body the desktop
// wears and the hatch end to end.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@/tests/helpers/test-utils";
import EggMascot from "@/components/EggMascot";

vi.mock("@/lib/i18n", () => ({ useT: () => ({ t: (k: string) => k, locale: "en", localeResolved: true }) }));

/** One cell of the sheet on screen (EGG_PX). Frame n is at -n * 56px. */
const CELL = 56;
const frameOf = (el: HTMLElement) => Math.round(-parseFloat(el.style.backgroundPositionY || "0") / CELL) || 0;

/**
 * Let the hatch's fetch chain settle WITHOUT moving the fake clock —
 * `vi.waitFor` advances fake timers while it polls, which would run the burst's
 * own frame timers under the assertions.
 */
async function settle(root: HTMLElement, phase: string) {
  for (let i = 0; i < 20 && root.getAttribute("data-egg-phase") !== phase; i++) {
    await act(async () => { await Promise.resolve(); });
  }
  expect(root.getAttribute("data-egg-phase")).toBe(phase);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("EggMascot", () => {
  // The burst used to open on frame 0, not on the first crack: the idle
  // bounce's cleanup reset the sprite to its rest frame AFTER React had written
  // the burst's first frame, and as setting the same frame again re-renders
  // nothing, frame 9 was never on screen — the hatch went rest, 10, 11.
  it("opens the hatch on its first crack frame and steps through the burst", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as Response)),
    );
    const { container } = render(<EggMascot />);
    const root = container.querySelector('[data-mascot="egg"]') as HTMLElement;
    const sprite = container.querySelector("[data-egg-sprite]") as HTMLElement;
    // Mid-bounce, so the idle timer has written a frame of its own.
    act(() => { vi.advanceTimersByTime(3600); });
    expect(frameOf(sprite)).toBeGreaterThan(0);

    fireEvent.click(container.querySelector("[data-egg-hatch]") as HTMLElement);
    await settle(root, "burst");
    // Every effect the burst's commit scheduled has run by now.
    await act(async () => {});
    expect(frameOf(sprite)).toBe(9);
    // The idle bounce is off for the burst: its timer no longer writes.
    act(() => { vi.advanceTimersByTime(279); });
    expect(frameOf(sprite)).toBe(9);
    act(() => { vi.advanceTimersByTime(1); });
    expect(frameOf(sprite)).toBe(10);
    act(() => { vi.advanceTimersByTime(280); });
    expect(frameOf(sprite)).toBe(11);
    // Then the fade, back on the rest frame.
    act(() => { vi.advanceTimersByTime(280); });
    expect(root.getAttribute("data-egg-phase")).toBe("fading");
    expect(frameOf(sprite)).toBe(0);
  });

  it("bounces again after a failed hatch, from where React left the sprite", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)));
    const { container } = render(<EggMascot />);
    const root = container.querySelector('[data-mascot="egg"]') as HTMLElement;
    const sprite = container.querySelector("[data-egg-sprite]") as HTMLElement;
    fireEvent.click(container.querySelector("[data-egg-hatch]") as HTMLElement);
    await settle(root, "hatching");
    await settle(root, "idle");
    const seen = new Set<number>();
    for (let i = 0; i < 120; i++) {
      act(() => { vi.advanceTimersByTime(50); });
      seen.add(frameOf(sprite));
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
