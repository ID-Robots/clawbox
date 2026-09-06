// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESKTOP_LAYERS,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  TITLE_BAR_HEIGHT,
  clampWindowPosition,
  fitWindowSize,
  getSnapRect,
  getSnapZone,
  shelfHeight,
  SNAP_THRESHOLD,
} from "@/lib/window-snap";

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
