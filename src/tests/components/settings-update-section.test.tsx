import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { translations } from "@/lib/translations";

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "en",
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let s = translations.en[key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
  }),
}));
vi.mock("next/image", () => ({ default: (props: Record<string, unknown>) => <img alt="" {...props} /> }));
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
 * The system update is a Settings page of its own now — versions, the run,
 * beta channel, branch pin, force — and About's tile only points there.
 */
describe("Settings → System Update", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
      const url = String(input ?? "");
      if (url.startsWith("/setup-api/update/versions")) {
        return jsonResponse({ clawbox: { current: "v4.0.0", target: "v4.1.0", updateAvailable: true }, openclaw: { current: "2.0.0", target: null } });
      }
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url === "/setup-api/system/update-branch") return jsonResponse({ branch: "" });
      if (url === "/setup-api/system/stats") return jsonResponse({ overview: { hostname: "clawbox", os: "Linux", kernel: "5.15", arch: "arm64", platform: "linux", uptime: "1h" } });
      if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
      if (url === "/setup-api/system/hotspot") return jsonResponse({ enabled: true, ssid: "ClawBox-Setup" });
      if (url === "/setup-api/ai-models/status") return jsonResponse({ connected: false, provider: null, providerLabel: null, mode: null, model: null });
      if (url === "/setup-api/ai-models/oauth/providers") return jsonResponse({ providers: [] });
      if (url === "/setup-api/providers/status") return jsonResponse({ harness: "openclaw", defaultProvider: "clawai", degraded: false, providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: false });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      return jsonResponse({});
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("has its own entry in the sidebar, and About's tile switches to it", async () => {
    render(<SettingsApp ui={defaultUi} />);
    const nav = await screen.findByRole("navigation");
    const entries = Array.from(nav.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(entries.some((e) => e.includes(translations.en["settings.systemUpdate"]))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(translations.en["settings.about"]) }));
    const tile = await screen.findByTestId("settings-about-open-update");
    // The beta toggle left About with the rest of the update.
    expect(screen.queryByText(translations.en["settings.betaChannel"])).toBeNull();
    fireEvent.click(tile);
    expect(await screen.findByTestId("settings-update-section")).toBeInTheDocument();
    expect(await screen.findByTestId("system-update-app")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/1 update available/)).toBeInTheDocument());
  });

  it("says in the sidebar when an update is waiting", async () => {
    render(<SettingsApp ui={defaultUi} />);
    const nav = await screen.findByRole("navigation");
    await waitFor(() => expect(nav.textContent).toContain("v4.0.0 → v4.1.0"));
  });
});
