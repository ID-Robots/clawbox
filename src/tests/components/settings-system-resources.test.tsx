import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { handoffSettingsSection } from "@/lib/ui-events";

/**
 * Settings → System → Device: one RESOURCES card (x64 laptop test,
 * 2026-11-10). Temperature and storage were cards of their own under it — a
 * big "50.0 °C" readout with a 0/50/100 °C scale, and a STORAGE card per box —
 * and read as a different page from the CPU, Memory, Swap and GPU rows above
 * them. They are rows of the Resources card now, drawn like the others: the
 * label on the left, the figure on the right, a thin bar and a small caption.
 */

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

// English, because these assertions read the labels a person sees.
vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "en",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations.en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/components/TelegramConfiguringOverlay", () => ({ default: () => null }));
vi.mock("@/components/AIModelsStep", () => ({ default: () => <div data-testid="ai-models-step" /> }));

const GiB = 1024 ** 3;

const ROOT_MOUNT = { filesystem: "/dev/nvme0n1p2", size: "233G", used: "107G", avail: "115G", usePercent: 49, mountpoint: "/" };
const EFI_MOUNT = { filesystem: "/dev/nvme0n1p1", size: "511M", used: "6.1M", avail: "505M", usePercent: 2, mountpoint: "/boot/efi" };

const BASE_STATS = {
  overview: { hostname: "clawbox", os: "Ubuntu", kernel: "5.15", uptime: "1h", arch: "x64", platform: "linux" },
  cpu: { usage: 10, model: "Intel(R) Core(TM) i7-8650U", cores: 8, loadAvg: ["1.45", "1.20", "1.00"], speed: 1900 },
  memory: { total: 15.5 * GiB, used: 5.6 * GiB, free: 9.9 * GiB, usedPercent: 36, swap: { used: 0.9 * GiB, total: 7.9 * GiB, percent: 12 } },
  temperature: { value: 50 as number | null },
  gpu: { usage: 0 },
  storage: [ROOT_MOUNT, EFI_MOUNT],
  network: [],
  timestamp: 0,
};

let stats: typeof BASE_STATS = BASE_STATS;

const OWNER = { username: "clawbox", isOwner: true, multiUser: true, openclawShared: false };

const ui: UISettings = {
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

function serve() {
  vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
    const url = String(input ?? "");
    if (url === "/setup-api/users/me") return jsonResponse(OWNER);
    if (url === "/setup-api/users") return jsonResponse({ owner: { username: "clawbox" }, users: [], currentUser: "clawbox", signIn: { available: true } });
    if (url.startsWith("/setup-api/system/stats")) return jsonResponse(stats);
    if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
    if (url.startsWith("/setup-api/update/versions")) {
      return jsonResponse({ clawbox: { current: "v1.0.0", target: null }, openclaw: { current: "1.0.0", target: null } });
    }
    if (url === "/setup-api/providers/status") return jsonResponse({ harness: "openclaw", defaultProvider: null, degraded: false, providers: [] });
    if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
    if (url === "/setup-api/harness/active") return jsonResponse({ active: "openclaw", edition: "openclaw", activeKnown: true });
    return jsonResponse({});
  }));
}

/** Opens Settings on System → Device and waits for the figures to be drawn. */
async function openDevice() {
  handoffSettingsSection("system");
  render(<SettingsApp ui={ui} />);
  const panel = await screen.findByRole("tabpanel", { name: "Device" });
  await within(panel).findByRole("heading", { name: "Resources" });
  return panel;
}

beforeEach(() => {
  stats = BASE_STATS;
  _resetSessionUserForTest();
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings → System → Device: Resources", () => {
  it("draws temperature and storage as rows of the Resources card, not as cards of their own", async () => {
    const panel = await openDevice();

    // No standalone Temperature or Storage card, and no heading of their own.
    expect(within(panel).queryByRole("heading", { name: "Temperature" })).toBeNull();
    expect(within(panel).queryByRole("heading", { name: "Storage" })).toBeNull();
    const resources = within(panel).getByTestId("settings-resources");
    expect(within(resources).getByRole("heading", { name: "Resources" })).toBeInTheDocument();
    for (const card of Array.from(panel.children)) {
      if (card === resources) continue;
      expect(card.textContent ?? "").not.toMatch(/Temperature|Storage/);
    }

    // Temperature: the label, the reading on the right, a bar and a caption.
    const temperature = within(resources).getByTestId("settings-resource-temperature");
    expect(temperature).toHaveTextContent("Temperature");
    expect(temperature).toHaveTextContent("50.0°C");
    expect(temperature).toHaveTextContent("Normal");

    // Storage: one row per mount, /boot/efi left out as before.
    const storage = within(resources).getAllByTestId("settings-resource-storage");
    expect(storage).toHaveLength(1);
    expect(storage[0]).toHaveTextContent("Storage");
    expect(within(storage[0]).getByText("/", { exact: true })).toBeInTheDocument();
    expect(storage[0]).toHaveTextContent("49%");
    expect(storage[0]).toHaveTextContent("free");
    expect(storage[0]).not.toHaveTextContent("/boot/efi");

    // Below the CPU, Memory, Swap and GPU rows, in that order.
    const text = resources.textContent ?? "";
    const order = ["CPU", "Memory", "Swap", "GPU", "Temperature", "Storage"].map((label) => text.indexOf(label));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("keeps the temperature's colour and caption: warm over 60 °C, critical over 80 °C", async () => {
    stats = { ...BASE_STATS, temperature: { value: 84.6 } };
    const panel = await openDevice();
    const temperature = within(panel).getByTestId("settings-resource-temperature");
    expect(temperature).toHaveTextContent("84.6°C");
    expect(temperature).toHaveTextContent("Critical");
    expect(within(temperature).getByText("84.6°C")).toHaveStyle({ color: "#ef4444" });
  });

  it("has no temperature row on a box that reads no temperature", async () => {
    stats = { ...BASE_STATS, temperature: { value: null } };
    const panel = await openDevice();
    const resources = within(panel).getByTestId("settings-resources");
    await waitFor(() => expect(within(resources).getAllByTestId("settings-resource-storage")).toHaveLength(1));
    expect(within(panel).queryByTestId("settings-resource-temperature")).toBeNull();
    expect(panel.textContent ?? "").not.toMatch(/Temperature|°C/);
  });
});
