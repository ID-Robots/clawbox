/**
 * Settings → Coding Agent: the card that connects the owner's own OpenAI
 * access for runs on the Codex CLI (CodingAgentOpenAICard.tsx) — a key, or a
 * ChatGPT sign-in through Codex's device flow — and says which of the three a
 * provider is: connected, not connected, or at its usage limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentOpenAICard from "@/components/CodingAgentOpenAICard";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const ROUTE = "/setup-api/coding-agent/openai";
/** A placeholder in the shape of an OpenAI project key — not a real credential. */
const KEY = "sk-proj-card-test-placeholder-0123456789";

const BASE = { limitedUntil: null, codexInstalled: true, models: ["gpt-6-astra"], defaultModel: "gpt-6-astra" };
const NOTHING = { ...BASE, connected: false, hasKey: false, hasLogin: false, source: null, status: "disconnected" };
const VIA_KEY = { ...BASE, connected: true, hasKey: true, hasLogin: false, source: "key", status: "connected" };
const VIA_CHATGPT = { ...BASE, connected: true, hasKey: false, hasLogin: true, source: "chatgpt", status: "connected" };
const PENDING = { id: "login-1", status: "pending", verificationUrl: "https://auth.openai.com/codex/device", userCode: "AB1C-DEFGH", error: null, expiresAt: Date.now() + 900_000 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let calls: { method: string; url: string; body: unknown }[];

function stub(answers: { get?: unknown; post?: (body: Record<string, unknown>) => Response; del?: (url: string) => Response; getFails?: boolean }) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method, url, body });
    if (!url.startsWith(ROUTE)) return json({ error: "unexpected" }, 404);
    if (method === "GET") {
      if (answers.getFails) throw new TypeError("Failed to fetch");
      return json(answers.get ?? NOTHING);
    }
    if (method === "POST") return answers.post ? answers.post(body ?? {}) : json(NOTHING);
    if (method === "DELETE") return answers.del ? answers.del(url) : json(NOTHING);
    return json({}, 405);
  }));
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("what the card says about the account", () => {
  it("says it is checking, not 'not connected', when the read fails", async () => {
    stub({ getFails: true });
    render(<CodingAgentOpenAICard />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.getByTestId("coding-agent-openai-state")).toHaveTextContent(t("codingAgent.openaiUnknown"));
  });

  it("names each of the three states", async () => {
    stub({ get: NOTHING });
    const { unmount } = render(<CodingAgentOpenAICard />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-openai-state")).toHaveAttribute("data-status", "disconnected"));
    unmount();

    stub({ get: VIA_CHATGPT });
    const second = render(<CodingAgentOpenAICard />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-openai-state")).toHaveTextContent(t("codingAgent.openaiViaChatgpt")));
    expect(screen.getByTestId("coding-agent-openai-state")).toHaveAttribute("data-status", "connected");
    second.unmount();

    const until = new Date(2026, 9, 28, 17, 5).getTime();
    stub({ get: { ...VIA_KEY, status: "limited", limitedUntil: until } });
    render(<CodingAgentOpenAICard />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-openai-state")).toHaveAttribute("data-status", "limited"));
    expect(screen.getByTestId("coding-agent-openai-state")).toHaveTextContent(t("codingAgent.openaiLimited", { time: "17:05" }));
  });

  it("says when the Codex CLI is missing, and offers no sign-in it could not start", async () => {
    stub({ get: { ...NOTHING, codexInstalled: false } });
    render(<CodingAgentOpenAICard />);
    await screen.findByTestId("coding-agent-openai-no-codex");
    expect(screen.getByTestId("coding-agent-openai-signin")).toBeDisabled();
  });
});

describe("the key", () => {
  it("is posted, taken out of the field once it landed, and never read back", async () => {
    const onChanged = vi.fn();
    stub({ get: NOTHING, post: () => json({ ...VIA_KEY, verified: true }) });
    render(<CodingAgentOpenAICard onChanged={onChanged} />);
    const field = await screen.findByTestId("coding-agent-openai-key") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: KEY } });
    fireEvent.click(screen.getByTestId("coding-agent-openai-save"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-openai-state")).toHaveTextContent(t("codingAgent.openaiViaKey")));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ apiKey: KEY });
    expect(field.value).toBe("");
    expect(onChanged).toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("says a key it could not check was saved unchecked, and shows the route's own refusal", async () => {
    stub({ get: NOTHING, post: () => json({ ...VIA_KEY, verified: false }) });
    const { unmount } = render(<CodingAgentOpenAICard />);
    fireEvent.change(await screen.findByTestId("coding-agent-openai-key"), { target: { value: KEY } });
    fireEvent.click(screen.getByTestId("coding-agent-openai-save"));
    await screen.findByText(t("codingAgent.openaiSavedUnchecked"));
    unmount();

    stub({ get: NOTHING, post: () => json({ error: "OpenAI did not accept that API key.", kind: "rejected" }, 400) });
    render(<CodingAgentOpenAICard />);
    fireEvent.change(await screen.findByTestId("coding-agent-openai-key"), { target: { value: KEY } });
    fireEvent.click(screen.getByTestId("coding-agent-openai-save"));
    await screen.findByText("OpenAI did not accept that API key.");
  });

  it("needs a second tap to remove", async () => {
    stub({ get: VIA_KEY, del: () => json(NOTHING) });
    render(<CodingAgentOpenAICard />);
    const remove = await screen.findByTestId("coding-agent-openai-remove");
    fireEvent.click(remove);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(remove).toHaveTextContent(t("codingAgent.openaiRemoveConfirm"));
    fireEvent.click(remove);
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.url).toBe(ROUTE));
  });
});

describe("the ChatGPT sign-in", () => {
  it("shows OpenAI's page and the code, polls, and lands connected once the owner approves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onChanged = vi.fn();
    let approved = false;
    stub({
      get: NOTHING,
      post: (body) => {
        if (body.action === "login-start") return json({ ...NOTHING, login: PENDING });
        if (body.action === "login-poll") return json(approved ? { ...VIA_CHATGPT, login: { ...PENDING, status: "approved" } } : { ...NOTHING, login: PENDING });
        return json(NOTHING);
      },
    });
    render(<CodingAgentOpenAICard onChanged={onChanged} />);
    fireEvent.click(await screen.findByTestId("coding-agent-openai-signin"));
    expect(await screen.findByTestId("coding-agent-openai-device-value")).toHaveTextContent("AB1C-DEFGH");
    expect(screen.getByTestId("coding-agent-openai-device-open")).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ action: "login-start" });

    approved = true;
    await act(async () => { vi.advanceTimersByTime(3_100); });
    await waitFor(() => expect(screen.getByTestId("coding-agent-openai-state")).toHaveTextContent(t("codingAgent.openaiViaChatgpt")));
    expect(screen.queryByTestId("coding-agent-openai-device")).toBeNull();
    expect(calls.some((c) => (c.body as { action?: string } | null)?.action === "login-poll" && (c.body as { id?: string }).id === PENDING.id)).toBe(true);
    expect(onChanged).toHaveBeenCalled();
    // Signed in: the card offers the way out instead of the way in.
    expect(screen.getByTestId("coding-agent-openai-signout")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-openai-signin")).toBeNull();
  });

  it("says why a sign-in failed, and cancels one the owner gives up on", async () => {
    stub({ get: NOTHING, post: (body) => json(body.action === "login-start" ? { ...NOTHING, login: { ...PENDING, status: "failed", error: "Codex did not print a sign-in link." } } : NOTHING) });
    const { unmount } = render(<CodingAgentOpenAICard />);
    fireEvent.click(await screen.findByTestId("coding-agent-openai-signin"));
    await screen.findByText("Codex did not print a sign-in link.");
    unmount();

    stub({ get: NOTHING, post: (body) => json(body.action === "login-start" ? { ...NOTHING, login: PENDING } : NOTHING) });
    render(<CodingAgentOpenAICard />);
    fireEvent.click(await screen.findByTestId("coding-agent-openai-signin"));
    fireEvent.click(await screen.findByTestId("coding-agent-openai-signin-cancel"));
    await waitFor(() => expect(calls.some((c) => (c.body as { action?: string } | null)?.action === "login-cancel")).toBe(true));
    expect(screen.queryByTestId("coding-agent-openai-device")).toBeNull();
  });

  it("signs out on a second tap, through its own DELETE", async () => {
    stub({ get: VIA_CHATGPT, del: () => json(NOTHING) });
    render(<CodingAgentOpenAICard />);
    const out = await screen.findByTestId("coding-agent-openai-signout");
    fireEvent.click(out);
    fireEvent.click(out);
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.url).toBe(`${ROUTE}?what=login`));
  });

  it("says which credential a run uses when both are there", async () => {
    stub({ get: { ...VIA_KEY, hasLogin: true } });
    render(<CodingAgentOpenAICard />);
    expect(await screen.findByTestId("coding-agent-openai-both-note")).toHaveTextContent(t("codingAgent.openaiBothNote"));
  });
});
