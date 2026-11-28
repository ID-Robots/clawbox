// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  getDeskScreens,
  screensFromStatus,
  setDeskScreens,
  setMonitorSessionWindow,
  updatingScreenRect,
  updatingSurfaces,
  type DeskRect,
  type MonitorStatusLike,
} from "@/lib/desktop-screens";
import {
  MONITOR_STATUS_KEY,
  recallMonitorStatus,
  rememberMonitorStatus,
  useMonitorLayoutSync,
} from "@/lib/use-monitor-layout";

/**
 * Two monitors, one update screen (the owner's x64 laptop test, 2026-11-10):
 * when an update starts, /updating shows on the main monitor only. In monitor
 * mode the desktop is ONE app window laid over the row, so the surfaces that
 * could show /updating are the monitors' regions inside it (or, were there
 * several, windows) — and exactly one of them, the primary's, does. With one
 * monitor, or none known, nothing changes.
 */

const W = 3840;
const H = 1080;

/** Two 1920×1080 monitors side by side; `main` names the primary. */
function row(main: "left" | "right"): MonitorStatusLike {
  return {
    available: true,
    main,
    box: { width: W, height: H },
    monitors: [
      { id: "left", label: "Left", enabled: true, rect: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: "right", label: "Right", enabled: true, rect: { x: 1920, y: 0, width: 1920, height: 1080 } },
    ],
  };
}

const ONE_MONITOR: MonitorStatusLike = {
  available: true,
  main: "left",
  box: { width: 1920, height: 1080 },
  monitors: [{ id: "left", label: "Left", enabled: true, rect: { x: 0, y: 0, width: 1920, height: 1080 } }],
};

/** A surface with a name, so the test can say which one was chosen. */
type Surface = DeskRect & { name: string };

describe("updatingSurfaces: which surfaces show /updating", () => {
  for (const main of ["left", "right"] as const) {
    it(`gives it to the primary monitor only when the primary is on the ${main}`, () => {
      const layout = screensFromStatus(row(main), W, H)!;
      expect(layout).toHaveLength(2);
      // The monitors' regions inside the one app window.
      const shown = updatingSurfaces(layout, layout);
      expect(shown).toHaveLength(1);
      expect(shown[0].id).toBe(main);
      expect(shown[0].main).toBe(true);
      expect(updatingScreenRect(layout)).toMatchObject({ id: main, x: main === "left" ? 0 : 1920, y: 0, width: 1920, height: 1080 });

      // Windows: the one on the primary goes to /updating, the other keeps its page.
      const windows: Surface[] = [
        { name: "on-left", x: 40, y: 30, width: 1200, height: 800 },
        { name: "on-right", x: 2000, y: 30, width: 1600, height: 900 },
      ];
      expect(updatingSurfaces(layout, windows).map((w) => w.name)).toEqual([`on-${main}`]);
    });
  }

  it("picks the surface most on the primary when several touch it", () => {
    const layout = screensFromStatus(row("right"), W, H)!;
    const windows: Surface[] = [
      { name: "straddling", x: 1500, y: 0, width: 800, height: 600 },
      { name: "inside", x: 2200, y: 100, width: 1000, height: 700 },
    ];
    expect(updatingSurfaces(layout, windows).map((w) => w.name)).toEqual(["inside"]);
  });

  it("leaves everything as it is with one monitor, or no layout at all", () => {
    const windows: Surface[] = [
      { name: "a", x: 0, y: 0, width: 1920, height: 1080 },
      { name: "b", x: 100, y: 100, width: 800, height: 600 },
    ];
    // One monitor on: the page knows no layout (screensFromStatus says null).
    expect(screensFromStatus(ONE_MONITOR, 1920, 1080)).toBeNull();
    expect(updatingSurfaces(null, windows)).toEqual(windows);
    expect(updatingSurfaces([], windows)).toEqual(windows);
    expect(updatingScreenRect(null)).toBeNull();
    const single = [{ id: "only", label: "", x: 0, y: 0, width: 1920, height: 1080, main: true }];
    expect(updatingSurfaces(single, windows)).toEqual(windows);
    expect(updatingScreenRect(single)).toBeNull();
  });
});

describe("the layout reaches /updating while the box is down", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The desktop's APP window: its display-mode is never `browser`.
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
    Object.defineProperty(window, "innerWidth", { value: W, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: H, configurable: true });
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setDeskScreens(null);
    setMonitorSessionWindow(false);
    sessionStorage.clear();
  });

  const answering = (body: MonitorStatusLike) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));

  it("is kept by the desktop's monitor poll, and recalled by /updating with no server", async () => {
    vi.stubGlobal("fetch", answering(row("right")));
    const desktop = renderHook(() => useMonitorLayoutSync(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getDeskScreens()?.find((s) => s.main)?.id).toBe("right");
    expect(recallMonitorStatus()?.main).toBe("right");
    // The desktop leaves for /updating.
    desktop.unmount();
    expect(getDeskScreens()).toBeNull();

    // /updating: the web server is down mid-rebuild.
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", down);
    renderHook(() => useMonitorLayoutSync(true, { recall: true }));
    expect(updatingScreenRect(getDeskScreens())).toMatchObject({ id: "right", x: 1920, width: 1920, height: 1080 });
    // And a read that fails keeps it, however long the box is away.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(down).toHaveBeenCalled();
    expect(updatingScreenRect(getDeskScreens())?.id).toBe("right");
  });

  it("is forgotten by a box with no monitor session, and the desktop poll keeps nothing then", async () => {
    rememberMonitorStatus(row("left"));
    vi.stubGlobal("fetch", answering({ available: false }));
    renderHook(() => useMonitorLayoutSync(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sessionStorage.getItem(MONITOR_STATUS_KEY)).toBeNull();
    expect(recallMonitorStatus()).toBeNull();
  });

  it("recalls nothing it cannot read, and the desktop starts from nothing", () => {
    for (const raw of ["not json", "null", JSON.stringify({ available: false }), JSON.stringify({ available: true, monitors: "x", box: { width: 1, height: 1 } })]) {
      sessionStorage.setItem(MONITOR_STATUS_KEY, raw);
      expect(recallMonitorStatus()).toBeNull();
    }
    // Only /updating asks for what was kept: the desktop waits for the box as before.
    rememberMonitorStatus(row("left"));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderHook(() => useMonitorLayoutSync(true));
    expect(getDeskScreens()).toBeNull();
  });
});
