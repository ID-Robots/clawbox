// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESKTOP_GAP,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  SNAP_THRESHOLD,
  TITLE_BAR_HEIGHT,
  clampFloatingRect,
  clampWindowPosition,
  desktopTop,
  dockedChatMaxWidth,
  fitPlacedWindow,
  fitWindowSize,
  getSnapRect,
  getSnapZone,
  maximizedRect,
  shelfHeight,
  snapTargetAt,
  workArea,
  type SnapZone,
} from "@/lib/window-snap";
import { setDeskScreens, type DeskScreen } from "@/lib/desktop-screens";
import { KIOSK_BAR_VAR } from "@/lib/kiosk-bar-inset";

/**
 * Snapping, maximizing, clamping and fitting over a ROW of monitors (monitor
 * mode, src/lib/desktop-screens.ts) — and, first, the promise that made it
 * safe to ship: with no monitor layout every function answers exactly what it
 * answered before monitor mode existed. The Jetson product and every desktop
 * opened in a browser tab have no layout, so for them the geometry must not
 * move by a pixel.
 *
 * The single-screen behaviour itself is pinned by window-snap.test.ts; this
 * file does not repeat it.
 */

const SHELF = 56;

function scr(id: string, x: number, y: number, width: number, height: number, main = false): DeskScreen {
  return { id, label: id, x, y, width, height, main };
}

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
}

function mountShelf(height: number) {
  const el = document.createElement("div");
  el.setAttribute("data-mascot-ground", "");
  el.getBoundingClientRect = () => ({ height }) as DOMRect;
  document.body.appendChild(el);
}

function setBar(px: number) {
  if (px > 0) document.documentElement.style.setProperty(KIOSK_BAR_VAR, `${px}px`);
  else document.documentElement.style.removeProperty(KIOSK_BAR_VAR);
}

afterEach(() => {
  setDeskScreens(null);
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty(KIOSK_BAR_VAR);
});

/* ------------------------------------------------------------------------ */
/* The old answers                                                           */
/* ------------------------------------------------------------------------ */

/**
 * The four functions as they were before monitor mode — copied verbatim from
 * `git show HEAD:src/lib/window-snap.ts` (75264518), with the module's own
 * `shelfHeight`/`desktopTop` (unchanged by the branch) standing in for theirs.
 */
const old = {
  getSnapZone(clientX: number, clientY: number, rInset = 0): SnapZone {
    const w = window.innerWidth - rInset;
    const h = window.innerHeight - shelfHeight();
    const nearLeft = clientX <= SNAP_THRESHOLD;
    const nearRight = clientX >= w - SNAP_THRESHOLD;
    const nearTop = clientY <= desktopTop() + SNAP_THRESHOLD;
    const nearBottom = clientY >= h - SNAP_THRESHOLD;
    if (nearTop && nearLeft) return "top-left";
    if (nearTop && nearRight) return "top-right";
    if (nearBottom && nearLeft) return "bottom-left";
    if (nearBottom && nearRight) return "bottom-right";
    if (nearLeft) return "left";
    if (nearRight) return "right";
    if (nearTop) return "top";
    return null;
  },
  clampWindowPosition(rect: { x: number; y: number; width: number; height: number }) {
    const spare = window.innerWidth - rect.width;
    const top = desktopTop();
    const availH = window.innerHeight - shelfHeight();
    const x = Math.min(Math.max(rect.x, Math.min(0, spare)), Math.max(0, spare));
    const y = Math.min(Math.max(rect.y, top), Math.max(top, availH - TITLE_BAR_HEIGHT));
    return { x, y };
  },
  fitWindowSize(size: { width: number; height: number }, rInset = 0) {
    const availW = rInset > 0 ? window.innerWidth - rInset - DESKTOP_GAP * 2 : window.innerWidth;
    const availH = window.innerHeight - shelfHeight() - desktopTop();
    return {
      width: Math.max(MIN_WINDOW_WIDTH, Math.min(size.width, availW)),
      height: Math.max(MIN_WINDOW_HEIGHT, Math.min(size.height, availH)),
    };
  },
  getSnapRect(zone: SnapZone, rInset = 0) {
    if (!zone) return null;
    const w = window.innerWidth - rInset;
    const t = desktopTop();
    const h = window.innerHeight - shelfHeight() - t;
    switch (zone) {
      case "left": return { x: 0, y: t, width: w / 2, height: h };
      case "right": return { x: w / 2, y: t, width: w / 2, height: h };
      case "top": return { x: 0, y: t, width: w, height: h };
      case "top-left": return { x: 0, y: t, width: w / 2, height: h / 2 };
      case "top-right": return { x: w / 2, y: t, width: w / 2, height: h / 2 };
      case "bottom-left": return { x: 0, y: t + h / 2, width: w / 2, height: h / 2 };
      case "bottom-right": return { x: w / 2, y: t + h / 2, width: w / 2, height: h / 2 };
      default: return null;
    }
  },
  /** ChatPopup's floating-chat drag clamp before monitor mode (`onDragStart`). */
  clampFloating(rect: { x: number; y: number; width: number; height: number }, margin: number) {
    const top = desktopTop() + margin;
    return {
      x: Math.max(margin, Math.min(rect.x, window.innerWidth - rect.width - margin)),
      y: Math.max(top, Math.min(rect.y, window.innerHeight - rect.height - margin)),
    };
  },
  /**
   * What a maximized window stood on before: ChromeWindow's style was
   * `left: 0, top: barInset, width: calc(100% - rightInset), height:
   * calc(100vh - shelf - barInset)`.
   */
  maximized(rInset = 0) {
    const t = desktopTop();
    return { x: 0, y: t, width: window.innerWidth - rInset, height: window.innerHeight - shelfHeight() - t };
  },
};

const ZONES: SnapZone[] = ["left", "right", "top", "top-left", "top-right", "bottom-left", "bottom-right", null];
const VIEWPORTS = [[1000, 800], [390, 844], [1366, 768], [5120, 1440]] as const;
const BARS = [0, 40];
const SHELVES = [null, 78] as const;
const INSETS = [0, 300, 406 + DESKTOP_GAP];

/** Every combination of viewport, kiosk bar, shelf and docked-chat strip. */
function* desktops(): Generator<{ W: number; H: number; bar: number; shelf: number; r: number; label: string }> {
  for (const [W, H] of VIEWPORTS) {
    for (const bar of BARS) {
      for (const shelf of SHELVES) {
        for (const r of INSETS) {
          setViewport(W, H);
          setBar(bar);
          document.body.innerHTML = "";
          if (shelf !== null) mountShelf(shelf);
          yield { W, H, bar, shelf: shelf ?? SHELF, r, label: `${W}x${H} bar=${bar} shelf=${shelf ?? SHELF} r=${r}` };
        }
      }
    }
  }
}

describe("with no monitor layout, exactly what it answered before", () => {
  // `at` is new: with one screen every point is on the viewport, so it must
  // not change a thing either.
  const ATS = [undefined, { x: 0, y: 0 }, { x: 99_999, y: 99_999 }, { x: -500, y: -500 }];

  it("getSnapZone", () => {
    let checked = 0;
    for (const d of desktops()) {
      const xs = [-10, 0, 5, 12, 13, d.W / 2, d.W - d.r - 13, d.W - d.r - 12, d.W - 13, d.W - 1, d.W + 50];
      const ys = [-5, 0, 12, 13, d.bar + 12, d.bar + 13, d.H / 2, d.H - d.shelf - 13, d.H - d.shelf - 12, d.H - 1, d.H + 30];
      for (const x of xs) {
        for (const y of ys) {
          expect(getSnapZone(x, y, d.r), `${d.label} at ${x},${y}`).toBe(old.getSnapZone(x, y, d.r));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("getSnapRect", () => {
    for (const d of desktops()) {
      for (const zone of ZONES) {
        for (const at of ATS) {
          expect(getSnapRect(zone, d.r, at), `${d.label} ${zone} at ${JSON.stringify(at)}`).toEqual(old.getSnapRect(zone, d.r));
        }
      }
    }
  });

  it("clampWindowPosition", () => {
    for (const d of desktops()) {
      for (const size of [{ width: 400, height: 300 }, { width: 800, height: 600 }, { width: d.W + 200, height: 400 }]) {
        for (const x of [-500, -44, 0, 100, d.W - 400, d.W + 20]) {
          for (const y of [-10, 0, 30, 200, d.H - 50, d.H + 90]) {
            const rect = { x, y, ...size };
            expect(clampWindowPosition(rect), `${d.label} ${JSON.stringify(rect)}`).toEqual(old.clampWindowPosition(rect));
          }
        }
      }
    }
  });

  it("fitWindowSize", () => {
    for (const d of desktops()) {
      for (const size of [{ width: 800, height: 600 }, { width: 1102, height: 881 }, { width: 100, height: 100 }, { width: d.W + 500, height: d.H + 500 }]) {
        for (const at of ATS) {
          expect(fitWindowSize(size, d.r, at), `${d.label} ${JSON.stringify(size)} at ${JSON.stringify(at)}`).toEqual(old.fitWindowSize(size, d.r));
        }
      }
    }
  });

  it("maximizedRect is where a maximized window stood", () => {
    for (const d of desktops()) {
      for (const at of ATS) {
        expect(maximizedRect(d.r, at), `${d.label} at ${JSON.stringify(at)}`).toEqual(old.maximized(d.r));
      }
    }
  });

  it("fitPlacedWindow is fitWindowSize", () => {
    for (const d of desktops()) {
      for (const size of [{ width: 800, height: 600 }, { width: 1102, height: 881 }, { width: 100, height: 100 }, { width: d.W + 500, height: d.H + 500 }]) {
        for (const [x, y] of [[0, 0], [-300, 40], [d.W - 200, d.H - 10]]) {
          expect(fitPlacedWindow({ x, y, ...size }), `${d.label} ${JSON.stringify(size)} at ${x},${y}`).toEqual(old.fitWindowSize(size, 0));
        }
      }
    }
  });

  it("dockedChatMaxWidth is 60% of the viewport", () => {
    for (const d of desktops()) {
      expect(dockedChatMaxWidth(), d.label).toBe(d.W * 0.6);
    }
  });

  it("clampFloatingRect is the floating chat's old drag clamp", () => {
    const M = 8;
    for (const d of desktops()) {
      for (const size of [{ width: 520, height: 680 }, { width: d.W + 100, height: d.H + 100 }]) {
        for (const x of [-50, 0, 300, d.W - 100, d.W + 40]) {
          for (const y of [-20, 0, 30, d.H - 300, d.H + 60]) {
            expect(clampFloatingRect({ x, y, ...size }, M), `${d.label} ${JSON.stringify(size)} at ${x},${y}`).toEqual(old.clampFloating({ x, y, ...size }, M));
          }
        }
      }
    }
  });

  it("snapTargetAt is getSnapZone's zone at the cursor", () => {
    for (const d of desktops()) {
      for (const [x, y] of [[0, 0], [d.W - 1, d.H / 2], [d.W / 2, d.H / 2], [5, d.H - d.shelf - 1]]) {
        const zone = old.getSnapZone(x, y, d.r);
        expect(snapTargetAt(x, y, d.r), `${d.label} at ${x},${y}`).toEqual(zone ? { zone, at: { x, y } } : null);
      }
    }
  });

  it("a layout of ONE monitor is no layout at all", () => {
    // The span script reports the laptop's own panel alone as a layout of one.
    setDeskScreens([scr("only", 0, 0, 1920, 1080, true)]);
    for (const d of desktops()) {
      expect(getSnapZone(d.W - 1, 0, d.r)).toBe(old.getSnapZone(d.W - 1, 0, d.r));
      expect(getSnapRect("right", d.r)).toEqual(old.getSnapRect("right", d.r));
      expect(clampWindowPosition({ x: d.W, y: d.H, width: 400, height: 300 })).toEqual(old.clampWindowPosition({ x: d.W, y: d.H, width: 400, height: 300 }));
      expect(fitWindowSize({ width: 5000, height: 5000 }, d.r)).toEqual(old.fitWindowSize({ width: 5000, height: 5000 }, d.r));
      expect(maximizedRect(d.r)).toEqual(old.maximized(d.r));
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Over a row of monitors                                                    */
/* ------------------------------------------------------------------------ */

const MON_W = 2560;
const MON_H = 1440;

/** The test machine: two 2560x1440 monitors, the MAIN one on the left. */
const ROW_MAIN_LEFT = [scr("a", 0, 0, MON_W, MON_H, true), scr("b", MON_W, 0, MON_W, MON_H)];
/** The same row with the main monitor on the right. */
const ROW_MAIN_RIGHT = [scr("a", 0, 0, MON_W, MON_H), scr("b", MON_W, 0, MON_W, MON_H, true)];
/** A 1080p main beside a taller 1440p monitor: the strip under the main one is dead page. */
const MIXED = [scr("small", 0, 0, 1920, 1080, true), scr("big", 1920, 0, 2560, 1440)];

describe("over a row of monitors", () => {
  beforeEach(() => {
    setViewport(2 * MON_W, MON_H);
  });

  describe("workArea", () => {
    it("is the main monitor less the shelf, and less the docked chat's strip", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(workArea(ROW_MAIN_LEFT[0])).toEqual({ x: 0, y: 0, width: MON_W, height: MON_H - SHELF });
      expect(workArea(ROW_MAIN_LEFT[0], 300)).toEqual({ x: 0, y: 0, width: MON_W - 300, height: MON_H - SHELF });
    });

    it("is the whole of any other monitor: no shelf, no chat, no kiosk bar there", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      setBar(40);
      mountShelf(78);
      expect(workArea(ROW_MAIN_LEFT[1], 300)).toEqual({ x: MON_W, y: 0, width: MON_W, height: MON_H });
    });

    it("takes the measured shelf and the kiosk bar on the main monitor, wherever it is", () => {
      setDeskScreens(ROW_MAIN_RIGHT);
      setBar(40);
      mountShelf(78);
      expect(workArea(ROW_MAIN_RIGHT[1], 300)).toEqual({ x: MON_W, y: 40, width: MON_W - 300, height: MON_H - 78 - 40 });
    });
  });

  describe("maximizedRect", () => {
    it("fills the main monitor's work area when no point says which monitor", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(maximizedRect()).toEqual({ x: 0, y: 0, width: MON_W, height: MON_H - SHELF });
      setDeskScreens(ROW_MAIN_RIGHT);
      expect(maximizedRect()).toEqual({ x: MON_W, y: 0, width: MON_W, height: MON_H - SHELF });
    });

    it("fills the monitor under the point: the main one short of the shelf and the chat, another whole", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(maximizedRect(300, { x: 100, y: 100 })).toEqual({ x: 0, y: 0, width: MON_W - 300, height: MON_H - SHELF });
      expect(maximizedRect(300, { x: 3000, y: 100 })).toEqual({ x: MON_W, y: 0, width: MON_W, height: MON_H });
    });

    it("starts under the kiosk bar on the main monitor only", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      setBar(40);
      expect(maximizedRect(0, { x: 100, y: 100 })).toEqual({ x: 0, y: 40, width: MON_W, height: MON_H - SHELF - 40 });
      expect(maximizedRect(0, { x: 3000, y: 100 })).toEqual({ x: MON_W, y: 0, width: MON_W, height: MON_H });
    });

    it("takes the nearest monitor for a point on none (the dead strip, past an edge)", () => {
      setViewport(4480, 1440);
      setDeskScreens(MIXED);
      expect(maximizedRect(0, { x: 100, y: 1300 })).toEqual({ x: 0, y: 0, width: 1920, height: 1080 - SHELF });
      expect(maximizedRect(0, { x: 9000, y: 100 })).toEqual({ x: 1920, y: 0, width: 2560, height: 1440 });
      expect(maximizedRect(0, { x: -50, y: 100 })).toEqual({ x: 0, y: 0, width: 1920, height: 1080 - SHELF });
    });
  });

  describe("getSnapZone", () => {
    it("snaps against the row's outer edges", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(getSnapZone(5, 700)).toBe("left");
      expect(getSnapZone(2 * MON_W - 5, 700)).toBe("right");
      expect(getSnapZone(5, 5)).toBe("top-left");
      expect(getSnapZone(2 * MON_W - 5, 5)).toBe("top-right");
    });

    it("snaps nothing at the seam between two monitors, which the cursor crosses on the way over", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(getSnapZone(MON_W - 5, 700)).toBeNull();
      expect(getSnapZone(MON_W - 1, 700)).toBeNull();
      expect(getSnapZone(MON_W, 700)).toBeNull();
      expect(getSnapZone(MON_W + 5, 700)).toBeNull();
    });

    it("keeps the top zone at the seam, without the shared side's corner", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(getSnapZone(MON_W - 5, 5)).toBe("top");
      expect(getSnapZone(MON_W + 5, 5)).toBe("top");
      expect(getSnapZone(3000, 5)).toBe("top");
    });

    it("measures the bottom from the shelf on the main monitor and from the floor on another", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      const aboveShelf = MON_H - SHELF - 1;
      expect(getSnapZone(5, aboveShelf)).toBe("bottom-left");
      // The same height on the other monitor is open space: there is no shelf there.
      expect(getSnapZone(2 * MON_W - 5, aboveShelf)).toBe("right");
      expect(getSnapZone(2 * MON_W - 5, MON_H - 1)).toBe("bottom-right");
      // The bottom of a seam is not a corner either.
      expect(getSnapZone(MON_W + 5, MON_H - 1)).toBeNull();
    });

    it("measures the top under the kiosk bar on the main monitor only", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      setBar(40);
      expect(getSnapZone(1000, 40 + SNAP_THRESHOLD)).toBe("top");
      expect(getSnapZone(1000, 40 + SNAP_THRESHOLD + 1)).toBeNull();
      expect(getSnapZone(3000, 40 + SNAP_THRESHOLD)).toBeNull();
      expect(getSnapZone(3000, SNAP_THRESHOLD)).toBe("top");
    });

    it("moves the main monitor's right edge in by the docked chat's strip when it is the row's last", () => {
      setDeskScreens(ROW_MAIN_RIGHT);
      expect(getSnapZone(2 * MON_W - 300 - 1, 700)).toBeNull();
      expect(getSnapZone(2 * MON_W - 300 - 1, 700, 300)).toBe("right");
    });

    it("leaves another monitor's edges where they are when the chat is docked", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(getSnapZone(2 * MON_W - 5, 700, 300)).toBe("right");
      expect(getSnapZone(2 * MON_W - 300 - 1, 700, 300)).toBeNull();
    });

    // The shared-edge suppression is about the MONITOR's edge; with a docked
    // chat the right-hand zone is the chat's left side, `rInset` px inside the
    // monitor and shared with nothing. Judged on the monitor's edge, the main
    // monitor on the left (the test machine's layout) could not snap a window
    // beside the chat at all, while `getSnapRect("right", rInset)` still laid
    // that half out and the one-screen desktop snapped there.
    it("snaps to the half beside a docked chat when the main monitor has a neighbour on its right", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(getSnapZone(MON_W - 300 - 1, 700, 300)).toBe("right");
      expect(getSnapZone(MON_W - 300 - SNAP_THRESHOLD, 5, 300)).toBe("top-right");
      expect(getSnapZone(MON_W - 300 - SNAP_THRESHOLD, MON_H - SHELF - 1, 300)).toBe("bottom-right");
      // Over the chat's own strip, as on one screen.
      expect(getSnapZone(MON_W - 100, 700, 300)).toBe("right");
      // Short of the zone: nothing.
      expect(getSnapZone(MON_W - 300 - SNAP_THRESHOLD - 1, 700, 300)).toBeNull();
      // And the seam itself is still no edge once the chat is undocked.
      expect(getSnapZone(MON_W - 1, 700, 0)).toBeNull();
    });

    it("keeps the main monitor's other shared edge suppressed while the chat is docked", () => {
      // The chat narrows the right-hand side only; the seam on the left of a
      // main monitor that sits on the right is still crossed, not rested on.
      setDeskScreens(ROW_MAIN_RIGHT);
      expect(getSnapZone(MON_W + 5, 700, 300)).toBeNull();
    });

    it("judges each monitor of a mixed-height row by its own edges", () => {
      setViewport(4480, 1440);
      setDeskScreens(MIXED);
      // The seam.
      expect(getSnapZone(1915, 500)).toBeNull();
      expect(getSnapZone(1925, 500)).toBeNull();
      // The short main monitor's bottom (above its shelf) vs the tall one's floor.
      expect(getSnapZone(5, 1080 - SHELF - 1)).toBe("bottom-left");
      expect(getSnapZone(4475, 1080 - SHELF - 1)).toBe("right");
      expect(getSnapZone(4475, 1439)).toBe("bottom-right");
      // In the dead strip under the short monitor: judged on the nearest one.
      expect(getSnapZone(5, 1300)).toBe("bottom-left");
    });

    // A neighbour is judged beside the CURSOR, not along the whole edge: on a
    // mixed-height row the tall monitor's left edge is shared only along the
    // short monitor's 1080 px; below that nothing borders it and the cursor
    // rests against it.
    it("snaps against the part of a tall monitor's edge that no neighbour borders", () => {
      setViewport(4480, 1440);
      setDeskScreens(MIXED);
      expect(getSnapZone(1920, 1300)).toBe("left");
      expect(getSnapZone(1920, 1439)).toBe("bottom-left");
      // Beside the short monitor it is still the seam.
      expect(getSnapZone(1920, 1000)).toBeNull();
    });
  });

  describe("getSnapRect", () => {
    it("lays a zone on the main monitor when no point says which", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(getSnapRect("left")).toEqual({ x: 0, y: 0, width: MON_W / 2, height: MON_H - SHELF });
      setDeskScreens(ROW_MAIN_RIGHT);
      expect(getSnapRect("right")).toEqual({ x: MON_W + MON_W / 2, y: 0, width: MON_W / 2, height: MON_H - SHELF });
    });

    it("lays every zone on the monitor under the point, all of it window space off the main one", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      const at = { x: 3000, y: 700 };
      const half = MON_W / 2;
      expect(getSnapRect("left", 0, at)).toEqual({ x: MON_W, y: 0, width: half, height: MON_H });
      expect(getSnapRect("right", 0, at)).toEqual({ x: MON_W + half, y: 0, width: half, height: MON_H });
      expect(getSnapRect("top", 0, at)).toEqual({ x: MON_W, y: 0, width: MON_W, height: MON_H });
      expect(getSnapRect("top-left", 0, at)).toEqual({ x: MON_W, y: 0, width: half, height: MON_H / 2 });
      expect(getSnapRect("top-right", 0, at)).toEqual({ x: MON_W + half, y: 0, width: half, height: MON_H / 2 });
      expect(getSnapRect("bottom-left", 0, at)).toEqual({ x: MON_W, y: MON_H / 2, width: half, height: MON_H / 2 });
      expect(getSnapRect("bottom-right", 0, at)).toEqual({ x: MON_W + half, y: MON_H / 2, width: half, height: MON_H / 2 });
      expect(getSnapRect(null, 0, at)).toBeNull();
    });

    it("tiles the other monitor without gap or overlap", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      const at = { x: 3000, y: 700 };
      const l = getSnapRect("left", 0, at)!;
      const r = getSnapRect("right", 0, at)!;
      expect(l.x).toBe(MON_W);
      expect(l.x + l.width).toBe(r.x);
      expect(r.x + r.width).toBe(2 * MON_W);
      const tl = getSnapRect("top-left", 0, at)!;
      const bl = getSnapRect("bottom-left", 0, at)!;
      expect(tl.y + tl.height).toBe(bl.y);
      expect(bl.y + bl.height).toBe(MON_H);
    });

    it("keeps the main monitor's halves clear of the shelf, the kiosk bar and the chat", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      setBar(40);
      const at = { x: 100, y: 700 };
      const w = MON_W - 300;
      const h = MON_H - SHELF - 40;
      expect(getSnapRect("right", 300, at)).toEqual({ x: w / 2, y: 40, width: w / 2, height: h });
      expect(getSnapRect("bottom-left", 300, at)).toEqual({ x: 0, y: 40 + h / 2, width: w / 2, height: h / 2 });
      // The chat is on the main monitor: the other one's halves ignore its strip.
      expect(getSnapRect("right", 300, { x: 3000, y: 700 })).toEqual({ x: MON_W + MON_W / 2, y: 0, width: MON_W / 2, height: MON_H });
    });

    it("lays the zone getSnapZone found on the monitor it found it on", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      const drop = { x: 2 * MON_W - 3, y: 700 };
      const zone = getSnapZone(drop.x, drop.y);
      expect(zone).toBe("right");
      const rect = getSnapRect(zone, 0, drop)!;
      expect(rect.x + rect.width).toBe(2 * MON_W);
      expect(rect.x).toBeGreaterThanOrEqual(MON_W);
    });

    it("uses each monitor's own height on a mixed row", () => {
      setViewport(4480, 1440);
      setDeskScreens(MIXED);
      expect(getSnapRect("top", 0, { x: 3000, y: 100 })).toEqual({ x: 1920, y: 0, width: 2560, height: 1440 });
      expect(getSnapRect("top", 0, { x: 100, y: 100 })).toEqual({ x: 0, y: 0, width: 1920, height: 1080 - SHELF });
      // A drop in the dead strip lands on the nearest monitor.
      expect(getSnapRect("left", 0, { x: 100, y: 1300 })).toEqual({ x: 0, y: 0, width: 960, height: 1080 - SHELF });
    });
  });

  describe("clampWindowPosition", () => {
    const win = { width: 800, height: 600 };

    it("leaves a window anywhere along the row alone, a seam-straddling one included", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(clampWindowPosition({ x: 3000, y: 100, ...win })).toEqual({ x: 3000, y: 100 });
      expect(clampWindowPosition({ x: MON_W - 400, y: 100, ...win })).toEqual({ x: MON_W - 400, y: 100 });
    });

    it("keeps the window controls on the row's last monitor, and its left on the first", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(clampWindowPosition({ x: 5000, y: 100, ...win }).x).toBe(2 * MON_W - win.width);
      expect(clampWindowPosition({ x: -44, y: 100, ...win }).x).toBe(0);
    });

    it("leaves a window wider than the whole row where it is, rather than pushing it right", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      const wide = { x: -200, y: 10, width: 2 * MON_W + 200, height: 400 };
      expect(clampWindowPosition(wide).x).toBe(-200);
      expect(clampWindowPosition({ ...wide, x: 40 }).x).toBe(0);
    });

    it("keeps the title bar above the shelf on the main monitor and above the floor on another", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(clampWindowPosition({ x: 100, y: 1430, ...win }).y).toBe(MON_H - SHELF - TITLE_BAR_HEIGHT);
      expect(clampWindowPosition({ x: 3000, y: 1430, ...win }).y).toBe(MON_H - TITLE_BAR_HEIGHT);
    });

    it("judges the monitor after pulling the window back onto the row", () => {
      setDeskScreens(ROW_MAIN_RIGHT);
      // Off the row's right end and under the main monitor's shelf: pulled
      // onto the main monitor, then above ITS shelf.
      expect(clampWindowPosition({ x: 6000, y: 1430, ...win })).toEqual({ x: 2 * MON_W - win.width, y: MON_H - SHELF - TITLE_BAR_HEIGHT });
      // Off the left end, on the other monitor: its floor.
      expect(clampWindowPosition({ x: -300, y: 1430, ...win })).toEqual({ x: 0, y: MON_H - TITLE_BAR_HEIGHT });
    });

    it("keeps the title bar under the kiosk bar on the main monitor only", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      setBar(40);
      expect(clampWindowPosition({ x: 100, y: 0, ...win })).toEqual({ x: 100, y: 40 });
      expect(clampWindowPosition({ x: 3000, y: 0, ...win })).toEqual({ x: 3000, y: 0 });
    });

    it("keeps a title bar out of the dead strip under a shorter main monitor", () => {
      setViewport(4480, 1440);
      setDeskScreens(MIXED);
      expect(clampWindowPosition({ x: 100, y: 1300, width: 400, height: 300 })).toEqual({ x: 100, y: 1080 - SHELF - TITLE_BAR_HEIGHT });
      // On the tall monitor the same height is fine.
      expect(clampWindowPosition({ x: 3000, y: 1300, width: 400, height: 300 })).toEqual({ x: 3000, y: 1300 });
    });
  });

  describe("fitWindowSize", () => {
    it("fits the main monitor's work area when no point says which monitor", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(fitWindowSize({ width: 3000, height: 2000 })).toEqual({ width: MON_W, height: MON_H - SHELF });
    });

    it("fits the monitor the window is on: all of it off the main one", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(fitWindowSize({ width: 3000, height: 2000 }, 0, { x: 3000, y: 100 })).toEqual({ width: MON_W, height: MON_H });
      expect(fitWindowSize({ width: 3000, height: 2000 }, 0, { x: 100, y: 100 })).toEqual({ width: MON_W, height: MON_H - SHELF });
    });

    it("leaves a window that fits its own, larger monitor at its size", () => {
      setViewport(4480, 1440);
      setDeskScreens(MIXED);
      expect(fitWindowSize({ width: 2400, height: 1300 }, 0, { x: 3000, y: 100 })).toEqual({ width: 2400, height: 1300 });
      // Measured against the short main monitor it would have been cut down.
      expect(fitWindowSize({ width: 2400, height: 1300 })).toEqual({ width: 1920, height: 1080 - SHELF });
    });

    it("fits a window opened beside the docked chat to the main monitor's strip", () => {
      setDeskScreens(ROW_MAIN_RIGHT);
      const inset = 400 + DESKTOP_GAP;
      expect(fitWindowSize({ width: 3000, height: 600 }, inset)).toEqual({ width: MON_W - inset - DESKTOP_GAP * 2, height: 600 });
    });

    it("takes the kiosk bar and the measured shelf off the main monitor only", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      setBar(40);
      mountShelf(78);
      expect(fitWindowSize({ width: 400, height: 5000 }, 0, { x: 100, y: 100 })).toEqual({ width: 400, height: MON_H - 78 - 40 });
      expect(fitWindowSize({ width: 400, height: 5000 }, 0, { x: 3000, y: 100 })).toEqual({ width: 400, height: MON_H });
    });

    it("never squeezes below the window minimums", () => {
      setViewport(400, 300);
      setDeskScreens([scr("a", 0, 0, 200, 150, true), scr("b", 200, 0, 200, 150)]);
      expect(fitWindowSize({ width: 800, height: 600 }, 0, { x: 250, y: 50 })).toEqual({ width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
      expect(fitWindowSize({ width: 800, height: 600 })).toEqual({ width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
    });
  });

  describe("snapTargetAt (the preview plate)", () => {
    it("lays the plate on the monitor the drop would use, not on the main one", () => {
      // Main on the left; the window is dragged to the far edge of the other.
      setDeskScreens(ROW_MAIN_LEFT);
      const target = snapTargetAt(2 * MON_W - 5, 700)!;
      expect(target.zone).toBe("right");
      // What the preview draws and what the drop lays out are one rect.
      expect(getSnapRect(target.zone, 0, target.at)).toEqual(getSnapRect(getSnapZone(2 * MON_W - 5, 700), 0, { x: 2 * MON_W - 5, y: 700 }));
      expect(getSnapRect(target.zone, 0, target.at)).toEqual({ x: MON_W + MON_W / 2, y: 0, width: MON_W / 2, height: MON_H });
    });

    it("hands the previous target back while the zone and the monitor stay the same", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      const first = snapTargetAt(2 * MON_W - 5, 700)!;
      // Along the same edge: the same object, so the plate does not re-render.
      expect(snapTargetAt(2 * MON_W - 3, 900, 0, first)).toBe(first);
      // Another zone: a new target.
      const corner = snapTargetAt(2 * MON_W - 3, 3, 0, first)!;
      expect(corner).not.toBe(first);
      expect(corner.zone).toBe("top-right");
      // The same zone on ANOTHER monitor: a new target, laid over there.
      const top = snapTargetAt(3000, 3)!;
      const topMain = snapTargetAt(100, 3, 0, top)!;
      expect(topMain).not.toBe(top);
      expect(getSnapRect(topMain.zone, 0, topMain.at)!.x).toBe(0);
      // Off every zone: nothing.
      expect(snapTargetAt(3000, 700, 0, top)).toBeNull();
    });
  });

  describe("fitPlacedWindow", () => {
    it("keeps a window stretched across the seam at its width", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      // 3500 px from x = 1000: its centre is on the right-hand monitor.
      expect(fitPlacedWindow({ x: 1000, y: 100, width: 3500, height: 900 })).toEqual({ width: 3500, height: 900 });
      // fitted to that one monitor it would have been cut to 2560.
      expect(fitWindowSize({ width: 3500, height: 900 }, 0, { x: 2750, y: 118 }).width).toBe(MON_W);
    });

    it("bounds the width by the whole row, and the height by the monitor the window is on", () => {
      setViewport(4480, 1440);
      setDeskScreens(MIXED);
      // Centred on the short main monitor: its height, less the shelf.
      expect(fitPlacedWindow({ x: -3500, y: 0, width: 9000, height: 5000 })).toEqual({ width: 4480, height: 1080 - SHELF });
      expect(fitPlacedWindow({ x: 0, y: 0, width: 3000, height: 5000 })).toEqual({ width: 3000, height: 1080 - SHELF });
      expect(fitPlacedWindow({ x: 2000, y: 0, width: 2400, height: 5000 })).toEqual({ width: 2400, height: 1440 });
    });

    it("never squeezes below the window minimums", () => {
      setViewport(400, 300);
      setDeskScreens([scr("a", 0, 0, 200, 150, true), scr("b", 200, 0, 200, 150)]);
      expect(fitPlacedWindow({ x: 0, y: 0, width: 800, height: 600 })).toEqual({ width: 400, height: MIN_WINDOW_HEIGHT });
      expect(fitPlacedWindow({ x: 0, y: 0, width: 100, height: 100 })).toEqual({ width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
    });
  });

  describe("dockedChatMaxWidth", () => {
    it("is 60% of the main monitor, not of the whole row", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(dockedChatMaxWidth()).toBe(MON_W * 0.6);
      setViewport(4480, 1440);
      setDeskScreens([scr("big", 0, 0, 2560, 1440), scr("small", 2560, 0, 1920, 1080, true)]);
      expect(dockedChatMaxWidth()).toBe(1920 * 0.6);
    });

    it("leaves the main monitor's work area wider than nothing at the cap", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      expect(workArea(ROW_MAIN_LEFT[0], dockedChatMaxWidth() + DESKTOP_GAP).width).toBeGreaterThan(MON_W / 3);
    });
  });

  describe("clampFloatingRect", () => {
    const chat = { width: 520, height: 700 };

    it("keeps the floating chat out of the dead strip under a shorter monitor", () => {
      setViewport(4480, 1440);
      setDeskScreens(MIXED);
      // On the 1080 main monitor: its bottom is that monitor's, not the row's.
      expect(clampFloatingRect({ x: 100, y: 900, ...chat }, 8)).toEqual({ x: 100, y: 1080 - 700 - 8 });
      // On the tall one the same drop is fine as far as ITS floor.
      expect(clampFloatingRect({ x: 3000, y: 900, ...chat }, 8)).toEqual({ x: 3000, y: 1440 - 700 - 8 });
      expect(clampFloatingRect({ x: 3000, y: 500, ...chat }, 8)).toEqual({ x: 3000, y: 500 });
    });

    it("moves along the whole row and keeps its header below the kiosk bar on the main monitor only", () => {
      setDeskScreens(ROW_MAIN_LEFT);
      setBar(40);
      expect(clampFloatingRect({ x: 9000, y: 100, ...chat }, 8).x).toBe(2 * MON_W - chat.width - 8);
      expect(clampFloatingRect({ x: 100, y: 0, ...chat }, 8).y).toBe(40 + 8);
      expect(clampFloatingRect({ x: 3000, y: 0, ...chat }, 8).y).toBe(8);
    });

    it("lands at the top gutter when taller than its monitor", () => {
      setViewport(4480, 1440);
      setDeskScreens(MIXED);
      expect(clampFloatingRect({ x: 100, y: 600, width: 520, height: 1300 }, 8).y).toBe(8);
    });
  });

  it("returns to the one-screen answers the moment the layout goes away", () => {
    setDeskScreens(ROW_MAIN_LEFT);
    expect(getSnapZone(MON_W + 5, 700)).toBeNull();
    setDeskScreens(null);
    // The viewport is the whole row now: x = 2565 is open space, 5115 the right edge.
    expect(getSnapRect("left", 0, { x: 3000, y: 700 })).toEqual(old.getSnapRect("left", 0));
    expect(maximizedRect(0, { x: 3000, y: 700 })).toEqual(old.maximized(0));
    expect(getSnapZone(2 * MON_W - 5, MON_H - SHELF - 1)).toBe("bottom-right");
  });
});
