import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { translations } from "@/lib/translations";

// The whole settings app mounts here — every panel and every status fetch.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// A German box, resolved out of the shipped catalogue rather than a fixture:
// the point of the fix is that these names come from the SAME table as the
// copy around them, so a key that never reached `de` must fail here.
vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "de",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let value = translations.de[key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) value = value.replaceAll(`{${k}}`, String(v));
      return value;
    },
  }),
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/components/TelegramConfiguringOverlay", () => ({ default: () => null }));

const defaultUi: UISettings = {
  wallpaperId: "default",
  wpFit: "fill",
  wpBgColor: "#000000",
  wpOpacity: 100,
  mascotHidden: false,
  wallpapers: [{ id: "default", name: "Default" }],
  customWallpapers: ["data:image/png;base64,AA=="],
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
 * The names that stayed English on a German box after the rest of Settings had
 * been translated: an uploaded wallpaper called itself "Custom 1", its delete
 * button "Remove Custom 1", and the two saved-network icon buttons carried
 * `title="Edit password"` / `title="Forget"` with English aria-labels built
 * from template literals. They were the last hardcoded accessible names in
 * this file, and a screen reader reading a German page hit them mid-sentence.
 */
describe("Settings names every control in the UI language", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
      const url = String(input ?? "");
      if (url === "/setup-api/wifi/saved") {
        return jsonResponse({ profiles: [{ name: "Heimnetz", priority: 0, device: null }] });
      }
      if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
      if (url === "/setup-api/system/hotspot") return jsonResponse({ enabled: false, ssid: "ClawBox-Setup" });
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url === "/setup-api/ai-models/status") return jsonResponse({ connected: false, provider: null, providerLabel: null, mode: null, model: null });
      if (url === "/setup-api/providers/status") return jsonResponse({ harness: "openclaw", defaultProvider: null, degraded: false, providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      return jsonResponse({});
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("names an uploaded wallpaper and its delete button in German", () => {
    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(translations.de["settings.appearance"]) }));

    expect(screen.getByRole("button", { name: "Eigenes 1" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Eigenes 1 entfernen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Custom 1/ })).toBeNull();
  });

  it("keeps the Material ligature out of the upload tile's name", () => {
    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(translations.de["settings.appearance"]) }));

    expect(screen.getByRole("button", { name: translations.de["settings.upload"] })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add_photo_alternate/ })).toBeNull();
  });

  it("names the background-colour swatch, which had no label of its own", () => {
    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(translations.de["settings.appearance"]) }));

    expect(screen.getByLabelText(translations.de["settings.bgColor"])).toHaveAttribute("type", "color");
  });

  it("names the saved-network buttons in German, each after its network", async () => {
    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(translations.de["settings.network"]) }));

    const edit = await screen.findByRole("button", { name: "Passwort für Heimnetz ändern" });
    expect(edit).toHaveAttribute("title", "Passwort ändern");
    const forget = screen.getByRole("button", { name: "Heimnetz entfernen" });
    expect(forget).toHaveAttribute("title", "Entfernen");
    expect(screen.queryByTitle("Forget")).toBeNull();
    expect(screen.queryByTitle("Edit password")).toBeNull();
  });
});
