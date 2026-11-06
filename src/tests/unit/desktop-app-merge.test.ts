import { describe, it, expect } from "vitest";
import { mergeDesktopApps, knownSetChanged } from "@/lib/desktop-app-merge";

const builtIns = ["files", "chat", "openclaw", "settings", "vnc", "system_update"];
const defaults = ["files", "chat", "openclaw", "settings"];

/** One page load: the merge, then what the page writes back. */
function load(stored: { desktop_apps?: unknown; desktop_apps_known?: unknown }, shed: Set<string> | null = null) {
  const r = mergeDesktopApps({
    saved: stored.desktop_apps,
    known: stored.desktop_apps_known,
    builtIns,
    defaults,
    shed,
  });
  return { ...r, next: { desktop_apps: r.apps ?? [...defaults], desktop_apps_known: r.known } };
}

describe("mergeDesktopApps", () => {
  it("a fresh box shows the defaults and records them all as known", () => {
    const r = load({});
    expect(r.apps).toBeNull();
    expect(r.known).toEqual(defaults);
  });

  it("a removed built-in stays removed across reloads", () => {
    let stored: { desktop_apps?: unknown; desktop_apps_known?: unknown } = load({}).next;
    // The owner removes Chat from the desktop.
    stored = { ...stored, desktop_apps: ["files", "openclaw", "settings"] };
    for (let i = 0; i < 3; i++) {
      const r = load(stored);
      expect(r.apps).toEqual(["files", "openclaw", "settings"]);
      stored = r.next;
    }
  });

  it("a genuinely new built-in appears once, and stays removed if the owner removes it", () => {
    const withNew = [...defaults, "newapp"];
    const merge = (s: { desktop_apps: unknown; desktop_apps_known: unknown }) =>
      mergeDesktopApps({ saved: s.desktop_apps, known: s.desktop_apps_known, builtIns: [...builtIns, "newapp"], defaults: withNew, shed: null });
    const first = merge({ desktop_apps: ["files", "settings"], desktop_apps_known: defaults });
    expect(first.apps).toEqual(["files", "settings", "newapp"]);
    expect(first.known).toEqual(withNew);
    const second = merge({ desktop_apps: ["files", "settings"], desktop_apps_known: first.known });
    expect(second.apps).toEqual(["files", "settings"]);
  });

  it("migration: a saved list without a known set resurrects nothing it lacks", () => {
    const r = load({ desktop_apps: ["files", "settings"] });
    expect(r.apps).toEqual(["files", "settings"]);
    expect(r.known).toEqual(defaults);
    expect(load(r.next).apps).toEqual(["files", "settings"]);
  });

  it("keeps an off-by-default app the owner added, and never adds one unasked", () => {
    expect(load({ desktop_apps: ["files", "vnc"], desktop_apps_known: defaults }).apps).toEqual(["files", "vnc"]);
    expect(load({ desktop_apps: ["files"], desktop_apps_known: defaults }).apps).toEqual(["files"]);
  });

  it("drops ids that are not built-ins from both lists", () => {
    const r = load({ desktop_apps: ["files", "installed-x", 3], desktop_apps_known: [...defaults, "gone"] });
    expect(r.apps).toEqual(["files"]);
    expect(r.known).toEqual(defaults);
  });

  it("shed interplay: a shed id goes, and a shed default is not re-added", () => {
    const r = load({ desktop_apps: ["files", "chat", "vnc", "system_update"] }, new Set(["vnc", "system_update", "chat"]));
    expect(r.apps).toEqual(["files"]);
    // The shed is applied once; the next load (no shed) keeps it gone.
    expect(load(r.next).apps).toEqual(["files"]);
  });

  it("shed on a box that already has a known set still adds only new defaults", () => {
    const r = load({ desktop_apps: ["files", "vnc"], desktop_apps_known: ["files", "chat", "openclaw"] }, new Set(["vnc"]));
    expect(r.apps).toEqual(["files", "settings"]);
    expect(r.known).toEqual(defaults);
  });
});

describe("knownSetChanged", () => {
  it("is false only for the same list in the same order", () => {
    expect(knownSetChanged(undefined, defaults)).toBe(true);
    expect(knownSetChanged(["files"], defaults)).toBe(true);
    expect(knownSetChanged([...defaults], defaults)).toBe(false);
  });
});
