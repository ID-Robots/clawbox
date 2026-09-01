// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSnapRect, getSnapZone, shelfHeight, SNAP_THRESHOLD } from "@/lib/window-snap";

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
