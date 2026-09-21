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

/** Every stats URL this render asked for, in order — the collapse contract is
 *  about what is REQUESTED, not only about what is drawn. */
let statsUrls: string[] = [];

function serve(stats: unknown) {
  statsUrls = [];
  vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
    const url = String(input ?? "");
    if (url.startsWith("/setup-api/system/stats")) { statsUrls.push(url); return jsonResponse(stats); }
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

/**
 * Both figure blocks are COLLAPSED when the page opens (owner's ask), so every
 * assertion about their contents has to press their button first. The blocks
 * are also not merely hidden: while shut, the poll tells the server not to
 * compute them, which is why `statsUrls` is checked alongside the DOM.
 */
async function expand(which: "per-core" | "processes") {
  await userEvent.click(await screen.findByTestId(`settings-${which}-toggle`));
}

/** The query the most recent stats poll actually sent. */
function lastStatsQuery(): URLSearchParams {
  return new URLSearchParams(statsUrls[statsUrls.length - 1]?.split("?")[1] ?? "");
}

afterEach(() => vi.unstubAllGlobals());

describe("Settings → System, the figures page", () => {
  beforeEach(() => serve(statsResponse({ cpu: { usage: 12, model: "ARMv8", cores: 6, loadAvg: ["2.69", "2.10", "1.90"], speed: 1800, perCore: [93, 4, 51, 0, 12, 7] } })));

  it("opens with both blocks shut, and asks the box to compute neither", async () => {
    // The whole point of the buttons. `ps aux` is 91% of the stats route's
    // cost and it was being spawned every three seconds for a table nobody had
    // opened, so a shut block must be absent from the REQUEST and not merely
    // hidden in the DOM.
    await openSection("system");
    await screen.findByTestId("settings-per-core");

    expect(screen.queryByText("93%")).toBeNull();
    expect(screen.queryByText("llama-server --alias gemma")).toBeNull();
    expect(screen.getByTestId("settings-per-core-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("settings-processes-toggle")).toHaveAttribute("aria-expanded", "false");

    const query = lastStatsQuery();
    expect(query.get("perCore")).toBe("0");
    expect(query.get("processes")).toBe("0");
  });

  it("draws a bar for every core, with the load averages beside them", async () => {
    await openSection("system");
    await expand("per-core");
    const panel = await screen.findByTestId("settings-per-core");
    for (const busy of ["93%", "4%", "51%", "0%", "12%", "7%"]) {
      expect(within(panel).getByText(busy)).toBeInTheDocument();
    }
    // All three load averages, not just the one-minute figure the aggregate
    // CPU row already shows.
    expect(within(panel).getByText(/2\.69 · 2\.10 · 1\.90/)).toBeInTheDocument();
    // Opening is what makes the box measure it.
    expect(lastStatsQuery().get("perCore")).toBe("1");
    // …and only it. The other block is still shut and still not computed.
    expect(lastStatsQuery().get("processes")).toBe("0");
  });

  it("stops asking for the figures again once the block is shut", async () => {
    await openSection("system");
    await expand("per-core");
    expect(lastStatsQuery().get("perCore")).toBe("1");

    await expand("per-core");
    expect(screen.getByTestId("settings-per-core-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(lastStatsQuery().get("perCore")).toBe("0");
    expect(screen.queryByText("93%")).toBeNull();
  });

  it("lists the busiest processes with their pid and figures", async () => {
    await openSection("system");
    await expand("processes");
    const panel = await screen.findByTestId("settings-processes");
    expect(within(panel).getByText("llama-server --alias gemma")).toBeInTheDocument();
    expect(within(panel).getByText("1201")).toBeInTheDocument();
    expect(within(panel).getByText("42.5")).toBeInTheDocument();
    expect(within(panel).getByText("3.1")).toBeInTheDocument();
    expect(lastStatsQuery().get("processes")).toBe("1");
  });

  it("says which figure is which, for a reader who cannot see the columns", async () => {
    // Two grids of divs read out as "1201 llama-server 42.5 3.1" — four values
    // and no indication of which is CPU and which is memory. A real table with
    // scoped headers is what associates them, and the unit is said once in the
    // header rather than on every cell.
    await openSection("system");
    await expand("processes");
    const panel = await screen.findByTestId("settings-processes");
    // By its accessible name: the headers say what a cell is, and this says
    // what the table is.
    expect(within(panel).getByRole("table", { name: "Busiest processes" })).toBeInTheDocument();
    expect(within(panel).getByRole("columnheader", { name: "CPU %" })).toBeInTheDocument();
    expect(within(panel).getByRole("columnheader", { name: "Memory %" })).toBeInTheDocument();
    expect(within(panel).getAllByRole("row")).toHaveLength(PROCESSES.length + 1);
  });

  it("switches the table to the memory ordering when asked", async () => {
    serve(statsResponse({
      cpu: { usage: 12, model: "ARMv8", cores: 6, loadAvg: ["2.69", "2.10", "1.90"], speed: 1800, perCore: [93] },
      processesByMemory: BY_MEMORY,
    }));
    await openSection("system");
    await expand("processes");
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
  it("draws no per-core bars rather than a row of empty ones", async () => {
    // A box mid-update runs a bundle and a server a version apart, and an
    // unreadable /proc/stat answers the same way. Six bars at 0% would be a
    // claim that the machine is idle; nothing is the honest answer.
    //
    // The CARD itself now stays either way, because it carries the button that
    // is the only way back in — withholding it would leave an owner who opened
    // the page against an older server with no way to ask again. What is
    // withheld is the row.
    serve(statsResponse());
    await openSection("system");
    await expand("per-core");
    const panel = await screen.findByTestId("settings-per-core");
    expect(within(panel).queryByText("%")).toBeNull();
    // Said, rather than left blank: an open card with nothing in it reads as
    // broken, and the real bars are one 3 s poll away.
    expect(within(panel).getByRole("status")).toHaveTextContent("Checking");
  });

  it("draws no per-core bars when the reading itself is empty", async () => {
    // The wire shape of a just-restarted box: no previous /proc/stat sample to
    // diff, so the server sends `perCore: []` rather than a zero per core. The
    // aggregate tile still shows its load-average figure — 19% here — which is
    // exactly the pairing that made six 0% bars read as a lie.
    serve(statsResponse({
      cpu: { usage: 19, model: "ARMv8", cores: 6, loadAvg: ["1.15", "1.02", "0.98"], speed: 1800, perCore: [] },
    }));
    await openSection("system");
    await expand("per-core");
    const panel = await screen.findByTestId("settings-per-core");
    expect(within(panel).getByRole("status")).toHaveTextContent("Checking");
    // The aggregate figure is still there — withholding the per-core row is not
    // withholding the rest of the page.
    expect(screen.getByText("19%")).toBeInTheDocument();
  });

  it("offers no ordering toggle when only one ordering was sent", async () => {
    serve(statsResponse());
    await openSection("system");
    await expand("processes");
    const panel = await screen.findByTestId("settings-processes");
    expect(within(panel).queryByRole("button", { name: "By memory" })).toBeNull();
    // …and still lists what it did get.
    expect(within(panel).getByText("node production-server.js")).toBeInTheDocument();
  });

  it("draws no process table when the box could not run ps", async () => {
    serve(statsResponse({ processes: [] }));
    await openSection("system");
    await expand("processes");
    const panel = await screen.findByTestId("settings-processes");
    expect(within(panel).queryByRole("table")).toBeNull();
    expect(within(panel).getByRole("status")).toHaveTextContent("Checking");
  });

  it("keeps the ordering toggle out of a block nobody has opened", async () => {
    // It reorders a table that is not on screen; offering it there would be a
    // control with nothing to act on.
    serve(statsResponse({ processesByMemory: BY_MEMORY }));
    await openSection("system");
    const panel = await screen.findByTestId("settings-processes");
    expect(within(panel).queryByRole("button", { name: "By memory" })).toBeNull();
    await expand("processes");
    expect(within(panel).getByRole("button", { name: "By memory" })).toBeInTheDocument();
  });
});

describe("where the set-once cards live", () => {
  beforeEach(() => serve(statsResponse()));

  it("puts the box's password on System — it is about the box, not the assistant (owner, 2026-09-16)", async () => {
    await openSection("system");
    await screen.findByTestId("settings-processes");
    // By its accessible name, the way the mobile-overlay e2e drives it: the
    // move must not disturb the labels that test selects on.
    expect(screen.getByPlaceholderText("Current password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
    expect(screen.queryByText("Desktop & power")).toBeNull();
  });

  it("keeps the Desktop & power card on Harness, and the password off it", async () => {
    await openSection("harness");
    // Awaited, not read: the card returns null until its own two status fetches
    // land.
    expect(await screen.findByText("Desktop & power")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Current password")).toBeNull();
  });
});
