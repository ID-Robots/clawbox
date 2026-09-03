/**
 * Settings → System → "Time zone" (TASK-514).
 *
 * WHAT THIS CARD IS FOR. The clock in the taskbar is drawn by the BROWSER, so
 * it reads correctly on a phone while the box itself is hours out — and it is
 * the box's clock that the assistant, the reminders and every schedule run on.
 * The only honest witness is the `localTime` the box read back, so these tests
 * pin that the card shows the SERVER's clock and confirms a change with the
 * server's reply rather than echoing the zone that was asked for.
 *
 * They also pin the two things an owner can be misled by: the UTC banner (a
 * box nobody ever asked, still on the systemd default) and a refusal — the
 * route's own sentence, including the 503 that names the missing helper, has
 * to reach the screen instead of a flattened "could not change the time zone".
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

// The whole Settings app mounts here — every panel and its status fetch. On a
// loaded runner that mount alone can outlast the default budget, and these
// assertions are cheap; the budget is the only thing that was ever wrong.
vi.setConfig({ testTimeout: 20_000 });

/** The real English strings, interpolated the way i18n.tsx interpolates them,
 *  because half of what this card says to the owner IS the interpolation. */
const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "en", name: "English" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t, locale: "en", setLocale: vi.fn() }),
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

// The System tab renders the read-only stat cards from this unguarded, so it
// has to be shaped even though no assertion here reads it.
const statsResponse = {
  overview: { hostname: "clawbox-test", os: "TestOS", kernel: "6.8.0", uptime: "1h", arch: "arm64", platform: "linux" },
  cpu: { usage: 12, model: "Test CPU", cores: 4, loadAvg: ["0.10", "0.12", "0.14"], speed: 1800 },
  memory: { total: 8e9, used: 2e9, free: 6e9, usedPercent: 25, swap: { used: 0, total: 0, percent: 0 } },
  temperature: { value: 42, display: "42C" },
  gpu: { usage: 0 },
  storage: [],
  network: [],
  processes: [],
  timestamp: Date.now(),
};

const ZONES = ["Etc/UTC", "Europe/Sofia", "Europe/Berlin", "America/New_York", "Asia/Tokyo"];

/** The box's own wall clock, deliberately nothing like the browser's. */
const BOX_NOW = "2026-09-03 18:42";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type TzHandlers = {
  /** Answer for GET /setup-api/system/timezone?zones=1 */
  get?: () => Response;
  /** Answer for POST /setup-api/system/timezone, given the parsed body. */
  post?: (body: Record<string, unknown>) => Response;
};

const defaultStatus = {
  supported: true,
  timezone: "Europe/Sofia",
  localTime: BOX_NOW,
  utcOffset: "+03:00",
  ntpSynchronized: true,
  isDefault: false,
};

const defaultGet = () => json({ ...defaultStatus, zones: ZONES });

/** The device, with only the timezone route under the test's control. */
function stubFetch(handlers: TzHandlers = {}) {
  const get = handlers.get ?? defaultGet;
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const path = url.split("?")[0];

    if (path === "/setup-api/system/timezone") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return handlers.post ? handlers.post(body) : json({ success: true, ...defaultStatus });
      }
      return get();
    }
    if (path === "/setup-api/system/stats") return json(statsResponse);
    if (path === "/setup-api/update/status") return json({ phase: "idle", steps: [] });
    if (path === "/setup-api/update/versions") {
      return json({ clawbox: { current: "v1.0.0", target: null }, openclaw: { current: "v1.0.0", target: null }, edition: "openclaw" });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Open Settings straight on System — the deep-link slot the desktop uses, so
 *  the default pane never mounts and starts fetches of its own. */
function renderSystemTab() {
  (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection = "system";
  return render(<SettingsApp ui={ui} />);
}

/** The card, once its one-shot GET has landed. */
async function timezoneCard(): Promise<HTMLElement> {
  return (await screen.findByRole("listbox", { name: t("settings.timezone") })).closest(
    "[data-testid='settings-timezone']",
  ) as HTMLElement;
}

function zoneOptions(card: HTMLElement): string[] {
  return within(card)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
}

/** The POST bodies the card sent, in order. */
function postedBodies(fetchMock: Mock): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input).split("?")[0] === "/setup-api/system/timezone" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection;
});

describe("Settings → System — time zone card", () => {
  it("shows the zone the box is on and the box's own clock", async () => {
    stubFetch();
    renderSystemTab();

    // One row, carrying both: the zone name and the clock the SERVER reported.
    // The browser's clock is not consulted anywhere in this card.
    const now = await screen.findByText(t("settings.timezoneCurrent", { time: BOX_NOW }));
    expect(now.previousElementSibling?.textContent).toBe("Europe/Sofia");

    const card = await timezoneCard();
    expect(zoneOptions(card)).toEqual(ZONES);
  });

  it("warns about UTC only while the box is still on the untouched default", async () => {
    stubFetch({
      get: () =>
        json({
          supported: true,
          timezone: "Etc/UTC",
          localTime: "2026-09-03 15:42",
          utcOffset: "+00:00",
          ntpSynchronized: true,
          isDefault: true,
          zones: ZONES,
        }),
    });
    renderSystemTab();

    expect(await screen.findByText(t("settings.timezoneUtcWarning"))).toBeInTheDocument();
  });

  it("does not warn when a real zone has been set", async () => {
    stubFetch();
    renderSystemTab();

    // Wait for the card's own data before asserting an absence, otherwise the
    // assertion passes on an empty card and proves nothing.
    await screen.findByText(t("settings.timezoneCurrent", { time: BOX_NOW }));
    expect(screen.queryByText(t("settings.timezoneUtcWarning"))).not.toBeInTheDocument();
  });

  it("narrows the zone list as the owner types", async () => {
    stubFetch();
    const card = (renderSystemTab(), await timezoneCard());

    expect(zoneOptions(card)).toEqual(ZONES);

    fireEvent.change(screen.getByLabelText(t("settings.timezoneSearch")), { target: { value: "tokyo" } });

    // Asia/Tokyo is the match; Europe/Sofia is on screen because it is the
    // current PICK, which the list always keeps a row for — Apply must never
    // be armed with a zone nobody can see.
    await waitFor(() => expect(zoneOptions(card)).toEqual(["Europe/Sofia", "Asia/Tokyo"]));
    expect(zoneOptions(card)).not.toContain("America/New_York");
  });

  it("posts the picked zone and confirms with the clock the box read back", async () => {
    const APPLIED_NOW = "2026-09-03 11:42";
    const fetchMock = stubFetch({
      post: () =>
        json({
          success: true,
          supported: true,
          timezone: "America/New_York",
          localTime: APPLIED_NOW,
          utcOffset: "-04:00",
          ntpSynchronized: true,
          agent: { configWritten: true, personaWritten: true, harnessRestarted: false },
        }),
    });
    renderSystemTab();
    const card = await timezoneCard();

    fireEvent.click(within(card).getByRole("option", { name: "America/New_York" }));
    fireEvent.click(within(card).getByRole("button", { name: t("settings.timezoneApply") }));

    await waitFor(() => expect(postedBodies(fetchMock)).toEqual([{ timezone: "America/New_York" }]));

    // The confirmation quotes the reply, not the request: an echo of the
    // requested zone would read identically whether or not the OS moved.
    const status = await within(card).findByRole("status");
    expect(status).toHaveTextContent(t("settings.timezoneSaved", { zone: "America/New_York", time: APPLIED_NOW }));
    expect(status.textContent).toContain(APPLIED_NOW);
    expect(status.textContent).not.toContain(BOX_NOW);

    // And the current-zone row now reads the applied status, same source.
    expect(await screen.findByText(t("settings.timezoneCurrent", { time: APPLIED_NOW }))).toBeInTheDocument();
  });

  it("surfaces the route's own sentence when the zone is refused (400)", async () => {
    const REFUSAL = "Not a known time zone name.";
    stubFetch({ post: () => json({ error: REFUSAL }, 400) });
    renderSystemTab();
    const card = await timezoneCard();

    fireEvent.click(within(card).getByRole("option", { name: "Asia/Tokyo" }));
    fireEvent.click(within(card).getByRole("button", { name: t("settings.timezoneApply") }));

    const status = await within(card).findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(REFUSAL));
    expect(status.textContent).not.toContain(t("settings.timezoneSaveFailed"));
  });

  it("surfaces the 503 that names the missing helper, install step intact", async () => {
    const HELPER_MISSING = "The time zone helper is not installed. Run sudo bash install.sh to add it.";
    stubFetch({ get: () => json({ error: HELPER_MISSING }, 503) });
    renderSystemTab();

    // No zone data at all in this state, so the card is found by its own hook.
    const card = await screen.findByTestId("settings-timezone");
    const status = await within(card).findByRole("status");
    expect(status).toHaveTextContent(HELPER_MISSING);
  });
});
