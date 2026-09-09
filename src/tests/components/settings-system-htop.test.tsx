import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/tests/helpers/test-utils";
import userEvent from "@testing-library/user-event";
import { translations } from "@/lib/translations";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

/**
 * What Settings → System became when the two set-once cards left it.
 *
 * The owner's ruling (2026-09-09): the box's password and the Desktop & Power
 * switches move to Harness — they are configured once, like the harness picker
 * and the background jobs already there — and System carries the figures alone,
 * with the two an htop user opens a system page for and a single aggregate bar
 * cannot give them: what each CORE is doing, and WHICH processes are doing it.
 *
 * Both new panels have to degrade rather than lie, which is most of what is
 * pinned here. A box mid-update runs a server and a browser bundle that are a
 * version apart, so the page must be correct against a server that sends
 * neither field — and an unreadable /proc/stat must draw no per-core row at
 * all rather than a row of empty bars claiming an idle machine.
 */

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

// Without a provider `useT()` answers the KEY, so every label here would be
// "settings.byMemory". The sibling figures suite mocks the module the same way;
// English, because these assertions are about the panel, not the catalogue.
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

const PROCESSES = [
  { pid: "1201", user: "clawbox", cpu: 42.5, mem: 3.1, command: "llama-server --alias gemma" },
  { pid: "980", user: "clawbox", cpu: 11.0, mem: 1.2, command: "node production-server.js" },
];
const BY_MEMORY = [
  { pid: "1440", user: "clawbox", cpu: 0.4, mem: 27.8, command: "python hermes-agent" },
  { pid: "1201", user: "clawbox", cpu: 42.5, mem: 3.1, command: "llama-server --alias gemma" },
];

function statsResponse(extra: Record<string, unknown> = {}) {
  return {
    overview: { hostname: "clawbox", os: "Ubuntu", kernel: "5.15", uptime: "1h", arch: "arm64", platform: "linux" },
    cpu: { usage: 12, model: "ARMv8", cores: 6, loadAvg: ["2.69", "2.10", "1.90"], speed: 1800 },
    memory: { total: 7.4 * GiB, used: 5.8 * GiB, free: 1.6 * GiB, usedPercent: 78, swap: { used: 0, total: 0, percent: 0 } },
    temperature: { value: 56.1, display: "56.1°C" },
    gpu: { usage: 0 },
    storage: [],
    network: [],
    processes: PROCESSES,
    timestamp: Date.now(),
    ...extra,
  };
}

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

function serve(stats: unknown) {
  vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
    const url = String(input ?? "");
    if (url === "/setup-api/system/stats") return jsonResponse(stats);
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

async function openSection(section: "system" | "harness") {
  render(<SettingsApp ui={defaultUi} />);
  window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section } }));
}

afterEach(() => vi.unstubAllGlobals());

describe("Settings → System, the figures page", () => {
  beforeEach(() => serve(statsResponse({ cpu: { usage: 12, model: "ARMv8", cores: 6, loadAvg: ["2.69", "2.10", "1.90"], speed: 1800, perCore: [93, 4, 51, 0, 12, 7] } })));

  it("draws a bar for every core, with the load averages beside them", async () => {
    await openSection("system");
    const panel = await screen.findByTestId("settings-per-core");
    for (const busy of ["93%", "4%", "51%", "0%", "12%", "7%"]) {
      expect(within(panel).getByText(busy)).toBeInTheDocument();
    }
    // All three load averages, not just the one-minute figure the aggregate
    // CPU row already shows.
    expect(within(panel).getByText(/2\.69 · 2\.10 · 1\.90/)).toBeInTheDocument();
  });

  it("lists the busiest processes with their pid and figures", async () => {
    await openSection("system");
    const panel = await screen.findByTestId("settings-processes");
    expect(within(panel).getByText("llama-server --alias gemma")).toBeInTheDocument();
    expect(within(panel).getByText("1201")).toBeInTheDocument();
    expect(within(panel).getByText("42.5")).toBeInTheDocument();
    expect(within(panel).getByText("3.1")).toBeInTheDocument();
  });

  it("switches the table to the memory ordering when asked", async () => {
    serve(statsResponse({
      cpu: { usage: 12, model: "ARMv8", cores: 6, loadAvg: ["2.69", "2.10", "1.90"], speed: 1800, perCore: [93] },
      processesByMemory: BY_MEMORY,
    }));
    await openSection("system");
    const panel = await screen.findByTestId("settings-processes");
    // The CPU ordering is what it opens on, and the biggest memory user is not
    // in it — which is the point of the toggle.
    expect(within(panel).queryByText("python hermes-agent")).toBeNull();

    await userEvent.click(within(panel).getByRole("button", { name: "By memory" }));
    expect(within(panel).getByText("python hermes-agent")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "By memory" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Settings → System against a server that predates the new figures", () => {
  it("draws no per-core row rather than a row of empty bars", async () => {
    // A box mid-update runs a bundle and a server a version apart, and an
    // unreadable /proc/stat answers the same way. Six bars at 0% would be a
    // claim that the machine is idle; nothing is the honest answer.
    serve(statsResponse());
    await openSection("system");
    await screen.findByTestId("settings-processes");
    expect(screen.queryByTestId("settings-per-core")).toBeNull();
  });

  it("offers no ordering toggle when only one ordering was sent", async () => {
    serve(statsResponse());
    await openSection("system");
    const panel = await screen.findByTestId("settings-processes");
    expect(within(panel).queryByRole("button", { name: "By memory" })).toBeNull();
    // …and still lists what it did get.
    expect(within(panel).getByText("node production-server.js")).toBeInTheDocument();
  });

  it("draws no process table at all when the box could not run ps", async () => {
    serve(statsResponse({ processes: [] }));
    await openSection("system");
    await screen.findByText(/ARMv8/);
    expect(screen.queryByTestId("settings-processes")).toBeNull();
  });
});

describe("the two set-once cards moved to Harness", () => {
  beforeEach(() => serve(statsResponse()));

  it("puts the box's password and the Desktop & power card on Harness", async () => {
    await openSection("harness");
    // By its accessible name, the way the mobile-overlay e2e drives it: the
    // move must not disturb the labels that test selects on.
    expect(await screen.findByPlaceholderText("Current password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
    // Awaited, not read: the card returns null until its own two status fetches
    // land, which is after the password inputs are already on screen.
    expect(await screen.findByText("Desktop & power")).toBeInTheDocument();
  });

  it("leaves neither of them on System", async () => {
    await openSection("system");
    await screen.findByTestId("settings-processes");
    expect(screen.queryByPlaceholderText("Current password")).toBeNull();
    expect(screen.queryByText("Desktop & power")).toBeNull();
  });
});
