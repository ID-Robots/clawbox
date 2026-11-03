import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { dispatchOpenSettingsSection, handoffSettingsSection } from "@/lib/ui-events";

/**
 * Settings → System → Users (TASK-2130). Users was a sidebar row of its own;
 * it is a tab of System now, beside the device's figures, and the owner's
 * alone:
 *
 *  - the sidebar (and the phone's list) has no Users row, and System's Users
 *    tab is the same panel — the list, the add-user form, remove;
 *  - every way in that named the old section — the cold-open handoff, the
 *    live event, the standalone page's `?section=users` handoff — lands on
 *    System with Users open, and a link to `system` or the System row opens
 *    the figures again;
 *  - anyone signed in who is not the owner gets System without tabs and no
 *    Users anywhere, a link to it included; a link to Users waits for
 *    `/users/me` rather than drawing the list for a moment for someone it is
 *    not for.
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

const STATS = {
  overview: { hostname: "clawbox", os: "Ubuntu", kernel: "5.15", uptime: "1h", arch: "arm64", platform: "linux" },
  cpu: { usage: 12, model: "ARMv8", cores: 6, loadAvg: ["2.69", "2.10", "1.90"], speed: 1800 },
  memory: { total: 7.4 * GiB, used: 5.8 * GiB, free: 1.6 * GiB, usedPercent: 78, swap: { used: 0, total: 0, percent: 0 } },
  temperature: { value: 56.1, display: "56.1°C" },
  gpu: { usage: 0 },
  storage: [],
  network: [],
  timestamp: 0,
};

const LISTING = {
  owner: { username: "clawbox" },
  users: [{ username: "ivan", createdAt: "2026-10-20T09:30:00.000Z" }],
  currentUser: "clawbox",
  signIn: { available: true },
};

const OWNER = { username: "clawbox", isOwner: true, multiUser: true, openclawShared: false };
const IVAN = { username: "ivan", isOwner: false, multiUser: true, openclawShared: false };

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

/** What `/users/me` answers: a person, a request that has not come back yet, or a failure. */
type Me = typeof OWNER | typeof IVAN | "pending" | "fail";
let me: Me = OWNER;
/** Answers a `"pending"` /users/me. */
let releaseMe: ((who: typeof OWNER | typeof IVAN) => void) | null = null;
/** Every request this render made, as `METHOD url`. */
let calls: string[] = [];

function serve() {
  calls = [];
  releaseMe = null;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined, init?: RequestInit) => {
    const url = String(input ?? "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === "/setup-api/users/me") {
      if (me === "fail") return Promise.reject(new TypeError("Failed to fetch"));
      if (me === "pending") {
        return new Promise((resolve) => {
          releaseMe = (who) => resolve({ ok: true, status: 200, json: () => Promise.resolve(who) });
        });
      }
      return jsonResponse(me);
    }
    if (url === "/setup-api/users" && method === "GET") return jsonResponse(LISTING);
    if (url.startsWith("/setup-api/system/stats")) return jsonResponse(STATS);
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

type PendingSlot = Window & { __clawboxPendingSettingsSection?: unknown };

const sidebar = () => screen.getByRole("navigation", { name: "Settings" });
/** A sidebar row by its label (its accessible name also carries the icon's ligature and the status line). */
const navRow = (label: string) =>
  within(sidebar()).queryAllByRole("button").find((b) => within(b).queryByText(label, { exact: true })) ?? null;
const systemTab = (name: "Device" | "Users") => screen.getByRole("tab", { name });
const usersRequested = () => calls.filter((c) => c === "GET /setup-api/users").length;
const statsRequested = () => calls.filter((c) => c.startsWith("GET /setup-api/system/stats")).length;

/** Mounts Settings and waits for the sidebar and the session answer. */
async function mount() {
  render(<SettingsApp ui={ui} />);
  await waitFor(() => expect(navRow("Appearance")).not.toBeNull());
  await waitFor(() => expect(calls).toContain("GET /setup-api/users/me"));
}

beforeEach(() => {
  me = OWNER;
  _resetSessionUserForTest();
  serve();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as PendingSlot).__clawboxPendingSettingsSection;
});

describe("Settings → System → Users", () => {
  it("has no sidebar row of its own: System's Users tab holds the list, the add-user form and remove", async () => {
    await mount();
    expect(navRow("Users")).toBeNull();
    expect(navRow("System")).not.toBeNull();

    fireEvent.click(navRow("System")!);
    const tabs = await screen.findByRole("tablist", { name: "System" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["computerDevice", "groupUsers"]);
    // System opens on the device's figures, as it always did.
    expect(systemTab("Device")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("tabpanel", { name: "Device" })).toBeInTheDocument();
    expect(screen.queryByTestId("settings-users-section")).toBeNull();
    expect(usersRequested()).toBe(0);

    fireEvent.click(systemTab("Users"));
    expect(systemTab("Users")).toHaveAttribute("aria-selected", "true");
    const panel = await screen.findByRole("tabpanel", { name: "Users" });
    const users = within(panel).getByTestId("settings-users-section");
    expect(await within(users).findByTestId("users-row-ivan")).toBeInTheDocument();
    expect(within(users).getByTestId("users-add-form")).toBeInTheDocument();
    expect(within(users).getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.queryByRole("tabpanel", { name: "Device" })).toBeNull();
    // The sidebar still says where the owner is: System.
    expect(navRow("System")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 2, name: "System" })).toBeInTheDocument();
  });

  it("polls the device's figures only while their tab is open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await mount();
    fireEvent.click(navRow("System")!);
    await screen.findByRole("tabpanel", { name: "Device" });
    await waitFor(() => expect(statsRequested()).toBeGreaterThan(0));

    const onDevice = statsRequested();
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(statsRequested()).toBe(onDevice + 1);

    fireEvent.click(systemTab("Users"));
    await screen.findByTestId("settings-users-section");
    const onUsers = statsRequested();
    act(() => { vi.advanceTimersByTime(9_000); });
    expect(statsRequested()).toBe(onUsers);

    fireEvent.click(systemTab("Device"));
    await waitFor(() => expect(statsRequested()).toBe(onUsers + 1));
  });

  it("moves between the tabs with the arrow keys, Home and End", async () => {
    await mount();
    fireEvent.click(navRow("System")!);
    const tabs = await screen.findByRole("tablist", { name: "System" });
    // One tab stop: the selected tab.
    expect(systemTab("Device")).toHaveAttribute("tabindex", "0");
    expect(systemTab("Users")).toHaveAttribute("tabindex", "-1");

    systemTab("Device").focus();
    fireEvent.keyDown(tabs, { key: "ArrowRight" });
    expect(systemTab("Users")).toHaveAttribute("aria-selected", "true");
    expect(systemTab("Users")).toHaveFocus();
    expect(await screen.findByTestId("settings-users-section")).toBeInTheDocument();

    fireEvent.keyDown(tabs, { key: "ArrowRight" });
    expect(systemTab("Device")).toHaveAttribute("aria-selected", "true");
    expect(systemTab("Device")).toHaveFocus();
    fireEvent.keyDown(tabs, { key: "ArrowLeft" });
    expect(systemTab("Users")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs, { key: "Home" });
    expect(systemTab("Device")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs, { key: "End" });
    expect(systemTab("Users")).toHaveAttribute("aria-selected", "true");
    expect(systemTab("Users")).toHaveFocus();
  });
});

describe("Every old way into Users lands on System → Users", () => {
  it("a cold open asked for `users` (the handoff the standalone page's ?section=users makes)", async () => {
    // What /app/settings?section=users does before Settings has mounted.
    handoffSettingsSection("users");
    await mount();
    expect(await screen.findByTestId("settings-users-section")).toBeInTheDocument();
    expect(systemTab("Users")).toHaveAttribute("aria-selected", "true");
    expect(navRow("System")).toHaveAttribute("aria-current", "page");
    expect(navRow("Appearance")).not.toHaveAttribute("aria-current");
    // Taken, so the next cold open is not sent there again.
    expect((window as PendingSlot).__clawboxPendingSettingsSection).toBeUndefined();
  });

  it("a link to `users` while Settings is already open", async () => {
    await mount();
    expect(navRow("Appearance")).toHaveAttribute("aria-current", "page");
    act(() => dispatchOpenSettingsSection("users"));
    expect(await screen.findByTestId("settings-users-section")).toBeInTheDocument();
    expect(systemTab("Users")).toHaveAttribute("aria-selected", "true");
    expect(navRow("System")).toHaveAttribute("aria-current", "page");
  });

  it("a link to `system`, and the System row, open the device's figures again", async () => {
    handoffSettingsSection("users");
    await mount();
    await screen.findByTestId("settings-users-section");

    act(() => dispatchOpenSettingsSection("system"));
    await waitFor(() => expect(systemTab("Device")).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByTestId("settings-users-section")).toBeNull();

    fireEvent.click(systemTab("Users"));
    await screen.findByTestId("settings-users-section");
    fireEvent.click(navRow("System")!);
    await waitFor(() => expect(systemTab("Device")).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByTestId("settings-users-section")).toBeNull();
  });

  it("on a phone: no Users row in the list, and the old link opens System → Users", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    try {
      const { unmount } = render(<SettingsApp ui={ui} />);
      await waitFor(() => expect(screen.queryByText("Appearance", { exact: true })).not.toBeNull());
      expect(screen.queryByText("Users", { exact: true })).toBeNull();
      expect(screen.getByText("System", { exact: true })).toBeInTheDocument();
      unmount();

      handoffSettingsSection("users");
      render(<SettingsApp ui={ui} />);
      expect(await screen.findByTestId("settings-users-section")).toBeInTheDocument();
      expect(systemTab("Users")).toHaveAttribute("aria-selected", "true");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  });
});

describe("Users is the owner's", () => {
  it("anyone else gets System without tabs, and no Users wherever a link asked to go", async () => {
    me = IVAN;
    handoffSettingsSection("users");
    await mount();
    // System, on its own page — the figures, no tabs.
    expect(await screen.findByText("Device", { exact: true })).toBeInTheDocument();
    expect(navRow("System")).toHaveAttribute("aria-current", "page");
    expect(navRow("Users")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByTestId("settings-users-section")).toBeNull();

    // A live link to Users, from anywhere, changes nothing.
    fireEvent.click(navRow("Appearance")!);
    act(() => dispatchOpenSettingsSection("users"));
    await waitFor(() => expect(navRow("System")).toHaveAttribute("aria-current", "page"));
    expect(await screen.findByText("Device", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId("settings-users-section")).toBeNull();
    // The list was never even asked for.
    expect(usersRequested()).toBe(0);
  });

  it("a link to Users waits for /users/me rather than drawing the list for someone it is not for", async () => {
    me = "pending";
    handoffSettingsSection("users");
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(navRow("System")).toHaveAttribute("aria-current", "page"));
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByTestId("settings-users-section")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(usersRequested()).toBe(0);
    expect(statsRequested()).toBe(0);

    await waitFor(() => expect(releaseMe).not.toBeNull());
    await act(async () => { releaseMe!(IVAN); });
    expect(await screen.findByText("Device", { exact: true })).toBeInTheDocument();
    expect(screen.queryByTestId("settings-users-section")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(usersRequested()).toBe(0);
  });

  it("…and draws it once the answer is the owner", async () => {
    me = "pending";
    handoffSettingsSection("users");
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(releaseMe).not.toBeNull());
    expect(screen.queryByTestId("settings-users-section")).toBeNull();
    await act(async () => { releaseMe!(OWNER); });
    expect(await screen.findByTestId("settings-users-section")).toBeInTheDocument();
    expect(systemTab("Users")).toHaveAttribute("aria-selected", "true");
  });

  it("a /users/me that cannot be had counts as the owner's, as it does on the desktop", async () => {
    me = "fail";
    handoffSettingsSection("users");
    await mount();
    expect(await screen.findByTestId("settings-users-section")).toBeInTheDocument();
    expect(systemTab("Users")).toHaveAttribute("aria-selected", "true");
  });
});
