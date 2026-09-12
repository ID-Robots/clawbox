/**
 * Settings → Coding Agent: WHICH ACCOUNT PAYS, and the card that connects the
 * owner's own Anthropic access.
 *
 * Two rules the panel has to honour and one it must not break:
 *
 *  - a server that predates the selector answers with no provider list at
 *    all, and that box must show NO picker and NO Anthropic card rather than
 *    a control with one option in it;
 *  - switching to an account that is not connected is ALLOWED (the owner
 *    picks it, then pastes the key) and says so, rather than being refused by
 *    a control that would then be impossible to use;
 *  - the key never comes back from the route, so nothing here may pre-fill,
 *    re-read or keep it in the DOM after a save.
 *
 * The real English catalogue is used throughout, so a missing key fails here
 * rather than on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
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
const NOTHING: AnthropicAnswer = { connected: false, hasKey: false, hasLogin: false, source: null, models: ["claude-opus-5", "claude-sonnet-5"], defaultModel: "claude-opus-5" };
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
    tokenLimit: null, minTokenLimit: 10_000,
    reviewPass: false, generateImages: true, generateAudio: true, realBrowser: true,
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
    tokenLimit: null, minTokenLimit: 10_000,
    reviewPass: false, generateImages: true, generateAudio: true, realBrowser: true,
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

describe("the provider picker", () => {
  it("is not drawn at all by a server that predates it", async () => {
    stubDevice();
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-effort");
    expect(screen.queryByTestId("coding-agent-provider")).toBeNull();
    // And neither is the credential card that belongs to it.
    expect(screen.queryByTestId("coding-agent-anthropic-card")).toBeNull();
  });

  it("shows both accounts, with the owner's own marked", async () => {
    stubDevice({ providers: ["clawbox-ai", "anthropic"], provider: "clawbox-ai" });
    render(<CodingAgentSettingsPanel />);
    const track = await screen.findByTestId("coding-agent-provider");
    expect(track).toBeTruthy();
    expect(screen.getByTestId("coding-agent-provider-clawbox-ai").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("coding-agent-provider-anthropic").getAttribute("aria-pressed")).toBe("false");
  });

  it("saves the pick and renders back what the route answered", async () => {
    stubDevice({ providers: ["clawbox-ai", "anthropic"], provider: "clawbox-ai" });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-provider");
    fireEvent.click(screen.getByTestId("coding-agent-provider-anthropic"));
    await waitFor(() => {
      expect(screen.getByTestId("coding-agent-provider-anthropic").getAttribute("aria-pressed")).toBe("true");
    });
    expect(posts.some((p) => (p.body as { provider?: string }).provider === "anthropic")).toBe(true);
  });

  it("says the account is not connected, rather than refusing the pick", async () => {
    // The owner chooses the account and THEN pastes the key. A control that
    // refused the first half of that would be impossible to use.
    stubDevice({ providers: ["clawbox-ai", "anthropic"], provider: "anthropic", anthropicConnected: false });
    render(<CodingAgentSettingsPanel />);
    expect(await screen.findByTestId("coding-agent-provider-unconnected")).toBeTruthy();
    expect(screen.getByTestId("coding-agent-provider-anthropic").hasAttribute("disabled")).toBe(false);
  });

  it("invents no warning for a server that does not answer with the field", async () => {
    // `!undefined` is true, and a box whose Anthropic access is perfectly fine
    // must not be told it is missing on that alone.
    stubDevice({ providers: ["clawbox-ai", "anthropic"], provider: "anthropic" });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-provider");
    expect(screen.queryByTestId("coding-agent-provider-unconnected")).toBeNull();
  });

  it("does not read the status back while a provider write is still in flight", async () => {
    // `loadStatus` ends in the same `publish` the writes do, so it is a writer
    // of what the panel and the sidebar show. Fired straight from the
    // Anthropic card while a provider write was still on the wire, its GET
    // could be answered from BEFORE that write landed and put the old account
    // back on screen with the box already saved to the new one — the exact
    // ordering `writeChain` exists to prevent, arriving by the one path that
    // was not on it.
    //
    // Asserted on the wire rather than on the pixels, because the damage is
    // the overlap itself: whether a given overlap happens to resolve in the
    // harmful order is the server's timing, not the panel's to rely on.
    let provider = "clawbox-ai";
    let releaseWrite: (() => void) | null = null;
    const events: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/coding-agent/status")) {
        events.push("status");
        return json(basePayload(provider));
      }
      if (url.startsWith("/setup-api/coding-agent/permissions")) return json({ allowRules: [], maxAllowRules: 32 });
      if (url.startsWith("/setup-api/coding-agent/git")) return json({ installed: false, connected: false, login: null, loginCommand: "gh auth login" });
      if (url.startsWith("/setup-api/coding-agent/anthropic")) {
        if (init?.method === "DELETE") {
          events.push("delete");
          return json(NOTHING);
        }
        return json(VIA_KEY);
      }
      if (url === "/setup-api/coding-agent/enable" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { provider?: string };
        events.push("write:start");
        await new Promise<void>((resolve) => { releaseWrite = resolve; });
        if (typeof body.provider === "string") provider = body.provider;
        events.push("write:end");
        return json(basePayload(provider));
      }
      return json({ error: "unexpected" }, 404);
    }));

    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-provider");

    fireEvent.click(screen.getByTestId("coding-agent-provider-anthropic"));
    await waitFor(() => expect(releaseWrite).not.toBeNull());

    // The card reports a change while that write is still open, and everything
    // it triggers is given room to run before the write is allowed to finish.
    // Arm, then confirm — the card asks twice before it disconnects.
    const removeBtn = await screen.findByTestId("coding-agent-anthropic-remove");
    fireEvent.click(removeBtn);
    fireEvent.click(removeBtn);
    await waitFor(() => expect(events).toContain("delete"));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    const opened = events.indexOf("write:start");
    expect(events.slice(opened).includes("status")).toBe(false);

    releaseWrite!();
    await waitFor(() => expect(events).toContain("write:end"));
    // And the queued read does happen, once the write is done with.
    await waitFor(() => expect(events.slice(events.indexOf("write:end"))).toContain("status"));
    expect(screen.getByTestId("coding-agent-provider-anthropic").getAttribute("aria-pressed")).toBe("true");
  });

  it("says nothing about it when the account IS connected", async () => {
    stubDevice({ providers: ["clawbox-ai", "anthropic"], provider: "anthropic", anthropicConnected: true });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-provider");
    expect(screen.queryByTestId("coding-agent-provider-unconnected")).toBeNull();
  });
});

describe("the Anthropic card", () => {
  it("does not call an account 'not connected' when the read FAILED", async () => {
    // `state === null` is also what the card holds before the first read, so
    // rendering it as "not connected" made a claim about the owner's account
    // over a request that had simply fallen over.
    stubDevice({ providers: ["clawbox-ai", "anthropic"], anthropicReadFails: true });
    render(<CodingAgentSettingsPanel />);
    const badge = await screen.findByTestId("coding-agent-anthropic-state");
    expect(badge.textContent).toBe(t("codingAgent.anthropicUnknown"));
    expect(badge.textContent).not.toBe(t("codingAgent.anthropicOff"));
  });

  it("reports an unconnected account and offers no Remove", async () => {
    stubDevice({ providers: ["clawbox-ai", "anthropic"] });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-anthropic-card");
    expect((await screen.findByTestId("coding-agent-anthropic-state")).textContent).toBe(t("codingAgent.anthropicOff"));
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

  it("will not save an empty field", async () => {
    stubDevice({ providers: ["clawbox-ai", "anthropic"] });
    render(<CodingAgentSettingsPanel />);
    const save = await screen.findByTestId("coding-agent-anthropic-save");
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(save);
    expect(posts).toEqual([]);
  });
});
