/**
 * The Coding Agent's CONNECTED PROVIDERS (CodingAgentSettingsPanel.tsx): the
 * accounts a team may run on, each with Connect or Disconnect — the single
 * "Runs on" choice it replaced (the owner's brief, 2026-10-28). Drawn only
 * for a server that answers with `providers`; the connected set is
 * `connectedProviders`, and a server from before the list reads its default
 * provider as the one connected.
 *
 * The last test is about ORDERING on the wire: a status read fired by the
 * Anthropic card while a provider write is still open must wait for it.
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
const NOTHING: AnthropicAnswer = { connected: false, hasKey: false, hasLogin: false, source: null, models: ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5"], defaultModel: "claude-opus-5-5" };
const VIA_KEY: AnthropicAnswer = { ...NOTHING, connected: true, hasKey: true, source: "key" };

type Verdict = { id: string; ready: boolean; problems: string[] };
const READY_BOTH: Verdict[] = [{ id: "clawbox-ai", ready: true, problems: [] }, { id: "anthropic", ready: true, problems: [] }];

/** The status route's answer, as the panel reads it. */
function basePayload(provider: string, connected: string[] | null, extra: { providers?: string[] | null; verdicts?: Verdict[] } = {}) {
  return {
    enabled: true,
    ready: true,
    readiness: {
      ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true,
      capabilityDropAvailable: true, problems: [] as string[],
      ...(extra.verdicts ? { providers: extra.verdicts } : {}),
    },
    running: 0,
    harnessCommand: "claude-ds",
    maxTaskChars: 4000,
    defaultDirectory: "/home/clawbox/Projects",
    effort: "max",
    effortLevels: ["low", "xhigh", "max"],
    ...(extra.providers === null ? {} : { provider, providers: extra.providers ?? ["clawbox-ai", "anthropic"] }),
    ...(connected ? { connectedProviders: connected } : {}),
    subagents: true,
    maxTurns: 150, minMaxTurns: 10, maxMaxTurns: 2000,
    reviewPass: false, generateMedia: true, realBrowser: true,
  };
}

let posts: { url: string; body: unknown }[] = [];

function stubDevice(opts: { provider?: string; connected?: string[] | null; providers?: string[] | null; verdicts?: Verdict[]; anthropic?: AnthropicAnswer } = {}) {
  let provider = opts.provider ?? "clawbox-ai";
  let connected = opts.connected === undefined ? [provider] : opts.connected;
  const anthropic = opts.anthropic ?? VIA_KEY;
  const payload = () => basePayload(provider, connected, { providers: opts.providers, verdicts: opts.verdicts ?? READY_BOTH });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) return json(payload());
    if (url.startsWith("/setup-api/coding-agent/permissions")) return json({ allowRules: [], maxAllowRules: 32 });
    if (url.startsWith("/setup-api/coding-agent/git")) return json({ installed: false, connected: false, login: null, loginCommand: "gh auth login" });
    if (url.startsWith("/setup-api/coding-agent/anthropic")) return json(anthropic);
    if (url === "/setup-api/coding-agent/enable" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { providers?: string[] };
      posts.push({ url, body });
      if (Array.isArray(body.providers)) {
        connected = body.providers;
        if (!connected.includes(provider)) provider = connected[0];
      }
      return json(payload());
    }
    return json({ error: "unexpected" }, 404);
  }));
}

beforeEach(() => { posts = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the connected providers", () => {
  it("is not drawn at all by a server that predates the picker", async () => {
    stubDevice({ providers: null, connected: null });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-effort");
    expect(screen.queryByTestId("coding-agent-providers")).toBeNull();
  });

  it("shows both accounts, the connected one marked, the other with Connect", async () => {
    stubDevice({ provider: "clawbox-ai", connected: ["clawbox-ai"] });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-providers");
    expect(screen.getByTestId("coding-agent-provider-clawbox-ai")).toHaveAttribute("data-connected", "true");
    expect(screen.getByTestId("coding-agent-provider-clawbox-ai-connected")).toHaveTextContent(t("codingAgent.providers.connected"));
    expect(screen.getByTestId("coding-agent-provider-anthropic")).toHaveAttribute("data-connected", "false");
    expect(screen.getByTestId("coding-agent-provider-connect-anthropic")).not.toBeDisabled();
    expect(screen.queryByTestId("coding-agent-provider-disconnect-anthropic")).toBeNull();
  });

  it("reads a server from before the list as its default provider alone being connected", async () => {
    stubDevice({ provider: "anthropic", connected: null });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-providers");
    expect(screen.getByTestId("coding-agent-provider-anthropic")).toHaveAttribute("data-connected", "true");
    expect(screen.getByTestId("coding-agent-provider-clawbox-ai")).toHaveAttribute("data-connected", "false");
  });

  it("connects an account with the whole list, and renders back what the route answered", async () => {
    stubDevice({ provider: "clawbox-ai", connected: ["clawbox-ai"] });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-providers");
    fireEvent.click(screen.getByTestId("coding-agent-provider-connect-anthropic"));
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { providers: ["clawbox-ai", "anthropic"] } }]));
    await screen.findByTestId("coding-agent-provider-anthropic-connected");
    // Now either may go, but not both.
    fireEvent.click(screen.getByTestId("coding-agent-provider-disconnect-clawbox-ai"));
    await waitFor(() => expect(posts[1]).toEqual({ url: "/setup-api/coding-agent/enable", body: { providers: ["anthropic"] } }));
    await waitFor(() => expect(screen.getByTestId("coding-agent-provider-disconnect-anthropic")).toBeDisabled());
  });

  it("greys Connect for an account that is not set up, and says what is missing", async () => {
    const MISSING = "No Anthropic account is connected: add an API key or sign in.";
    stubDevice({
      provider: "clawbox-ai",
      connected: ["clawbox-ai"],
      anthropic: NOTHING,
      verdicts: [{ id: "clawbox-ai", ready: true, problems: [] }, { id: "anthropic", ready: false, problems: [MISSING] }],
    });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-providers");
    expect(screen.getByTestId("coding-agent-provider-connect-anthropic")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-provider-anthropic-not-set-up")).toHaveTextContent(MISSING);
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
    let connected = ["clawbox-ai"];
    let releaseWrite: (() => void) | null = null;
    const events: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/coding-agent/status")) {
        events.push("status");
        return json(basePayload("clawbox-ai", connected, { verdicts: READY_BOTH }));
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
        const body = JSON.parse(String(init.body)) as { providers?: string[] };
        events.push("write:start");
        await new Promise<void>((resolve) => { releaseWrite = resolve; });
        if (Array.isArray(body.providers)) connected = body.providers;
        events.push("write:end");
        return json(basePayload("clawbox-ai", connected, { verdicts: READY_BOTH }));
      }
      return json({ error: "unexpected" }, 404);
    }));

    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-providers");

    fireEvent.click(screen.getByTestId("coding-agent-provider-connect-anthropic"));
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
    expect(screen.getByTestId("coding-agent-provider-anthropic")).toHaveAttribute("data-connected", "true");
  });
});
