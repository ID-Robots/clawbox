import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";

// The desktop is the whole shell, and this suite is about ONE handler in it.
// Mounting the mascot (a rAF walk loop) and the chat popup (6 500 lines, a
// gateway socket, a history round-trip) for every case made this file slow
// enough to starve the worker pool — four unrelated component files timed out
// beside it. Neither draws a wallpaper.
vi.mock("@/components/Mascot", () => ({ default: () => null }));
vi.mock("@/components/ChatPopup", () => ({
  default: () => null,
  CHAT_PANEL_GAP: 12,
  noticeColumnInset: () => 0,
}));

/**
 * Deleting a custom wallpaper must not change which one is on screen (TASK-719).
 *
 * `custom-<n>` is a POSITION in the saved list, so removing an entry renumbers
 * every entry after it. The delete handler only reset the selection when the
 * deleted one WAS the selected one; delete an earlier picture and the id the
 * desktop still held pointed one slot too far — off the end of the list in the
 * common case — and the desktop silently fell back to the default. The
 * customer's wallpaper changed because they deleted a different one.
 */

// Mounts the WHOLE desktop shell three times — every mount runs the preference
// load, the harness probe, the app grid and a full SettingsApp render before
// the case can click anything. Measured ~0.9 s per case idle here; on a
// four-worker runner that is several sub-5 s waits in series and vitest's
// default `testTimeout` fires. See src/tests/unit/test-timeout-hygiene.test.ts,
// which lists this file so the ceiling cannot quietly go away again.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const WP = [
  "data:image/png;base64,AAAA",
  "data:image/png;base64,BBBB",
  "data:image/png;base64,CCCC",
];

/** The saved `wp_id` the box answers with on mount. */
let savedWallpaperId = "custom-2";
/** Which harness the box reports — the fallback wallpaper follows it. */
let activeHarness = "openclaw";
/** Every preference body the desktop POSTed, in order. */
const saved: Record<string, unknown>[] = [];

/** A complete-enough `Response`: `ok`, `status`, `json` and `text`. */
function answer(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/preferences") && init?.method === "POST") {
      try { saved.push(JSON.parse(String(init.body)) as Record<string, unknown>); } catch { /* not ours */ }
      return answer({ ok: true });
    }
    if (url.includes("/setup-api/setup/status")) return answer({ setup_complete: true });
    if (url.includes("/setup-api/harness/active")) {
      return answer({ active: activeHarness, edition: activeHarness });
    }
    if (url.includes("/setup-api/preferences?all=1")) {
      return answer({ wp_id: savedWallpaperId, wp_opacity: 100 });
    }
    return answer({});
  }));
}

/** The most recent `wp_id` the desktop sent to the box. */
function lastSavedWallpaperId(): unknown {
  for (let i = saved.length - 1; i >= 0; i--) {
    if ("wp_id" in saved[i]) return saved[i].wp_id;
  }
  return undefined;
}

/** The desktop paints the wallpaper as a background-image on a full-bleed div. */
function wallpaperUrls(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("div[style*='background-image']"))
    .map((el) => el.style.backgroundImage);
}

async function mountDesktop(expected: string) {
  render(<ChromeDesktop />);
  await waitFor(() => expect(screen.getByTestId("desktop-root")).toBeTruthy());
  await waitFor(() => expect(wallpaperUrls().some((u) => u.includes(expected))).toBe(true));
}

async function openAppearanceSettings() {
  fireEvent.contextMenu(screen.getByTestId("desktop-surface"));
  const menu = await screen.findByTestId("desktop-context-menu");
  const settings = Array.from(menu.querySelectorAll("button"))
    .find((b) => /settings/i.test(b.textContent || ""));
  expect(settings).toBeTruthy();
  fireEvent.click(settings!);
  fireEvent.click(await screen.findByRole("button", { name: /appearance/i }));
}

describe("deleting a custom wallpaper", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(WP));
    savedWallpaperId = "custom-2";
    activeHarness = "openclaw";
    saved.length = 0;
    resetHarnessCache();
    // jsdom does not implement it at all, so `vi.spyOn` cannot be used and
    // `restoreMocks` has nothing to restore — put it back by hand below.
    Element.prototype.scrollIntoView = vi.fn();
    // The shared `matchMedia` from `src/tests/setup.ts` is a `vi.fn()`, and
    // `mockReset: true` (vitest.config.ts) empties every mock's implementation
    // after each test — so from the SECOND case in any file it answers
    // `undefined` and the mascot's reduced-motion effect throws on `.matches`.
    // A plain function has no implementation to reset.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      }),
    });
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHarnessCache();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    window.localStorage.clear();
  });

  it("keeps the picture the owner is actually looking at", async () => {
    await mountDesktop(WP[2]);

    await openAppearanceSettings();
    fireEvent.click(await screen.findByRole("button", { name: /Remove custom 1/i }));

    // It is now Custom 2 of two, but it is the same picture.
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem("clawbox-custom-wallpapers") || "[]"))
        .toEqual([WP[1], WP[2]]);
    });
    expect(wallpaperUrls().some((u) => u.includes(WP[2]))).toBe(true);
    // And the box hears about it — the selection is SQLite-backed, so a
    // re-index that never left the tab would come back wrong on the next boot.
    await waitFor(() => expect(lastSavedWallpaperId()).toBe("custom-1"));
  });

  it("falls back to the HERMES art on a Hermes box", async () => {
    // A shared surface has to be right on both editions: the mount path
    // deliberately opens a Hermes box on the Hermes wallpaper, and deleting
    // the picture in use must land on the same one.
    activeHarness = "hermes";
    await mountDesktop(WP[2]);

    await openAppearanceSettings();
    fireEvent.click(await screen.findByRole("button", { name: /Remove custom 3/i }));

    await waitFor(() => expect(wallpaperUrls().some((u) => u.includes("hermes-wallpaper"))).toBe(true));
    expect(wallpaperUrls().some((u) => u.includes("clawbox-wallpaper"))).toBe(false);
  });

  it("heals a selection this browser's list can no longer answer", async () => {
    // What a delete on the OWNER'S LAPTOP leaves on the box's own screen, and
    // what every box that hit this bug before the fix is still holding: the
    // box-wide `wp_id` names a slot past the end of this browser's list.
    window.localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify([WP[0]]));
    savedWallpaperId = "custom-2";
    render(<ChromeDesktop />);
    await waitFor(() => expect(screen.getByTestId("desktop-root")).toBeTruthy());

    // Repaired rather than left dangling — and the repair is persisted, so it
    // is not re-done on every load and Settings stops claiming "Custom 3".
    await waitFor(() => expect(lastSavedWallpaperId()).toBe("clawbox"));
    expect(wallpaperUrls().some((u) => u.includes("clawbox-wallpaper"))).toBe(true);
  });
});
