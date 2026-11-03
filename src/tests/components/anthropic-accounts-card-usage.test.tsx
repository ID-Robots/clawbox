/**
 * The Anthropic accounts card on the usage meters of 2026-11 (TASK-2141), in
 * Bulgarian: each Claude account's week in Anthropic's own percent, its active
 * model weeks, and a model week a run found spent — which says until when THAT
 * model's runs wait while the account itself stays "Ready", never "Limited".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import AnthropicAccountsCard from "@/components/AnthropicAccountsCard";

const BULGARIAN = translations.bg as Record<string, string>;

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "bg",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let text = BULGARIAN[key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v));
      return text;
    },
  }),
}));

const WORK = "aaaaaaaa";
const PERSONAL = "bbbbbbbb";
const NOW = Date.now();
const FABLE_BACK = NOW + 50 * 3_600_000;

const say = (key: string, params: Record<string, string> = {}) =>
  Object.entries(params).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, v), BULGARIAN[key]);

function view() {
  return {
    accounts: [
      {
        id: WORK, label: "Work Max", email: "work@example.com", kind: "oauth", status: "ok", limitedUntil: null, priority: 1, active: true,
        modelLimits: [{ family: "fable", name: "Fable", until: FABLE_BACK }],
        usage: { at: NOW, sessionPercent: null, weeklyPercent: 56.4, weeklyResetsAt: NOW + 100 * 3_600_000, models: [{ name: "Fable", family: "fable", percent: 100, resetsAt: FABLE_BACK, spent: true }], extraUsage: { enabled: true, spendLimitReached: false } },
      },
      {
        id: PERSONAL, label: "Personal Max", email: "me@example.com", kind: "oauth", status: "ok", limitedUntil: null, priority: 2, active: false,
        usage: { at: NOW, sessionPercent: 12, weeklyPercent: 30, weeklyResetsAt: null, models: [{ name: "Opus", family: "opus", percent: 40, resetsAt: null, spent: false }], extraUsage: { enabled: true, spendLimitReached: true } },
      },
    ],
    health: { total: 2, healthy: 2, limited: 0, allLimited: false, nextResetAt: null },
    activeAccountId: WORK,
    loginAvailable: false,
    returnToPrimary: false,
    lastSwap: null,
    gateway: { following: false, accountId: null, label: null, since: null, available: true },
  };
}

let urls: string[];

beforeEach(() => {
  urls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    if (!String(input).includes("/setup-api/anthropic/accounts")) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(view()), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("each account's usage on the card", () => {
  it("asks for Anthropic's percents and shows the week, the model weeks, and the model whose runs wait — the account stays Ready", async () => {
    render(<AnthropicAccountsCard />);
    const work = await screen.findByTestId(`anthropic-account-usage-${WORK}`);
    expect(urls[0]).toBe("/setup-api/anthropic/accounts?usage=1");
    expect(work.textContent).toContain(say("settings.anthropicAccounts.usageWeek", { percent: "56" }));
    // The spent Fable week is said once, as the wait — not again as a percent.
    expect(work.textContent).toContain(BULGARIAN["settings.anthropicAccounts.modelLimited"].split("{time}")[0].replace("{model}", "Fable"));
    expect(work.textContent).not.toContain(say("settings.anthropicAccounts.usageModelWeek", { model: "Fable", percent: "100" }));
    // Not "Limited until …": the account answers every other model.
    const status = screen.getByTestId(`anthropic-account-status-${WORK}`).textContent ?? "";
    expect(status).toContain(BULGARIAN["settings.anthropicAccounts.statusInUse"]);
    expect(status).not.toContain(BULGARIAN["settings.anthropicAccounts.statusLimited"].split("{time}")[0]);
  });

  it("shows the session, the week and a model week with room, and a reached monthly spend limit", async () => {
    render(<AnthropicAccountsCard />);
    const personal = await screen.findByTestId(`anthropic-account-usage-${PERSONAL}`);
    await waitFor(() => expect(personal.textContent).toContain(say("settings.anthropicAccounts.usageSession", { percent: "12" })));
    expect(personal.textContent).toContain(say("settings.anthropicAccounts.usageWeek", { percent: "30" }));
    expect(personal.textContent).toContain(say("settings.anthropicAccounts.usageModelWeek", { model: "Opus", percent: "40" }));
    expect(personal.textContent).toContain(BULGARIAN["settings.anthropicAccounts.spendLimitReached"]);
    expect(screen.getByTestId(`anthropic-account-status-${PERSONAL}`).textContent).toContain(BULGARIAN["settings.anthropicAccounts.statusReady"]);
  });
});
