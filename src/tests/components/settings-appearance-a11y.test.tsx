import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

// The whole settings app mounts here — every panel and every status fetch.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Keys stand in for copy, the way the neighbouring settings suites do it: this
// file is about the NAME a control exposes, not about which words fill it.
vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({ locale: "en", localeResolved: true, setLocale: () => {}, t: (key: string) => key }),
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/components/TelegramConfiguringOverlay", () => ({ default: () => null }));

const ui: UISettings = {
  wallpaperId: "hermes",
  wpFit: "fill",
  wpBgColor: "#000000",
  wpOpacity: 50,
  mascotHidden: false,
  wallpapers: [{ id: "hermes", name: "Hermes" }, { id: "deep-space", name: "Deep Space" }],
  customWallpapers: [],
  onWallpaperChange: vi.fn(),
  onWpFitChange: vi.fn(),
  onWpBgColorChange: vi.fn(),
  onWpOpacityChange: vi.fn(),
  onMascotToggle: vi.fn(),
  onWallpaperUpload: vi.fn(),
  onCustomWallpaperDelete: vi.fn(),
};

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

/**
 * Settings → Appearance and → Network, read the way a screen reader reads them.
 *
 * The sweep's aria snapshot of this page was: `button [pressed]` with no name
 * for the beta switch, `slider: "50"` for the opacity range, `button "Hermes
 * Hermes check"` for the selected wallpaper (the tick is a Material ligature,
 * which is TEXT, so it landed in the accessible name) and `button "zoom_out_map
 * fill"` for the fit picker — and the Show Mascot and hotspot switches came
 * through as unnamed buttons with no state at all, because their label is a
 * sibling <span> and `htmlFor` only binds to form controls.
 */
describe("Settings → Appearance and Network expose named, stateful controls", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
      const url = String(input ?? "");
      if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
      if (url === "/setup-api/system/hotspot") return jsonResponse({ enabled: true, ssid: "ClawBox-Setup" });
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url === "/setup-api/ai-models/status") return jsonResponse({ connected: false, provider: null, providerLabel: null, mode: null, model: null });
      if (url === "/setup-api/providers/status") return jsonResponse({ harness: "openclaw", defaultProvider: null, degraded: false, providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      return jsonResponse({});
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  function openAppearance() {
    render(<SettingsApp ui={ui} />);
    fireEvent.click(screen.getByRole("button", { name: /settings\.appearance/ }));
  }

  it("names the Show Mascot switch after its label and states whether it is on", () => {
    openAppearance();
    const toggle = screen.getByRole("switch", { name: "settings.showMascot" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("names the opacity slider", () => {
    openAppearance();
    expect(screen.getByRole("slider", { name: "settings.opacity" })).toHaveValue("50");
  });

  it("says which wallpaper is chosen without reading the tick glyph out", () => {
    openAppearance();
    const chosen = screen.getByRole("button", { name: "Hermes" });
    expect(chosen).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Deep Space" })).toHaveAttribute("aria-pressed", "false");
  });

  it("says which fit mode is chosen without reading the icon ligature out", () => {
    openAppearance();
    expect(screen.getByRole("button", { name: "settings.fill" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "settings.fit" })).toHaveAttribute("aria-pressed", "false");
  });

  it("names the hotspot switch and states whether it is broadcasting", async () => {
    render(<SettingsApp ui={ui} />);
    fireEvent.click(screen.getByRole("button", { name: /settings\.network/ }));
    const toggle = await screen.findByRole("switch", { name: "settings.hotspot" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});
