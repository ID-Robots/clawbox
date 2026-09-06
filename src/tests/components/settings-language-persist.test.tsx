import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@/lib/i18n";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

// The whole settings app mounts here — every panel and every status fetch.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
 * The sweep saw a language picked in the DESKTOP Settings window fail to reach
 * the server twice, while the same pick on /app/settings landed — which would
 * mean the desktop had a write path of its own. It does not: both pages render
 * this one component, and its picker calls the provider's `setLocale`, which is
 * the ONLY thing on the device that writes `ui_language`. This pins that, so a
 * later refactor cannot give the desktop a second, silent path: the pick must
 * still leave the box as a POST, with the real provider in place rather than
 * the `setLocale: () => {}` stub the neighbouring suites install.
 */
describe("Settings → Appearance language pick reaches the server", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: string | URL | undefined) => {
      const url = String(input ?? "");
      if (url.startsWith("/setup-api/preferences")) return jsonResponse({ ui_language: "en" });
      if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
      if (url === "/setup-api/system/hotspot") return jsonResponse({ enabled: false, ssid: "ClawBox-Setup" });
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url === "/setup-api/ai-models/status") return jsonResponse({ connected: false, provider: null, providerLabel: null, mode: null, model: null });
      if (url === "/setup-api/providers/status") return jsonResponse({ harness: "openclaw", defaultProvider: null, degraded: false, providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("POSTs ui_language when Deutsch is picked in the desktop window", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <SettingsApp ui={defaultUi} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: /Appearance|settings\.appearance/ }));
    await user.click(await screen.findByRole("button", { name: /English/ }));
    await user.click(await screen.findByRole("option", { name: /Deutsch/ }));

    await waitFor(() => {
      const write = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/setup-api/preferences" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(write, "the pick was never written to the box").toBeDefined();
      expect(JSON.parse(String((write![1] as RequestInit).body))).toEqual({ ui_language: "de" });
    });
  });
});
