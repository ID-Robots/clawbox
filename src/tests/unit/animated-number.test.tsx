/**
 * A figure that counts to its new value (src/components/AnimatedNumber.tsx):
 * the first value at once, a change tweened on animation frames, the final
 * figure exact — and a straight jump where motion is turned off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import AnimatedNumber from "@/components/AnimatedNumber";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("AnimatedNumber", () => {
  it("shows the first value at once and settles exactly on a new one after tweening", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const format = (n: number) => `${Math.round(n / 1000)}k`;
    const { rerender } = render(<AnimatedNumber value={26_000} format={format} durationMs={100} testId="n" />);
    expect(screen.getByTestId("n").textContent).toBe("26k");
    expect(frames).toHaveLength(0);
    rerender(<AnimatedNumber value={36_000} format={format} durationMs={100} testId="n" />);
    expect(frames).toHaveLength(1);
    const began = performance.now();
    frames[0](began + 50);
    // Halfway through the tween: between the two figures, and still tweening.
    const mid = Number(screen.getByTestId("n").textContent!.replace("k", ""));
    expect(mid).toBeGreaterThan(26);
    expect(mid).toBeLessThan(36);
    expect(screen.getByTestId("n")).toHaveAttribute("data-tweening", "true");
    expect(frames).toHaveLength(2);
    frames[1](began + 200);
    expect(screen.getByTestId("n").textContent).toBe("36k");
    expect(screen.getByTestId("n")).not.toHaveAttribute("data-tweening");
    expect(screen.getByTestId("n")).toHaveAttribute("data-value", "36000");
  });

  it("jumps straight to the value where motion is turned off", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    const { rerender } = render(<AnimatedNumber value={1} testId="n" />);
    rerender(<AnimatedNumber value={9} testId="n" />);
    expect(screen.getByTestId("n").textContent).toBe("9");
    expect(raf).not.toHaveBeenCalled();
  });
});
