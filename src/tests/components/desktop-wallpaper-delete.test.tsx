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
/** Whether anything on the device actually NAMED an edition (the lock, or the env). */
let editionKnown = true;
/** Milliseconds the harness probe takes to answer, so a case can run inside the window where it has not. */
let harnessDelayMs = 0;
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
      if (harnessDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, harnessDelayMs));
      return answer({ active: activeHarness, edition: activeHarness, editionKnown });
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

/** The built-in wallpaper tiles the Appearance card offers, in order. */
function builtinWallpaperTiles(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-testid='wallpaper-tile']"))
    .map((el) => el.dataset.wallpaperId ?? "");
}

/**
 * Every reference to a BRAND wallpaper image anywhere on screen — the painted
 * background and the Appearance tiles both. The removed brand's picture must
 * not be fetched on the other edition either, and a tile is an `<img src>`
 * rather than a background-image, so the two are asked together.
 */
function deepSpacePainted(): boolean {
  return document.querySelector(".bg-stars") !== null;
}

function brandWallpaperAssets(): string[] {
  const painted = wallpaperUrls();
  const tiles = Array.from(document.querySelectorAll<HTMLImageElement>("img"))
    .map((el) => el.getAttribute("src") ?? "");
  return [...painted, ...tiles].filter((url) => url.includes("-wallpaper.jpeg"));
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

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(WP));
  savedWallpaperId = "custom-2";
  activeHarness = "openclaw";
  editionKnown = true;
  harnessDelayMs = 0;
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

describe("deleting a custom wallpaper", () => {
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

  it("never writes this browser's missing pictures back over the box's selection", async () => {
    // The box's own screen, or the owner's phone: `wp_id` is box-wide (SQLite)
    // and the pictures are per-browser `localStorage`, so a browser that never
    // uploaded anything cannot answer ANY `custom-<n>` — including the one the
    // owner's laptop chose and still resolves perfectly.
    //
    // Opening the desktop is not a statement about that selection. The
    // fallback below is what THIS browser paints; the box keeps what it holds.
    window.localStorage.removeItem("clawbox-custom-wallpapers");
    savedWallpaperId = "custom-2";
    await mountDesktop("clawbox-wallpaper");

    // Well past the 500 ms preference debounce.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(lastSavedWallpaperId()).not.toBe("clawbox");
    expect(saved.some((body) => "wp_id" in body && body.wp_id !== "custom-2")).toBe(false);
  });

  it("does not renumber a selection that is not this browser's to renumber", async () => {
    // The same cross-browser numbering, on the DELETE path. `wp_id` is
    // box-wide and the pictures are per-browser, so the laptop's `custom-5`
    // can arrive at a browser holding three of its own — and deleting one of
    // those three renumbers a list the saved id was never an index into. The
    // handler would have written `custom-4` over the laptop's choice, from a
    // list it has no standing to renumber, which is the very write the mount
    // path above refuses to make.
    savedWallpaperId = "custom-5";
    await mountDesktop("clawbox-wallpaper");

    await openAppearanceSettings();
    fireEvent.click(await screen.findByRole("button", { name: /Remove custom 1/i }));

    // This browser's own list did shrink — the delete is not being refused.
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem("clawbox-custom-wallpapers") || "[]"))
        .toEqual([WP[1], WP[2]]);
    });
    // Rendered locally, persisted nowhere: still the local fallback, and the
    // box still holds the selection it held. Well past the 500 ms debounce.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(wallpaperUrls().some((u) => u.includes("clawbox-wallpaper"))).toBe(true);
    expect(saved.some((body) => "wp_id" in body && body.wp_id !== "custom-5")).toBe(false);
  });

  it("paints the HERMES art for a selection this browser cannot answer", async () => {
    // Same browser, Hermes box. The local fallback follows the edition, and it
    // is still only a local fallback — nothing about it reaches the box.
    activeHarness = "hermes";
    window.localStorage.removeItem("clawbox-custom-wallpapers");
    savedWallpaperId = "custom-2";
    await mountDesktop("hermes-wallpaper");

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(wallpaperUrls().some((u) => u.includes("clawbox-wallpaper"))).toBe(false);
    expect(saved.some((body) => "wp_id" in body && body.wp_id !== "custom-2")).toBe(false);
  });

  it("does not select an UPLOAD it could not store", async () => {
    // The upload had the delete's bug the other way round: the list moved in
    // memory, the `setItem` failure was swallowed, and the box-wide `wp_id`
    // was then pointed at a slot the next load cannot paint — the owner's
    // wallpaper replaced, box-wide, by one that does not exist. Both writers
    // now go through the same store-first rule.
    await mountDesktop(WP[2]);
    saved.length = 0;

    const input = document.querySelector<HTMLInputElement>("input[type='file'][accept='image/*']");
    expect(input).toBeTruthy();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      fireEvent.change(input!, {
        target: { files: [new File([new Uint8Array([1, 2, 3])], "wp.png", { type: "image/png" })] },
      });
      await screen.findByText(/not letting the page store them/i);
    } finally {
      setItem.mockRestore();
    }

    // Nothing moved: not the stored list, not what is on screen, not the box.
    expect(JSON.parse(window.localStorage.getItem("clawbox-custom-wallpapers") || "[]")).toEqual(WP);
    expect(wallpaperUrls().some((u) => u.includes(WP[2]))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saved.some((body) => "wp_id" in body && body.wp_id !== "custom-2")).toBe(false);
  });

  it("shows no branding at all while the harness probe has not answered, and lands on the Hermes art", async () => {
    // The preferences call and the harness probe race, and until the probe
    // answers the desktop cannot know which edition's art the fallback is. The
    // repair this replaced ran in that window and PERSISTED "clawbox" — on a
    // Hermes box, box-wide and for good, since the later Hermes answer found a
    // selection already made. Nothing is written now, so the paint simply
    // catches up when the probe lands.
    //
    // And the paint inside that window is the NEUTRAL one. It used to be the
    // ClawBox art — a guess, shown as a fact, on a device that had not yet said
    // which product it is; on the Hermes box that is a competitor's picture
    // flickering across the customer's screen on every load.
    activeHarness = "hermes";
    harnessDelayMs = 900;
    window.localStorage.removeItem("clawbox-custom-wallpapers");
    savedWallpaperId = "custom-2";

    render(<ChromeDesktop />);
    await waitFor(() => expect(screen.getByTestId("desktop-root")).toBeTruthy());
    // Inside the window: the preferences have landed, the probe has not.
    await waitFor(() => expect(deepSpacePainted()).toBe(true));
    expect(brandWallpaperAssets()).toEqual([]);
    expect(saved.some((body) => "wp_id" in body && body.wp_id !== "custom-2")).toBe(false);

    // And once it does answer, the paint follows the edition.
    await waitFor(() => expect(wallpaperUrls().some((u) => u.includes("hermes-wallpaper"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saved.some((body) => "wp_id" in body && body.wp_id !== "custom-2")).toBe(false);
  });

  it("writes no edition fallback when the in-use picture is deleted before the probe answers", async () => {
    // The mount path already refuses to persist a fallback it cannot compute
    // ("writes nothing while the harness probe has not answered"). The DELETE
    // path is the sibling call site of the very same value, and it was writing
    // it: `activeHarness` is null until the probe lands and null reads as
    // OpenClaw, so deleting the wallpaper in use on a Hermes box whose probe is
    // slow — or has failed for good, after three attempts — persisted
    // "clawbox" box-wide. Permanent, and nothing to do with the edition.
    activeHarness = "hermes";
    harnessDelayMs = 3_000;
    savedWallpaperId = "custom-2";

    render(<ChromeDesktop />);
    await waitFor(() => expect(screen.getByTestId("desktop-root")).toBeTruthy());
    // Inside the window: preferences have landed, the probe has not.
    await waitFor(() => expect(wallpaperUrls().some((u) => u.includes(WP[2]))).toBe(true));

    await openAppearanceSettings();
    fireEvent.click(await screen.findByRole("button", { name: /Remove custom 3/i }));

    // The delete itself is not blocked — a local operation must not wait on a
    // remote probe. Only the box-wide guess is withheld.
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem("clawbox-custom-wallpapers") || "[]"))
        .toEqual([WP[0], WP[1]]);
    });
    // Well past the 500 ms debounce, still inside the probe delay.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saved.some((body) => "wp_id" in body && body.wp_id === "clawbox")).toBe(false);
    expect(saved.some((body) => "wp_id" in body && body.wp_id !== "custom-2")).toBe(false);
  });

  it("does not offer a phantom slot for a picture this browser does not have", async () => {
    // Settings used to claim "Custom 3" over a grid of none, with no tile
    // highlighted. The panel is handed what is ON SCREEN, so the fallback tile
    // is the selected one and the row names it.
    window.localStorage.removeItem("clawbox-custom-wallpapers");
    savedWallpaperId = "custom-2";
    await mountDesktop("clawbox-wallpaper");

    await openAppearanceSettings();
    const tile = await screen.findByRole("button", { name: /^ClawBox$/i });
    expect(tile.getAttribute("aria-pressed")).toBe("true");
  });
});

/**
 * The built-in list is EDITION-SCOPED (owner ruling 2026-09-06): the OpenClaw
 * edition offers ClawBox + Deep Space, the Hermes edition offers Hermes + Deep
 * Space, and the uploads are on both. The other edition's branding is not
 * something a customer can select, so it is not something the box ships.
 *
 * The edition is the device's own answer, and while nobody has given one the
 * neutral Deep Space is the whole list: painting a brand there is a coin flip,
 * and the wrong side of it is another product's artwork on the customer's
 * screen.
 */
describe("the built-in wallpapers this edition offers", () => {
  it("offers ClawBox and Deep Space on an OpenClaw box, and never the Hermes art", async () => {
    savedWallpaperId = "clawbox";
    await mountDesktop("clawbox-wallpaper");
    await openAppearanceSettings();

    // Not merely unselectable — not fetched. The tile is an <img src>, so a
    // tile for the other edition would still pull the other product's picture.
    expect(brandWallpaperAssets().some((url) => url.includes("hermes-wallpaper"))).toBe(false);
    expect(builtinWallpaperTiles()).toEqual(["clawbox", "deep-space"]);
  });

  it("offers Hermes and Deep Space on a Hermes box, and never the ClawBox art", async () => {
    activeHarness = "hermes";
    savedWallpaperId = "hermes";
    await mountDesktop("hermes-wallpaper");
    await openAppearanceSettings();

    expect(brandWallpaperAssets().some((url) => url.includes("clawbox-wallpaper"))).toBe(false);
    expect(builtinWallpaperTiles()).toEqual(["hermes", "deep-space"]);
  });

  it("offers only Deep Space while no edition could be read, and writes nothing", async () => {
    // The lock exists and says nothing this device could parse (a truncated
    // write, a permission change, a partial reflash), so `readEditionSource`
    // falls back to its own "openclaw" — which the route now reports as a
    // GUESS. Taking the guess would put ClawBox branding on a Hermes box.
    editionKnown = false;
    savedWallpaperId = "clawbox";
    render(<ChromeDesktop />);
    await waitFor(() => expect(screen.getByTestId("desktop-root")).toBeTruthy());
    await openAppearanceSettings();

    expect(brandWallpaperAssets()).toEqual([]);
    expect(builtinWallpaperTiles()).toEqual(["deep-space"]);
    // The neutral paint is a paint. The box keeps the value it holds — a
    // fallback this browser derived is never written back (TASK-719/#728).
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saved.some((body) => "wp_id" in body && body.wp_id !== "clawbox")).toBe(false);
  });

  it("heals a stored OTHER-edition brand to this one for the paint, and persists nothing", async () => {
    // A box re-imaged onto the other edition, or a `wp_id` chosen before this
    // ruling: the id names an art this edition does not ship. It resolves to
    // the local brand on screen and the stored value is left alone.
    savedWallpaperId = "hermes";
    await mountDesktop("clawbox-wallpaper");
    await openAppearanceSettings();

    expect(brandWallpaperAssets().some((url) => url.includes("hermes-wallpaper"))).toBe(false);
    expect(builtinWallpaperTiles()).toEqual(["clawbox", "deep-space"]);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saved.some((body) => "wp_id" in body && body.wp_id !== "hermes")).toBe(false);
  });
});
