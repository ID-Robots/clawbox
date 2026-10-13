import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
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
 * The wallpaper Upload tile takes pictures only (2026-10-13 smoke test).
 *
 * `accept="image/*"` is a hint, and the picker's "All files" filter walks past
 * it: a text file was read into a `data:text/plain` URL, stored as a custom
 * wallpaper and selected, and the desktop painted a background image that never
 * loads over its black backing colour. Two rules are held here: a non-picture
 * is refused with a message and changes nothing, and a non-picture ALREADY in
 * the stored list paints the default instead of black.
 */

// Whole-desktop mounts, as in desktop-wallpaper-delete.test.tsx; listed in
// src/tests/unit/test-timeout-hygiene.test.ts for the same reason.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const WP = [
  "data:image/png;base64,AAAA",
  "data:image/png;base64,BBBB",
  "data:image/png;base64,CCCC",
];

const DECODABLE = "REAL-PICTURE";
const DECODABLE_URL = `data:image/png;base64,${btoa(DECODABLE)}`;

/** jsdom's `Image` never loads; this one answers the way a browser does. */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(value: string) {
    const ok = value.includes(btoa(DECODABLE)) || WP.includes(value);
    queueMicrotask(() => {
      if (ok) {
        this.naturalWidth = 4;
        this.naturalHeight = 4;
        this.onload?.();
      } else {
        this.onerror?.();
      }
    });
  }
}

function uploadInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("input[type='file'][accept='image/*']");
  expect(input).toBeTruthy();
  return input!;
}

function storedWallpapers(): string[] {
  return JSON.parse(window.localStorage.getItem("clawbox-custom-wallpapers") ?? "[]") as string[];
}

/** The saved `wp_id` the box answers with on mount. */
let savedWallpaperId = "custom-2";
/** Which harness the box reports — the fallback wallpaper follows it. */
let activeHarness = "openclaw";
/** The `wp_opacity` the box answers, or null for a box that holds none. */
let savedOpacity: number | null = 100;
/** Whether the device could actually RESOLVE its harness, or `active` is its own default. */
let activeKnown = true;
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
      return answer({ active: activeHarness, edition: activeHarness, activeKnown });
    }
    if (url.includes("/setup-api/preferences?all=1")) {
      return answer({ wp_id: savedWallpaperId, ...(savedOpacity === null ? {} : { wp_opacity: savedOpacity }) });
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
  // The catalogue is a lazy chunk; a refusal said before it lands would be the
  // raw key, which no owner can reach by hand that quickly.
  await import("@/lib/translations");
  await vi.dynamicImportSettled();
  await act(async () => {});
}

/**
 * Testing-library's implicit `findBy` budget is 1 s, which is not a load-safe
 * one HERE: every case mounts the whole desktop shell, so under the components
 * project's four workers the Settings window can take longer than that to paint
 * and the failure lands as "Unable to find role=button" on a case that is not
 * broken. The file's own `testTimeout` above is what actually bounds a hang.
 */
const PAINTS_SOON = { timeout: 8_000 };

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(WP));
  savedWallpaperId = "custom-2";
  savedOpacity = 100;
  activeHarness = "openclaw";
  activeKnown = true;
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
  vi.stubGlobal("Image", FakeImage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  window.localStorage.clear();
});

describe("uploading a wallpaper", () => {
  it("refuses a text file: says why, stores nothing and keeps the wallpaper", async () => {
    await mountDesktop(WP[2]);

    fireEvent.change(uploadInput(), {
      target: { files: [new File(["just a note"], "smoke-note.txt", { type: "text/plain" })] },
    });

    expect(await screen.findByText(/not a picture/i, {}, PAINTS_SOON)).toBeTruthy();
    expect(storedWallpapers()).toEqual(WP);
    expect(wallpaperUrls().some((u) => u.includes(WP[2]))).toBe(true);
    expect(wallpaperUrls().some((u) => u.includes("data:text/plain"))).toBe(false);
    // Well past the 500 ms debounce: the box-wide selection was not moved.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(lastSavedWallpaperId()).not.toBe("custom-3");
  });

  it("refuses a text file that only claims to be a picture", async () => {
    await mountDesktop(WP[2]);

    fireEvent.change(uploadInput(), {
      target: { files: [new File(["just a note"], "note.png", { type: "image/png" })] },
    });

    expect(await screen.findByText(/not a picture/i, {}, PAINTS_SOON)).toBeTruthy();
    expect(storedWallpapers()).toEqual(WP);
  });

  it("stores and selects a real picture", async () => {
    await mountDesktop(WP[2]);

    fireEvent.change(uploadInput(), {
      target: { files: [new File([DECODABLE], "photo.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(storedWallpapers()).toEqual([...WP, DECODABLE_URL]), PAINTS_SOON);
    await waitFor(() => expect(wallpaperUrls().some((u) => u.includes(DECODABLE_URL))).toBe(true), PAINTS_SOON);
    await waitFor(() => expect(lastSavedWallpaperId()).toBe("custom-3"), PAINTS_SOON);
  });
});

describe("a stored wallpaper that is not a picture", () => {
  it("paints the edition's default instead of a black desktop, and writes nothing", async () => {
    const NOTE = "data:text/plain;base64,anVzdCBhIG5vdGU=";
    window.localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify([WP[0], NOTE]));
    savedWallpaperId = "custom-1";
    activeHarness = "hermes";

    await mountDesktop("hermes-wallpaper");

    expect(wallpaperUrls().some((u) => u.includes("data:text/plain"))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 900));
    // Healed in the render only: the owner's saved selection is left alone.
    expect(lastSavedWallpaperId()).not.toBe("hermes");
    expect(storedWallpapers()).toEqual([WP[0], NOTE]);
  });

  it("paints the default when the stored picture does not decode", async () => {
    const BROKEN = "data:image/png;base64,bm90IGEgcGljdHVyZQ==";
    window.localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify([BROKEN]));
    savedWallpaperId = "custom-0";

    render(<ChromeDesktop />);
    await waitFor(() => expect(screen.getByTestId("desktop-root")).toBeTruthy());
    await waitFor(() => expect(wallpaperUrls().some((u) => u.includes("lobster-orbital-wallpaper"))).toBe(true), PAINTS_SOON);
    expect(wallpaperUrls().some((u) => u.includes(BROKEN))).toBe(false);
  });
});
