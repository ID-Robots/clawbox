/**
 * The Anthropic accounts card, in German (TASK-902).
 *
 * A re-authentication with the WRONG Claude account is refused by the pool
 * (`wrong_account`, `duplicate`), and the route sends the facts of it beside an
 * English sentence. The card says it in the owner's language. An English line
 * in a German panel was what the visual pass saw. Any other refusal still shows
 * the route's own sentence. The armed Remove button is named for what it does.
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
const VIEW = {
  accounts: [
    { id: WORK, label: "Work Max", email: "work@example.com", kind: "oauth", status: "ok", limitedUntil: null, priority: 1, active: true },
    { id: "bbbbbbbb", label: "Personal Max", email: "me@example.com", kind: "oauth", status: "ok", limitedUntil: null, priority: 2, active: false },
  ],
  health: { total: 2, healthy: 2, limited: 0, allLimited: false, nextResetAt: null },
  activeAccountId: WORK,
  loginAvailable: false,
};
const SERVER_SENTENCE = "An English sentence the German panel must not show.";

let refusal: { status: number; body: Record<string, unknown> };

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  refusal = {
    status: 409,
    body: { error: SERVER_SENTENCE, code: "wrong_account", details: { signedIn: "stranger@example.org", expected: "work@example.com", label: "Work Max" } },
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/ai-models/oauth/start")) return answer({ url: "https://claude.ai/oauth/authorize?code=true" });
    if (url.includes("/setup-api/ai-models/oauth/exchange")) return answer({ status: "complete" });
    if (url.includes("/setup-api/anthropic/accounts")) {
      if ((init?.method ?? "GET") === "GET") return answer(VIEW);
      return answer(refusal.body, refusal.status);
    }
    return answer({}, 404);
  }));
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Re-authenticate "Work Max": sign in, paste a code, Connect. Answers the alert's text. */
async function reauthenticate(): Promise<string> {
  render(<AnthropicAccountsCard />);
  fireEvent.click(await screen.findByTestId(`anthropic-account-reauth-${WORK}`));
  fireEvent.click(await screen.findByTestId("anthropic-accounts-signin"));
  const code = await screen.findByLabelText(GERMAN["settings.anthropicAccounts.codePlaceholder"]);
  fireEvent.change(code, { target: { value: "code#state" } });
  fireEvent.click(await screen.findByRole("button", { name: GERMAN["settings.anthropicAccounts.connect"] }));
  return (await screen.findByTestId("anthropic-accounts-error")).textContent ?? "";
}

describe("a re-authentication refused as another Claude account, in German", () => {
  it("says which account signed in and which one this is, in German, not the route's English", async () => {
    const text = await reauthenticate();
    expect(text).toBe("Diese Anmeldung gehört zu stranger@example.org, nicht zu work@example.com. Melden Sie sich als work@example.com an, um Work Max zu erneuern, oder verbinden Sie stranger@example.org als eigenes Konto.");
    expect(text).not.toContain(SERVER_SENTENCE);
  });

  it("says the sign-in is already on the list, in German", async () => {
    refusal.body = { error: SERVER_SENTENCE, code: "duplicate", details: { signedIn: "me@example.com", label: "Personal Max" } };
    expect(await reauthenticate()).toBe("Diese Anmeldung gehört zu me@example.com, das bereits als Personal Max in der Liste steht.");
  });

  it("keeps the route's own sentence for any other refusal, or one without its facts", async () => {
    refusal = { status: 503, body: { error: "The store would not write.", code: "store_unavailable" } };
    expect(await reauthenticate()).toBe("The store would not write.");
  });

  it("tells the owner up front to sign in with the SAME account", async () => {
    render(<AnthropicAccountsCard />);
    fireEvent.click(await screen.findByTestId(`anthropic-account-reauth-${WORK}`));
    expect(await screen.findByText(GERMAN["settings.anthropicAccounts.stepSignInReauth"])).toBeTruthy();
    expect(screen.queryByText(GERMAN["settings.anthropicAccounts.stepSignIn"])).toBeNull();
  });
});

describe("the Remove button", () => {
  it("is named for what the next press does once it is armed", async () => {
    render(<AnthropicAccountsCard />);
    const remove = await screen.findByTestId(`anthropic-account-remove-${WORK}`);
    expect(remove.getAttribute("aria-label")).toBe(GERMAN["settings.anthropicAccounts.remove"]);
    fireEvent.click(remove);
    await waitFor(() => expect(remove.getAttribute("aria-label")).toBe(GERMAN["settings.anthropicAccounts.removeConfirm"]));
    expect(remove.getAttribute("title")).toBe(GERMAN["settings.anthropicAccounts.removeConfirm"]);
    expect(remove.textContent).toBe(GERMAN["settings.anthropicAccounts.removeConfirm"]);
  });
});
