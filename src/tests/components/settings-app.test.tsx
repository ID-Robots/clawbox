import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "en", name: "English" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("next/image", () => ({
  default: () => null,
}));

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

const statsResponse = {
  overview: {
    hostname: "clawbox-test",
    os: "TestOS",
    kernel: "6.8.0",
    uptime: "1h",
    arch: "arm64",
    platform: "linux",
  },
  cpu: {
    usage: 12,
    model: "Test CPU",
    cores: 4,
    loadAvg: ["0.10", "0.12", "0.14"],
    speed: 1800,
  },
  memory: {
    total: 8 * 1024 * 1024 * 1024,
    used: 2 * 1024 * 1024 * 1024,
    free: 6 * 1024 * 1024 * 1024,
    usedPercent: 25,
    swap: {
      used: 0,
      total: 0,
      percent: 0,
    },
  },
  temperature: {
    value: 42,
    display: "42C",
  },
  gpu: {
    usage: 0,
  },
  storage: [],
  network: [],
  processes: [],
  timestamp: Date.now(),
};

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

describe("SettingsApp factory reset overlay", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL) => {
      const url = input.toString();

      if (url === "/setup-api/system/stats") return jsonResponse(statsResponse);
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url === "/setup-api/update/versions") {
        return jsonResponse({
          clawbox: { current: "v1.0.0", target: null },
          openclaw: { current: "v1.0.0", target: null },
        });
      }
      if (url === "/setup-api/system/update-branch") return jsonResponse({ branch: "" });
      if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
      if (url === "/setup-api/system/hotspot") return jsonResponse({ enabled: true, ssid: "ClawBox-Setup" });
      if (url === "/setup-api/ai-models/status") {
        return jsonResponse({
          connected: false,
          provider: null,
          providerLabel: null,
          mode: null,
          model: null,
        });
      }
      if (url === "/setup-api/ai-models/oauth/providers") return jsonResponse({ providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: false });
      if (url === "/setup-api/llamacpp/status") return jsonResponse({ installed: false });
      if (url === "/setup-api/ollama/status") return jsonResponse({ installed: false });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      if (url === "/setup-api/setup/reset") return jsonResponse({ ok: true });

      return jsonResponse({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the factory reset loading screen in a portal with progress steps", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    const { container } = render(<SettingsApp ui={defaultUi} />, { container: root });

    fireEvent.click(screen.getByRole("button", { name: /settings\.about$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /factoryReset/ }));
    fireEvent.click(screen.getByRole("button", { name: "settings.reset" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/setup/reset", { method: "POST" });
    });

    const overlay = await screen.findByRole("status");
    expect(overlay).toBeInTheDocument();
    expect(document.body).toContainElement(overlay);
    expect(container).not.toContainElement(overlay);
    expect(within(overlay).getAllByText("settings.erasingSettings")).toHaveLength(2);
    expect(within(overlay).getByText("settings.waitingOnline")).toBeInTheDocument();
    expect(within(overlay).getByText("settings.startingSetup")).toBeInTheDocument();
  });

  it("opens the ClawBox AI offer when the desktop deep-link event is fired", async () => {
    const pendingWindow = window as Window & {
      __clawboxPendingSettingsSection?: string;
      __clawboxPendingClawAiOffer?: boolean;
    };
    pendingWindow.__clawboxPendingSettingsSection = "ai";
    pendingWindow.__clawboxPendingClawAiOffer = true;

    render(<SettingsApp ui={defaultUi} />);

    expect(await screen.findByRole("dialog", { name: /ClawBox AI token setup/i })).toBeInTheDocument();
    expect(screen.getByText("Unlock the recommended ClawBox AI experience")).toBeInTheDocument();
  });

  it("selects ClawBox AI when the desktop provider deep-link is fired", async () => {
    const pendingWindow = window as Window & {
      __clawboxPendingSettingsSection?: string;
      __clawboxPendingAiProvider?: string;
    };
    pendingWindow.__clawboxPendingSettingsSection = "ai";
    pendingWindow.__clawboxPendingAiProvider = "clawai";

    render(<SettingsApp ui={defaultUi} />);

    const providerRadio = await screen.findByRole("radio", { name: /ClawBox AI/i });
    expect(providerRadio).toBeChecked();
  });
});
