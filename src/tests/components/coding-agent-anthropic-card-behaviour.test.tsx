/**
 * Settings → Coding Agent: the card that connects the owner's own Anthropic
 * access (CodingAgentAnthropicCard.tsx, drawn by CodingAgentSettingsPanel).
 *
 * These cases lived in coding-agent-provider-picker.test.tsx until the "Runs
 * on" picker became the connected-providers list (2026-10-28); the card is
 * untouched, and so are they, beyond the status payload they stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentSettingsPanel from "@/components/CodingAgentSettingsPanel";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface AnthropicAnswer {
  connected: boolean;
  hasKey: boolean;
  hasLogin: boolean;
  source: "key" | "login" | null;
  models: string[];
  defaultModel: string;
}
const NOTHING: AnthropicAnswer = { connected: false, hasKey: false, hasLogin: false, source: null, models: ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5"], defaultModel: "claude-opus-5-5" };
const VIA_KEY: AnthropicAnswer = { ...NOTHING, connected: true, hasKey: true, source: "key" };
const VIA_LOGIN: AnthropicAnswer = { ...NOTHING, connected: true, hasLogin: true, source: "login" };

/** The status route's answer, as the panel reads it. */
function basePayload(provider: string, extra: Record<string, unknown> = {}) {
  return {
    enabled: true,
    ready: true,
    readiness: {
      ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true,
      capabilityDropAvailable: true, problems: [] as string[],
      ...(extra.readiness ?? {}),
    },
    running: 0,
    harnessCommand: "claude-ds",
    maxTaskChars: 4000,
    defaultDirectory: "/home/clawbox/Projects",
    effort: "max",
    effortLevels: ["low", "xhigh", "max"],
    provider,
    providers: ["clawbox-ai", "anthropic"],
    subagents: true,
    maxTurns: 150, minMaxTurns: 10, maxMaxTurns: 2000,
    reviewPass: false, generateMedia: true, realBrowser: true,
  };
}

let posts: { url: string; body: unknown }[];
let deletes: string[];

function stubDevice(opts: {
  /** Omit to stand in for a server that predates the selector. */
  providers?: string[];
  provider?: string;
  anthropicConnected?: boolean;
  anthropic?: AnthropicAnswer;
  /** What POSTing a key answers with. */
  saveAnswer?: { body: unknown; status: number };
  /** The GET falls over — a box the card cannot ask about. */
  anthropicReadFails?: boolean;
} = {}) {
  posts = [];
  deletes = [];
  let provider = opts.provider ?? "clawbox-ai";
  let anthropic = opts.anthropic ?? NOTHING;
  const payload = () => ({
    enabled: true,
    ready: true,
    readiness: {
      ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true,
      capabilityDropAvailable: true, problems: [] as string[],
      ...(opts.anthropicConnected === undefined ? {} : { anthropicConnected: opts.anthropicConnected }),
    },
    running: 0,
    harnessCommand: "claude-ds",
    maxTaskChars: 4000,
    defaultDirectory: "/home/clawbox/Projects",
    effort: "max",
    effortLevels: ["low", "xhigh", "max"],
    ...(opts.providers ? { provider, providers: opts.providers } : {}),
    subagents: true,
    maxTurns: 150, minMaxTurns: 10, maxMaxTurns: 2000,
    reviewPass: false, generateMedia: true, realBrowser: true,
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) return json(payload());
    if (url.startsWith("/setup-api/coding-agent/permissions")) return json({ allowRules: [], maxAllowRules: 32 });
    if (url.startsWith("/setup-api/coding-agent/git")) return json({ installed: false, connected: false, login: null, loginCommand: "gh auth login" });
    if (url.startsWith("/setup-api/coding-agent/anthropic")) {
      if (opts.anthropicReadFails && (init?.method ?? "GET") === "GET") {
        throw new TypeError("Failed to fetch");
      }
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (opts.saveAnswer) return json(opts.saveAnswer.body, opts.saveAnswer.status);
        anthropic = { ...VIA_KEY };
        return json({ ...anthropic, verified: true });
      }
      if (init?.method === "DELETE") {
        deletes.push(url);
        anthropic = { ...NOTHING, hasLogin: anthropic.hasLogin, connected: anthropic.hasLogin, source: anthropic.hasLogin ? "login" : null };
        return json(anthropic);
      }
      return json(anthropic);
    }
    if (url === "/setup-api/coding-agent/enable" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { provider?: string };
      posts.push({ url, body });
      if (typeof body.provider === "string") provider = body.provider;
      return json(payload());
    }
    return json({ error: "unexpected" }, 404);
  }));
}

beforeEach(() => { posts = []; deletes = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the Anthropic card", () => {
  it("does not call an account 'not connected' when the read FAILED", async () => {
    // `state === null` is also what the card holds before the first read, so
    // rendering it as "not connected" made a claim about the owner's account
    // over a request that had simply fallen over.
    stubDevice({ providers: ["clawbox-ai", "anthropic"], anthropicReadFails: true });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-anthropic-state");
    // The card says "checking…" from its first frame, so the claim is only
    // tested once the read has been made and has failed — read at once, this
    // passed whatever a failed read then drew.
    await waitFor(() => {
      expect(vi.mocked(globalThis.fetch).mock.calls.some(([input]) => input.toString().startsWith("/setup-api/coding-agent/anthropic"))).toBe(true);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const badge = screen.getByTestId("coding-agent-anthropic-state");
    expect(badge.textContent).toBe(t("codingAgent.anthropicUnknown"));
    expect(badge.textContent).not.toBe(t("codingAgent.anthropicOff"));
  });

  it("reports an unconnected account and offers no Remove", async () => {
    stubDevice({ providers: ["clawbox-ai", "anthropic"] });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-anthropic-card");
    // Every state of the badge carries the one test id, and the card mounts
    // saying "checking…" until its first read lands — so the badge is found
    // at once, and only its TEXT says the read has answered. Waiting on the
    // element alone raced that read.
    await waitFor(() => {
      expect(screen.getByTestId("coding-agent-anthropic-state").textContent).toBe(t("codingAgent.anthropicOff"));
    });
    // Asked only once the read has answered: before it, there is no Remove
    // whatever the account says.
    expect(screen.queryByTestId("coding-agent-anthropic-remove")).toBeNull();
  });

  it("saves a key, then holds nothing back in the field", async () => {
    stubDevice({ providers: ["clawbox-ai", "anthropic"] });
    render(<CodingAgentSettingsPanel />);
    const field = await screen.findByTestId("coding-agent-anthropic-key") as HTMLInputElement;
    // A password field: the key is not on screen while it is typed either.
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" } });
    fireEvent.click(screen.getByTestId("coding-agent-anthropic-save"));
    await waitFor(() => {
      expect((screen.getByTestId("coding-agent-anthropic-state")).textContent).toBe(t("codingAgent.anthropicViaKey"));
    });
    // Out of the DOM the moment it has landed: a credential left in an input
    // is a credential in every tab that page is open in.
    expect((screen.getByTestId("coding-agent-anthropic-key") as HTMLInputElement).value).toBe("");
    expect(posts.some((p) => (p.body as { apiKey?: string }).apiKey?.startsWith("sk-ant-"))).toBe(true);
  });

  it("says a key was stored but not checked when the box could not ask", async () => {
    stubDevice({
      providers: ["clawbox-ai", "anthropic"],
      saveAnswer: { body: { ...VIA_KEY, verified: false }, status: 200 },
    });
    render(<CodingAgentSettingsPanel />);
    const field = await screen.findByTestId("coding-agent-anthropic-key");
    fireEvent.change(field, { target: { value: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" } });
    fireEvent.click(screen.getByTestId("coding-agent-anthropic-save"));
    expect(await screen.findByText(t("codingAgent.anthropicSavedUnchecked"))).toBeTruthy();
  });

  it("shows the route's own sentence when a key is refused", async () => {
    stubDevice({
      providers: ["clawbox-ai", "anthropic"],
      saveAnswer: { body: { error: "Anthropic did not accept that API key.", kind: "rejected" }, status: 400 },
    });
    render(<CodingAgentSettingsPanel />);
    const field = await screen.findByTestId("coding-agent-anthropic-key");
    fireEvent.change(field, { target: { value: "sk-ant-api03-wrongwrongwrongwrong" } });
    fireEvent.click(screen.getByTestId("coding-agent-anthropic-save"));
    expect(await screen.findByText("Anthropic did not accept that API key.")).toBeTruthy();
  });

  it("removes a key only on the second tap", async () => {
    stubDevice({ providers: ["clawbox-ai", "anthropic"], anthropic: VIA_KEY });
    render(<CodingAgentSettingsPanel />);
    const remove = await screen.findByTestId("coding-agent-anthropic-remove");
    fireEvent.click(remove);
    expect(deletes).toEqual([]);
    expect(remove.textContent).toBe(t("codingAgent.anthropicRemoveConfirm"));
    fireEvent.click(screen.getByTestId("coding-agent-anthropic-remove"));
    await waitFor(() => expect(deletes.length).toBe(1));
  });

  it("names the Terminal sign-in as something this card did not make", async () => {
    // And offers no Remove for it: that credential is the owner's, made
    // outside this app, and a button here must not end their session.
    stubDevice({ providers: ["clawbox-ai", "anthropic"], anthropic: VIA_LOGIN });
    render(<CodingAgentSettingsPanel />);
    // waitFor, not findBy: the element exists from the first paint (saying
    // "not connected" until the read lands), so findBy would resolve on the
    // placeholder.
    await waitFor(() => {
      expect(screen.getByTestId("coding-agent-anthropic-state").textContent).toBe(t("codingAgent.anthropicViaLogin"));
    });
    expect(await screen.findByTestId("coding-agent-anthropic-login-note")).toBeTruthy();
    expect(screen.queryByTestId("coding-agent-anthropic-remove")).toBeNull();
  });

  it("does not let the first read undo a key saved while it was in flight", async () => {
    // The card is on screen from mount and the owner may paste a key into it
    // straight away. A first GET that is ANSWERED after the POST describes the
    // account as it was BEFORE the save — and, winning simply by finishing
    // later, it put "not connected" back over a key the box had accepted,
    // until something remounted the card.
    let releaseRead: (() => void) | null = null;
    let firstRead = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/coding-agent/status")) return json(basePayload("clawbox-ai"));
      if (url.startsWith("/setup-api/coding-agent/permissions")) return json({ allowRules: [], maxAllowRules: 32 });
      if (url.startsWith("/setup-api/coding-agent/git")) return json({ installed: false, connected: false, login: null, loginCommand: "gh auth login" });
      if (url.startsWith("/setup-api/coding-agent/anthropic")) {
        if (init?.method === "POST") return json({ ...VIA_KEY, verified: true });
        if (firstRead) {
          firstRead = false;
          // Held open until after the save has landed.
          await new Promise<void>((resolve) => { releaseRead = resolve; });
        }
        return json(NOTHING);
      }
      return json({ error: "unexpected" }, 404);
    }));

    render(<CodingAgentSettingsPanel />);
    const field = await screen.findByTestId("coding-agent-anthropic-key") as HTMLInputElement;
    await waitFor(() => expect(releaseRead).not.toBeNull());

    fireEvent.change(field, { target: { value: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" } });
    fireEvent.click(screen.getByTestId("coding-agent-anthropic-save"));
    await waitFor(() => {
      expect(screen.getByTestId("coding-agent-anthropic-state").textContent).toBe(t("codingAgent.anthropicViaKey"));
    });

    // Now the stale read answers "no account".
    releaseRead!();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByTestId("coding-agent-anthropic-state").textContent).toBe(t("codingAgent.anthropicViaKey"));
  });

  it("will not save an empty field", async () => {
    stubDevice({ providers: ["clawbox-ai", "anthropic"] });
    render(<CodingAgentSettingsPanel />);
    const save = await screen.findByTestId("coding-agent-anthropic-save");
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(save);
    expect(posts).toEqual([]);
  });
});
