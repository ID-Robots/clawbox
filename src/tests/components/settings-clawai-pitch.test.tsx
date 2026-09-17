import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { translations } from "@/lib/translations";

/**
 * Settings → Providers on a box with NO ClawBox AI subscription.
 *
 * The owner's decision of 2026-09-15: a subscriber's box runs the cloud
 * models by default and only goes local when the owner says so, and a box
 * with no subscription is told — in as many words — that ClawBox AI is the
 * best experience and how to get it, WITH the way to stay local beside it.
 *
 * What the box did instead: the one sentence about a missing subscription
 * lived on the cloud-defaults card inside Settings → Local AI, which the
 * per-model inventory rewrite deleted, so an unlinked box said nothing at all
 * — no pitch, no subscribe path, and nowhere pointing an owner who WANTS to
 * stay local at the tab that sets that up.
 *
 * The pitch is on the Providers page rather than back inside Local AI because
 * that page is where the provider decision is made, and Local AI is the plain
 * inventory the owner asked for.
 */

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

/** A box whose ClawBox AI link is `configured` or not; everything else quiet. */
function serve(clawaiConfigured: boolean, edition: "openclaw" | "hermes" = "openclaw") {
  vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
    const url = String(input ?? "");
    if (url === "/setup-api/ai-models/status") {
      return jsonResponse({
        connected: clawaiConfigured,
        provider: clawaiConfigured ? "clawai" : null,
        providerLabel: clawaiConfigured ? "ClawBox AI" : null,
        mode: null,
        model: null,
        clawaiTier: null,
        clawaiConfigured,
        clawaiTokenRejected: false,
      });
    }
    if (url === "/setup-api/ai-models/oauth/providers") return jsonResponse({ providers: [] });
    if (url.startsWith("/setup-api/harness/active")) return jsonResponse({ edition, active: edition });
    if (url.startsWith("/setup-api/hermes/clawai")) return jsonResponse({ active: false, hasToken: false, model: null });
    if (url.startsWith("/setup-api/hermes/")) return jsonResponse({});
    if (url === "/setup-api/providers/status") {
      return jsonResponse({ harness: "openclaw", defaultProvider: "clawai", degraded: false, providers: [] });
    }
    if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
    if (url.startsWith("/setup-api/local-models")) return jsonResponse({ models: [], unavailable: [] });
    if (url.startsWith("/setup-api/local-ai/exclusive")) return jsonResponse({ enabled: false });
    if (url === "/setup-api/system/stats") return jsonResponse({ overview: {} });
    if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
    return jsonResponse({});
  }));
}

function openProviders() {
  window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section: "ai" } }));
}

describe("Settings → Providers: the ClawBox AI pitch on an unlinked box", () => {
  beforeEach(() => serve(false));
  afterEach(() => vi.unstubAllGlobals());

  it("pitches ClawBox AI, in the owner's language, with the subscribe path", async () => {
    render(<SettingsApp ui={defaultUi} />);
    openProviders();

    const card = await screen.findByTestId("clawai-pitch-card");
    expect(card).toHaveTextContent(translations.en["settings.clawaiPitch.title"]);
    expect(card).toHaveTextContent(translations.en["settings.clawaiPitch.body"]);
    // The plans link goes to the portal, in a tab of its own.
    const plans = screen.getByTestId("clawai-pitch-plans");
    expect(plans).toHaveAttribute("href", expect.stringContaining("clawbox.com/portal"));
    expect(plans).toHaveAttribute("target", "_blank");
  });

  it("starts the ClawBox AI sign-in from the card's own button", async () => {
    render(<SettingsApp ui={defaultUi} />);
    openProviders();

    fireEvent.click(await screen.findByTestId("clawai-pitch-connect"));
    // The connect panel below is what performs the device-code handoff — the
    // card's job is to ask it for one, which is the request that leaves the
    // box. Asserting the button "did something" would pass on a card that
    // only selected a radio.
    await waitFor(() =>
      expect(
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
          .some(([input]) => String(input ?? "").startsWith("/setup-api/ai-models/clawai/start")),
      ).toBe(true),
    );
  });

  it("offers the owner who wants to stay local the way to Local AI", async () => {
    render(<SettingsApp ui={defaultUi} />);
    openProviders();

    const card = await screen.findByTestId("clawai-pitch-card");
    expect(card).toHaveTextContent(translations.en["settings.clawaiPitch.localBody"]);
    fireEvent.click(screen.getByTestId("clawai-pitch-local"));
    // The Local AI tab, not a dead end: the panel that owns the on-device
    // engines is what opens.
    expect(await screen.findByTestId("local-ai-panel")).toBeInTheDocument();
  });

  // The Hermes edition answers this page with HermesProviderConfig, which
  // draws its own ClawBox AI sign-in once the provider is selected. The offer
  // counter is read there by an AIModelsStep that returns before it renders
  // anything, so a card that fired it would start a device login with no card
  // on screen to show the code.
  it("puts a Hermes box in front of that edition's own ClawBox AI sign-in", async () => {
    serve(false, "hermes");
    render(<SettingsApp ui={defaultUi} />);
    openProviders();

    fireEvent.click(await screen.findByTestId("clawai-pitch-connect"));
    // The ClawBox AI pane of that panel — the plan summary its sign-in card
    // sits under — rather than a radio's checked state.
    expect(await screen.findByTestId("clawai-plan-summary")).toBeInTheDocument();
    // …and nothing was started behind the owner's back on the other edition's
    // route, which has no card here to show its code.
    expect(
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
        .some(([input]) => String(input ?? "").startsWith("/setup-api/ai-models/clawai/start")),
    ).toBe(false);
  });

  it("says nothing on a box that already holds a ClawBox AI credential", async () => {
    serve(true);
    render(<SettingsApp ui={defaultUi} />);
    openProviders();

    // The providers list is up, so the section has rendered…
    await screen.findByTestId("ai-provider-list");
    // …and the pitch is not part of it.
    await waitFor(() => expect(screen.queryByTestId("clawai-pitch-card")).toBeNull());
  });
});
