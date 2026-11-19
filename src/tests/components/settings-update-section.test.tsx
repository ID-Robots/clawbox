import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { translations } from "@/lib/translations";
import { LINKED_BOXES_FLAG_EVENT } from "@/lib/box-switcher";

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

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

/**
 * The system update is a Settings page of its own now — versions, the run,
 * beta channel, branch pin, force — and About's tile only points there.
 */
describe("Settings → System Update", () => {
  // The box's preferences, as GET/POST /setup-api/preferences keep them.
  let prefs: Record<string, unknown>;
  // The answers to the switch's read, held by hand when a case needs /users/me to be first.
  let holdSwitch: boolean;
  let heldSwitch: Array<() => void>;
  beforeEach(() => {
    prefs = {};
    holdSwitch = false;
    heldSwitch = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined, init?: RequestInit) => {
      const url = String(input ?? "");
      if (url.startsWith("/setup-api/preferences")) {
        if (init?.method === "POST") Object.assign(prefs, JSON.parse(String(init.body)));
        else if (holdSwitch && url.includes("ui_linked_boxes")) {
          return new Promise((resolve) => { heldSwitch.push(() => resolve(jsonResponse(prefs))); });
        }
        return jsonResponse(prefs);
      }
      if (url.startsWith("/setup-api/update/versions")) {
        return jsonResponse({ clawbox: { current: "v4.0.0", target: "v4.1.0", updateAvailable: true }, openclaw: { current: "2.0.0", target: null } });
      }
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url === "/setup-api/system/update-branch") return jsonResponse({ branch: "" });
      if (url.startsWith("/setup-api/system/stats")) return jsonResponse({ overview: { hostname: "clawbox", os: "Linux", kernel: "5.15", arch: "arm64", platform: "linux", uptime: "1h" } });
      if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
      if (url === "/setup-api/system/hotspot") return jsonResponse({ enabled: true, ssid: "ClawBox-Setup" });
      if (url === "/setup-api/ai-models/status") return jsonResponse({ connected: false, provider: null, providerLabel: null, mode: null, model: null });
      if (url === "/setup-api/ai-models/oauth/providers") return jsonResponse({ providers: [] });
      if (url === "/setup-api/providers/status") return jsonResponse({ harness: "openclaw", defaultProvider: "clawai", degraded: false, providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: false });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      return jsonResponse({});
    }));
  });
  afterEach(() => {
    delete (window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection;
    vi.unstubAllGlobals();
  });

  it("has its own entry in the sidebar, and About's tile switches to it", async () => {
    render(<SettingsApp ui={defaultUi} />);
    const nav = await screen.findByRole("navigation");
    const entries = Array.from(nav.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(entries.some((e) => e.includes(translations.en["settings.systemUpdate"]))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(translations.en["settings.about"]) }));
    const tile = await screen.findByTestId("settings-about-open-update");
    // The beta toggle left About with the rest of the update.
    expect(screen.queryByText(translations.en["settings.betaChannel"])).toBeNull();
    fireEvent.click(tile);
    expect(await screen.findByTestId("settings-update-section")).toBeInTheDocument();
    expect(await screen.findByTestId("system-update-app")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/1 update available/)).toBeInTheDocument());
  });

  it("says in the sidebar when an update is waiting", async () => {
    render(<SettingsApp ui={defaultUi} />);
    const nav = await screen.findByRole("navigation");
    await waitFor(() => expect(nav.textContent).toContain("v4.0.0 → v4.1.0"));
  });

  describe("Linked ClawBoxes (experimental)", () => {
    const label = translations.en["settings.linkedBoxes"];
    const navEntries = (nav: HTMLElement) => Array.from(nav.querySelectorAll("button")).map((b) => b.textContent ?? "");
    const flagAsked = () => expect(fetch).toHaveBeenCalledWith(
      "/setup-api/preferences?keys=ui_linked_boxes",
      expect.anything(),
    );

    it("has no page in the sidebar while the switch is off, and gets it the moment it is switched on", async () => {
      render(<SettingsApp ui={defaultUi} />);
      const nav = await screen.findByRole("navigation");
      await waitFor(flagAsked);
      // The answer (off) is read once the fetch's promises have settled: one task.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(navEntries(nav).some((e) => e.includes(label))).toBe(false);
      act(() => { window.dispatchEvent(new CustomEvent(LINKED_BOXES_FLAG_EVENT, { detail: true })); });
      await waitFor(() => expect(navEntries(nav).some((e) => e.includes(label))).toBe(true));
    });

    it("has its page in the sidebar once the switch is on, and opens it", async () => {
      prefs = { ui_linked_boxes: true };
      render(<SettingsApp ui={defaultUi} />);
      fireEvent.click(await screen.findByRole("button", { name: new RegExp(label) }));
      expect(await screen.findByTestId("linked-boxes-panel")).toBeInTheDocument();
    });

    describe("a deep link to the page, when /users/me answers before the switch does", () => {
      async function openLinkedBoxes() {
        holdSwitch = true;
        (window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection = "linkedBoxes";
        render(<SettingsApp ui={defaultUi} />);
        await waitFor(() => expect(fetch).toHaveBeenCalledWith("/setup-api/users/me", expect.anything()));
        await waitFor(() => expect(heldSwitch).toHaveLength(1));
        // /users/me has settled by now; the switch's answer is still out.
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(screen.queryByTestId("linked-boxes-panel")).toBeNull();
      }

      it("is kept while the switch is unanswered, and opens once it is on", async () => {
        prefs = { ui_linked_boxes: true };
        await openLinkedBoxes();
        await act(async () => { heldSwitch[0](); });
        expect(await screen.findByTestId("linked-boxes-panel")).toBeInTheDocument();
      });

      it("is dropped once the switch is answered off: switching it on later does not bring the link back", async () => {
        await openLinkedBoxes();
        await act(async () => { heldSwitch[0](); });
        act(() => { window.dispatchEvent(new CustomEvent(LINKED_BOXES_FLAG_EVENT, { detail: true })); });
        await screen.findByRole("button", { name: new RegExp(label) });
        expect(screen.queryByTestId("linked-boxes-panel")).toBeNull();
      });
    });

    it("is switched on and off in Advanced options, and the sidebar follows", async () => {
      render(<SettingsApp ui={defaultUi} />);
      const nav = await screen.findByRole("navigation");
      fireEvent.click(screen.getByRole("button", { name: new RegExp(translations.en["settings.systemUpdate"]) }));
      fireEvent.click(await screen.findByRole("button", { name: translations.en["update.advancedOptions"] }));
      const toggle = await screen.findByRole("switch", { name: translations.en["update.linkedBoxesExperimental"] });
      expect(toggle).toHaveAttribute("aria-checked", "false");

      fireEvent.click(toggle);
      await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
      expect(prefs).toEqual({ ui_linked_boxes: true });
      expect(navEntries(nav).some((e) => e.includes(label))).toBe(true);

      fireEvent.click(toggle);
      await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
      expect(prefs).toEqual({ ui_linked_boxes: false });
      expect(navEntries(nav).some((e) => e.includes(label))).toBe(false);
    });
  });
});
