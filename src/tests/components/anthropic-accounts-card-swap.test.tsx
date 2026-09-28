/**
 * The Anthropic accounts card's box-wide half (TASK-1260), in German: which
 * account everything runs on, "all limited, earliest reset …", the owner's
 * "return to the first account" switch, and the last swap with what each
 * consumer did — in fixed words, never a process's own text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import AnthropicAccountsCard from "@/components/AnthropicAccountsCard";

const GERMAN = translations.de as Record<string, string>;

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "de",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let text = GERMAN[key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v));
      return text;
    },
  }),
}));

const WORK = "aaaaaaaa";
const PERSONAL = "bbbbbbbb";
const NOW = Date.now();

function view(over: Record<string, unknown> = {}) {
  return {
    accounts: [
      { id: WORK, label: "Work Max", email: "work@example.com", kind: "oauth", status: "limited", limitedUntil: NOW + 3_600_000, priority: 1, active: false },
      { id: PERSONAL, label: "Personal Max", email: "me@example.com", kind: "oauth", status: "ok", limitedUntil: null, priority: 2, active: true },
    ],
    health: { total: 2, healthy: 1, limited: 1, allLimited: false, nextResetAt: NOW + 3_600_000 },
    activeAccountId: PERSONAL,
    loginAvailable: false,
    returnToPrimary: false,
    lastSwap: {
      at: NOW - 60_000,
      fromLabel: "Work Max",
      toLabel: "Personal Max",
      cause: "limit",
      limitedUntil: NOW + 3_600_000,
      nextResetAt: null,
      consumers: {
        coding: { status: "ok", code: "moved", count: 2 },
        gateway: { status: "ok", code: "switched", count: 1 },
        retries: { status: "ok", code: "retried", count: 1 },
      },
    },
    gateway: { following: true, accountId: PERSONAL, label: "Personal Max", since: NOW - 60_000 },
    ...over,
  };
}

let current: ReturnType<typeof view>;
let posts: Record<string, unknown>[];

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  current = view();
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("/setup-api/anthropic/accounts")) return answer({}, 404);
    if ((init?.method ?? "GET") === "GET") return answer(current);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push(body);
    if (body.action === "set_return_to_primary") current = { ...current, returnToPrimary: body.on === true };
    return answer(current);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the box-wide account on the card", () => {
  it("names the account everything runs on", async () => {
    render(<AnthropicAccountsCard />);
    const line = await screen.findByTestId("anthropic-accounts-active");
    // (The icon's ligature is text too: "bolt".)
    expect(line.textContent).toContain(GERMAN["settings.anthropicAccounts.activeNow"].replace("{label}", "Personal Max"));
  });

  it("says every account is limited, and the earliest reset, instead", async () => {
    current = view({
      activeAccountId: null,
      health: { total: 2, healthy: 0, limited: 2, allLimited: true, nextResetAt: NOW + 30 * 60_000 },
    });
    render(<AnthropicAccountsCard />);
    const banner = await screen.findByTestId("anthropic-accounts-all-limited");
    const [before] = GERMAN["settings.anthropicAccounts.allLimitedBanner"].split("{time}");
    expect(banner.textContent).toContain(before);
    expect(screen.queryByTestId("anthropic-accounts-active")).toBeNull();
  });

  it("shows the last swap and what each consumer did, in the owner's language", async () => {
    render(<AnthropicAccountsCard />);
    const swap = await screen.findByTestId("anthropic-accounts-last-swap");
    expect(swap.textContent).toContain("Work Max → Personal Max");
    expect(screen.getByTestId("anthropic-accounts-swap-coding").textContent).toContain(GERMAN["settings.anthropicAccounts.outcomeMoved"].replace("{count}", "2"));
    expect(screen.getByTestId("anthropic-accounts-swap-gateway").textContent).toContain(GERMAN["settings.anthropicAccounts.outcomeSwitched"]);
    expect(screen.getByTestId("anthropic-accounts-swap-retries").textContent).toContain(GERMAN["settings.anthropicAccounts.outcomeRetried"].replace("{count}", "1"));
    expect(swap.textContent).toContain(GERMAN["settings.anthropicAccounts.consumerGateway"]);
  });

  it('turns "return to the first account" on through the route', async () => {
    render(<AnthropicAccountsCard />);
    const toggle = (await screen.findByTestId("anthropic-accounts-return-to-primary")).querySelector("input") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(posts).toEqual([{ action: "set_return_to_primary", on: true }]));
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it("draws an older server's answer, which has none of it, without the new parts", async () => {
    current = { accounts: view().accounts, health: view().health, activeAccountId: PERSONAL, loginAvailable: false } as ReturnType<typeof view>;
    render(<AnthropicAccountsCard />);
    await screen.findByTestId("anthropic-accounts-active");
    expect(screen.queryByTestId("anthropic-accounts-last-swap")).toBeNull();
  });
});
