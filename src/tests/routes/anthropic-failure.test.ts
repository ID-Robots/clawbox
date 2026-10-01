/**
 * /setup-api/anthropic/failure — the desktop chat handing over a turn that died
 * on the Claude account's limit (TASK-1260).
 *
 * A report takes an account out of rotation, so it is the owner's page's and
 * nobody else's; the chat is answered within a few seconds whatever the swap
 * behind it is still doing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const gateway = vi.hoisted(() => ({ reportChatFailure: vi.fn(), startGatewaySwap: vi.fn() }));
vi.mock("@/lib/anthropic-gateway", () => gateway);
const swap = vi.hoisted(() => ({ startAnthropicSwap: vi.fn() }));
vi.mock("@/lib/anthropic-swap", () => swap);

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
const BODY = {
  errorMessage: "⚠️ API rate limit reached.",
  detail: "HTTP 429: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
  reason: "rate_limit",
  provider: "anthropic",
  model: "anthropic/claude-opus-5-5",
  sessionKey: "agent:main:main",
  message: "Summarise my inbox",
};

let POST: (req: Request) => Promise<Response>;
let session: SessionFixture;
let restore: () => void;

function req(body: unknown, init: { auth?: "cookie" | "bearer" | "none"; site?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  const auth = init.auth ?? "cookie";
  if (auth === "cookie") headers.cookie = session.cookie;
  if (auth === "bearer") headers.authorization = `Bearer ${MCP_TOKEN}`;
  if (init.site !== undefined) headers["sec-fetch-site"] = init.site;
  return new Request("http://localhost/setup-api/anthropic/failure", { method: "POST", headers, body: JSON.stringify(body) });
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  gateway.reportChatFailure.mockResolvedValue({
    handled: true, kind: "limit", limitKind: "weekly", activeId: "bbbbbbbb", activeLabel: "Personal Max",
    allLimited: false, nextResetAt: null, retry: "sent",
  });
  POST = (await import("@/app/setup-api/anthropic/failure/route")).POST;
});

afterEach(() => {
  vi.useRealTimers();
  session.cleanup();
  restore();
});

describe("reporting a failed chat turn", () => {
  it("hands the turn to the swap and says what happened", async () => {
    const res = await POST(req(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      handled: true, pending: false, kind: "limit", limitKind: "weekly", activeLabel: "Personal Max",
      allLimited: false, nextResetAt: null, retry: "sent",
    });
    expect(gateway.reportChatFailure).toHaveBeenCalledWith(BODY);
    // The swap and the gateway's half are listening in this process.
    expect(swap.startAnthropicSwap).toHaveBeenCalled();
    expect(gateway.startGatewaySwap).toHaveBeenCalled();
  });

  it("answers `handled: false` for a failure that is not an Anthropic account's", async () => {
    gateway.reportChatFailure.mockResolvedValue(null);
    expect(await (await POST(req({ ...BODY, provider: "openai" }))).json()).toEqual({ handled: false });
  });

  it("does not keep the chat waiting for the gateway's restart", async () => {
    vi.useFakeTimers();
    gateway.reportChatFailure.mockReturnValue(new Promise(() => {}));
    const answer = POST(req(BODY));
    await vi.advanceTimersByTimeAsync(4_100);
    expect(await (await answer).json()).toEqual({ handled: true, pending: true });
  });

  it("refuses the agent's bearer and another site, and touches nothing", async () => {
    for (const [init, code] of [[{ auth: "bearer" as const }, "owner_only"], [{ auth: "none" as const }, "owner_only"], [{ site: "cross-site" }, "cross_origin"]] as const) {
      const res = await POST(req(BODY, init));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe(code);
    }
    expect(gateway.reportChatFailure).not.toHaveBeenCalled();
  });

  it("refuses a body that is not an object", async () => {
    const res = await POST(new Request("http://localhost/setup-api/anthropic/failure", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost", cookie: session.cookie },
      body: "[]",
    }));
    expect(res.status).toBe(400);
  });
});
