import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adding a provider has to reach the RUNNING AGENT, not just the browser.
 *
 * `mcp/lib/context.ts` builds FOUR boot-time snapshots, and three of them have
 * already been given a write path that refreshes them — the mailbox read tools
 * (#486), the image tools (#503), the coding-agent family (#514). The fourth is
 * `ctx.providers`, read once from `/setup-api/hermes/models` while the ClawBox
 * MCP server starts, and it is NOT advisory: `mcp/tools/ai.ts` makes it the
 * `provider` parameter's z.enum, and the schema IS the validation ("Closed sets
 * are z.enum, never free text: the schema IS the validation, so a wrong value
 * never reaches the device" — mcp/lib/schema.ts).
 *
 * So the owner pastes an Anthropic key, the route stores it and drops the
 * catalogue cache so "the panel's very next request must see the provider as
 * usable" — and the long-lived stdio MCP child keeps the enum it was born with.
 * `ai_list_models` (a live read) then lists the provider that `ai_set_provider`
 * cannot be handed, and the advice it gives back is the step that just failed.
 *
 * These pin the reload at the two write paths a customer reaches from Settings.
 */

const rpcMock = vi.hoisted(() => vi.fn());
const cliMock = vi.hoisted(() => vi.fn());
const optionsMock = vi.hoisted(() => vi.fn());
const invalidateMock = vi.hoisted(() => vi.fn());
const dashboardFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: rpcMock }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-dashboard-auth", () => ({ dashboardFetch: dashboardFetchMock }));
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/hermes-model-options", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-model-options")>()),
  getModelOptions: optionsMock,
  invalidateModelOptions: invalidateMock,
}));

import { POST as providerKeyPost } from "@/app/setup-api/hermes/provider-key/route";
import { POST as oauthSubmitPost } from "@/app/setup-api/hermes/oauth/submit/route";
import { GET as oauthPollGet } from "@/app/setup-api/hermes/oauth/poll/route";

/** A catalogue payload naming exactly these credentialed providers. */
function catalogue(ids: string[], current = "openrouter") {
  return {
    providers: [
      ...ids.map((id) => ({
        id,
        name: id,
        authenticated: true,
        verified: null,
        isUserDefined: false,
        source: "dashboard",
        total: 1,
        models: [{ id: `${id}-model`, description: "" }],
      })),
      // A row Hermes explicitly reports as having NO credentials. The MCP
      // server drops those, so this suite must too — otherwise the "set" being
      // compared is not the set the agent is holding.
      {
        id: "kimi-coding",
        name: "kimi-coding",
        authenticated: false,
        verified: null,
        isUserDefined: false,
        source: "dashboard",
        total: 0,
        models: [],
      },
    ],
    current: { provider: current, model: `${current}-model` },
    reasoning: "",
    fetchedAt: Date.now(),
    source: "dashboard" as const,
    stale: false,
  };
}

/** How many GLOBAL MCP respawns this request asked the agent for. */
function reloadCount(): number {
  return rpcMock.mock.calls.filter((call) => call[0] === "reload.mcp").length;
}

/** Answer the "before" read with `first`, every later read with `second`. */
function catalogueGrows(first: string[], second: string[], current = "openrouter") {
  let seen = 0;
  optionsMock.mockImplementation(async () => catalogue(seen++ === 0 ? first : second, current));
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ status: "ok" });
  cliMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  optionsMock.mockReset();
  invalidateMock.mockReset();
  dashboardFetchMock.mockReset();
});

function keyRequest(provider: string) {
  return new Request("http://localhost/setup-api/hermes/provider-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey: "sk-abcdefghijklmnop" }),
  });
}

describe("pasting a provider API key", () => {
  it("asks the agent to re-advertise its providers when the set grew", async () => {
    catalogueGrows(["openrouter"], ["openrouter", "anthropic"]);
    const res = await providerKeyPost(keyRequest("anthropic"));
    expect(res.status).toBe(200);
    expect(reloadCount()).toBe(1);
    expect(rpcMock).toHaveBeenCalledWith("reload.mcp", { confirm: true });
  });

  it("does not pay for a reload when the same provider is re-keyed", async () => {
    // A reload respawns every MCP child and invalidates the model's prompt
    // cache. Rotating a key the device already had changes nothing the agent
    // can see, so it must cost nothing.
    catalogueGrows(["openrouter", "anthropic"], ["openrouter", "anthropic"]);
    await providerKeyPost(keyRequest("anthropic"));
    expect(reloadCount()).toBe(0);
  });

  it("asks for nothing when the key was refused", async () => {
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "nope" });
    catalogueGrows(["openrouter"], ["openrouter", "anthropic"]);
    const res = await providerKeyPost(keyRequest("anthropic"));
    expect(res.status).toBe(502);
    expect(reloadCount()).toBe(0);
  });

  it("still saves the key when the agent will not reload", async () => {
    // Best effort, exactly like its three siblings: the credential IS stored,
    // and a box whose dashboard is down must not have the owner's save turned
    // into an error by a refresh.
    catalogueGrows(["openrouter"], ["openrouter", "anthropic"]);
    rpcMock.mockResolvedValue(null);
    const res = await providerKeyPost(keyRequest("anthropic"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe("completing a provider OAuth sign-in", () => {
  function submitRequest() {
    return new Request("http://localhost/setup-api/hermes/oauth/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "nous", sessionId: "abcdefgh1234", code: "the-code" }),
    });
  }

  it("re-advertises the providers when a pasted code completed the exchange", async () => {
    catalogueGrows(["openrouter"], ["openrouter", "nous"]);
    dashboardFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, status: "connected" }), { status: 200 }),
    );
    const res = await oauthSubmitPost(submitRequest());
    expect(res.status).toBe(200);
    expect(reloadCount()).toBe(1);
  });

  it("asks for nothing when the exchange failed", async () => {
    catalogueGrows(["openrouter"], ["openrouter", "nous"]);
    dashboardFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, status: "error", message: "bad code" }), { status: 200 }),
    );
    await oauthSubmitPost(submitRequest());
    expect(reloadCount()).toBe(0);
  });

  function pollRequest() {
    return new Request(
      "http://localhost/setup-api/hermes/oauth/poll?providerId=nous&sessionId=abcdefgh1234",
    );
  }

  it("re-advertises the providers on the approved device-code tick", async () => {
    catalogueGrows(["openrouter"], ["openrouter", "nous"]);
    dashboardFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ session_id: "abcdefgh1234", status: "approved" }), { status: 200 }),
    );
    const res = await oauthPollGet(pollRequest());
    expect(res.status).toBe(200);
    expect(reloadCount()).toBe(1);
  });

  it("asks the agent for nothing on a pending tick", async () => {
    // This route is polled every few seconds for the length of a device-code
    // flow, so anything it does per tick is paid for once per tick. The
    // snapshot is a read of the SWR-cached catalogue; the RELOAD — every MCP
    // child respawned and the model's prompt cache invalidated — is what must
    // never happen more than once per flow.
    catalogueGrows(["openrouter"], ["openrouter"]);
    dashboardFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ session_id: "abcdefgh1234", status: "pending" }), { status: 200 }),
    );
    await oauthPollGet(pollRequest());
    expect(reloadCount()).toBe(0);
  });

  it("does not charge a client that keeps polling a finished session", async () => {
    // "approved" is not a one-shot: a client that never stops polling gets it
    // back on every tick. The set comparison is what makes the second one free.
    optionsMock.mockImplementation(async () => catalogue(["openrouter", "nous"]));
    dashboardFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ session_id: "abcdefgh1234", status: "approved" }), { status: 200 }),
    );
    await oauthPollGet(pollRequest());
    await oauthPollGet(pollRequest());
    expect(reloadCount()).toBe(0);
  });
});
