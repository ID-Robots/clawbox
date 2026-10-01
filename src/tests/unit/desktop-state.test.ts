/**
 * The desktop's saved windows (TASK-1306, src/lib/desktop-state.ts and
 * desktop-state-client.ts): what a refresh brings back, how it is kept on a
 * smaller screen, and which copy — the device's or this browser's — wins.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_STATE_VERSION,
  MAX_SAVED_WINDOWS,
  MAX_TERMINAL_TABS,
  clampRectToViewport,
  desktopLayoutKey,
  pickDesktopState,
  restoreDesktopWindows,
  sanitizeDesktopState,
  snapshotDesktop,
  stateFromLegacyWindows,
  type DesktopState,
  type DesktopWindowRecord,
} from "@/lib/desktop-state";
import {
  DESKTOP_STATE_URL,
  createDesktopStateSaver,
  loadDesktopState,
  readLocalDesktopState,
} from "@/lib/desktop-state-client";

const SESSION_A = "11111111-2222-4333-8444-555555555555";
const SESSION_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";

const desk: DesktopWindowRecord[] = [
  { id: "files-1", appId: "files", zIndex: 105, minimized: false, x: 40, y: 60, width: 700, height: 500, meta: { path: "projects" } },
  {
    id: "terminal-1", appId: "terminal", zIndex: 103, minimized: false, x: 300, y: 80, width: 820, height: 520,
    terminal: { tabs: [{ id: 1, session: SESSION_A }, { id: 3, title: "backup", session: SESSION_B }], activeId: 3, nextId: 4 },
  },
  { id: "terminal-2", appId: "terminal", zIndex: 101, minimized: false, maximized: true, x: 10, y: 10, width: 640, height: 400, restore: { x: 10, y: 10, width: 640, height: 400 } },
  { id: "settings-1", appId: "settings", zIndex: 107, minimized: true, x: 5, y: 5, width: 600, height: 400 },
  { id: "setup-1", appId: "setup", zIndex: 108, minimized: false },
];

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

describe("snapshotDesktop", () => {
  it("saves the windows bottom to top, the focused one, and never the setup wizard", () => {
    const state = snapshotDesktop(desk, { savedAt: 42, viewport: { width: 1600, height: 900 } });
    expect(state.v).toBe(DESKTOP_STATE_VERSION);
    expect(state.windows.map((w) => w.id)).toEqual(["terminal-2", "terminal-1", "files-1", "settings-1"]);
    // Settings is on top but minimized: the focus is the top window that is showing.
    expect(state.focusedId).toBe("files-1");
    expect(state.viewport).toEqual({ width: 1600, height: 900 });
    expect(state.windows[0]).toMatchObject({ maximized: true, restore: { x: 10, y: 10, width: 640, height: 400 } });
    expect(state.windows[1].terminal).toEqual(desk[1].terminal);
    expect(state.windows[2].meta).toEqual({ path: "projects" });
  });

  it("has no focus when every window is minimized", () => {
    const state = snapshotDesktop([{ id: "a-1", appId: "files", zIndex: 100, minimized: true }], { savedAt: 1 });
    expect(state.focusedId).toBeNull();
  });
});

describe("restoreDesktopWindows", () => {
  it("brings back the same windows, order, geometry, modes and terminal sessions", () => {
    const saved = snapshotDesktop(desk, { savedAt: 1, viewport: { width: 1600, height: 900 } });
    const restored = restoreDesktopWindows(saved, { viewport: { width: 1600, height: 900, shelf: 56 } });
    expect(restored.map((w) => [w.id, w.zIndex])).toEqual([
      ["terminal-2", 100], ["terminal-1", 101], ["files-1", 102], ["settings-1", 103],
    ]);
    const byId = Object.fromEntries(restored.map((w) => [w.id, w]));
    expect(byId["files-1"]).toMatchObject({ x: 40, y: 60, width: 700, height: 500, minimized: false, meta: { path: "projects" } });
    expect(byId["settings-1"]).toMatchObject({ minimized: true });
    expect(byId["terminal-2"]).toMatchObject({ maximized: true, restore: { x: 10, y: 10, width: 640, height: 400 } });
    expect(byId["terminal-1"].terminal?.tabs.map((t) => t.session)).toEqual([SESSION_A, SESSION_B]);
    // A round trip keeps every window as it was, in the order it came back in.
    const again = snapshotDesktop(restored, { savedAt: 2, viewport: { width: 1600, height: 900 } });
    expect(again.windows.map((w) => w.id)).toEqual(restored.map((w) => w.id));
    expect(new Map(again.windows.map((w) => [w.id, w]))).toEqual(new Map(saved.windows.map((w) => [w.id, w])));
    expect(again.focusedId).toBe("files-1");
  });

  it("puts the focused window on top of the ones that are showing", () => {
    const saved = snapshotDesktop(desk, { savedAt: 1 });
    // A state that says the terminal had the focus while Files sat above it.
    const restored = restoreDesktopWindows({ ...saved, focusedId: "terminal-1" });
    expect(restored.map((w) => w.id)).toEqual(["terminal-2", "files-1", "terminal-1", "settings-1"]);
  });

  it("keeps every window inside a smaller screen than the one it was saved on", () => {
    const saved = snapshotDesktop(desk, { savedAt: 1 });
    const restored = restoreDesktopWindows(saved, { viewport: { width: 800, height: 600, shelf: 56 } });
    for (const w of restored) {
      if (w.x === undefined) continue;
      expect(w.x).toBeGreaterThanOrEqual(0);
      expect(w.y).toBeGreaterThanOrEqual(0);
      expect(w.x! + w.width!).toBeLessThanOrEqual(800);
      expect(w.height!).toBeLessThanOrEqual(600 - 56);
    }
    expect(restored.find((w) => w.id === "terminal-1")).toMatchObject({ x: 0, width: 800 });
  });

  it("leaves the layout as saved when asked not to clamp (a phone shows windows full screen)", () => {
    const saved = snapshotDesktop(desk, { savedAt: 1 });
    const restored = restoreDesktopWindows(saved, { viewport: { width: 390, height: 844, shelf: 56 }, clamp: false });
    expect(restored.find((w) => w.id === "terminal-1")).toMatchObject({ x: 300, width: 820 });
  });
});

describe("clampRectToViewport", () => {
  it.each([
    [{ x: 1500, y: 700, width: 600, height: 400 }, { x: 424, y: 508, width: 600, height: 400 }],
    [{ x: -50, y: -20, width: 300, height: 200 }, { x: 0, y: 0, width: 300, height: 200 }],
    [{ x: 10, y: 10, width: 3000, height: 2000 }, { x: 0, y: 10, width: 1024, height: 544 }],
  ])("keeps %o on a 1024×600 desktop as %o", (rect, expected) => {
    expect(clampRectToViewport(rect, { width: 1024, height: 600, shelf: 56 })).toEqual(expected);
  });

  it("never makes a window smaller than the minimum a screen can hold", () => {
    expect(clampRectToViewport({ x: 0, y: 0, width: 100, height: 50 }, { width: 1024, height: 600, shelf: 56 })).toMatchObject({ width: 300, height: 200 });
    expect(clampRectToViewport({ x: 0, y: 0, width: 900, height: 900 }, { width: 250, height: 200, shelf: 56 })).toMatchObject({ width: 250, height: 144 });
  });
});

describe("sanitizeDesktopState", () => {
  const good = snapshotDesktop(desk, { savedAt: 7, viewport: { width: 1600, height: 900 } });

  it("keeps a state it wrote itself as it is", () => {
    expect(sanitizeDesktopState(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it.each([null, 3, "x", [], {}, { v: 2, windows: [] }, { v: 1, windows: {} }])("refuses %o", (input) => {
    expect(sanitizeDesktopState(input)).toBeNull();
  });

  it("drops the windows that do not fit and keeps the rest", () => {
    const state = sanitizeDesktopState({
      v: 1,
      savedAt: 5,
      focusedId: "gone-1",
      windows: [
        { id: "ok-1", appId: "files", minimized: false, x: 1, y: 2, width: 300, height: 200 },
        { id: "ok-1", appId: "files", minimized: false },
        { id: "bad id/..", appId: "files" },
        { id: "setup-9", appId: "setup" },
        { id: "nan-1", appId: "files", x: Number.NaN, y: 3, width: Infinity, height: 1 },
        { id: "t-1", appId: "terminal", snapped: "sideways", restore: { x: 1, y: 1, width: 1, height: 1 },
          meta: { command: "htop", maximize: "true", "bad key": "x", n: 3 },
          terminal: { tabs: [{ id: 2, session: "../../x", title: "  " }, { id: 2 }, { id: 0 }, "x"], activeId: 9, nextId: 1 } },
        "nope",
      ],
    });
    expect(state?.windows.map((w) => w.id)).toEqual(["ok-1", "nan-1", "t-1"]);
    expect(state?.windows[1]).toEqual({ id: "nan-1", appId: "files", minimized: false });
    expect(state?.windows[2]).toEqual({ id: "t-1", appId: "terminal", minimized: false, meta: { command: "htop" }, terminal: { tabs: [{ id: 2 }], activeId: 2, nextId: 3 } });
    expect(state?.focusedId).toBeNull();
  });

  it("holds a state to its bounds", () => {
    const windows = Array.from({ length: MAX_SAVED_WINDOWS + 5 }, (_, i) => ({ id: `w-${i}`, appId: "files", minimized: false }));
    const tabs = Array.from({ length: MAX_TERMINAL_TABS + 3 }, (_, i) => ({ id: i + 1 }));
    const state = sanitizeDesktopState({ v: 1, savedAt: 1, windows: [{ id: "t", appId: "terminal", minimized: false, terminal: { tabs, activeId: 1, nextId: 99 } }, ...windows] });
    expect(state?.windows).toHaveLength(MAX_SAVED_WINDOWS);
    expect(state?.windows[0].terminal?.tabs).toHaveLength(MAX_TERMINAL_TABS);
  });
});

describe("pickDesktopState", () => {
  const older: DesktopState = { v: 1, savedAt: 100, windows: [], focusedId: null };
  const newer: DesktopState = { v: 1, savedAt: 200, windows: [], focusedId: null };

  it("prefers the device's copy — it follows the user to any browser", () => {
    expect(pickDesktopState({ reachable: true, state: older }, { state: newer, synced: true })).toEqual({ state: older, source: "device", resend: false });
  });

  it("restores this browser's copy when the last save never reached the device", () => {
    expect(pickDesktopState({ reachable: true, state: older }, { state: newer, synced: false })).toEqual({ state: newer, source: "local", resend: true });
    expect(pickDesktopState({ reachable: true, state: null }, { state: older, synced: false })).toMatchObject({ source: "local" });
  });

  it("falls back to this browser's copy when the device store is unreachable", () => {
    expect(pickDesktopState({ reachable: false }, { state: older, synced: true })).toMatchObject({ state: older, source: "local" });
    expect(pickDesktopState({ reachable: false }, null)).toEqual({ state: null, source: "none", resend: false });
  });

  it("has nothing to restore when neither has anything", () => {
    expect(pickDesktopState({ reachable: true, state: null }, null)).toEqual({ state: null, source: "none", resend: false });
  });
});

describe("stateFromLegacyWindows", () => {
  it("brings an old desktop_open_windows workspace back minimized, as it always came back", () => {
    const state = stateFromLegacyWindows([
      { appId: "files", minimized: false, x: 10, y: 20, width: 600, height: 400 },
      { appId: "setup", minimized: false },
      { appId: "terminal", minimized: true },
    ]);
    expect(state?.windows).toEqual([
      { id: "files-legacy-0", appId: "files", minimized: true, x: 10, y: 20, width: 600, height: 400 },
      { id: "terminal-legacy-2", appId: "terminal", minimized: true },
    ]);
  });

  it.each([undefined, null, "x", [], [{ appId: "setup" }]])("has nothing for %o", (value) => {
    expect(stateFromLegacyWindows(value)).toBeNull();
  });
});

describe("loadDesktopState", () => {
  const deviceState = snapshotDesktop(desk.slice(0, 1), { savedAt: 500 });
  const localState = snapshotDesktop(desk.slice(1, 2), { savedAt: 900 });

  it("restores the device's copy for the user it names", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ user: "owner", state: deviceState })));
    const whoAmI = vi.fn(async () => "never-asked");
    const loaded = await loadDesktopState({ fetchImpl, whoAmI, storage: memoryStorage() });
    expect(fetchImpl).toHaveBeenCalledWith(DESKTOP_STATE_URL, expect.objectContaining({ cache: "no-store" }));
    expect(loaded).toEqual({ user: "owner", state: deviceState, source: "device", resend: false });
    expect(whoAmI).not.toHaveBeenCalled();
  });

  it("falls back to this browser's copy, under the user's own name, when the device store fails", async () => {
    const storage = memoryStorage();
    storage.setItem("clawbox:desktop-state:v1:alice", JSON.stringify({ state: localState, synced: true }));
    storage.setItem("clawbox:desktop-state:v1:bob", JSON.stringify({ state: deviceState, synced: false }));
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const loaded = await loadDesktopState({ fetchImpl, whoAmI: async () => "alice", storage });
    // Asked twice before giving up on the device.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Not resent on its own: the device could not be reached, and the next change sends it.
    expect(loaded).toEqual({ user: "alice", state: localState, source: "local", resend: false });
  });

  it("keeps nothing locally and restores nothing when nobody can say whose desktop it is", async () => {
    const loaded = await loadDesktopState({
      fetchImpl: async () => { throw new TypeError("network"); },
      whoAmI: async () => null,
      storage: memoryStorage(),
    });
    expect(loaded).toEqual({ user: null, state: null, source: "none", resend: false });
  });

  it("asks the device again when the first request fails", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("reset"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: "owner", state: deviceState })));
    const loaded = await loadDesktopState({ fetchImpl, whoAmI: async () => null, storage: memoryStorage() });
    expect(loaded).toMatchObject({ user: "owner", state: deviceState, source: "device" });
  });

  it("restores this browser's newer copy the device never got, and asks for it to be sent", async () => {
    const storage = memoryStorage();
    storage.setItem("clawbox:desktop-state:v1:owner", JSON.stringify({ state: localState, synced: false }));
    const loaded = await loadDesktopState({
      fetchImpl: async () => new Response(JSON.stringify({ user: "owner", state: deviceState })),
      whoAmI: async () => null,
      storage,
    });
    expect(loaded).toEqual({ user: "owner", state: localState, source: "local", resend: true });
  });
});

describe("desktopLayoutKey", () => {
  it("is the same for the same windows whenever and wherever the picture was taken", () => {
    const a = snapshotDesktop(desk, { savedAt: 1, viewport: { width: 1600, height: 900 } });
    const b = snapshotDesktop(desk, { savedAt: 99, viewport: { width: 800, height: 600 } });
    expect(desktopLayoutKey(a)).toBe(desktopLayoutKey(b));
    const moved = snapshotDesktop(desk.map((w) => (w.id === "files-1" ? { ...w, x: 41 } : w)), { savedAt: 1 });
    expect(desktopLayoutKey(moved)).not.toBe(desktopLayoutKey(a));
  });

  it("is unchanged by a restore, so loading a desktop saves nothing", () => {
    const saved = snapshotDesktop(desk, { savedAt: 1 });
    const restored = restoreDesktopWindows(saved, { viewport: { width: 1600, height: 900, shelf: 56 } });
    expect(desktopLayoutKey(snapshotDesktop(restored, { savedAt: 2 }))).toBe(desktopLayoutKey(saved));
  });
});

describe("createDesktopStateSaver", () => {
  it("keeps every change in this browser at once and sends the device the settled one", async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const bodies: unknown[] = [];
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      });
      const saver = createDesktopStateSaver({ user: "owner", storage, fetchImpl, delayMs: 100 });
      const first = snapshotDesktop(desk.slice(0, 1), { savedAt: 1 });
      const second = snapshotDesktop(desk.slice(0, 2), { savedAt: 2 });
      saver.save(first);
      saver.save(second);
      expect(readLocalDesktopState("owner", storage)).toEqual({ state: second, synced: false });
      expect(fetchImpl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "PUT", keepalive: false });
      expect(bodies).toEqual([{ state: second }]);
      expect(readLocalDesktopState("owner", storage)).toEqual({ state: second, synced: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends what is waiting as the page goes, as a request that outlives it", () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response("{}"));
    const saver = createDesktopStateSaver({ user: "owner", storage: memoryStorage(), fetchImpl, delayMs: 10_000 });
    saver.save(snapshotDesktop(desk.slice(0, 1), { savedAt: 3 }));
    saver.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "PUT", keepalive: true });
    saver.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("leaves this browser's copy unsynced when the device cannot be reached", async () => {
    const storage = memoryStorage();
    const saver = createDesktopStateSaver({ user: "owner", storage, fetchImpl: async () => { throw new TypeError("offline"); }, delayMs: 10_000 });
    const state = snapshotDesktop(desk.slice(0, 1), { savedAt: 4 });
    saver.save(state);
    saver.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(readLocalDesktopState("owner", storage)).toEqual({ state, synced: false });
  });

  it("sends nothing once disposed", () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const saver = createDesktopStateSaver({ user: null, storage: memoryStorage(), fetchImpl, delayMs: 10 });
    saver.dispose();
    saver.save(snapshotDesktop([], { savedAt: 5 }));
    saver.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
