import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { snapshotDesktop, type DesktopState } from "@/lib/desktop-state";

// TASK-1306: the desktop comes back as it was left, from the user's saved
// state on the device. Pinned here against the whole desktop: the windows are
// restored open (not on the shelf) with the focus where it was; a window whose
// app is no longer on this desktop — it was uninstalled while no desktop was
// open — neither takes the focus nor blanks the screen; and a load writes
// nothing back, so a desktop that came up without its state cannot overwrite
// the one the device holds.

vi.mock("@/components/Mascot", () => ({ default: () => null }));
vi.mock("@/components/ChatPopup", () => ({ default: () => null, CHAT_PANEL_GAP: 12, noticeColumnInset: () => 0 }));
vi.mock("@/components/TimezoneAdopter", () => ({ default: () => null }));
vi.mock("@/components/FilesApp", () => ({ default: () => <div data-testid="files-app-stub" /> }));
vi.mock("@/components/SettingsApp", () => ({ default: () => <div data-testid="settings-app-stub" /> }));

// Mounts the whole desktop shell per case — see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function answer(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
}

let saved: DesktopState | null = null;
/** What `/setup-api/preferences` answers: the saved icons, shelf pins and grid. */
let prefs: Record<string, unknown> = {};

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/desktop/state")) {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") return answer({ ok: true });
      return answer({ user: "clawbox", state: saved });
    }
    if (url.includes("/setup-api/preferences")) return answer((init?.method ?? "GET").toUpperCase() === "GET" ? prefs : { ok: true });
    if (url.includes("/setup-api/users/me")) return answer({ username: "clawbox", isOwner: true, multiUser: false });
    if (url.includes("/setup-api/setup/status")) return answer({ setup_complete: true });
    if (url.includes("/setup-api/harness/active")) return answer({ active: "openclaw", edition: "openclaw", activeKnown: true });
    return answer({});
  }));
}

const desktopPuts = () => vi.mocked(fetch).mock.calls.filter(([input, init]) =>
  String(input).includes("/setup-api/desktop/state") && (init?.method ?? "GET").toUpperCase() === "PUT");

beforeEach(() => {
  saved = null;
  prefs = {};
  resetHarnessCache();
  _resetSessionUserForTest();
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });
  installFetch();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a desktop restored from its saved state", () => {
  it("brings the windows back open, in place, with the focus where it was — and writes nothing back", async () => {
    saved = snapshotDesktop([
      { id: "settings-1", appId: "settings", zIndex: 100, minimized: false, x: 700, y: 80, width: 600, height: 420 },
      { id: "files-1", appId: "files", zIndex: 101, minimized: false, x: 40, y: 60, width: 640, height: 400 },
    ], { savedAt: 1 });
    render(<ChromeDesktop />);
    const files = await screen.findByTestId("chrome-window-files");
    expect(files).toHaveAttribute("data-window-id", "files-1");
    expect(files.style.left).toBe("40px");
    expect(files.style.width).toBe("640px");
    await waitFor(() => expect(files).toHaveAttribute("data-active", "true"));
    expect(screen.getByTestId("chrome-window-settings")).toHaveAttribute("data-active", "false");
    await wait(700);
    expect(desktopPuts()).toEqual([]);
  });

  it("gives the focus to the top window that is drawn, not to one whose app is gone", async () => {
    saved = snapshotDesktop([
      { id: "files-1", appId: "files", zIndex: 100, minimized: false, x: 40, y: 60, width: 640, height: 400 },
      // On top when it was saved; its app has since been uninstalled.
      { id: "installed-gone-1", appId: "installed-gone", zIndex: 101, minimized: false, x: 300, y: 100, width: 500, height: 400 },
    ], { savedAt: 1 });
    render(<ChromeDesktop />);
    const files = await screen.findByTestId("chrome-window-files");
    await waitFor(() => expect(files).toHaveAttribute("data-active", "true"));
    expect(document.querySelector('[data-window-id="installed-gone-1"]')).toBeNull();
  });

  // TASK-1556: the Projects app is gone. A box updated from a build that had
  // it may still hold its icon in the saved desktop list, its cell in the
  // grid, a shelf pin, and an open window on top of the rest.
  it("loads a layout that still holds the removed Projects app: its icon and window are simply not there", async () => {
    prefs = {
      desktop_apps: ["settings", "files", "projects"],
      icon_grid: { "desktop-settings": { row: 0, col: 0 }, "desktop-projects": { row: 1, col: 0 }, "desktop-files": { row: 2, col: 0 } },
      pinned_apps: { projects: true },
    };
    saved = snapshotDesktop([
      { id: "files-1", appId: "files", zIndex: 100, minimized: false, x: 40, y: 60, width: 640, height: 400 },
      { id: "projects-1", appId: "projects", zIndex: 101, minimized: false, x: 300, y: 100, width: 900, height: 620, meta: { place: "projects" } },
    ], { savedAt: 1 });
    const errors = vi.spyOn(console, "error");
    try {
      render(<ChromeDesktop />);
      const files = await screen.findByTestId("chrome-window-files");
      // The window that was under it takes the focus: nothing invisible holds it.
      await waitFor(() => expect(files).toHaveAttribute("data-active", "true"));
      await waitFor(() => expect(document.querySelector('[data-desktop-icon-id="desktop-files"]')).not.toBeNull());
      expect(document.querySelector('[data-desktop-icon-id="desktop-settings"]')).not.toBeNull();
      expect(document.querySelector('[data-desktop-icon-id="desktop-projects"]')).toBeNull();
      expect(document.querySelector('[data-window-id="projects-1"]')).toBeNull();
      expect(screen.queryByTestId("chrome-window-projects")).toBeNull();
      // No tile for it anywhere — not a label, not an untranslated key.
      expect(document.body.textContent ?? "").not.toMatch(/app\.projects/);
      const aboutProjects = errors.mock.calls.filter((args) => args.some((a) => String(a).toLowerCase().includes("projects")));
      expect(aboutProjects).toEqual([]);

      // Not held on to out of sight either: the next layout the desktop saves
      // carries no Projects window, so the saved state sheds it for good.
      within(files).getByRole("button", { name: "Close" }).click();
      await waitFor(() => expect(desktopPuts().length).toBeGreaterThan(0), { timeout: 3000 });
      const last = desktopPuts().at(-1)!;
      const body = JSON.parse(String(last[1]?.body)) as { state?: DesktopState };
      expect(body.state?.windows.map((w) => w.appId)).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
