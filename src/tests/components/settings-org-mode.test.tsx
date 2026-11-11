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

function serve() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined, init?: RequestInit) => {
    const url = String(input ?? "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === "/setup-api/users/me") return jsonResponse(me);
    if (url === "/setup-api/users/me/password") return jsonResponse(passwordAnswer.body, passwordAnswer.status);
    if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
    if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
    if (url === "/setup-api/harness/active") return jsonResponse({ active: "openclaw", edition: "openclaw", activeKnown: true });
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

describe("a user on a home box", () => {
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
