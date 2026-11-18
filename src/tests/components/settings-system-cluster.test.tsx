import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { handoffSettingsSection } from "@/lib/ui-events";

/**
 * Settings → System → Cluster (TASK-2670): the tab is the OWNER's, and only on a
 * box that has a cluster to show. A staff user's Settings must neither draw it
 * nor call its route; an owner's Settings on a box with no cluster draws no tab
 * and makes one cheap availability request, nothing more.
 */

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

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

const STATS = {
  overview: { hostname: "this-spark", os: "Ubuntu", kernel: "6.8", uptime: "1h", arch: "arm64", platform: "linux" },
  cpu: { usage: 10, model: "Cortex", cores: 20, loadAvg: ["1.45", "1.20", "1.00"], speed: 1900 },
  memory: { total: 120 * GiB, used: 100 * GiB, free: 20 * GiB, usedPercent: 85, swap: { used: 0, total: 0, percent: 0 } },
  temperature: { value: 50 as number | null },
  gpu: { usage: 0 },
  storage: [],
  network: [],
  timestamp: 0,
};

const OWNER = { username: "clawbox", isOwner: true, multiUser: true, openclawShared: false };
const STAFF = { username: "alice", isOwner: false, multiUser: true, openclawShared: false };

const SNAPSHOT = {
  enabled: true,
  generatedAt: 0,
  sparks: [
    { id: "local", local: true, online: true, hostname: "spark-a", checkedAt: 0, figures: { cpuPercent: 5, memory: { usedBytes: 96 * GiB, totalBytes: 120 * GiB, percent: 80 }, unifiedMemory: true, gpu: { utilPercent: 0, memoryUsedBytes: null, memoryTotalBytes: null }, temperatureC: 50, disk: null, uptimeSeconds: 1 } },
    { id: "peer-1", local: false, online: false, hostname: "spark-b", failure: "unreachable", checkedAt: 0 },
  ],
  engine: { configured: false },
};

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

let me: typeof OWNER | typeof STAFF | null;
let clusterEnabled: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (data: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(data) });

function serve() {
  fetchMock = vi.fn((input: string | URL | undefined) => {
    const url = String(input ?? "");
    if (url === "/setup-api/users/me") return me ? json(me) : json({}, 500);
    if (url === "/setup-api/users") return json({ owner: { username: "clawbox" }, users: [], currentUser: "clawbox", signIn: { available: true } });
    if (url.startsWith("/setup-api/system/cluster")) {
      if (me?.isOwner !== true) return json({ error: "Only the box owner can do this.", code: "owner_only" }, 403);
      if (url.includes("availability=1")) return json({ enabled: clusterEnabled });
      return json(clusterEnabled ? SNAPSHOT : { enabled: false });
    }
    if (url.startsWith("/setup-api/system/stats")) return json(STATS);
    if (url === "/setup-api/update/status") return json({ phase: "idle", steps: [] });
    if (url.startsWith("/setup-api/update/versions")) return json({ clawbox: { current: "v1.0.0", target: null }, openclaw: { current: "1.0.0", target: null } });
    if (url === "/setup-api/providers/status") return json({ harness: "openclaw", defaultProvider: null, degraded: false, providers: [] });
    if (url === "/setup-api/setup/status") return json({ setup_complete: true });
    if (url === "/setup-api/harness/active") return json({ active: "openclaw", edition: "openclaw", activeKnown: true });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
}

const clusterCalls = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/setup-api/system/cluster"));

async function openSystem() {
  handoffSettingsSection("system");
  render(<SettingsApp ui={ui} />);
  await screen.findByRole("tab", { name: "Device" }).catch(() => screen.findByRole("heading", { name: "Resources" }));
}

beforeEach(() => {
  me = OWNER;
  clusterEnabled = true;
  _resetSessionUserForTest();
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings → System → Cluster", () => {
  it("adds a Cluster tab for the owner of a box that has a cluster, and opens the cluster on it", async () => {
    await openSystem();
    const tab = await screen.findByRole("tab", { name: "Cluster" });
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("data-testid"))).toEqual([
      "settings-system-tab-device",
      "settings-system-tab-users",
      "settings-system-tab-cluster",
    ]);

    fireEvent.click(tab);
    const panel = await screen.findByRole("tabpanel", { name: "Cluster" });
    expect(within(panel).getByRole("heading", { name: "spark-a" })).toBeTruthy();
    // A Spark that is down: the warning is the first thing on the page.
    expect((await within(panel).findByTestId("cluster-unreachable-banner")).textContent).toContain("spark-b");
    // The Device figures are not drawn beside it.
    expect(screen.queryByRole("heading", { name: "Resources" })).toBeNull();
  });

  it("lets the keyboard move from the selected Cluster tab into its panel", async () => {
    await openSystem();
    fireEvent.click(await screen.findByRole("tab", { name: "Cluster" }));
    const panel = await screen.findByRole("tabpanel", { name: "Cluster" });
    expect(panel.getAttribute("tabindex")).toBe("0");
  });

  it("takes the Cluster tab away and opens Device when the cluster read says there is none after all", async () => {
    await openSystem();
    const tab = await screen.findByRole("tab", { name: "Cluster" });
    // The peers were taken out between the tab's check and the first read.
    clusterEnabled = false;
    fireEvent.click(tab);
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Cluster" })).toBeNull());
    expect(await screen.findByRole("heading", { name: "Resources" })).toBeTruthy();
    expect(screen.queryByTestId("cluster-panel")).toBeNull();
    // Nothing keeps polling the cluster route behind the Device view.
    const asked = clusterCalls().length;
    await new Promise((r) => setTimeout(r, 200));
    expect(clusterCalls().length).toBe(asked);
  });

  it("goes back to the device's own figures from the Cluster tab", async () => {
    await openSystem();
    fireEvent.click(await screen.findByRole("tab", { name: "Cluster" }));
    await screen.findByRole("tabpanel", { name: "Cluster" });
    fireEvent.click(screen.getByRole("tab", { name: "Device" }));
    expect(await screen.findByRole("heading", { name: "Resources" })).toBeTruthy();
    expect(screen.queryByTestId("cluster-panel")).toBeNull();
  });

  it("draws no Cluster tab where the box has no cluster (not a Workstation, or no peers) — one availability request, no more", async () => {
    clusterEnabled = false;
    await openSystem();
    await screen.findByRole("tab", { name: "Users" });
    await waitFor(() => expect(clusterCalls().length).toBeGreaterThan(0));
    expect(screen.queryByRole("tab", { name: "Cluster" })).toBeNull();
    expect(clusterCalls()).toEqual(["/setup-api/system/cluster?availability=1"]);
  });

  it("neither draws the tab for a staff user nor calls the cluster route for them", async () => {
    me = STAFF;
    await openSystem();
    await screen.findByRole("heading", { name: "Resources" });
    // Give any stray effect time to fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("tab", { name: "Cluster" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(clusterCalls()).toEqual([]);
  });

  it("does not ask the cluster route while nobody has said who is signed in", async () => {
    me = null;
    await openSystem();
    await new Promise((r) => setTimeout(r, 100));
    expect(clusterCalls()).toEqual([]);
    expect(screen.queryByRole("tab", { name: "Cluster" })).toBeNull();
  });
});
