import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { resetHarnessCache } from "@/lib/client-harness";
import { OPEN_ANTHROPIC_ACCOUNTS_SETTINGS } from "@/lib/notify-action";
import { dispatchOpenSettingsSection } from "@/lib/ui-events";
import { translations } from "@/lib/translations";

/**
 * Settings → Providers and the Anthropic accounts (TASK-902).
 *
 * The accounts used to be a card of their own under the connect panel, always
 * open and re-reading the pool for anyone who opened Providers for any reason.
 * They now hang off the Anthropic row of the provider list behind a button,
 * shut until asked for, and only where that row exists — accounts need an
 * Anthropic sign-in.
 *
 * The coding agent's usage-limit notices are the one caller that asks for
 * them: clicking one has to land on Providers with the accounts OPEN and the
 * row in view, whether Settings was already up or opens cold.
 */

// Every case mounts the WHOLE settings app and then waits on the provider
// list, the accounts card and a scroll in series — the budget settings-app.test.tsx
// gives the same mount, for the same reason.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

const ANTHROPIC_ROW = { id: "anthropic", label: "Anthropic Claude", state: "connected", isDefault: false, section: "ai", enabled: true };
const CLAWAI_ROW = { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai", enabled: true };

const POOL = {
  accounts: [{ id: "aaaaaaaa", label: "Work Max", email: null, kind: "oauth", status: "limited", limitedUntil: Date.now() + 3_600_000, priority: 1, active: false }],
  health: { total: 1, healthy: 0, limited: 1, allLimited: true, nextResetAt: Date.now() + 3_600_000 },
  activeAccountId: null,
  loginAvailable: false,
};

type PendingWindow = Window & { __clawboxPendingSettingsSection?: unknown; __clawboxPendingSettingsFocus?: unknown };

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

let accountReads = 0;

/** A linked box whose provider list holds these rows; everything else quiet. */
function serve(providers: unknown[]) {
  accountReads = 0;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
    const url = String(input ?? "");
    if (url.startsWith("/setup-api/anthropic/accounts")) {
      accountReads += 1;
      return jsonResponse(POOL);
    }
    if (url === "/setup-api/ai-models/status") {
      return jsonResponse({
        connected: true,
        provider: "clawai",
        providerLabel: "ClawBox AI",
        mode: null,
        model: null,
        clawaiTier: null,
        clawaiConfigured: true,
        clawaiTokenRejected: false,
      });
    }
    if (url.startsWith("/setup-api/ai-models/usage")) return jsonResponse({ available: false, reason: "unreachable" });
    if (url === "/setup-api/ai-models/oauth/providers") return jsonResponse({ providers: [] });
    if (url.startsWith("/setup-api/harness/active")) return jsonResponse({ edition: "openclaw", active: "openclaw" });
    if (url.startsWith("/setup-api/providers/status")) {
      return jsonResponse({ harness: "openclaw", defaultProvider: "clawai", degraded: false, providers });
    }
    if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
    if (url.startsWith("/setup-api/system/stats")) return jsonResponse({ overview: {} });
    if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
    return jsonResponse({});
  }));
}

function openSection(section: string, focus?: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: focus ? { section, focus } : { section } }));
  });
}

describe("Settings → Providers: the Anthropic accounts behind the Anthropic row", () => {
  const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  let scrolled: Element[] = [];

  beforeEach(() => {
    resetHarnessCache();
    serve([CLAWAI_ROW, ANTHROPIC_ROW]);
    scrolled = [];
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value(this: Element) { scrolled.push(this); },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
    delete (window as PendingWindow).__clawboxPendingSettingsSection;
    delete (window as PendingWindow).__clawboxPendingSettingsFocus;
  });

  it("opens Providers with the accounts folded away — no card of their own, and the pool not read", async () => {
    render(<SettingsApp ui={defaultUi} />);
    openSection("ai");

    const toggle = await screen.findByTestId("anthropic-accounts-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("ai-provider-controls-anthropic")).toContainElement(toggle);
    // The standalone card is gone from the page, not merely moved down it.
    expect(screen.queryByTestId("anthropic-accounts")).toBeNull();
    expect(accountReads).toBe(0);
    expect(scrolled).toEqual([]);
  });

  it("lands an open Settings window on the accounts, open and scrolled into view, from a limit notice", async () => {
    render(<SettingsApp ui={defaultUi} />);
    // Settings is up on its default page when the owner clicks the notice.
    act(() => { dispatchOpenSettingsSection(OPEN_ANTHROPIC_ACCOUNTS_SETTINGS.section, OPEN_ANTHROPIC_ACCOUNTS_SETTINGS.focus); });

    const panel = await screen.findByTestId("anthropic-accounts-panel");
    expect(screen.getByTestId("anthropic-accounts-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(panel).toContainElement(await screen.findByTestId("anthropic-accounts"));
    await waitFor(() => expect(scrolled).toContain(screen.getByTestId("ai-provider-anthropic")));
    // The handoff was taken by the window that applied it.
    expect((window as PendingWindow).__clawboxPendingSettingsSection).toBeUndefined();
    expect((window as PendingWindow).__clawboxPendingSettingsFocus).toBeUndefined();
  });

  it("does the same on a COLD open, from the handoff the notice left on window", async () => {
    (window as PendingWindow).__clawboxPendingSettingsSection = "ai";
    (window as PendingWindow).__clawboxPendingSettingsFocus = "anthropicAccounts";
    render(<SettingsApp ui={defaultUi} />);

    expect(await screen.findByTestId("anthropic-accounts-panel")).toBeInTheDocument();
    expect(screen.getByTestId("anthropic-accounts-toggle")).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(scrolled).toContain(screen.getByTestId("ai-provider-anthropic")));
    expect((window as PendingWindow).__clawboxPendingSettingsFocus).toBeUndefined();
  });

  it("asks once: coming back to Providers later finds the accounts folded again", async () => {
    render(<SettingsApp ui={defaultUi} />);
    openSection("ai", "anthropicAccounts");
    await screen.findByTestId("anthropic-accounts-panel");

    openSection("appearance");
    await waitFor(() => expect(screen.queryByTestId("ai-provider-list")).toBeNull());
    openSection("ai");

    const toggle = await screen.findByTestId("anthropic-accounts-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("anthropic-accounts-panel")).toBeNull();
  });

  it("ignores the focus on any section but Providers", async () => {
    render(<SettingsApp ui={defaultUi} />);
    openSection("appearance", "anthropicAccounts");
    openSection("ai");

    const toggle = await screen.findByTestId("anthropic-accounts-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("anthropic-accounts-panel")).toBeNull();
  });

  it("shows no accounts UI on a box with no Anthropic sign-in, even when a notice asks for it", async () => {
    serve([CLAWAI_ROW]);
    render(<SettingsApp ui={defaultUi} />);
    openSection("ai", "anthropicAccounts");

    await screen.findByTestId("ai-provider-clawai");
    expect(screen.queryByTestId("anthropic-accounts-toggle")).toBeNull();
    expect(screen.queryByTestId("anthropic-accounts-panel")).toBeNull();
    expect(screen.queryByTestId("anthropic-accounts")).toBeNull();
    expect(accountReads).toBe(0);
  });
});
