/**
 * POST /setup-api/coding-agent/github-login — the device-flow login.
 *
 * OWNER-ONLY for all three actions: this route changes whose GitHub
 * credential the box holds, and the party that gains push access (the agent,
 * whose bearer the middleware would otherwise accept) must not be the party
 * that can grant it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const startDeviceLogin = vi.hoisted(() => vi.fn());
const pollDeviceLogin = vi.hoisted(() => vi.fn());
const cancelDeviceLogin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-github", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-github")>("@/lib/coding-github");
  return { ...actual, startDeviceLogin, pollDeviceLogin, cancelDeviceLogin };
});

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";

let POST: (req: Request) => Promise<Response>;
let session: SessionFixture;
let restore: () => void;

function post(action: unknown, auth?: { cookie?: string; bearer?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth?.cookie) headers.cookie = auth.cookie;
  if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  return new Request("http://localhost/setup-api/coding-agent/github-login", {
    method: "POST",
    headers,
    body: JSON.stringify({ action }),
  });
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  startDeviceLogin.mockResolvedValue({ userCode: "8A5B-0396", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 });
  pollDeviceLogin.mockResolvedValue({ status: "pending" });
  POST = (await import("@/app/setup-api/coding-agent/github-login/route")).POST;
});

afterEach(() => {
  session.cleanup();
  restore();
});

describe("the owner gate", () => {
  it("refuses the agent's bearer — push access must not be self-granted", async () => {
    const res = await POST(post("start", { bearer: MCP_TOKEN }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
    expect(startDeviceLogin).not.toHaveBeenCalled();
  });

  it("refuses no session at all", async () => {
    expect((await POST(post("start"))).status).toBe(403);
  });
});

describe("the actions", () => {
  it("start answers the code and link for the card", async () => {
    const res = await POST(post("start", { cookie: session.cookie }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userCode: "8A5B-0396" });
  });

  it("start answers 503 when github.com could not be reached — transient, retry", async () => {
    startDeviceLogin.mockResolvedValue({ error: "Could not reach github.com" });
    const res = await POST(post("start", { cookie: session.cookie }));
    expect(res.status).toBe(503);
  });

  it("poll and cancel pass through", async () => {
    const cookie = session.cookie;
    expect(await (await POST(post("poll", { cookie }))).json()).toEqual({ status: "pending" });
    expect((await POST(post("cancel", { cookie }))).status).toBe(200);
    expect(cancelDeviceLogin).toHaveBeenCalled();
  });

  it("answers 400 for an action it does not know", async () => {
    expect((await POST(post("steal-token", { cookie: session.cookie }))).status).toBe(400);
  });
});
