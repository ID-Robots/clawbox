/**
 * What the WhatsApp pairing card says when the bridge will not start.
 *
 * The panel renders ONE snapshot for two harnesses, and each one has its own
 * vocabulary for the same failure: the Hermes manager says `bridge_missing`
 * when its Baileys script is absent, the OpenClaw one says `plugin_missing`
 * when the gateway answers "web login provider is not available". Only the
 * first was ever mapped, so on an OpenClaw box the one diagnosable failure
 * fell through to "Something went wrong while starting the bridge." — a
 * sentence that names nothing and offers nothing but the same button again.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "en", name: "English" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));
vi.mock("next/image", () => ({ default: () => null }));

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

/** The snapshot POST /setup-api/whatsapp/pair answers with this run. */
let pairSnapshot: Record<string, unknown>;

function json(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  // An OpenClaw box that has never had the channel saved: nothing paired, and
  // "Link your phone" is the only thing on the card to press.
  pairSnapshot = { supported: true, phase: "error", error: "plugin_missing", qrCount: 0, restarts: 0 };

  (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection =
    "whatsapp";

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/whatsapp/status")) {
        return json({
          supported: true,
          harness: "openclaw",
          state: "not_configured",
          enabled: false,
          paired: false,
          verified: true,
          allowlistSupported: false,
          mode: null,
          allowedUsers: [],
          allowAllUsers: false,
          receiving: false,
        });
      }
      if (url.startsWith("/setup-api/whatsapp/pair")) {
        // Only the start; the poller's GET must not answer the same snapshot
        // and re-render it as a second failure.
        return init?.method === "POST" ? json(pairSnapshot) : json({ supported: true, phase: "idle" });
      }
      return json({});
    }),
  );
});

/** Press "Link your phone" and wait for the card to render the refusal. */
async function pairAndReadError(): Promise<string> {
  render(<SettingsApp ui={ui} />);
  const start = await screen.findByTestId("whatsapp-pair-start");
  start.click();
  const alert = await screen.findByRole("alert");
  await waitFor(() => expect(alert.textContent).toContain("settings.whatsappPairErr"));
  return alert.textContent ?? "";
}

describe("the WhatsApp pairing card's error text", () => {
  it("names the missing bridge when OpenClaw's gateway has no login provider", async () => {
    expect(await pairAndReadError()).toContain("settings.whatsappPairErrBridge");
  });

  it("still names the missing bridge in the Hermes wording", async () => {
    pairSnapshot = { supported: true, phase: "error", error: "bridge_missing" };
    expect(await pairAndReadError()).toContain("settings.whatsappPairErrBridge");
  });

  it("keeps the install failure separate — that one is a network problem", async () => {
    pairSnapshot = { supported: true, phase: "error", error: "install_failed" };
    expect(await pairAndReadError()).toContain("settings.whatsappPairErrInstall");
  });

  it("falls back to the generic sentence only for a code it has no words for", async () => {
    pairSnapshot = { supported: true, phase: "error", error: "start_failed" };
    expect(await pairAndReadError()).toContain("settings.whatsappPairErrGeneric");
  });
});
