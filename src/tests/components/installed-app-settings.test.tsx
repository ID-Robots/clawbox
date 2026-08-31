import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import InstalledAppSettings from "@/components/InstalledAppSettings";
import type { StoreApp } from "@/components/AppStore";

/**
 * The installed-app window's honesty about skill state.
 *
 * A skill-info 404 used to resolve to skillInfo=null with no error, so a skill
 * that was GONE from the box rendered the green "works out of the box" panel —
 * and so did a 500/503 while the skill CLI was the thing failing. The window
 * also restored the Active/Disabled badge from a KV mirror instead of the
 * `enabled` the server reads back from openclaw.json, and Home Assistant's form
 * offered an "Enable Webhooks" toggle no config writer ever persisted.
 *
 * `useT` falls back to identity when no provider is mounted, so copy asserts
 * as translation keys ("installed.notInstalled", ...).
 */

function storeApp(overrides: Partial<StoreApp> = {}): StoreApp {
  return {
    id: "weather-forecast",
    name: "Weather Forecast",
    description: "Forecasts.",
    rating: 4.5,
    color: "#06b6d4",
    category: "weather",
    iconUrl: "",
    ...overrides,
  };
}

const HEALTHY_SKILL = {
  name: "Weather Forecast",
  description: "Forecasts.",
  emoji: null,
  eligible: true,
  primaryEnv: null,
  requiredEnv: [],
  requiredBins: [],
  requiredConfig: [],
};

let skillInfoResponse: { status: number; body: unknown };
let storeDetailResponse: unknown;

beforeEach(() => {
  skillInfoResponse = { status: 200, body: HEALTHY_SKILL };
  storeDetailResponse = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown = {};
      let status = 200;
      if (url.startsWith("/setup-api/apps/skill-info")) ({ status, body } = skillInfoResponse);
      else if (url.startsWith("/setup-api/apps/store")) body = storeDetailResponse;
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      } as unknown as Response);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderWindow(appId = "weather-forecast", app = storeApp()) {
  return render(<InstalledAppSettings appId={appId} storeApp={app} icon={<span />} onUninstall={vi.fn()} />);
}

describe("installed app settings — skill state", () => {
  it("shows a distinct 'no longer installed' state on a skill-info 404, not 'works out of the box'", async () => {
    skillInfoResponse = { status: 404, body: { error: "Skill not found", code: "not_installed" } };
    renderWindow();

    await screen.findByText("installed.notInstalled");
    expect(screen.getByText("installed.notInstalledHint")).toBeInTheDocument();
    expect(screen.getByText("installed.notInstalledBadge")).toBeInTheDocument();
    expect(screen.queryByText("installed.worksOutOfBox")).toBeNull();
    // No enable switch for a skill that is gone — it would write config for
    // nothing. Uninstall stays as the cleanup path.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("button", { name: /store\.uninstall/ })).toBeInTheDocument();
  });

  it("treats a 503 'skills_unavailable' as the CLI failing, not as a healthy skill", async () => {
    skillInfoResponse = { status: 503, body: { error: "Skill list unavailable", code: "skills_unavailable" } };
    renderWindow();

    await screen.findByText("installed.loadFailed");
    expect(screen.queryByText("installed.worksOutOfBox")).toBeNull();
    expect(screen.queryByText("installed.notInstalled")).toBeNull();
  });

  it("initialises the switch from the server's `enabled`, defaulting to enabled when absent", async () => {
    skillInfoResponse = { status: 200, body: { ...HEALTHY_SKILL, enabled: false } };
    renderWindow();

    await screen.findByText("installed.worksOutOfBox");
    expect(screen.getByRole("switch", { name: "installed.enableSkillAria" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("installed.disabled")).toBeInTheDocument();
  });

  it("stays enabled when the server predates the `enabled` field", async () => {
    skillInfoResponse = { status: 200, body: HEALTHY_SKILL };
    renderWindow();

    await screen.findByText("installed.worksOutOfBox");
    expect(screen.getByRole("switch", { name: "installed.enableSkillAria" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("installed.active")).toBeInTheDocument();
  });
});

describe("installed app settings — Home Assistant form", () => {
  it("offers no webhook toggle and points at the HA-side setup instead", async () => {
    renderWindow("home-assistant", storeApp({ id: "home-assistant", name: "Home Assistant" }));

    await screen.findByText("Home Assistant URL");
    expect(screen.getByText("Long-Lived Access Token")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Enable Webhooks" })).toBeNull();
    expect(screen.getByText("installed.haWebhookNote")).toBeInTheDocument();
  });
});

describe("installed app settings — store link", () => {
  it("links the real ClawHub page when the store detail names the publisher", async () => {
    storeDetailResponse = { ownerHandle: "alex098929", developer: "weatherpro" };
    renderWindow();

    const link = await screen.findByRole("link", { name: /store\.viewOnHub/ });
    expect(link).toHaveAttribute("href", "https://clawhub.ai/alex098929/skills/weather-forecast");
  });

  it("labels the fallback as the store page when no publisher resolves", async () => {
    storeDetailResponse = {};
    renderWindow("weather-forecast", storeApp({ url: "https://clawbox.com/store/app/weather-forecast" }));

    const link = await screen.findByRole("link", { name: /store\.viewInStore/ });
    expect(link).toHaveAttribute("href", "https://clawbox.com/store/app/weather-forecast");
  });

  it("does not rebuild the dead link from `developer` when the store answered ownerHandle: null", async () => {
    // ownerHandle: null is the server's explicit "ClawHub could not name the
    // publisher"; the handle-shaped display name ("weatherpro") is exactly the
    // guess that built the dead URL the server removed.
    storeDetailResponse = { ownerHandle: null, developer: "weatherpro" };
    renderWindow("weather-forecast", storeApp({ developer: "weatherpro", url: "https://clawbox.com/store/app/weather-forecast" }));

    const link = await screen.findByRole("link", { name: /store\.viewInStore/ });
    expect(link).toHaveAttribute("href", "https://clawbox.com/store/app/weather-forecast");
  });
});
