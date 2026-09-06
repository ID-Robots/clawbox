import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

// The whole settings app mounts here — every panel and every status fetch.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({ locale: "en", localeResolved: true, setLocale: () => {}, t: (key: string) => key }),
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
 * The trigger has always promised `aria-haspopup="listbox"`. What it opened was
 * a bare div of buttons that only a mouse could dismiss, so a screen reader was
 * sent looking for options that did not exist and a keyboard had no way out.
 */
describe("Settings → Appearance language picker", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
      const url = String(input ?? "");
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

  function openPicker() {
    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: /settings\.appearance/ }));
    const trigger = screen.getByRole("button", { name: /English/ });
    fireEvent.click(trigger);
    return trigger;
  }

  it("renders the listbox its trigger announces, with one selected option", () => {
    const trigger = openPicker();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const listbox = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    expect(listbox).toContainElement(options[0]);
    expect(options.length).toBeGreaterThan(1);
    expect(options.filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("English");
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    const trigger = openPicker();
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("still closes on a click outside", () => {
    openPicker();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
