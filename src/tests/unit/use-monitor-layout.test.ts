// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MONITOR_POLL_MS, MONITOR_SOON_MS, parseViewerScreens, useMonitorLayoutSync } from "@/lib/use-monitor-layout";
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

/**
 * Another box's desktop SHOWN in a kiosk whose Linked ClawBoxes monitors switch
 * is on (TASK-2771): the box that serves the page answers for ITS monitors, the
 * wrong ones, so the page is laid out by the kiosk's — which the kiosk
 * extension keeps on <html> — and reads its own at no time.
 */
describe("useMonitorLayoutSync — shown on another box's kiosk", () => {
  const ATTR = "data-clawbox-viewer-screens";
  /** What the extension leaves: the kiosk's two monitors, geometry only. */
  const KIOSK = {
    available: true,
    main: "HDMI-A-1",
    box: { width: W, height: H },
    mirror: false,
    monitors: [
      { id: "DP-1", enabled: true, rect: { x: 0, y: 0, width: 1920, height: 1440 } },
      { id: "HDMI-A-1", enabled: true, rect: { x: 1920, y: 0, width: 3200, height: 1440 } },
    ],
  };
  const mark = (value: unknown) => document.documentElement.setAttribute(ATTR, typeof value === "string" ? value : JSON.stringify(value));
  const ids = () => getDeskScreens()?.map((s) => `${s.id}${s.main ? "*" : ""}@${s.x}+${s.width}`);

  beforeEach(() => {
    // What /updating recalls is this window's, and earlier tests kept answers.
    window.sessionStorage.clear();
  });
  afterEach(() => {
    document.documentElement.removeAttribute(ATTR);
  });

  it("lays the page out by the kiosk's monitors and never reads this box's own", async () => {
    const f = manualFetch();
    mark(KIOSK);
    renderHook(() => useMonitorLayoutSync(true));
    await advance(MONITOR_POLL_MS * 3);
    expect(ids()).toEqual(["DP-1@0+1920", "HDMI-A-1*@1920+3200"]);
    expect(f.fetchMock).not.toHaveBeenCalled();
    // The page is not the box's own session window.
    expect(isMonitorSessionWindow()).toBe(false);
  });

  it("takes the layout over from the box's own read when the mark arrives, and follows it as it changes", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    expect(ids()).toEqual(["a*@0+2560", "b@2560+2560"]);
    expect(isMonitorSessionWindow()).toBe(true);
    await act(async () => { mark(KIOSK); });
    expect(ids()).toEqual(["DP-1@0+1920", "HDMI-A-1*@1920+3200"]);
    expect(isMonitorSessionWindow()).toBe(false);
    // The box's own chain is over: no read, a resize included.
    const reads = f.fetchMock.mock.calls.length;
    act(() => { window.dispatchEvent(new Event("resize")); });
    await advance(MONITOR_POLL_MS * 3);
    expect(f.fetchMock).toHaveBeenCalledTimes(reads);
    // The kiosk's layout changes (main moved, a monitor plugged in): the page follows.
    await act(async () => { mark({ ...KIOSK, main: "DP-1" }); });
    expect(ids()).toEqual(["DP-1*@0+1920", "HDMI-A-1@1920+3200"]);
    await act(async () => {
      mark({ ...KIOSK, main: "DP-1", monitors: [{ id: "DP-1", enabled: true, rect: { x: 0, y: 0, width: 1920, height: 1440 } }, { id: "DP-3", enabled: true, rect: { x: 1920, y: 0, width: 1600, height: 1440 } }, { id: "HDMI-A-1", enabled: true, rect: { x: 3520, y: 0, width: 1600, height: 1440 } }] });
    });
    expect(ids()).toEqual(["DP-1*@0+1920", "DP-3@1920+1600", "HDMI-A-1@3520+1600"]);
  });

  it("is one screen when the kiosk has no layout, a window that is not the row, or one monitor — and still never this box's own", async () => {
    const f = manualFetch();
    mark({ available: false });
    renderHook(() => useMonitorLayoutSync(true));
    await advance(MONITOR_POLL_MS * 3);
    expect(getDeskScreens()).toBeNull();
    expect(f.fetchMock).not.toHaveBeenCalled();
    // A window the row's proportions do not fit (here: half as wide) is one screen.
    await act(async () => { mark(KIOSK); });
    expect(getDeskScreens()).not.toBeNull();
    Object.defineProperty(window, "innerWidth", { value: W / 2, configurable: true });
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(getDeskScreens()).toBeNull();
    Object.defineProperty(window, "innerWidth", { value: W, configurable: true });
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(getDeskScreens()).not.toBeNull();
    await act(async () => { mark({ ...KIOSK, monitors: [KIOSK.monitors[0]] }); });
    expect(getDeskScreens()).toBeNull();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("applies in a browser-mode window too — the extension is the proof — and clears with the page", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(display-mode: browser)" }));
    mark(KIOSK);
    const { unmount } = renderHook(() => useMonitorLayoutSync(true));
    expect(getDeskScreens()).not.toBeNull();
    unmount();
    expect(getDeskScreens()).toBeNull();
  });

  it("goes back to this box's own monitors the moment the mark is taken off", async () => {
    const f = manualFetch();
    mark(KIOSK);
    renderHook(() => useMonitorLayoutSync(true));
    expect(f.fetchMock).not.toHaveBeenCalled();
    await act(async () => { document.documentElement.removeAttribute(ATTR); });
    expect(getDeskScreens()).toBeNull();
    expect(f.inFlight).toBe(1);
    await f.answer(ROW);
    expect(ids()).toEqual(["a*@0+2560", "b@2560+2560"]);
  });

  it("ignores a mark that is not the extension's shape: this box's own layout stands", async () => {
    const f = manualFetch();
    renderHook(() => useMonitorLayoutSync(true));
    await f.answer(ROW);
    for (const forged of ["not json", "[]", "null", "42", JSON.stringify({ available: true }), JSON.stringify({ ...KIOSK, box: { width: -1, height: H } }), JSON.stringify({ ...KIOSK, monitors: [] })]) {
      await act(async () => { mark(forged); });
      expect(ids(), forged).toEqual(["a*@0+2560", "b@2560+2560"]);
      expect(isMonitorSessionWindow(), forged).toBe(true);
    }
  });

  it("leaves /updating's recall, and a page that is not enabled, to their own rules", async () => {
    const f = manualFetch();
    mark(KIOSK);
    renderHook(() => useMonitorLayoutSync(true, { recall: true }));
    expect(f.inFlight).toBe(1);
    expect(getDeskScreens()).toBeNull();
    const reads = f.fetchMock.mock.calls.length;
    renderHook(() => useMonitorLayoutSync(false));
    expect(getDeskScreens()).toBeNull();
    expect(f.fetchMock).toHaveBeenCalledTimes(reads);
  });
});

describe("parseViewerScreens", () => {
  const good = {
    available: true,
    main: "DP-1",
    box: { width: 3840, height: 1080 },
    mirror: true,
    monitors: [
      { id: "DP-1", enabled: true, rect: { x: 0, y: 0, width: 1920, height: 1080 }, builtIn: true },
      { id: "HDMI-A-1", enabled: true, rect: { x: 1920, y: 0, width: 1920, height: 1080 } },
    ],
  };

  it("rebuilds what it takes, from the values alone: nothing else passes through", () => {
    const parsed = parseViewerScreens(JSON.stringify({ ...good, secret: "x", monitors: [{ ...good.monitors[0], label: "AOC Q27B3MA", serial: "123" }, good.monitors[1]] }));
    expect(parsed).toEqual({
      available: true,
      main: "DP-1",
      box: { width: 3840, height: 1080 },
      mirror: true,
      monitors: [
        { id: "DP-1", label: "DP-1", enabled: true, rect: { x: 0, y: 0, width: 1920, height: 1080 }, builtIn: true },
        { id: "HDMI-A-1", label: "HDMI-A-1", enabled: true, rect: { x: 1920, y: 0, width: 1920, height: 1080 } },
      ],
    });
  });

  it("reads no mark as undefined and a kiosk with no monitor session as null", () => {
    expect(parseViewerScreens(null)).toBeUndefined();
    expect(parseViewerScreens(JSON.stringify({ available: false }))).toBeNull();
  });

  it("refuses what recallMonitorStatus refuses, and more: bounds, finiteness, ids, counts, size", () => {
    const refused: string[] = [
      "", "{", "[]", "null", "true", JSON.stringify({}), JSON.stringify({ available: "true" }),
      { ...good, monitors: "x" }, { ...good, monitors: [] }, { ...good, box: null }, { ...good, box: { width: "3840", height: 1080 } },
      { ...good, box: { width: 0, height: 1080 } }, { ...good, box: { width: 3840, height: 1e6 } },
      { ...good, main: 7 }, { ...good, main: "has a space" },
      { ...good, monitors: [{ ...good.monitors[0], id: 3 }] },
      { ...good, monitors: [{ ...good.monitors[0], id: "" }] },
      { ...good, monitors: [{ ...good.monitors[0], id: "x".repeat(65) }] },
      { ...good, monitors: [{ ...good.monitors[0], id: "line\nbreak" }] },
      { ...good, monitors: [{ ...good.monitors[0], rect: undefined }] },
      { ...good, monitors: [{ ...good.monitors[0], rect: { x: "0", y: 0, width: 1, height: 1 } }] },
      { ...good, monitors: [{ ...good.monitors[0], rect: { x: 0, y: 0, width: 0, height: 1080 } }] },
      { ...good, monitors: [{ ...good.monitors[0], rect: { x: 0, y: 0, width: 1920, height: -5 } }] },
      { ...good, monitors: [{ ...good.monitors[0], rect: { x: 1e9, y: 0, width: 1920, height: 1080 } }] },
      { ...good, monitors: [null] },
      { ...good, monitors: [good.monitors[0], { ...good.monitors[1], id: "DP-1" }] },
      { ...good, monitors: Array.from({ length: 17 }, (_, i) => ({ id: `M${i}`, enabled: true, rect: { x: i * 100, y: 0, width: 100, height: 100 } })) },
    ].map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    for (const raw of refused) expect(parseViewerScreens(raw), raw).toBeUndefined();
    expect(parseViewerScreens(JSON.stringify({ ...good, pad: "x".repeat(9000) }))).toBeUndefined();
    // …and a monitor whose number is not one JSON can say (NaN/Infinity become null).
    expect(parseViewerScreens(JSON.stringify({ ...good, box: { width: Infinity, height: 1080 } }))).toBeUndefined();
  });
});
