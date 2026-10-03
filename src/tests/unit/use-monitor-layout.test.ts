// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MONITOR_POLL_MS, MONITOR_SOON_MS, useMonitorLayoutSync } from "@/lib/use-monitor-layout";
import {
  MONITORS_CHANGED_EVENT,
  getDeskScreens,
  isMonitorSessionWindow,
  setDeskScreens,
  setMonitorSessionWindow,
  type MonitorStatusLike,
} from "@/lib/desktop-screens";
import { isBoxOwnScreen } from "@/lib/visible-interval";

/**
 * The desktop's poll of `/setup-api/monitors` (monitor mode). Two rules the
 * first version broke:
 *
 * - ONE read at a time. A resize or a layout change arriving while a read was
 *   in flight scheduled a second timer that the next tick dropped without
 *   clearing — and from then on two chains polled for the life of the page,
 *   one more for every such event (each read is a wlr-randr spawn).
 * - A page that HAS been spread over the monitors keeps asking, and keeps its
 *   layout, through a read that failed. `available: false` there is wlr-randr
 *   timing out or a dock unplugged for a moment; it stopped the poll for good
 *   and left the page laid out as one screen across every monitor.
 *
 * And the rule that made it safe to ship, unchanged: a box with no monitor
 * session is asked once and then left alone.
 */

const W = 5120;
const H = 1440;

/** The test machine: two 2560x1440 monitors side by side. */
const ROW: MonitorStatusLike = {
  available: true,
  main: "a",
  box: { width: W, height: H },
  monitors: [
    { id: "a", label: "A", enabled: true, rect: { x: 0, y: 0, width: 2560, height: 1440 } },
    { id: "b", label: "B", enabled: true, rect: { x: 2560, y: 0, width: 2560, height: 1440 } },
  ],
};

const UNAVAILABLE: MonitorStatusLike = { available: false };

interface Pending {
  resolve: (body: MonitorStatusLike, status?: number) => void;
}

/** A fetch whose every answer the test hands out by hand, in order. */
function manualFetch() {
  const pending: Pending[] = [];
  const fetchMock = vi.fn(
    () =>
      new Promise((resolve) => {
        pending.push({
          resolve: (body, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }),
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    /** Answer the oldest read that is still out. */
    async answer(body: MonitorStatusLike, status?: number) {
      const next = pending.shift();
      if (!next) throw new Error("no read is in flight");
      await act(async () => {
        next.resolve(body, status);
      });
    },
    get inFlight() {
      return pending.length;
    },
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // The desktop's APP window: its display-mode is never `browser`.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
  Object.defineProperty(window, "innerWidth", { value: W, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: H, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setDeskScreens(null);
  setMonitorSessionWindow(false);
});

describe("useMonitorLayoutSync", () => {
  it("asks a box with no monitor session once, and then only after a resize", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    await f.answer(UNAVAILABLE);
    await advance(MONITOR_POLL_MS * 6);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    expect(getDeskScreens()).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await advance(MONITOR_SOON_MS);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks nothing in a browser tab, nor while it is not enabled", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(false));
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(display-mode: browser)" }));
    renderHook(() => useMonitorLayoutSync(true));
    await advance(MONITOR_POLL_MS * 3);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("polls with ONE chain when an event arrives while a read is in flight", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    expect(f.inFlight).toBe(1);
    // The span's resize lands while the first read is still out.
    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event(MONITORS_CHANGED_EVENT));
    });
    await advance(MONITOR_SOON_MS * 3);
    // No second read was started beside the first.
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    await f.answer(ROW);
    // The read that might predate the change is followed by one more, soon.
    await advance(MONITOR_SOON_MS);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    await f.answer(ROW);
    // From here on: one read per poll interval, never two.
    for (let i = 0; i < 6; i++) {
      await advance(MONITOR_POLL_MS);
      expect(f.inFlight).toBe(1);
      await f.answer(ROW);
    }
    expect(f.fetchMock).toHaveBeenCalledTimes(8);
    await advance(MONITOR_POLL_MS - 1);
    expect(f.fetchMock).toHaveBeenCalledTimes(8);
  });

  it("schedules one read for several events between two reads", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    act(() => {
      for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("resize"));
    });
    await advance(MONITOR_SOON_MS);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    await f.answer(ROW);
    await advance(MONITOR_POLL_MS);
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("lays the page out over the monitors and keeps that layout through a read that failed", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    const layout = getDeskScreens();
    expect(layout?.map((s) => s.id)).toEqual(["a", "b"]);
    // wlr-randr timed out: the server answers as if there were no session.
    await advance(MONITOR_POLL_MS);
    await f.answer(UNAVAILABLE);
    expect(getDeskScreens()).toBe(layout);
    // …and the page keeps asking.
    await advance(MONITOR_POLL_MS);
    expect(f.inFlight).toBe(1);
    await f.answer({ available: true, main: "a", box: { width: W, height: H }, monitors: [...ROW.monitors!] });
    expect(getDeskScreens()).toBe(layout);
  });

  it("keeps asking through a server error once the monitors have answered", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    await advance(MONITOR_POLL_MS);
    await f.answer({}, 502);
    expect(getDeskScreens()).not.toBeNull();
    await advance(MONITOR_POLL_MS);
    expect(f.inFlight).toBe(1);
  });

  it("stops at a refusal (4xx), which asking again would not change", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    await advance(MONITOR_POLL_MS);
    await f.answer({}, 403);
    await advance(MONITOR_POLL_MS * 3);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follows a real change of layout", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    expect(getDeskScreens()?.find((s) => s.main)?.id).toBe("a");
    await advance(MONITOR_POLL_MS);
    await f.answer({ ...ROW, main: "b" });
    expect(getDeskScreens()?.find((s) => s.main)?.id).toBe("b");
  });

  it("forgets the layout and asks nothing more once unmounted", async () => {
    const f = manualFetch();
    const { unmount } = renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    expect(getDeskScreens()).not.toBeNull();
    unmount();
    expect(getDeskScreens()).toBeNull();
    await advance(MONITOR_POLL_MS * 3);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * A window nobody can see (the app window minimised) does not spawn wlr-randr
 * on the box every 5 s. A tick that falls due then is read the moment the page
 * is visible again, so the layout on return is at least as fresh as before;
 * a resize or a Settings change is an event, not the clock, and is read at
 * once whether the page is visible or not.
 */
describe("useMonitorLayoutSync — a hidden page", () => {
  let visibility: DocumentVisibilityState = "visible";
  function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  beforeEach(() => {
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });
  afterEach(() => {
    // jsdom's own getter is on Document.prototype; the instance override goes.
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  it("skips the periodic read while hidden and reads at once on the visible edge", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    setVisibility("hidden");
    await advance(MONITOR_POLL_MS * 10);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    await f.answer({ ...ROW, main: "b" });
    expect(getDeskScreens()?.find((s) => s.main)?.id).toBe("b");
    // The cadence carries on from there.
    await advance(MONITOR_POLL_MS);
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a trip away shorter than the interval reads nothing extra", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    setVisibility("hidden");
    await advance(MONITOR_POLL_MS - 1_000);
    setVisibility("visible");
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still reads a resize at once while hidden", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    setVisibility("hidden");
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await advance(MONITOR_SOON_MS);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * The box's own answer is what tells the rest of the page it is the monitor
 * session's window (`isBoxOwnScreen()`, which keeps the owner-notice ring at
 * its on-screen pace while the window is hidden). An app `display-mode` used
 * to be the test, and that also took in the desktop installed as an app on a
 * phone and a tab in full screen — a hidden phone then read the ring every
 * 2 s. Those pages ask here too, and on a box with no monitor session (every
 * Jetson) the answer is `available: false`.
 */
describe("useMonitorLayoutSync — the page learns it is the session's window", () => {
  it("is marked once a monitor session answered, and isBoxOwnScreen() says so", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    expect(isMonitorSessionWindow()).toBe(false);
    expect(isBoxOwnScreen()).toBe(false);
    await f.answer(ROW);
    expect(isMonitorSessionWindow()).toBe(true);
    expect(isBoxOwnScreen()).toBe(true);
  });

  it("is marked with ONE monitor on, where the page has no screens to lay out", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer({ available: true, main: "a", box: { width: 2560, height: 1440 }, monitors: [ROW.monitors![0]] });
    expect(getDeskScreens()).toBeNull();
    expect(isMonitorSessionWindow()).toBe(true);
  });

  it("is not marked in an app window the box answers with no monitor session (an installed app, a full-screen tab)", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(UNAVAILABLE);
    expect(isMonitorSessionWindow()).toBe(false);
    expect(isBoxOwnScreen()).toBe(false);
  });

  it("is not marked by a refusal or a server error before any answer", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer({}, 502);
    expect(isMonitorSessionWindow()).toBe(false);
  });

  it("keeps the mark through a read that failed, as it keeps the layout", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    await advance(MONITOR_POLL_MS);
    await f.answer(UNAVAILABLE);
    expect(isMonitorSessionWindow()).toBe(true);
    await advance(MONITOR_POLL_MS);
    await f.answer({}, 502);
    expect(isMonitorSessionWindow()).toBe(true);
  });

  it("drops the mark when it unmounts, with the layout", async () => {
    const f = manualFetch();
    const { unmount } = renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    unmount();
    expect(isMonitorSessionWindow()).toBe(false);
  });

  it("an answer that lands after it unmounted marks nothing", async () => {
    const f = manualFetch();
    const { unmount } = renderHook(() => useMonitorLayoutSync(true));
    unmount();
    await f.answer(ROW);
    expect(isMonitorSessionWindow()).toBe(false);
  });

  it("a browser tab asks nothing and is never marked", async () => {
    const f = manualFetch();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(display-mode: browser)" }));
    renderHook(() => useMonitorLayoutSync(true));
    await advance(MONITOR_POLL_MS);
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(isMonitorSessionWindow()).toBe(false);
  });
});
