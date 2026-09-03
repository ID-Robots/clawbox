/**
 * Settings → Channels must tell the truth on its FIRST render.
 *
 * THE BUG THIS PINS. The hub row for each channel reads `channelConnected()`,
 * which reads the very same React state each channel's own PANE fills — and
 * every one of those fetches was gated behind `section === "<that channel>"`.
 * Open Settings → Channels on a desktop and nothing was ever asked, so a box
 * with Email and WhatsApp both configured drew them with no dot and their
 * static hint, exactly as if they were not set up. Only after the owner had
 * opened each pane did the hub start telling the truth.
 *
 * Reported on a Hermes box where /setup-api/email/status answered
 * `configured: true` and /setup-api/whatsapp/status answered `state: "paired"`
 * on a cold read — the routes were right, the list never asked them.
 *
 * The sidebar row is the same bug one level up: with nothing read yet it
 * counted zero connected channels and said "Not configured".
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

vi.setConfig({ testTimeout: 20_000 });

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

/** A masked address of the shape the status route returns. Not a real one. */
const MASKED_ADDRESS = "b••x@example.com";
const BOT_USERNAME = "clawbox_test_bot";

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

/**
 * A Hermes box exactly like the one in the report: Telegram, Email and
 * WhatsApp all configured, Discord genuinely not.
 */
function boxFetch(input: string | URL) {
  const url = input.toString();
  if (url.startsWith("/setup-api/telegram/status")) {
    return jsonResponse({ configured: true, username: BOT_USERNAME, receiving: true });
  }
  if (url.startsWith("/setup-api/email/status")) {
    return jsonResponse({
      configured: true,
      address: MASKED_ADDRESS,
      hasPassword: true,
      mode: "read",
      askBeforeSend: true,
      allowedSenders: [],
      pendingCount: 0,
      harness: "hermes",
      inboundSupported: true,
      defaults: { smtpHost: "smtp.example.com", smtpPort: 587, imapHost: "imap.example.com" },
    });
  }
  if (url.startsWith("/setup-api/whatsapp/status")) {
    return jsonResponse({
      supported: true,
      harness: "hermes",
      state: "paired",
      enabled: true,
      paired: true,
      authorized: true,
      bridgeReady: true,
      receiving: true,
      allowedUsers: [],
    });
  }
  if (url.startsWith("/setup-api/discord/status")) {
    return jsonResponse({ configured: false, harness: "hermes" });
  }
  return jsonResponse({});
}

/** The green dot the owner reads as "this channel is live". */
function hasDot(row: HTMLElement): boolean {
  return row.querySelector(".bg-emerald-400") !== null;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(boxFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection;
});

describe("Settings → Channels on a cold open", () => {
  /** Land straight on the hub, the way the owner's deep link does. */
  function openHub() {
    (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection =
      "channels";
    return render(<SettingsApp ui={ui} />);
  }

  it("shows every configured channel as configured without visiting its pane", async () => {
    openHub();
    const list = await screen.findByTestId("settings-channels-list");

    const email = within(list).getByTestId("settings-channel-email");
    await waitFor(() => expect(email).toHaveTextContent(MASKED_ADDRESS));
    expect(hasDot(email)).toBe(true);
    expect(email).toHaveAttribute("data-state", "connected");

    const whatsapp = within(list).getByTestId("settings-channel-whatsapp");
    await waitFor(() => expect(whatsapp).toHaveTextContent("settings.whatsappActive"));
    expect(hasDot(whatsapp)).toBe(true);
    expect(whatsapp).toHaveAttribute("data-state", "connected");

    const telegram = within(list).getByTestId("settings-channel-telegram");
    await waitFor(() => expect(telegram).toHaveTextContent(`@${BOT_USERNAME}`));
    expect(hasDot(telegram)).toBe(true);
    expect(telegram).toHaveAttribute("data-state", "connected");
  });

  it("still calls a genuinely unconfigured channel unconfigured", async () => {
    openHub();
    const list = await screen.findByTestId("settings-channels-list");

    const discord = within(list).getByTestId("settings-channel-discord");
    await waitFor(() => expect(discord).toHaveTextContent("settings.notConfigured"));
    expect(hasDot(discord)).toBe(false);
    expect(discord).toHaveAttribute("data-state", "not-configured");
  });

  it("says 'still asking', not 'not configured', while a status is in flight", async () => {
    // A status route that never answers — the Jetson's WhatsApp probe shells
    // out and takes seconds. Nothing may be claimed about the channel yet.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) =>
        input.toString().startsWith("/setup-api/whatsapp/status")
          ? new Promise<Response>(() => {})
          : boxFetch(input),
      ),
    );

    openHub();
    const list = await screen.findByTestId("settings-channels-list");
    const whatsapp = within(list).getByTestId("settings-channel-whatsapp");

    // The other three settle; this one stays honestly unknown.
    await waitFor(() =>
      expect(within(list).getByTestId("settings-channel-discord")).toHaveAttribute(
        "data-state",
        "not-configured",
      ),
    );
    expect(whatsapp).toHaveAttribute("data-state", "unknown");
    expect(whatsapp).not.toHaveTextContent("settings.notConfigured");
    expect(hasDot(whatsapp)).toBe(false);
  });

  it("asks for no channel status at all from a section that shows none", async () => {
    // The hub's four GETs are the cost this fix accepts. A regression that made
    // the gate unconditional would keep every other test in this file green
    // while re-reading all four CLI-backed routes on every Settings open.
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    const statusCalls = (fetch as unknown as Mock).mock.calls
      .map(([input]) => String(input))
      .filter((url) => /^\/setup-api\/(telegram|email|whatsapp|discord)\/status/.test(url));
    expect(statusCalls).toEqual([]);
  });

  it("stops claiming it is still asking once a status read has failed", async () => {
    // The routes 5xx while the gateway restarts. The refreshers deliberately
    // keep the last known value, and on a cold open there is none — so without
    // a settled marker this row pulsed "checking" for the life of the session.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) =>
        input.toString().startsWith("/setup-api/whatsapp/status")
          ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response)
          : boxFetch(input),
      ),
    );

    openHub();
    const list = await screen.findByTestId("settings-channels-list");
    const whatsapp = within(list).getByTestId("settings-channel-whatsapp");

    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "unreachable"));
    // Neither a green dot nor a claim either way, and nothing still animating.
    expect(hasDot(whatsapp)).toBe(false);
    expect(whatsapp).not.toHaveTextContent("settings.notConfigured");
    expect(whatsapp.querySelector(".animate-pulse")).toBeNull();
  });

  it("re-asks a channel when its pane is opened, so a failed hub read is never final", async () => {
    // PROBE-ONCE. The hub reads every channel on open; entering a pane must
    // still re-ask. Otherwise a status that failed on the cold read is treated
    // as fact for the life of the Settings mount and the pane sits on its
    // loading skeleton forever, with no request ever issued to clear it.
    let waCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = input.toString();
        if (url.startsWith("/setup-api/whatsapp/status")) {
          waCalls += 1;
          // The gateway is restarting: the cold hub read fails.
          if (waCalls === 1) {
            return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response);
          }
        }
        return boxFetch(input);
      }),
    );

    openHub();
    const list = await screen.findByTestId("settings-channels-list");
    const whatsapp = within(list).getByTestId("settings-channel-whatsapp");
    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "unreachable"));
    expect(waCalls).toBe(1);

    // The owner clicks the row to find out what is wrong.
    fireEvent.click(whatsapp);

    await waitFor(() => expect(waCalls).toBeGreaterThan(1));
  });

  it("offers a retry on a channel whose status could not be read", async () => {
    let waCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = input.toString();
        if (url.startsWith("/setup-api/whatsapp/status")) {
          waCalls += 1;
          if (waCalls === 1) {
            return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response);
          }
        }
        return boxFetch(input);
      }),
    );

    openHub();
    const list = await screen.findByTestId("settings-channels-list");
    const whatsapp = within(list).getByTestId("settings-channel-whatsapp");
    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "unreachable"));

    // The row must SAY the read failed, not fall back to the generic hint that
    // reads exactly like a channel nobody has set up.
    expect(whatsapp).toHaveTextContent("settings.statusUnavailable");
    expect(whatsapp).not.toHaveTextContent("settings.channelsWhatsappHint");

    const retry = within(list).getByTestId("settings-channel-retry-whatsapp");
    fireEvent.click(retry);

    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "connected"));
  });

  /**
   * THE OTHER SKU. On OpenClaw and dual, /setup-api/whatsapp/status answers
   * HTTP 200 with `state: "not_configured"` when the gateway could not be
   * asked at all — so "the route answered" is not the same as "the route knew
   * anything", and a list that cannot tell the two apart prints "Not
   * configured" over a paired phone. `verified` is what separates them.
   */
  function openclawWhatsapp(extra: Record<string, unknown>) {
    return (input: string | URL) =>
      input.toString().startsWith("/setup-api/whatsapp/status")
        ? jsonResponse({
            supported: true,
            harness: "openclaw",
            allowlistSupported: false,
            mode: null,
            allowedUsers: [],
            ...extra,
          })
        : boxFetch(input);
  }

  it("says a paired OpenClaw channel could not be checked, never 'not configured'", async () => {
    // Gateway restarting: the row is null, so the route has to say
    // not_configured — but it says so unverified.
    vi.stubGlobal("fetch", vi.fn(openclawWhatsapp({ state: "not_configured", verified: false })));

    openHub();
    const list = await screen.findByTestId("settings-channels-list");
    const whatsapp = within(list).getByTestId("settings-channel-whatsapp");

    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "unreachable"));
    expect(whatsapp).toHaveTextContent("settings.statusUnavailable");
    // The exact words TASK-689 exists to remove, on the other edition.
    expect(whatsapp).not.toHaveTextContent("settings.notConfigured");
    expect(within(list).getByTestId("settings-channel-retry-whatsapp")).toBeTruthy();
  });

  it("still calls an unconfigured OpenClaw channel unconfigured when the gateway answered", async () => {
    // The DEFAULT state of the SKU: gateway healthy, WhatsApp never set up.
    // This must not become a permanent "could not check" with a Retry that can
    // never clear it.
    vi.stubGlobal("fetch", vi.fn(openclawWhatsapp({ state: "not_configured", verified: true })));

    openHub();
    const list = await screen.findByTestId("settings-channels-list");
    const whatsapp = within(list).getByTestId("settings-channel-whatsapp");

    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "not-configured"));
    expect(whatsapp).toHaveTextContent("settings.notConfigured");
    expect(whatsapp).not.toHaveTextContent("settings.statusUnavailable");
    expect(within(list).queryByTestId("settings-channel-retry-whatsapp")).toBeNull();

    // And the sidebar must not go permanently blank: an answered "no such
    // channel" is knowledge, so the count can be completed. (Telegram and
    // Email are configured in this fixture, hence a count rather than
    // "Not configured".)
    const nav = document.querySelector("nav");
    const row = [...(nav?.querySelectorAll(":scope > button") ?? [])].find((b) =>
      (b.textContent ?? "").includes("settings.channels"),
    );
    await waitFor(() => expect(row?.textContent).toContain("settings.channelsConnectedCount"));
  });

  it("shows 'checking' again while a retry is in flight", async () => {
    let release: (() => void) | null = null;
    let waCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        if (input.toString().startsWith("/setup-api/whatsapp/status")) {
          waCalls += 1;
          if (waCalls === 1) {
            return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response);
          }
          return new Promise<Response>((resolve) => {
            release = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ supported: true, state: "paired", enabled: true, paired: true, receiving: true, verified: true }) } as Response);
          });
        }
        return boxFetch(input);
      }),
    );

    openHub();
    const list = await screen.findByTestId("settings-channels-list");
    const whatsapp = within(list).getByTestId("settings-channel-whatsapp");
    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "unreachable"));

    fireEvent.click(within(list).getByTestId("settings-channel-retry-whatsapp"));

    // A dead press otherwise: the row said "could not check" throughout.
    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "unknown"));
    expect(whatsapp).toHaveTextContent("settings.checking");

    await waitFor(() => expect(release).not.toBeNull());
    release!();
    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "connected"));
  });

  it("does not send an unreadable row into a pane that says 'Not configured'", async () => {
    // THE SIBLING CALL SITE. The row is a button whose only job is to open the
    // pane, and the pane re-asks the same route inside the same failure window.
    // Teaching only the row to say "Could not check" left the destination
    // printing the exact TASK-689 words — with a "Link a number" button under
    // them, over a phone that is paired. Two clicks, two contradictory answers.
    let waCalls = 0;
    let paneAnswerRead = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        if (!input.toString().startsWith("/setup-api/whatsapp/status")) return boxFetch(input);
        waCalls += 1;
        const calls = waCalls;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => {
            if (calls > 1) paneAnswerRead = true;
            return Promise.resolve({
              supported: true,
              harness: "openclaw",
              allowlistSupported: false,
              mode: null,
              allowedUsers: [],
              state: "not_configured",
              verified: false,
            });
          },
        } as unknown as Response);
      }),
    );

    openHub();
    const list = await screen.findByTestId("settings-channels-list");
    const whatsapp = within(list).getByTestId("settings-channel-whatsapp");
    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "unreachable"));

    fireEvent.click(whatsapp);
    const pane = await screen.findByTestId("settings-section-whatsapp");
    // Wait for the pane's OWN read to come back, so this is not asserting on a
    // skeleton that simply has not been overwritten yet.
    await waitFor(() => expect(paneAnswerRead).toBe(true));
    await act(async () => {});

    expect(pane).not.toHaveTextContent("settings.notConfigured");
    expect(pane).not.toHaveTextContent("settings.whatsappNotConfiguredHint");
    // And no invitation to link a number over a channel nobody could read.
    expect(within(pane).queryByTestId("whatsapp-pairing")).toBeNull();
  });

  it("keeps the retry focused while the read it started is in flight", async () => {
    // A keyboard or screen-reader owner tabs to Retry and presses Enter. The
    // button used to be rendered only in the `unreachable` state, so it
    // unmounted under its own click and dropped focus to <body> — and if the
    // retry failed it came back with focus still nowhere.
    let waCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        if (input.toString().startsWith("/setup-api/whatsapp/status")) {
          waCalls += 1;
          if (waCalls === 1) {
            return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response);
          }
          return new Promise<Response>(() => {});
        }
        return boxFetch(input);
      }),
    );

    openHub();
    const list = await screen.findByTestId("settings-channels-list");
    const whatsapp = within(list).getByTestId("settings-channel-whatsapp");
    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "unreachable"));

    const retry = within(list).getByTestId("settings-channel-retry-whatsapp");
    retry.focus();
    expect(document.activeElement).toBe(retry);

    fireEvent.click(retry);

    await waitFor(() => expect(whatsapp).toHaveAttribute("data-state", "unknown"));
    expect(document.activeElement).toBe(retry);
  });

  it("never claims the sidebar entry is unconfigured before anything has been read", () => {
    const { container } = render(<SettingsApp ui={ui} />);
    const nav = container.querySelector("nav");
    if (!nav) throw new Error("desktop sidebar nav did not render");
    const row = [...nav.querySelectorAll(":scope > button")].find((b) =>
      (b.textContent ?? "").includes("settings.channels"),
    );
    if (!row) throw new Error("Messaging Channels nav entry did not render");

    // Nothing has been read yet, so "Not configured" is a claim the UI cannot
    // make. Silence is the honest third state.
    expect(row.textContent).not.toContain("settings.notConfigured");
  });
});
