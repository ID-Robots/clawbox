import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { dispatchOpenSettingsSection } from "@/lib/ui-events";

/**
 * Settings per person (TASK-2435):
 *  - a member of staff on an organisation box sees only their own items —
 *    Appearance (language, wallpaper, look) and Account (their password) —
 *    and a link to any other section opens Appearance;
 *  - every user other than the owner, on any box, has Account and no System
 *    Update, and never the owner's password card;
 *  - the owner keeps every section and never sees Account.
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

const OWNER = { username: "clawbox", isOwner: true, multiUser: true, openclawShared: false, orgMode: false };
const IVAN = { username: "ivan", isOwner: false, multiUser: true, openclawShared: false, orgMode: false };
let me: Record<string, unknown> = OWNER;
let calls: string[] = [];

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

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(data) });
}

let passwordAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true } };

const GiB = 1024 ** 3;
/** What System's figures read — About asks for it on a home box. */
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

function serve() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined, init?: RequestInit) => {
    const url = String(input ?? "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === "/setup-api/users/me") return jsonResponse(me);
    if (url === "/setup-api/users/me/password") return jsonResponse(passwordAnswer.body, passwordAnswer.status);
    if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
    if (url.startsWith("/setup-api/system/stats")) return jsonResponse(STATS);
    if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
    if (url === "/setup-api/harness/active") return jsonResponse({ active: "openclaw", edition: "openclaw", activeKnown: true });
    if (url === "/setup-api/ai-models/status") return jsonResponse({ connected: true, provider: "openai", clawaiConfigured: false });
    return jsonResponse({});
  }));
}

const sidebar = () => screen.getByRole("navigation", { name: "Settings" });
const rows = () => within(sidebar()).queryAllByRole("button").map((b) => b.textContent ?? "");
const hasRow = (label: string) => rows().some((text) => text.includes(label));

async function mount() {
  render(<SettingsApp ui={ui} />);
  await waitFor(() => expect(hasRow("Appearance")).toBe(true));
  await waitFor(() => expect(calls).toContain("GET /setup-api/users/me"));
}

beforeEach(() => {
  me = OWNER;
  passwordAnswer = { status: 200, body: { ok: true } };
  _resetSessionUserForTest();
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a member of staff on an organisation box", () => {
  beforeEach(() => {
    me = { ...IVAN, orgMode: true };
  });

  it("sees Appearance and Account, and none of the owner's sections", async () => {
    await mount();
    await waitFor(() => expect(hasRow("Account")).toBe(true));
    for (const label of ["Providers", "Local AI", "System", "Network", "System Update", "Messaging", "Remote", "About"]) {
      expect(hasRow(label), label).toBe(false);
    }
  });

  it("lands on Appearance when a link asks for a section that is not theirs", async () => {
    await mount();
    await waitFor(() => expect(hasRow("Account")).toBe(true));
    act(() => dispatchOpenSettingsSection("ai"));
    await waitFor(() => expect(screen.getByText("Language")).toBeInTheDocument());
    expect(screen.queryByTestId("ai-models-step")).toBeNull();
  });

  it("changes their own password from Account", async () => {
    await mount();
    await waitFor(() => expect(hasRow("Account")).toBe(true));
    fireEvent.click(within(sidebar()).getAllByRole("button").find((b) => (b.textContent ?? "").includes("Account"))!);
    const card = await screen.findByTestId("own-password-card");
    fireEvent.change(within(card).getByLabelText("Current password"), { target: { value: "old secret" } });
    fireEvent.change(within(card).getByLabelText("New password"), { target: { value: "new secret 1" } });
    fireEvent.change(within(card).getByLabelText("Confirm new password"), { target: { value: "new secret 1" } });
    fireEvent.click(within(card).getByTestId("own-password-save"));
    expect(await within(card).findByTestId("own-password-status")).toHaveTextContent("Your password was changed");
    expect(calls).toContain("POST /setup-api/users/me/password");
  });

  it("is told plainly when the current password is wrong", async () => {
    passwordAnswer = { status: 400, body: { code: "wrong_password", error: "x" } };
    await mount();
    await waitFor(() => expect(hasRow("Account")).toBe(true));
    fireEvent.click(within(sidebar()).getAllByRole("button").find((b) => (b.textContent ?? "").includes("Account"))!);
    const card = await screen.findByTestId("own-password-card");
    fireEvent.change(within(card).getByLabelText("Current password"), { target: { value: "nope" } });
    fireEvent.change(within(card).getByLabelText("New password"), { target: { value: "new secret 1" } });
    fireEvent.change(within(card).getByLabelText("Confirm new password"), { target: { value: "new secret 1" } });
    fireEvent.click(within(card).getByTestId("own-password-save"));
    expect(await within(card).findByTestId("own-password-status")).toHaveTextContent("Your current password is not right.");
  });
});

describe("what a section that is not drawn may still ask", () => {
  afterEach(() => {
    delete (window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection;
  });

  it("a member's deep link to System neither shows it nor polls its figures", async () => {
    me = { ...IVAN, orgMode: true };
    (window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection = "system";
    await mount();
    await waitFor(() => expect(hasRow("Account")).toBe(true));
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((c) => c.includes("/setup-api/system/stats"))).toEqual([]);
    expect(screen.getByText("Language")).toBeInTheDocument();
  });
});

describe("the ClawBox AI pitch in Providers", () => {
  const openProviders = () => fireEvent.click(within(sidebar()).getAllByRole("button").find((b) => (b.textContent ?? "").includes("Providers"))!);

  it("is shown to a home box's owner without ClawBox AI", async () => {
    await mount();
    openProviders();
    expect(await screen.findByTestId("clawai-pitch-card")).toBeInTheDocument();
  });

  it("is never shown on an organisation box, the owner included", async () => {
    me = { ...OWNER, orgMode: true };
    await mount();
    openProviders();
    await waitFor(() => expect(calls).toContain("GET /setup-api/ai-models/status"));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId("clawai-pitch-card")).toBeNull();
  });
});

describe("a user on a home box", () => {
  it("is not offered System Update from About", async () => {
    me = IVAN;
    await mount();
    await waitFor(() => expect(hasRow("Account")).toBe(true));
    fireEvent.click(within(sidebar()).getAllByRole("button").find((b) => (b.textContent ?? "").includes("About"))!);
    await screen.findByText("settings.version".replace("settings.version", translations.en["settings.version"] ?? "settings.version"));
    expect(screen.queryByTestId("settings-about-open-update")).toBeNull();
  });

  it("has Account, every app section, and no System Update", async () => {
    me = IVAN;
    await mount();
    await waitFor(() => expect(hasRow("Account")).toBe(true));
    expect(hasRow("Providers")).toBe(true);
    expect(hasRow("System Update")).toBe(false);
  });
});

describe("the owner", () => {
  it("keeps every section, on an organisation box too, and has no Account row", async () => {
    for (const orgMode of [false, true]) {
      me = { ...OWNER, orgMode };
      _resetSessionUserForTest();
      serve();
      const view = render(<SettingsApp ui={ui} />);
      await waitFor(() => expect(calls).toContain("GET /setup-api/users/me"));
      await waitFor(() => expect(hasRow("System Update")).toBe(true));
      for (const label of ["Providers", "Local AI", "System", "Network"]) expect(hasRow(label), `${label} (${orgMode})`).toBe(true);
      expect(hasRow("Account")).toBe(false);
      view.unmount();
    }
  });
});
