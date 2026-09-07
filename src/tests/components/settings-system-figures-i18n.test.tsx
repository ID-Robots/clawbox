import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

// The whole settings app mounts here — every panel and every status fetch —
// which on a loaded Jetson eats most of the default budget before the first
// assertion runs. Same ceiling as the neighbouring SettingsApp suites.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

/**
 * Settings → System on a German desktop read "Arbeitsspeicher … 78% · 1.6 GB
 * free", "Swap … 8% used", "Speicher … 391G free" and "6 Kerne · Load 2.69":
 * three English words inside translated labels (locale sweep DE-3), and every
 * figure with the English decimal point — "5.8 GB", "56.1°C" (DE-11,
 * 2026-09-07). The words come from the catalogue now and the figures from the
 * UI locale — the disk rows too, which the route hands over as `df -h` wrote
 * them ("5.8G") and the page reads back into bytes before it prints them.
 */

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "de",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations.de[key] ?? translations.en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/components/TelegramConfiguringOverlay", () => ({ default: () => null }));
vi.mock("@/components/AIModelsStep", () => ({ default: () => <div data-testid="ai-models-step" /> }));

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** The box the sweep looked at, give or take: 7.4 GB of RAM, an 8 GB swapfile, warm. */
const statsResponse = {
  overview: { hostname: "clawbox", os: "Ubuntu", kernel: "5.15", uptime: "1h", arch: "arm64", platform: "linux" },
  cpu: { usage: 12, model: "ARMv8", cores: 6, loadAvg: ["2.69", "2.10", "1.90"], speed: 1800 },
  memory: {
    total: 7.4 * GiB,
    used: 5.8 * GiB,
    free: 1.6 * GiB,
    usedPercent: 78,
    swap: { used: 967.1 * MiB, total: 11.7 * GiB, percent: 8 },
  },
  temperature: { value: 56.1, display: "56.1°C" },
  gpu: { usage: 0 },
  storage: [
    { filesystem: "/dev/nvme0n1p1", size: "469G", used: "58G", avail: "391G", usePercent: 12, mountpoint: "/" },
    // A stick with under 10 GB free: df writes one decimal, English-style.
    { filesystem: "/dev/sda1", size: "7.3G", used: "1.5G", avail: "5.8G", usePercent: 21, mountpoint: "/media/usb" },
    // A pseudo filesystem df has no figures for: shown as sent, never "NaN".
    { filesystem: "overlay", size: "-", used: "-", avail: "-", usePercent: 0, mountpoint: "/var/lib/overlay" },
  ],
  network: [],
  processes: [],
  timestamp: Date.now(),
};

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

describe("Settings → System figures under a German desktop", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
      const url = String(input ?? "");
      if (url === "/setup-api/system/stats") return jsonResponse(statsResponse);
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url.startsWith("/setup-api/update/versions")) {
        return jsonResponse({ clawbox: { current: "v1.0.0", target: null }, openclaw: { current: "1.0.0", target: null } });
      }
      if (url === "/setup-api/providers/status") return jsonResponse({ harness: "openclaw", defaultProvider: null, degraded: false, providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
      return jsonResponse({});
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  async function openSystem() {
    render(<SettingsApp ui={defaultUi} />);
    window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section: "system" } }));
    // The memory bar's "free" line: the first thing that proves the stats landed.
    await screen.findByText(/1,6 GB frei/);
  }

  it("says free, used and load in the locale's words", async () => {
    await openSystem();

    expect(screen.getByText(/78% · 1,6 GB frei/)).toBeInTheDocument();
    expect(screen.getByText(/8 % belegt/)).toBeInTheDocument();
    expect(screen.getByText(/12% · 391 GB frei/)).toBeInTheDocument();
    expect(screen.getByText(/6 Kerne · Auslastung 2,69/)).toBeInTheDocument();

    expect(screen.queryByText(/\bfree\b/)).toBeNull();
    expect(screen.queryByText(/% used\b/)).toBeNull();
    expect(screen.queryByText(/\bLoad\b/)).toBeNull();
  });

  it("formats every size and the temperature through the UI locale", async () => {
    await openSystem();

    expect(screen.getByText("5,8 GB / 7,4 GB")).toBeInTheDocument();
    expect(screen.getByText("967,1 MB / 11,7 GB")).toBeInTheDocument();
    // The disk rows: df's "58G / 469G" and "5.8G" read back into bytes and
    // printed the way every other size on the page is.
    expect(screen.getByText("58,0 GB / 469 GB")).toBeInTheDocument();
    expect(screen.getByText("1,5 GB / 7,3 GB")).toBeInTheDocument();
    expect(screen.getByText(/21% · 5,8 GB frei/)).toBeInTheDocument();
    expect(screen.queryByText(/\d+G\b/)).toBeNull();
    // A figure df could not give stays what df wrote.
    expect(screen.getByText("- / -")).toBeInTheDocument();
    expect(screen.getByText(/0% · - frei/)).toBeInTheDocument();
    expect(screen.getByText("56,1°C")).toBeInTheDocument();
    expect(screen.queryByText("56.1°C")).toBeNull();
    expect(screen.queryByText(/\d\.\d GB/)).toBeNull();
  });
});
