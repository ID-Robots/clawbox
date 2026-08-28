/**
 * POST /setup-api/coding-agent/github-login — the device-flow login.
 *
 * OWNER-ONLY for all three actions: this route changes whose GitHub
 * credential the box holds, and the party that gains push access (the agent,
 * whose bearer the middleware would otherwise accept) must not be the party
 * that can grant it.
 *
 * And OUR PAGE ONLY: the owner's browser attaches the session cookie to a
 * POST any other site fires at the box, so a signed-in owner visiting a
 * hostile page must not have a device flow started in their name.
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

function post(action: unknown, auth?: { cookie?: string; bearer?: string; origin?: string; site?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (auth?.cookie) headers.cookie = auth.cookie;
  if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth?.origin !== undefined) headers.origin = auth.origin;
  if (auth?.site !== undefined) headers["sec-fetch-site"] = auth.site;
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

describe("the origin guard", () => {
  it("refuses a cross-site POST that carries the owner's cookie", async () => {
    const res = await POST(post("start", { cookie: session.cookie, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "cross_origin" });
    expect(startDeviceLogin).not.toHaveBeenCalled();
  });

  it("refuses an opaque origin — 'null' is not 'nowhere'", async () => {
    expect((await POST(post("start", { cookie: session.cookie, origin: "null" }))).status).toBe(403);
    expect(startDeviceLogin).not.toHaveBeenCalled();
  });

  it("refuses a browser that says cross-site even without an Origin", async () => {
    expect((await POST(post("cancel", { cookie: session.cookie, site: "cross-site" }))).status).toBe(403);
    expect(cancelDeviceLogin).not.toHaveBeenCalled();
  });

  it("lets the box's own page through, whatever scheme it was served over", async () => {
    // Plain http on the LAN and https through the tunnel both name this host.
    expect((await POST(post("start", { cookie: session.cookie, origin: "https://localhost" }))).status).toBe(200);
    expect(startDeviceLogin).toHaveBeenCalledTimes(1);
  });

  it("lets a caller with no Origin through — that is not a browser, and the owner gate already decided", async () => {
    expect((await POST(post("start", { cookie: session.cookie }))).status).toBe(200);
  });

  it("runs after the owner gate, so the agent's bearer still gets the owner-only answer", async () => {
    const res = await POST(post("start", { bearer: MCP_TOKEN, origin: "https://evil.example" }));
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
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

  it("poll relays the cadence github.com currently allows, so the card can reschedule", async () => {
    pollDeviceLogin.mockResolvedValue({ status: "pending", interval: 10 });
    expect(await (await POST(post("poll", { cookie: session.cookie }))).json()).toEqual({ status: "pending", interval: 10 });
  });

  it("answers 400 for an action it does not know", async () => {
    expect((await POST(post("steal-token", { cookie: session.cookie }))).status).toBe(400);
  });
});
