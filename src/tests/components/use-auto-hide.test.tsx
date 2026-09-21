import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@/tests/helpers/test-utils";
import { NOTICE_AUTO_HIDE_MS, useAutoHide } from "@/lib/use-auto-hide";

/**
 * The clock behind every top-right desktop notice.
 *
 * Pinned: a card leaves on its own after the shared delay; a card dismissed
 * by hand before that has its clock cleared (so the same key shown again later
 * gets a whole new delay); re-rendering with the same keys never restarts a
 * running clock; and unmounting clears them all.
 */

function Probe({ keys, onExpire, ms }: { keys: string[]; onExpire: (k: string) => void; ms?: number }) {
  useAutoHide(keys, onExpire, ms);
  return null;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("useAutoHide", () => {
  it("expires a key after the shared delay", () => {
    const onExpire = vi.fn();
    render(<Probe keys={["a"]} onExpire={onExpire} />);
    act(() => { vi.advanceTimersByTime(NOTICE_AUTO_HIDE_MS - 1); });
    expect(onExpire).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onExpire).toHaveBeenCalledWith("a");
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("does not restart a running clock when the same keys are rendered again", () => {
    const onExpire = vi.fn();
    const { rerender } = render(<Probe keys={["a"]} onExpire={onExpire} ms={1000} />);
    act(() => { vi.advanceTimersByTime(600); });
    // A poll replay hands the component a NEW array with the same key.
    rerender(<Probe keys={["a"]} onExpire={onExpire} ms={1000} />);
    act(() => { vi.advanceTimersByTime(400); });
    expect(onExpire).toHaveBeenCalledWith("a");
  });

  it("clears the clock of a key dismissed by hand, and starts over if it returns", () => {
    const onExpire = vi.fn();
    const { rerender } = render(<Probe keys={["a"]} onExpire={onExpire} ms={1000} />);
    act(() => { vi.advanceTimersByTime(900); });
    rerender(<Probe keys={[]} onExpire={onExpire} ms={1000} />);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onExpire).not.toHaveBeenCalled();
    rerender(<Probe keys={["a"]} onExpire={onExpire} ms={1000} />);
    act(() => { vi.advanceTimersByTime(999); });
    expect(onExpire).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("runs the latest handler, not the one the clock was started with", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe keys={["a"]} onExpire={first} ms={1000} />);
    rerender(<Probe keys={["a"]} onExpire={second} ms={1000} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("a");
  });

  it("clears every clock on unmount", () => {
    const onExpire = vi.fn();
    const { unmount } = render(<Probe keys={["a", "b"]} onExpire={onExpire} ms={1000} />);
    unmount();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onExpire).not.toHaveBeenCalled();
  });
});
