// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useReconnect } from "@/hooks/useReconnect";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useReconnect", () => {
  it("waits the grace period, polls, then fires onReady once after the settle delay", async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn<(attempt: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const onReady = vi.fn();

    const { result } = renderHook(() =>
      useReconnect({ probe, onReady, graceMs: 4000, intervalMs: 2500, readyDelayMs: 1500 }),
    );

    // Idle during the grace window — no probe yet.
    expect(result.current).toBe("grace");
    expect(probe).not.toHaveBeenCalled();

    // Grace elapses -> first probe (false), still probing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(result.current).toBe("probing");
    expect(probe).toHaveBeenCalledTimes(1);

    // Next interval -> second probe (true) -> ready, but onReady waits out the
    // settle delay so the "back online" state is visible first.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current).toBe("ready");
    expect(onReady).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(onReady).toHaveBeenCalledTimes(1);

    // Engine is done: no further probes, onReady never fires twice.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("stays idle while disabled", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(true);
    const onReady = vi.fn();

    renderHook(() => useReconnect({ probe, onReady, enabled: false, graceMs: 1000 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(probe).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("fires onReady via the hard-timeout fallback when the probe never succeeds", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(false);
    const onReady = vi.fn();

    renderHook(() =>
      useReconnect({ probe, onReady, graceMs: 1000, intervalMs: 1000, hardTimeoutMs: 5000 }),
    );

    // Advance past the hard timeout so the 0ms settle timer it schedules also
    // flushes (a boundary-exact advance can miss a timer added at that instant).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("cancels on unmount without firing onReady", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(true);
    const onReady = vi.fn();

    const { unmount } = renderHook(() =>
      useReconnect({ probe, onReady, graceMs: 4000, readyDelayMs: 1500 }),
    );

    // Probe succeeds -> phase ready, settle timer pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(onReady).not.toHaveBeenCalled();
  });
});
