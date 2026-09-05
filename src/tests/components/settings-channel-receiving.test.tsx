/**
 * The Channels hub's green dot has to mean RECEIVING, not "configured".
 *
 * Each transport's own status route already answers the question — Telegram
 * publishes `configured && gateway.running`, WhatsApp `paired && running &&
 * authorized`, Discord `state === "connected"` — and the hub read none of them.
 * So a Hermes box with the bot saved and `hermes gateway` stopped drew the
 * emerald dot anyway, and on Discord that dot sat in the same row as the
 * subtitle "Offline", contradicting the words beside it.
 *
 * THE TRAP THIS ALSO PINS, in both directions. A route that says NOTHING —
 * `/setup-api/email/status` by design, and every box still on a build whose
 * Telegram route had no `receiving` key — must read as unknown, or a naive
 * `receiving === true` gate blanks the dot on a working box. And a route that
 * says `null` — "the gateway could not be asked", which every Save's gateway
 * restart produces — must not read as a definite no, or the panel accuses a
 * healthy bot. Both are the same false failure, inverted.
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

/** What each status route answers this run. */
let telegram: Record<string, unknown>;
let discord: Record<string, unknown>;
let whatsapp: Record<string, unknown>;

function json(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  // A Hermes box with a bot saved and its gateway stopped.
  telegram = { configured: true, verified: true, receiving: false, username: "clawbot" };
  // Configured, token fine, and not connected — the row where the dot used to
  // contradict its own subtitle.
  discord = { configured: true, receiving: false, state: "offline", username: "clawbot" };
  whatsapp = { supported: true, state: "paired", authorized: true, receiving: true };

  (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection = "channels";

  vi.stubGlobal("fetch", vi.fn((input: string | URL) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/telegram/status")) return json(telegram);
    if (url.startsWith("/setup-api/discord/status")) return json(discord);
    if (url.startsWith("/setup-api/whatsapp/status")) return json(whatsapp);
    if (url.startsWith("/setup-api/email/status")) {
      return json({ configured: false, address: null, allowedSenders: [], mode: "send" });
    }
    return json({});
  }));
});

/**
 * The row's state once its status route has answered. Waited for as "no longer
 * asking" rather than as the expected value, so a wrong answer fails on the
 * assertion that names it instead of on a five-second timeout.
 */
async function settledState(id: string): Promise<string | null> {
  const row = await screen.findByTestId(`settings-channel-${id}`);
  await waitFor(() => expect(row.getAttribute("data-state")).not.toBe("unknown"));
  return row.getAttribute("data-state");
}

describe("the Channels hub dot", () => {
  it("says silent for a channel that is set up and not receiving", async () => {
    render(<SettingsApp ui={ui} />);
    expect(await settledState("telegram")).toBe("silent");
    // The dot is decoration, so the fact has to reach a screen reader through
    // the row's words.
    const row = await screen.findByTestId("settings-channel-telegram");
    expect(row.textContent).toContain("settings.channelNotReceiving");
    expect(row.textContent).not.toContain("@clawbot");
  });

  it("says silent on Discord, where the dot used to contradict its own subtitle", async () => {
    render(<SettingsApp ui={ui} />);
    expect(await settledState("discord")).toBe("silent");
    const row = await screen.findByTestId("settings-channel-discord");
    // Discord already worded its own state; only the dot was wrong.
    expect(row.textContent).toContain("settings.discordStateOffline");
  });

  it("does not read a route that COULD NOT ASK as not receiving", async () => {
    // The false failure the other direction. The OpenClaw Discord branch maps
    // `state: null` — "the gateway could not be asked", which every Save's
    // gateway restart produces — and flattening that into `receiving: false`
    // would paint amber over a bot answering in a guild, with the subtitle
    // still reading "@clawbot" and nothing saying otherwise.
    discord = { configured: true, verified: false, state: null, receiving: null, username: "clawbot" };
    telegram = { configured: true, verified: false, receiving: null, username: "clawbot" };
    render(<SettingsApp ui={ui} />);
    expect(await settledState("discord")).toBe("connected");
    expect(await settledState("telegram")).toBe("connected");
    const row = await screen.findByTestId("settings-channel-telegram");
    expect(row.textContent).toContain("@clawbot");
    expect(row.textContent).not.toContain("settings.channelNotReceiving");
  });

  it("stays connected for a channel that IS receiving", async () => {
    render(<SettingsApp ui={ui} />);
    expect(await settledState("whatsapp")).toBe("connected");
  });

  it("does not read a MISSING receiving field as false (an older server)", async () => {
    // A box that has not been updated yet answers configured + bot info and
    // nothing else — the shape every OpenClaw box had before the route learned
    // to ask `openclaw channels status`. That is "this box cannot say", not
    // "no", and `/setup-api/email/status` publishes no such field by design.
    telegram = { configured: true, username: "clawbot" };
    render(<SettingsApp ui={ui} />);
    expect(await settledState("telegram")).toBe("connected");
    const row = await screen.findByTestId("settings-channel-telegram");
    expect(row.textContent).toContain("@clawbot");
  });

  it("still treats a silent channel as one the owner has set up", async () => {
    // The account IS set up; "how many channels have you connected" is a
    // different question from "how many are live", and only the dot answers
    // the second one.
    render(<SettingsApp ui={ui} />);
    expect(await settledState("telegram")).toBe("silent");
    const telegramRow = await screen.findByTestId("settings-channel-telegram");
    // The icon stays lit: a silent channel is still a configured one, and the
    // hub's "N connected" count still asks `channelConnected`.
    const icon = telegramRow.querySelector<HTMLElement>(".material-symbols-rounded");
    expect(icon?.style.color).toBe("var(--coral-bright)");
    expect(telegramRow.textContent).not.toContain("settings.notConfigured");
  });
});
