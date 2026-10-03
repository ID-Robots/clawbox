// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deskScreens,
  followLayout,
  getDeskScreens,
  hasNeighbour,
  identifyMonitors,
  mainInsets,
  mainScreen,
  screenAt,
  screenForRect,
  screensFromStatus,
  setDeskScreens,
  subscribeDeskScreens,
  MONITORS_IDENTIFY_EVENT,
  type DeskScreen,
  type MonitorStatusLike,
  type MonitorsIdentifyDetail,
} from "@/lib/desktop-screens";

/**
 * The monitors the desktop is spread over (monitor mode). With no layout —
 * every Jetson, every phone, every desktop opened in a plain browser tab —
 * each answer here must be the VIEWPORT's, exactly as the desktop has always
 * been laid out; with one, it must be the monitor's.
 *
 * The fixture mirrors the test machine's real `wlr-randr` output: two AOC
 * Q27B3MA panels side by side at 2560x1440 (HDMI-A-1 at 0,0 and DP-2 at
 * 2560,0) and the built-in panel switched off.
 */

const HDMI = "AOC|Q27B3MA|17ZP6HA000848";
const DP = "AOC|Q27B3MA|17ZP6HA001316";
const EDP = "BOE|0x0BCA|@eDP-1";

function scr(id: string, x: number, y: number, width: number, height: number, main = false, label = id): DeskScreen {
  return { id, label, x, y, width, height, main };
}

/** A row of two equal monitors, the main one on the LEFT. */
const ROW: DeskScreen[] = [scr("a", 0, 0, 2560, 1440, true), scr("b", 2560, 0, 2560, 1440)];

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
}

beforeEach(() => {
  setViewport(1000, 800);
});

afterEach(() => {
  // Module state: every test leaves the one-screen desktop behind it.
  setDeskScreens(null);
});

describe("setDeskScreens / getDeskScreens", () => {
  it("starts as the one-screen desktop", () => {
    expect(getDeskScreens()).toBeNull();
  });

  it("stores a layout of two or more monitors", () => {
    setDeskScreens(ROW);
    expect(getDeskScreens()).toEqual(ROW);
  });

  it("reads fewer than two monitors as no layout at all", () => {
    // One monitor IS the viewport; a layout of one would only re-measure it.
    setDeskScreens([scr("a", 0, 0, 2560, 1440, true)]);
    expect(getDeskScreens()).toBeNull();
    setDeskScreens([]);
    expect(getDeskScreens()).toBeNull();
    setDeskScreens(ROW);
    setDeskScreens([ROW[0]]);
    expect(getDeskScreens()).toBeNull();
  });
});

describe("subscribeDeskScreens", () => {
  it("notifies on a change, and not on a layout that is the same", () => {
    const l = vi.fn();
    const off = subscribeDeskScreens(l);
    setDeskScreens(ROW);
    expect(l).toHaveBeenCalledTimes(1);
    // A fresh array with the same content: the desktop's poll answers this
    // every few seconds, and re-laying out every window for it would be noise.
    setDeskScreens(ROW.map((s) => ({ ...s })));
    expect(l).toHaveBeenCalledTimes(1);
    off();
  });

  it("does not notify for null after null, nor for one screen after none", () => {
    const l = vi.fn();
    const off = subscribeDeskScreens(l);
    setDeskScreens(null);
    setDeskScreens([scr("a", 0, 0, 100, 100, true)]);
    setDeskScreens([]);
    expect(l).not.toHaveBeenCalled();
    off();
  });

  it.each([
    ["geometry", (s: DeskScreen[]) => [s[0], { ...s[1], x: 2561 }]],
    ["size", (s: DeskScreen[]) => [s[0], { ...s[1], width: 1920 }]],
    ["main", (s: DeskScreen[]) => [{ ...s[0], main: false }, { ...s[1], main: true }]],
    ["label", (s: DeskScreen[]) => [s[0], { ...s[1], label: "Right" }]],
    ["id", (s: DeskScreen[]) => [s[0], { ...s[1], id: "c" }]],
    ["count", (s: DeskScreen[]) => [...s, scr("c", 5120, 0, 1920, 1080)]],
  ] as const)("notifies when the %s changes", (_what, change) => {
    setDeskScreens(ROW);
    const l = vi.fn();
    const off = subscribeDeskScreens(l);
    setDeskScreens(change(ROW) as DeskScreen[]);
    expect(l).toHaveBeenCalledTimes(1);
    off();
  });

  it("notifies when the layout goes back to one screen", () => {
    setDeskScreens(ROW);
    const l = vi.fn();
    const off = subscribeDeskScreens(l);
    setDeskScreens([ROW[0]]);
    expect(l).toHaveBeenCalledTimes(1);
    expect(getDeskScreens()).toBeNull();
    off();
  });

  it("notifies every listener, and none after it unsubscribed", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeDeskScreens(a);
    const offB = subscribeDeskScreens(b);
    setDeskScreens(ROW);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    setDeskScreens(null);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
    setDeskScreens(ROW);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("has the new layout in place by the time a listener runs", () => {
    let seen: DeskScreen[] | null | undefined;
    const off = subscribeDeskScreens(() => {
      seen = getDeskScreens();
    });
    setDeskScreens(ROW);
    expect(seen).toEqual(ROW);
    off();
  });
});

describe("deskScreens / mainScreen with one screen", () => {
  it("is the viewport, the one main screen", () => {
    expect(deskScreens()).toEqual([{ id: "viewport", label: "", x: 0, y: 0, width: 1000, height: 800, main: true }]);
    expect(mainScreen()).toEqual({ id: "viewport", label: "", x: 0, y: 0, width: 1000, height: 800, main: true });
  });

  it("follows the viewport as it resizes", () => {
    setViewport(390, 844);
    expect(mainScreen()).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  });
});

describe("deskScreens / mainScreen with a layout", () => {
  it("lists the monitors", () => {
    setDeskScreens(ROW);
    expect(deskScreens()).toEqual(ROW);
  });

  it("finds the main monitor wherever it is in the row", () => {
    setDeskScreens([scr("a", 0, 0, 2560, 1440), scr("b", 2560, 0, 2560, 1440, true)]);
    expect(mainScreen().id).toBe("b");
  });

  it("falls back to the first monitor when none is marked main", () => {
    setDeskScreens([scr("a", 0, 0, 2560, 1440), scr("b", 2560, 0, 2560, 1440)]);
    expect(mainScreen().id).toBe("a");
  });
});

describe("screenAt", () => {
  it("answers the viewport for any point with one screen, inside it or not", () => {
    for (const [x, y] of [[0, 0], [500, 400], [-50, -50], [5000, 5000]]) {
      expect(screenAt(x, y).id).toBe("viewport");
    }
  });

  it("finds the monitor a point is on", () => {
    setDeskScreens(ROW);
    expect(screenAt(0, 0).id).toBe("a");
    expect(screenAt(2559, 1439).id).toBe("a");
    expect(screenAt(3000, 700).id).toBe("b");
  });

  it("puts a shared edge on the monitor that starts there (half-open rects)", () => {
    setDeskScreens(ROW);
    expect(screenAt(2559, 10).id).toBe("a");
    expect(screenAt(2560, 10).id).toBe("b");
  });

  it("answers the nearest monitor past the row's edges", () => {
    setDeskScreens(ROW);
    expect(screenAt(-100, 700).id).toBe("a");
    expect(screenAt(9000, 700).id).toBe("b");
    expect(screenAt(100, -40).id).toBe("a");
    expect(screenAt(4000, 2000).id).toBe("b");
  });

  it("answers the nearest monitor in the dead area below a shorter one", () => {
    // A 1080p main beside a 1440p monitor: the window spread over both is
    // 1440 tall, so the strip under the main monitor is page that no monitor
    // shows.
    setDeskScreens([scr("small", 0, 0, 1920, 1080, true), scr("big", 1920, 0, 2560, 1440)]);
    // Far from the big one: the small one, by its bottom edge.
    expect(screenAt(100, 1300).id).toBe("small");
    // 20 px from the big one's left edge, 220 px below the small one: the big one.
    expect(screenAt(1900, 1300).id).toBe("big");
  });

  it("answers the nearest monitor in a gap between two", () => {
    setDeskScreens([scr("l", 0, 0, 1000, 800, true), scr("r", 1100, 0, 1000, 800)]);
    expect(screenAt(1030, 400).id).toBe("l");
    expect(screenAt(1080, 400).id).toBe("r");
  });
});

describe("screenForRect", () => {
  it("answers the viewport with one screen", () => {
    expect(screenForRect({ x: 4000, y: 10, width: 400, height: 300 }).id).toBe("viewport");
  });

  it("judges a straddling window by its centre", () => {
    setDeskScreens(ROW);
    // 400 px wide: centre at 2460 (left of the seam) vs 2660 (right of it).
    expect(screenForRect({ x: 2260, y: 100, width: 400, height: 300 }).id).toBe("a");
    expect(screenForRect({ x: 2460, y: 100, width: 400, height: 300 }).id).toBe("b");
  });

  it("judges height by the title bar, not the window's middle", () => {
    // A tall window whose title bar is on the short main monitor but whose
    // middle hangs in the dead area beside the tall one: it belongs where its
    // title bar is, since that is where it is dragged from.
    setDeskScreens([scr("small", 0, 0, 1000, 500, true), scr("big", 1000, 0, 1000, 800)]);
    expect(screenForRect({ x: 850, y: 450, width: 200, height: 600 }).id).toBe("small");
    // ...while its true centre (950, 750) would have been the big one.
    expect(screenAt(950, 750).id).toBe("big");
  });
});

describe("mainInsets", () => {
  it("is all zero with one screen, whatever rect is passed", () => {
    expect(mainInsets()).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(mainInsets({ x: 300, y: 40, width: 100, height: 100 })).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it("measures the main monitor's edges from the viewport's", () => {
    setViewport(5120, 1440);
    setDeskScreens(ROW);
    expect(mainInsets()).toEqual({ left: 0, top: 0, right: 2560, bottom: 0 });
    setDeskScreens([scr("a", 0, 0, 2560, 1440), scr("b", 2560, 0, 2560, 1440, true)]);
    expect(mainInsets()).toEqual({ left: 2560, top: 0, right: 0, bottom: 0 });
  });

  it("puts the shelf on a shorter main monitor's own bottom", () => {
    setViewport(4480, 1440);
    setDeskScreens([scr("big", 0, 0, 2560, 1440), scr("small", 2560, 0, 1920, 1080, true)]);
    expect(mainInsets()).toEqual({ left: 2560, top: 0, right: 0, bottom: 360 });
  });

  it("measures a main monitor in the middle of three", () => {
    setViewport(6000, 1200);
    setDeskScreens([scr("l", 0, 0, 2000, 1200), scr("m", 2000, 100, 2000, 1000, true), scr("r", 4000, 0, 2000, 1200)]);
    expect(mainInsets()).toEqual({ left: 2000, top: 100, right: 2000, bottom: 100 });
  });

  it("takes an explicit rect, and never answers a negative inset", () => {
    setViewport(2000, 1000);
    setDeskScreens(ROW);
    expect(mainInsets({ x: 500, y: 0, width: 1000, height: 1000 })).toEqual({ left: 500, top: 0, right: 500, bottom: 0 });
    // A viewport smaller than the monitor (a window still being resized).
    expect(mainInsets({ x: 0, y: 0, width: 2560, height: 1440 })).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});

describe("hasNeighbour", () => {
  it("is false for every side with one screen", () => {
    const v = mainScreen();
    for (const side of ["left", "right", "top", "bottom"] as const) {
      expect(hasNeighbour(v, side)).toBe(false);
    }
  });

  it("knows which edges of a row of three are shared", () => {
    const row = [scr("l", 0, 0, 1920, 1080, true), scr("m", 1920, 0, 1920, 1080), scr("r", 3840, 0, 1920, 1080)];
    setDeskScreens(row);
    const sides = (s: DeskScreen) => (["left", "right", "top", "bottom"] as const).filter((side) => hasNeighbour(s, side));
    expect(sides(row[0])).toEqual(["right"]);
    expect(sides(row[1])).toEqual(["left", "right"]);
    expect(sides(row[2])).toEqual(["left"]);
  });

  it("knows stacked monitors share their top and bottom", () => {
    const col = [scr("up", 0, 0, 1920, 1080), scr("down", 0, 1080, 1920, 1080, true)];
    setDeskScreens(col);
    expect(hasNeighbour(col[0], "bottom")).toBe(true);
    expect(hasNeighbour(col[0], "top")).toBe(false);
    expect(hasNeighbour(col[1], "top")).toBe(true);
    expect(hasNeighbour(col[1], "left")).toBe(false);
  });

  it("tolerates the 1 px a zoomed layout's rounding leaves, and nothing more", () => {
    setDeskScreens([scr("a", 0, 0, 1000, 800, true), scr("b", 1001, 0, 1000, 800)]);
    expect(hasNeighbour(getDeskScreens()![0], "right")).toBe(true);
    setDeskScreens([scr("a", 0, 0, 1000, 800, true), scr("b", 999, 0, 1000, 800)]);
    expect(hasNeighbour(getDeskScreens()![0], "right")).toBe(true);
    setDeskScreens([scr("a", 0, 0, 1000, 800, true), scr("b", 1002, 0, 1000, 800)]);
    expect(hasNeighbour(getDeskScreens()![0], "right")).toBe(false);
  });

  it("does not count a monitor that only meets this one at a corner", () => {
    setDeskScreens([scr("a", 0, 0, 1000, 800, true), scr("b", 1000, 800, 1000, 800)]);
    const [a, b] = getDeskScreens()!;
    expect(hasNeighbour(a, "right")).toBe(false);
    expect(hasNeighbour(a, "bottom")).toBe(false);
    expect(hasNeighbour(b, "left")).toBe(false);
    expect(hasNeighbour(b, "top")).toBe(false);
  });

  it("does not count the monitor itself", () => {
    setDeskScreens(ROW);
    expect(hasNeighbour({ ...ROW[0] }, "left")).toBe(false);
    expect(hasNeighbour({ ...ROW[1] }, "right")).toBe(false);
  });

  describe("beside a point", () => {
    // A 1080p main beside a 1440p monitor: the tall one's left edge is shared
    // along the short one's 1080 px only.
    const MIXED = [scr("small", 0, 0, 1920, 1080, true), scr("big", 1920, 0, 2560, 1440)];

    it("counts a neighbour only where it borders the edge", () => {
      setDeskScreens(MIXED);
      const [small, big] = getDeskScreens()!;
      expect(hasNeighbour(big, "left", { x: 1920, y: 500 })).toBe(true);
      expect(hasNeighbour(big, "left", { x: 1920, y: 1079 })).toBe(true);
      expect(hasNeighbour(big, "left", { x: 1920, y: 1080 })).toBe(false);
      expect(hasNeighbour(big, "left", { x: 1920, y: 1300 })).toBe(false);
      // Along the whole of the short one's edge, the tall one is there.
      expect(hasNeighbour(small, "right", { x: 1919, y: 1000 })).toBe(true);
      // Without a point, the edge as a whole: shared.
      expect(hasNeighbour(big, "left")).toBe(true);
    });

    it("judges stacked monitors along x", () => {
      setDeskScreens([scr("up", 0, 0, 1920, 1080), scr("down", 500, 1080, 1920, 1080, true)]);
      const [up, down] = getDeskScreens()!;
      expect(hasNeighbour(up, "bottom", { x: 600, y: 1079 })).toBe(true);
      expect(hasNeighbour(up, "bottom", { x: 100, y: 1079 })).toBe(false);
      expect(hasNeighbour(down, "top", { x: 2000, y: 1080 })).toBe(false);
    });

    it("is false for every point with one screen", () => {
      for (const side of ["left", "right", "top", "bottom"] as const) {
        expect(hasNeighbour(mainScreen(), side, { x: 0, y: 0 })).toBe(false);
      }
    });
  });
});

describe("identifyMonitors", () => {
  function listen() {
    const seen: Array<MonitorsIdentifyDetail | null> = [];
    const on = (e: Event) => seen.push((e as CustomEvent<MonitorsIdentifyDetail>).detail ?? null);
    window.addEventListener(MONITORS_IDENTIFY_EVENT, on);
    return { seen, off: () => window.removeEventListener(MONITORS_IDENTIFY_EVENT, on) };
  }

  it("asks for nothing, and says so, on a page that is not spread over the monitors", () => {
    // A browser on the LAN, one monitor on, mirrored: nothing would show.
    const l = listen();
    expect(identifyMonitors(["a", "b"])).toBe(false);
    expect(l.seen).toEqual([]);
    l.off();
  });

  it("carries the order the Monitors tab numbers them in", () => {
    setDeskScreens(ROW);
    const l = listen();
    const order = ["b", "a"];
    expect(identifyMonitors(order)).toBe(true);
    expect(identifyMonitors()).toBe(true);
    expect(l.seen).toEqual([{ order: ["b", "a"] }, {}]);
    // A copy: the panel's own array may change under the overlay.
    order.reverse();
    expect(l.seen[0]).toEqual({ order: ["b", "a"] });
    l.off();
  });
});

describe("followLayout", () => {
  const win = { x: 100, y: 200, width: 800, height: 600 };

  it("moves nothing when there was no layout before", () => {
    expect(followLayout(win, null, ROW)).toBeNull();
    expect(followLayout(win, [], ROW)).toBeNull();
  });

  it("moves nothing when its monitor stayed where it was", () => {
    expect(followLayout(win, ROW, ROW.map((s) => ({ ...s })))).toBeNull();
  });

  it("follows its monitor when two are swapped", () => {
    const swapped = [scr("b", 0, 0, 2560, 1440), scr("a", 2560, 0, 2560, 1440, true)];
    expect(followLayout(win, ROW, swapped)).toEqual({ x: 2660, y: 200 });
    expect(followLayout({ ...win, x: 3000 }, ROW, swapped)).toEqual({ x: 440, y: 200 });
  });

  it("goes to the main monitor, at the same offset, when its own was turned off", () => {
    const prev = [scr("a", 0, 0, 2560, 1440), scr("b", 2560, 0, 2560, 1440), scr("c", 5120, 0, 1920, 1080, true)];
    // b is gone and the main monitor c moved to the front of the row.
    const next = [scr("c", 0, 0, 1920, 1080, true), scr("a", 1920, 0, 2560, 1440)];
    // On b at offset 140: lands on c (main) at offset 140.
    expect(followLayout({ ...win, x: 2700 }, prev, next)).toEqual({ x: 140, y: 200 });
    // On c at offset 100: stays on c.
    expect(followLayout({ ...win, x: 5220 }, prev, next)).toEqual({ x: 100, y: 200 });
    // On a: follows a to its new place.
    expect(followLayout(win, prev, next)).toEqual({ x: 2020, y: 200 });
  });

  it("keeps its offset on the one screen that is left", () => {
    expect(followLayout({ ...win, x: 2700 }, ROW, null)).toEqual({ x: 140, y: 200 });
    // Already on the left monitor, at the origin: nothing moves.
    expect(followLayout(win, ROW, null)).toBeNull();
  });

  it("moves nothing when the next layout is empty", () => {
    expect(followLayout({ ...win, x: 2700 }, ROW, [])).toBeNull();
  });
});

describe("screensFromStatus", () => {
  /** The test machine's status: DP-2 right of HDMI-A-1, the built-in panel off. */
  function status(over: Partial<MonitorStatusLike> = {}): MonitorStatusLike {
    return {
      available: true,
      main: HDMI,
      box: { width: 5120, height: 1440 },
      monitors: [
        { id: DP, label: "AOC Q27B3MA", enabled: true, rect: { x: 2560, y: 0, width: 2560, height: 1440 } },
        { id: HDMI, label: "AOC Q27B3MA (2)", enabled: true, rect: { x: 0, y: 0, width: 2560, height: 1440 } },
        { id: EDP, label: "Built-in", enabled: false, rect: null },
      ],
      ...over,
    };
  }

  it("lays the monitors out in this page's pixels, left to right, with the main one marked", () => {
    expect(screensFromStatus(status(), 5120, 1440)).toEqual([
      { id: HDMI, label: "AOC Q27B3MA (2)", x: 0, y: 0, width: 2560, height: 1440, main: true },
      { id: DP, label: "AOC Q27B3MA", x: 2560, y: 0, width: 2560, height: 1440, main: false },
    ]);
  });

  it("is null for anything that is not a monitor layout", () => {
    expect(screensFromStatus(null, 5120, 1440)).toBeNull();
    expect(screensFromStatus({ available: false }, 5120, 1440)).toBeNull();
    expect(screensFromStatus(status({ available: false }), 5120, 1440)).toBeNull();
    expect(screensFromStatus(status({ box: null }), 5120, 1440)).toBeNull();
    expect(screensFromStatus(status({ monitors: undefined }), 5120, 1440)).toBeNull();
  });

  it("is null with fewer than two monitors on", () => {
    const one = status({
      monitors: [
        { id: HDMI, label: "x", enabled: true, rect: { x: 0, y: 0, width: 2560, height: 1440 } },
        { id: DP, label: "y", enabled: false, rect: { x: 2560, y: 0, width: 2560, height: 1440 } },
        { id: EDP, label: "z", enabled: true, rect: null },
      ],
      box: { width: 2560, height: 1440 },
    });
    expect(screensFromStatus(one, 2560, 1440)).toBeNull();
    expect(screensFromStatus(status({ monitors: [] }), 5120, 1440)).toBeNull();
  });

  it("is null for a degenerate box or viewport", () => {
    expect(screensFromStatus(status({ box: { width: 0, height: 1440 } }), 5120, 1440)).toBeNull();
    expect(screensFromStatus(status({ box: { width: 5120, height: -1 } }), 5120, 1440)).toBeNull();
    expect(screensFromStatus(status(), 0, 1440)).toBeNull();
    expect(screensFromStatus(status(), 5120, 0)).toBeNull();
  });

  it("is null for a page whose proportions are not the row's (a tab, a phone, a laptop on the LAN)", () => {
    expect(screensFromStatus(status(), 1280, 800)).toBeNull();
    expect(screensFromStatus(status(), 390, 844)).toBeNull();
    // Half the row's width, the full height: a window still being spread.
    expect(screensFromStatus(status(), 2560, 1440)).toBeNull();
  });

  it("tolerates a couple of percent of disagreement between the axes, and no more", () => {
    // 1430 tall: ratios 1 and 0.993.
    expect(screensFromStatus(status(), 5120, 1430)).not.toBeNull();
    // 1400 tall: ratios 1 and 0.972.
    expect(screensFromStatus(status(), 5120, 1400)).toBeNull();
  });

  it("scales by the page zoom", () => {
    // Ctrl + to 125 %: the 5120x1440 window is a 4096x1152 page.
    expect(screensFromStatus(status(), 4096, 1152)).toEqual([
      { id: HDMI, label: "AOC Q27B3MA (2)", x: 0, y: 0, width: 2048, height: 1152, main: true },
      { id: DP, label: "AOC Q27B3MA", x: 2048, y: 0, width: 2048, height: 1152, main: false },
    ]);
    // Ctrl - to 50 %: a 10240x2880 page.
    expect(screensFromStatus(status(), 10240, 2880)).toEqual([
      { id: HDMI, label: "AOC Q27B3MA (2)", x: 0, y: 0, width: 5120, height: 2880, main: true },
      { id: DP, label: "AOC Q27B3MA", x: 5120, y: 0, width: 5120, height: 2880, main: false },
    ]);
  });

  it("answers whole pixels at an awkward zoom", () => {
    // 110 %: 5120 / 1.1 = 4654.5…
    const s = screensFromStatus(status(), 5120 / 1.1, 1440 / 1.1)!;
    expect(s).toHaveLength(2);
    for (const m of s) {
      for (const v of [m.x, m.y, m.width, m.height]) expect(Number.isInteger(v)).toBe(true);
    }
    // The seam stays a shared edge within the 1 px hasNeighbour tolerates.
    expect(Math.abs(s[0].x + s[0].width - s[1].x)).toBeLessThanOrEqual(1);
  });

  it("measures from the row's top-left corner, wherever the compositor put it", () => {
    const shifted = status({
      monitors: [
        { id: HDMI, label: "l", enabled: true, rect: { x: 1920, y: 200, width: 2560, height: 1440 } },
        { id: DP, label: "r", enabled: true, rect: { x: 4480, y: 0, width: 1920, height: 1080 } },
      ],
      box: { width: 4480, height: 1640 },
    });
    expect(screensFromStatus(shifted, 4480, 1640)).toEqual([
      { id: HDMI, label: "l", x: 0, y: 200, width: 2560, height: 1440, main: true },
      { id: DP, label: "r", x: 2560, y: 0, width: 1920, height: 1080, main: false },
    ]);
  });

  it("marks exactly the monitor the status names as main", () => {
    const s = screensFromStatus(status({ main: DP }), 5120, 1440)!;
    expect(s.filter((m) => m.main).map((m) => m.id)).toEqual([DP]);
  });

  it("falls back to the first monitor that is on when the named main is off, unknown or absent", () => {
    // The status's own order, not the row's: DP-2 is listed first.
    for (const main of [EDP, "nope", null, undefined]) {
      const s = screensFromStatus(status({ main }), 5120, 1440)!;
      expect(s.filter((m) => m.main).map((m) => m.id)).toEqual([DP]);
    }
  });

  it("leaves out the monitors that are off or have no place in the row", () => {
    const s = screensFromStatus(
      status({
        monitors: [
          { id: "a", label: "a", enabled: true, rect: { x: 0, y: 0, width: 2560, height: 1440 } },
          { id: "b", label: "b", enabled: false, rect: { x: 2560, y: 0, width: 2560, height: 1440 } },
          { id: "c", label: "c", enabled: true, rect: null },
          { id: "d", label: "d", enabled: true, rect: { x: 2560, y: 0, width: 2560, height: 1440 } },
        ],
        main: "a",
      }),
      5120,
      1440,
    )!;
    expect(s.map((m) => m.id)).toEqual(["a", "d"]);
  });

  it("feeds setDeskScreens a layout it keeps", () => {
    setDeskScreens(screensFromStatus(status(), 5120, 1440));
    expect(getDeskScreens()?.map((s) => s.id)).toEqual([HDMI, DP]);
    expect(mainScreen().id).toBe(HDMI);
  });
});
