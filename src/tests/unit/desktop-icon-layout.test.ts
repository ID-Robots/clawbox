import { describe, it, expect } from "vitest";
import {
  assignSlots,
  isDense,
  layoutIcons,
  layoutsEqual,
  moveIcon,
  readSequence,
  slotIndex,
  storageGeometry,
  type IconLayout,
  type LayoutGeometry,
} from "@/lib/desktop-icon-layout";

// A ClawBox desktop: two store-installed apps followed by the built-in
// shortcuts in the order they are declared in src/app/page.tsx.
const CANONICAL = [
  "notes",
  "weather",
  "desktop-settings",
  "desktop-clawbox",
  "desktop-openclaw",
  "desktop-hermes",
  "desktop-terminal",
  "desktop-files",
  "desktop-clawkeep",
  "desktop-system_update",
  "desktop-store",
  "desktop-browser",
  "desktop-vnc",
  "desktop-hermes-skills",
];

/** A 1920x855 desktop window: 19 columns of 100px, 7 rows of 110px. */
const DESKTOP: LayoutGeometry = { flow: "column", cols: 19, rowsPerColumn: 7 };
/** A 430x850 phone: 5 columns of 85px. */
const MOBILE: LayoutGeometry = { flow: "row", cols: 5, rowsPerColumn: 7 };

/** Read a layout back as a plain ordered id list, for readable assertions. */
function order(layout: IconLayout, geometry: LayoutGeometry): string[] {
  return Object.keys(layout).sort((a, b) => slotIndex(layout[a], geometry) - slotIndex(layout[b], geometry));
}

describe("assignSlots", () => {
  it("fills a desktop column-by-column and wraps at rowsPerColumn", () => {
    const layout = assignSlots(["a", "b", "c", "d", "e"], { flow: "column", cols: 10, rowsPerColumn: 3 });
    expect(layout).toEqual({
      a: { row: 0, col: 0 },
      b: { row: 1, col: 0 },
      c: { row: 2, col: 0 },
      d: { row: 0, col: 1 },
      e: { row: 1, col: 1 },
    });
  });

  it("fills a narrow viewport row-by-row", () => {
    const layout = assignSlots(["a", "b", "c", "d", "e"], { flow: "row", cols: 3, rowsPerColumn: 7 });
    expect(layout).toEqual({
      a: { row: 0, col: 0 },
      b: { row: 0, col: 1 },
      c: { row: 0, col: 2 },
      d: { row: 1, col: 0 },
      e: { row: 1, col: 1 },
    });
  });

  it("keeps overflowing icons in the last column instead of dropping them", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const geometry: LayoutGeometry = { flow: "column", cols: 2, rowsPerColumn: 2 };
    const layout = assignSlots(ids, geometry);
    expect(Object.keys(layout)).toHaveLength(ids.length);
    // The last column runs long rather than losing "e" off the edge.
    expect(layout.e).toEqual({ row: 2, col: 1 });
    expect(isDense(layout, geometry)).toBe(true);
  });

  it("survives a degenerate geometry instead of producing NaN cells", () => {
    const layout = assignSlots(["a", "b"], { flow: "column", cols: 0, rowsPerColumn: 0 });
    expect(layout).toEqual({ a: { row: 0, col: 0 }, b: { row: 1, col: 0 } });
  });
});

describe("unpositioned icons", () => {
  // The reported symptom: the desktop came up in a different order on every
  // load. Every unplaced icon used to get the same {row:999,col:999} sentinel,
  // so their relative order fell through to array order — and the arrays are
  // built from two independent fetches (preferences and the active harness)
  // that resolve in a different order each load.
  it("are ordered canonically, not by the order the ids arrive in", () => {
    const ids = ["desktop-files", "notes", "desktop-settings", "desktop-terminal"];
    const shuffled = ["desktop-terminal", "desktop-settings", "notes", "desktop-files"];

    const a = layoutIcons(ids, {}, DESKTOP, CANONICAL);
    const b = layoutIcons(shuffled, {}, DESKTOP, CANONICAL);

    expect(a).toEqual(b);
    expect(order(a, DESKTOP)).toEqual(["notes", "desktop-settings", "desktop-terminal", "desktop-files"]);
  });

  it("are deterministic even for ids missing from the canonical order", () => {
    const a = layoutIcons(["zeta", "alpha", "desktop-settings"], {}, DESKTOP, CANONICAL);
    const b = layoutIcons(["alpha", "desktop-settings", "zeta"], {}, DESKTOP, CANONICAL);
    expect(a).toEqual(b);
    expect(order(a, DESKTOP)).toEqual(["desktop-settings", "alpha", "zeta"]);
  });

  it("append after the icons that already have a slot", () => {
    const saved: IconLayout = { "desktop-files": { row: 0, col: 0 }, "desktop-terminal": { row: 1, col: 0 } };
    const layout = layoutIcons(["desktop-settings", "desktop-files", "desktop-terminal"], saved, DESKTOP, CANONICAL);
    expect(order(layout, DESKTOP)).toEqual(["desktop-files", "desktop-terminal", "desktop-settings"]);
  });
});

describe("density", () => {
  // The other half of the report: gaps between icons. A saved layout whose ids
  // matched the drawn set exactly used to be passed through verbatim, so a hole
  // left behind by a drag was permanent.
  it("closes gaps in a saved layout", () => {
    const saved: IconLayout = {
      "desktop-settings": { row: 0, col: 0 },
      "desktop-terminal": { row: 1, col: 0 },
      // row 2 empty — the icon that lived here was dragged away
      "desktop-files": { row: 3, col: 0 },
      // col 1 row 0 empty
      "desktop-browser": { row: 1, col: 1 },
    };
    const ids = Object.keys(saved);
    const layout = layoutIcons(ids, saved, DESKTOP, CANONICAL);

    expect(isDense(layout, DESKTOP)).toBe(true);
    expect(order(layout, DESKTOP)).toEqual([
      "desktop-settings",
      "desktop-terminal",
      "desktop-files",
      "desktop-browser",
    ]);
  });

  it("closes the gaps left by ids that are no longer drawn", () => {
    // A Hermes box: the OpenClaw-only shortcuts still have saved slots but are
    // never rendered, so their cells used to render as holes mid-column.
    const saved: IconLayout = {
      "desktop-settings": { row: 0, col: 0 },
      "desktop-openclaw": { row: 1, col: 0 },
      "desktop-terminal": { row: 2, col: 0 },
      "desktop-store": { row: 3, col: 0 },
      "desktop-files": { row: 4, col: 0 },
    };
    const drawn = ["desktop-settings", "desktop-terminal", "desktop-files"];

    const layout = layoutIcons(drawn, saved, DESKTOP, CANONICAL);

    expect(Object.keys(layout).sort()).toEqual([...drawn].sort());
    expect(isDense(layout, DESKTOP)).toBe(true);
    expect(order(layout, DESKTOP)).toEqual(drawn);
  });

  it("reproduces the reported layout and repairs it", () => {
    // Taken off the device: 10 drawn icons, two holes, columns not aligned to
    // the same rows — the exact shape in the bug report.
    const saved: IconLayout = {
      "desktop-settings": { row: 0, col: 0 },
      "desktop-terminal": { row: 1, col: 0 },
      "desktop-system_update": { row: 2, col: 0 },
      "desktop-clawbox": { row: 3, col: 0 },
      "desktop-files": { row: 4, col: 0 },
      // (5, 0) is a hole
      "desktop-clawkeep": { row: 6, col: 0 },
      // (0, 1) is a hole
      "desktop-browser": { row: 1, col: 1 },
      "desktop-vnc": { row: 2, col: 1 },
      "desktop-hermes": { row: 3, col: 1 },
      "desktop-hermes-skills": { row: 4, col: 1 },
    };
    const drawn = Object.keys(saved);

    const layout = layoutIcons(drawn, saved, DESKTOP, CANONICAL);

    expect(isDense(layout, DESKTOP)).toBe(true);
    // Reading order is preserved; the icons simply close up.
    expect(order(layout, DESKTOP)).toEqual([
      "desktop-settings",
      "desktop-terminal",
      "desktop-system_update",
      "desktop-clawbox",
      "desktop-files",
      "desktop-clawkeep",
      "desktop-browser",
      "desktop-vnc",
      "desktop-hermes",
      "desktop-hermes-skills",
    ]);
    expect(layout["desktop-clawkeep"]).toEqual({ row: 5, col: 0 });
    expect(layout["desktop-browser"]).toEqual({ row: 6, col: 0 });
  });

  it("stays dense at every viewport width and height", () => {
    const ids = CANONICAL.slice(0, 12);
    const geometries: LayoutGeometry[] = [
      { flow: "column", cols: 19, rowsPerColumn: 7 },
      { flow: "column", cols: 8, rowsPerColumn: 6 },
      { flow: "column", cols: 3, rowsPerColumn: 1 },
      { flow: "row", cols: 5, rowsPerColumn: 7 },
      { flow: "row", cols: 3, rowsPerColumn: 2 },
    ];
    for (const geometry of geometries) {
      const layout = layoutIcons(ids, {}, geometry, CANONICAL);
      expect(Object.keys(layout)).toHaveLength(ids.length);
      expect(isDense(layout, geometry)).toBe(true);
    }
  });
});

describe("stability across loads", () => {
  // The root cause: the old code read the saved layout ROW-major and wrote it
  // back COLUMN-major. That is a permutation, so every re-arrange reshuffled
  // the desktop — and a re-arrange runs on nearly every load, because the
  // active harness resolves after the first paint and briefly hides two icons.
  it("is idempotent — re-running the layout changes nothing", () => {
    const ids = CANONICAL.slice(0, 10);
    const first = layoutIcons(ids, {}, DESKTOP, CANONICAL);
    const second = layoutIcons(ids, first, DESKTOP, CANONICAL);
    const third = layoutIcons(ids, second, DESKTOP, CANONICAL);

    expect(layoutsEqual(first, second)).toBe(true);
    expect(layoutsEqual(second, third)).toBe(true);
  });

  it("survives icons being hidden and shown again, as the harness resolves", () => {
    const drawnEventually = CANONICAL.slice(0, 10);
    // Until /setup-api/harness/active answers, the desktop fails closed and
    // hides both harnesses' apps.
    const hiddenWhileUnresolved = ["desktop-openclaw", "desktop-hermes"];
    const drawnAtFirstPaint = drawnEventually.filter((id) => !hiddenWhileUnresolved.includes(id));

    // Load 1: fail-closed paint, then the harness resolves and the two return.
    const saved = layoutIcons(drawnEventually, {}, DESKTOP, CANONICAL);
    const failClosed = layoutIcons(drawnAtFirstPaint, saved, DESKTOP, CANONICAL);
    const resolved = layoutIcons(drawnEventually, failClosed, DESKTOP, CANONICAL);

    // Load 2: the same sequence again, starting from what load 1 persisted.
    const failClosed2 = layoutIcons(drawnAtFirstPaint, resolved, DESKTOP, CANONICAL);
    const resolved2 = layoutIcons(drawnEventually, failClosed2, DESKTOP, CANONICAL);

    expect(layoutsEqual(resolved, resolved2)).toBe(true);
    expect(isDense(resolved2, DESKTOP)).toBe(true);
  });

  it("does not depend on which of the two async fetches lands first", () => {
    const ids = CANONICAL.slice(0, 10);
    const saved = layoutIcons(ids, {}, DESKTOP, CANONICAL);
    const partial = ids.slice(0, 6);

    // Preferences land first: the saved layout is applied while the harness is
    // still unresolved, so only part of the set is drawn.
    const prefsFirst = layoutIcons(ids, layoutIcons(partial, saved, DESKTOP, CANONICAL), DESKTOP, CANONICAL);
    // Harness lands first: the full drawn set is known before the saved layout.
    const harnessFirst = layoutIcons(ids, saved, DESKTOP, CANONICAL);

    expect(layoutsEqual(prefsFirst, harnessFirst)).toBe(true);
  });
});

describe("reflow on viewport change", () => {
  it("keeps the order when only the window HEIGHT changes", () => {
    const ids = CANONICAL.slice(0, 10);
    const tallGeometry: LayoutGeometry = { flow: "column", cols: 19, rowsPerColumn: 9 };
    const shortGeometry: LayoutGeometry = { flow: "column", cols: 19, rowsPerColumn: 4 };

    const tall = layoutIcons(ids, {}, tallGeometry, CANONICAL);
    const reflowed = layoutIcons(ids, tall, shortGeometry, CANONICAL);

    expect(order(reflowed, shortGeometry)).toEqual(order(tall, tallGeometry));
    expect(isDense(reflowed, shortGeometry)).toBe(true);
    expect(reflowed[ids[4]]).toEqual({ row: 0, col: 1 });
  });

  it("carries the order from a wide desktop into a phone-width grid", () => {
    const ids = CANONICAL.slice(0, 8);
    const wide = layoutIcons(ids, {}, DESKTOP, CANONICAL);
    const narrow = layoutIcons(ids, wide, MOBILE, CANONICAL);

    expect(order(narrow, MOBILE)).toEqual(order(wide, DESKTOP));
    expect(isDense(narrow, MOBILE)).toBe(true);
  });

  it("round-trips through the phone layout without reordering", () => {
    // A phone DRAWS row-by-row but SAVES column-major, so going narrow and
    // back wide must be a no-op.
    const ids = CANONICAL.slice(0, 9);
    const wide = layoutIcons(ids, {}, storageGeometry(DESKTOP), CANONICAL);
    const savedOnPhone = layoutIcons(ids, wide, storageGeometry(MOBILE), CANONICAL);
    const backToWide = layoutIcons(ids, savedOnPhone, storageGeometry(DESKTOP), CANONICAL);

    expect(layoutsEqual(wide, backToWide)).toBe(true);
  });
});

describe("moveIcon", () => {
  const geometry: LayoutGeometry = { flow: "column", cols: 4, rowsPerColumn: 3 };

  it("puts the dragged icon where it was dropped and closes ranks", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const saved = assignSlots(ids, geometry); // col 0: a b c — col 1: d e

    const moved = moveIcon("e", { row: 0, col: 0 }, ids, saved, geometry, ids);

    expect(order(moved, geometry)).toEqual(["e", "a", "b", "c", "d"]);
    expect(isDense(moved, geometry)).toBe(true);
  });

  it("leaves no hole behind at the icon's old slot", () => {
    const tight: LayoutGeometry = { flow: "column", cols: 4, rowsPerColumn: 2 };
    const ids = ["a", "b", "c", "d"];
    const moved = moveIcon("a", { row: 1, col: 1 }, ids, assignSlots(ids, tight), tight, ids);

    expect(isDense(moved, tight)).toBe(true);
    expect(order(moved, tight)).toEqual(["b", "c", "a", "d"]);
  });

  it("clamps a drop past the end of the grid to the last position", () => {
    const tight: LayoutGeometry = { flow: "column", cols: 4, rowsPerColumn: 2 };
    const ids = ["a", "b", "c"];
    const moved = moveIcon("a", { row: 1, col: 3 }, ids, assignSlots(ids, tight), tight, ids);
    expect(order(moved, tight)).toEqual(["b", "c", "a"]);
  });

  it("keeps the manual order across a later reload", () => {
    const ids = ["a", "b", "c", "d"];
    const moved = moveIcon("d", { row: 0, col: 0 }, ids, assignSlots(ids, geometry), geometry, ids);
    const afterReload = layoutIcons(ids, moved, storageGeometry(geometry), ids);
    expect(layoutsEqual(moved, afterReload)).toBe(true);
  });

  it("saves a phone drag in the column encoding", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const phone: LayoutGeometry = { flow: "row", cols: 2, rowsPerColumn: 4 };
    const saved = layoutIcons(ids, {}, storageGeometry(phone), ids);

    // Drop "e" onto the top-left cell of the drawn (row-flow) grid.
    const moved = moveIcon("e", { row: 0, col: 0 }, ids, saved, phone, ids);

    expect(order(moved, storageGeometry(phone))).toEqual(["e", "a", "b", "c", "d"]);
    // And the drawn grid agrees with what was saved.
    expect(order(layoutIcons(ids, moved, phone, ids), phone)).toEqual(["e", "a", "b", "c", "d"]);
  });
});

describe("readSequence", () => {
  it("breaks duplicate slots deterministically", () => {
    const saved: IconLayout = {
      "desktop-files": { row: 0, col: 0 },
      "desktop-settings": { row: 0, col: 0 },
    };
    expect(readSequence(["desktop-files", "desktop-settings"], saved, CANONICAL)).toEqual([
      "desktop-settings",
      "desktop-files",
    ]);
  });

  it("treats a malformed saved slot as unplaced", () => {
    const saved = { "desktop-files": { row: NaN, col: 0 } } as unknown as IconLayout;
    const layout = layoutIcons(["desktop-settings", "desktop-files"], saved, DESKTOP, CANONICAL);
    expect(order(layout, DESKTOP)).toEqual(["desktop-settings", "desktop-files"]);
  });
});

describe("layoutsEqual", () => {
  it("compares slots, not object identity", () => {
    expect(layoutsEqual({ a: { row: 1, col: 2 } }, { a: { row: 1, col: 2 } })).toBe(true);
    expect(layoutsEqual({ a: { row: 1, col: 2 } }, { a: { row: 2, col: 1 } })).toBe(false);
    expect(layoutsEqual({ a: { row: 0, col: 0 } }, {})).toBe(false);
    expect(layoutsEqual({}, { a: { row: 0, col: 0 } })).toBe(false);
  });
});
