// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESKTOP_GAP,
  DESKTOP_LAYERS,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  TITLE_BAR_HEIGHT,
  clampWindowPosition,
  fitWindowSize,
  getSnapRect,
  getSnapZone,
  maximizedRect,
  shelfHeight,
  SNAP_THRESHOLD,
  desktopTop,
  devicePx,
} from "@/lib/window-snap";
import { KIOSK_BAR_VAR } from "@/lib/kiosk-bar-inset";

/**
 * The snap zones are shared by BOTH draggable surfaces on the desktop — the app
 * windows and the mascot chat. They were a private copy inside ChromeWindow
 * until the chat needed the same behaviour; these pin the geometry so the two
 * cannot drift into disagreeing about where "the right half" is.
 */

const W = 1000;
const H = 800;
const SHELF = 56;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: W, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: H, configurable: true });
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty(KIOSK_BAR_VAR);
});

describe("shelfHeight", () => {
  it("falls back to 56 when no shelf is mounted", () => {
    expect(shelfHeight()).toBe(SHELF);
  });

  it("measures the live shelf, so a safe-area inset is not ignored", () => {
    // The inset is a device property JS cannot read; measuring the element is
    // the only way a maximized surface stops above the bar rather than under it.
    const el = document.createElement("div");
    el.setAttribute("data-mascot-ground", "");
    el.getBoundingClientRect = () => ({ height: 78 }) as DOMRect;
    document.body.appendChild(el);
    expect(shelfHeight()).toBe(78);
  });
});

describe("getSnapZone", () => {
  it("has no zone in open space", () => {
    expect(getSnapZone(500, 400)).toBeNull();
  });

  it.each([
    ["top-left", 0, 0],
    ["top-right", W - 1, 0],
    ["bottom-left", 0, H - SHELF - 1],
    ["bottom-right", W - 1, H - SHELF - 1],
  ] as const)("returns %s at that corner", (zone, x, y) => {
    expect(getSnapZone(x, y)).toBe(zone);
  });

  it("prefers a corner over the edge it shares", () => {
    // Both nearLeft and nearTop hold here; a plain "left" would lose the corner.
    expect(getSnapZone(SNAP_THRESHOLD, SNAP_THRESHOLD)).toBe("top-left");
  });

  it("measures the bottom edge from above the shelf, not the viewport floor", () => {
    // At the true viewport bottom the pointer is already over the shelf, which
    // is not a drop target — the zone ends where the desktop does.
    expect(getSnapZone(500, H - SHELF - 1)).toBeNull();
    expect(getSnapZone(0, H - SHELF - 1)).toBe("bottom-left");
  });

  it("moves the right edge inward by the reserved strip", () => {
    // With the chat docked, "the right edge" is the edge of what is LEFT of the
    // desktop — the same x is open space without the strip and the right zone
    // with it.
    expect(getSnapZone(W - 300 - 1, 400)).toBeNull();
    expect(getSnapZone(W - 300 - 1, 400, 300)).toBe("right");
  });
});

describe("getSnapRect", () => {
  it("is null without a zone, so a plain drop changes nothing", () => {
    expect(getSnapRect(null)).toBeNull();
  });

  it("fills the desktop for top, stopping above the shelf", () => {
    expect(getSnapRect("top")).toEqual({ x: 0, y: 0, width: W, height: H - SHELF });
  });

  it("splits halves and quarters without overlap or gap", () => {
    const left = getSnapRect("left")!;
    const right = getSnapRect("right")!;
    expect(left.x + left.width).toBe(right.x);
    expect(right.x + right.width).toBe(W);

    const tl = getSnapRect("top-left")!;
    const bl = getSnapRect("bottom-left")!;
    expect(tl.y + tl.height).toBe(bl.y);
    expect(bl.y + bl.height).toBe(H - SHELF);
  });

  it("keeps a snapped surface clear of the reserved strip", () => {
    const right = getSnapRect("right", 300)!;
    expect(right.x + right.width).toBe(W - 300);
  });
});

describe("clampWindowPosition", () => {
  const win = { width: 800, height: 600 };

  it("leaves a window that is already on the desktop alone", () => {
    expect(clampWindowPosition({ x: 100, y: 50, ...win })).toEqual({ x: 100, y: 50 });
  });

  it("keeps the title bar above the shelf", () => {
    // The drag handler clamped y at 0 and nothing else, so a window dragged to
    // the bottom of the viewport put its whole 36px title bar under the shelf —
    // and with it every way to move the window back.
    expect(clampWindowPosition({ x: 100, y: 890, ...win }).y).toBe(H - SHELF - TITLE_BAR_HEIGHT);
  });

  it("keeps the window controls, which live at the right end, on the desktop", () => {
    expect(clampWindowPosition({ x: 1020, y: 0, ...win }).x).toBe(W - win.width);
    expect(clampWindowPosition({ x: -44, y: 20, ...win }).x).toBe(0);
  });

  it("measures the screen, not the desktop a docked chat narrows", () => {
    // A docked chat only narrows the desktop; the windows beside it keep their
    // own size and place, so a window wider than the strip that is left must
    // not be dragged to the left edge the moment the panel appears.
    expect(clampWindowPosition({ x: 500, y: 0, width: 400, height: 300 })).toEqual({ x: 500, y: 0 });
  });

  it("leaves a window wider than the screen where it is, rather than pushing it right", () => {
    const wide = { x: -200, y: 10, width: W + 200, height: 400 };
    expect(clampWindowPosition(wide).x).toBe(-200);
    expect(clampWindowPosition({ ...wide, x: 40 }).x).toBe(0);
  });
});

describe("fitWindowSize", () => {
  it("leaves a window that fits alone", () => {
    expect(fitWindowSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });

  it("shrinks a restored window that is taller than the desktop", () => {
    // 881px of window on an 844px desktop hides its own bottom edge — and the
    // resize handle that would fix it — under the shelf.
    expect(fitWindowSize({ width: 1102, height: 881 })).toEqual({ width: W, height: H - SHELF });
  });

  it("never squeezes below the window minimums", () => {
    Object.defineProperty(window, "innerWidth", { value: 120, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 120, configurable: true });
    expect(fitWindowSize({ width: 800, height: 600 })).toEqual({
      width: MIN_WINDOW_WIDTH,
      height: MIN_WINDOW_HEIGHT,
    });
  });

  it("fits a window being OPENED beside a docked chat to the strip, one desktop gap in on each side", () => {
    // Files at its 1090px default, centred in the 576px left of an 858px
    // panel, landed with its right 534px — minimize, maximize and close among
    // them — under the chat.
    const inset = 400 + DESKTOP_GAP;
    expect(fitWindowSize({ width: 800, height: 600 }, inset)).toEqual({
      width: W - inset - DESKTOP_GAP * 2,
      height: 600,
    });
  });

  it("leaves a window that fits the strip at its own size", () => {
    expect(fitWindowSize({ width: 400, height: 600 }, 400 + DESKTOP_GAP)).toEqual({ width: 400, height: 600 });
  });
});

/**
 * Window geometry on a LATTICE of points that are a whole CSS pixel AND a
 * whole device pixel. Measured in Chrome at devicePixelRatio 1.5: a window at
 * a whole device pixel that is not a whole CSS pixel (400.6667) drew its
 * content differently from one at 400 or 402 (thousands of pixels apart), on
 * the drag's layer and back in the page after the drop; only points that are
 * both drew the same everywhere.
 */
describe("on the CSS-and-device pixel lattice", () => {
  const DPR = 1.5;
  /** At 1.5, 2 CSS px is the smallest whole number that is 3 whole device px. */
  const STEP = 2;
  const onLattice = (v: number, step = STEP) => Math.abs(v / step - Math.round(v / step)) < 1e-9;
  const ZONES = ["left", "right", "top", "top-left", "top-right", "bottom-left", "bottom-right"] as const;
  beforeEach(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: DPR, configurable: true });
    // Odd sizes: halves and centres fall between lattice points.
    Object.defineProperty(window, "innerWidth", { value: 1365, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 767, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  });

  const wholeDevicePx = (v: number, dpr: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6;
  it.each([
    [1, 1, true], [2, 1, true], [3, 1, true], [0.5, 2, true], [1.5, 2, true], [2.5, 2, true], [1.25, 4, true], [1.75, 4, true],
    // No whole number up to 4 is a whole number of device pixels: whole CSS pixels.
    [1.1, 1, false], [1.125, 1, false], [1.331, 1, false],
  ])("steps by whole CSS pixels that are whole device pixels: at %s, %s", (dpr, step, device) => {
    Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
    expect(wholeDevicePx(step, dpr)).toBe(device);
    for (const v of [0, 101, 347.5, 400 + 2 / 3, 402, 1365, -99]) {
      const nearest = devicePx(v);
      expect(onLattice(nearest, step), `${v} -> ${nearest}`).toBe(true);
      expect(Number.isInteger(nearest) && (!device || wholeDevicePx(nearest, dpr)), `${v} -> ${nearest}`).toBe(true);
      expect(Math.abs(nearest - v)).toBeLessThanOrEqual(step / 2);
      const up = devicePx(v, true);
      expect(onLattice(up, step) && up >= v && up - v < step, `${v} -> ${up} (at least)`).toBe(true);
    }
  });

  it("takes a whole device pixel that is not a whole CSS pixel (400.6667) to the lattice, and keeps 402", () => {
    expect(clampWindowPosition({ x: 400 + 2 / 3, y: 202, width: 600, height: 400 })).toEqual({ x: 400, y: 202 });
    expect(clampWindowPosition({ x: 402, y: 200 + 2 / 3, width: 600, height: 400 })).toEqual({ x: 402, y: 200 });
  });

  it("lays every snap zone's left and top on the lattice, its halves meeting, its far edges the desktop's own", () => {
    for (const zone of ZONES) {
      const r = getSnapRect(zone)!;
      expect(onLattice(r.x) && onLattice(r.y), `${zone} ${JSON.stringify(r)}`).toBe(true);
    }
    const left = getSnapRect("left")!;
    const right = getSnapRect("right")!;
    expect(onLattice(left.width)).toBe(true);
    expect(left.x + left.width).toBe(right.x);
    // Never rounded short of the desktop's edge (1365 is not on the lattice).
    expect(right.x + right.width).toBe(1365);
    const tl = getSnapRect("top-left")!;
    const bl = getSnapRect("bottom-left")!;
    expect(onLattice(tl.height)).toBe(true);
    expect(tl.y + tl.height).toBe(bl.y);
    expect(bl.y + bl.height).toBe(767 - SHELF);
  });

  it("lays a maximized window's left and top on the lattice, reaching the desktop's far edges", () => {
    const m = maximizedRect(301);
    expect(onLattice(m.x) && onLattice(m.y), JSON.stringify(m)).toBe(true);
    expect(m.x + m.width).toBe(1365 - 301);
    expect(m.y + m.height).toBe(767 - SHELF);
  });

  it("clamps and fits a window onto the lattice: even CSS pixels at 1.5", () => {
    expect(clampWindowPosition({ x: 347.5, y: 101, width: 600, height: 400 })).toEqual({ x: 348, y: 102 });
    expect(fitWindowSize({ width: 801, height: 601 })).toEqual({ width: 802, height: 602 });
    // Fitted to the desktop: its edge, to the nearest lattice point.
    const big = fitWindowSize({ width: 2000, height: 2000 });
    expect(onLattice(big.width) && onLattice(big.height), JSON.stringify(big)).toBe(true);
    expect(Math.abs(big.width - 1365)).toBeLessThanOrEqual(STEP / 2);
    expect(Math.abs(big.height - (767 - SHELF))).toBeLessThanOrEqual(STEP / 2);
    // The minimums stay 300 x 200, which are on every lattice.
    expect(fitWindowSize({ width: 10, height: 10 })).toEqual({ width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
  });

  it("changes nothing that is already on the lattice, and nothing at all at devicePixelRatio 1", () => {
    expect(clampWindowPosition({ x: 100, y: 50, width: 800, height: 600 })).toEqual({ x: 100, y: 50 });
    expect(fitWindowSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: W, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: H, configurable: true });
    expect(getSnapRect("right")).toEqual({ x: W / 2, y: 0, width: W / 2, height: H - SHELF });
  });
});

/**
 * The laptop's kiosk: its extension draws a bar across the top of the desktop
 * page, and says how tall it is on <html>
 * (src/lib/kiosk-bar-inset.ts). Everything laid against the top edge starts
 * under it, or its title bar is under a bar that sits above every layer.
 */
describe("under the kiosk bar", () => {
  const BAR = 40;
  beforeEach(() => {
    document.documentElement.style.setProperty(KIOSK_BAR_VAR, `${BAR}px`);
  });

  it("puts the desktop's top under the bar, and at 0 without one", () => {
    expect(desktopTop()).toBe(BAR);
    document.documentElement.style.removeProperty(KIOSK_BAR_VAR);
    expect(desktopTop()).toBe(0);
  });

  it("snaps below the bar, stopping above the shelf", () => {
    expect(getSnapRect("top")).toEqual({ x: 0, y: BAR, width: W, height: H - SHELF - BAR });
    expect(getSnapRect("left")).toEqual({ x: 0, y: BAR, width: W / 2, height: H - SHELF - BAR });
    const half = (H - SHELF - BAR) / 2;
    expect(getSnapRect("bottom-right")).toEqual({ x: W / 2, y: BAR + half, width: W / 2, height: half });
  });

  it("measures the top snap zone from the desktop's top, not the screen's", () => {
    expect(getSnapZone(500, BAR + SNAP_THRESHOLD)).toBe("top");
    expect(getSnapZone(500, BAR + SNAP_THRESHOLD + 1)).toBeNull();
  });

  it("keeps a window's title bar out from under the bar", () => {
    expect(clampWindowPosition({ x: 100, y: 0, width: 400, height: 300 })).toEqual({ x: 100, y: BAR });
    expect(clampWindowPosition({ x: 100, y: 200, width: 400, height: 300 })).toEqual({ x: 100, y: 200 });
  });

  it("fits a window to the strip between the bar and the shelf", () => {
    expect(fitWindowSize({ width: 400, height: 2000 })).toEqual({ width: 400, height: H - SHELF - BAR });
  });

  it("ignores a value that is not a bar's height", () => {
    document.documentElement.style.setProperty(KIOSK_BAR_VAR, "banana");
    expect(desktopTop()).toBe(0);
    document.documentElement.style.setProperty(KIOSK_BAR_VAR, "-40px");
    expect(desktopTop()).toBe(0);
    document.documentElement.style.setProperty(KIOSK_BAR_VAR, "5000px");
    expect(desktopTop()).toBe(120);
  });
});

describe("DESKTOP_LAYERS", () => {
  it("puts the modal launcher above the chat it used to open behind", () => {
    // 9998/9999 against the chat's 10010 left nine of twelve app tiles
    // unclickable whenever the chat was open, and a click on one landed in the
    // chat's composer.
    expect(DESKTOP_LAYERS.overlay).toBeGreaterThan(DESKTOP_LAYERS.chat);
  });

  it("keeps the ladder in one order: windows under the shelf, menus over everything but a modal", () => {
    const ladder = [
      DESKTOP_LAYERS.window,
      DESKTOP_LAYERS.shelf,
      DESKTOP_LAYERS.mascot,
      DESKTOP_LAYERS.chat,
      DESKTOP_LAYERS.overlay,
      DESKTOP_LAYERS.notice,
      DESKTOP_LAYERS.menu,
      DESKTOP_LAYERS.modal,
    ];
    expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
    expect(new Set(ladder).size).toBe(ladder.length);
  });
});
