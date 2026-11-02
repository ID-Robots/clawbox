import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

// The agent's MCP bearer passes middleware on every /setup-api route. The chat
// path to an update (`update/request`, MCP `update_run`) only asks the owner,
// and the update runs when they tap Confirm. Its siblings `update/run` and
// `update/openclaw` must not let the same bearer start the root updater
// straight away (4.3 bug 2).

vi.mock("@/lib/mcp-token", () => ({
  verifyMcpBearer: (header: string | null) => header === "Bearer agent-token",
}));
vi.mock("@/lib/updater", () => ({
  startUpdate: vi.fn(() => ({ started: true })),
  startOpenclawUpdate: vi.fn(() => ({ started: true })),
  isUpdateCompleted: vi.fn(async () => false),
}));
vi.mock("@/lib/update-whats-new-server", () => ({
  prefetchUpdateWhatsNew: vi.fn(async () => undefined),
}));
vi.mock("@/lib/power-approval", () => ({
  requestPowerApproval: vi.fn(async () => ({ id: "p1", expiresAt: 1234, messages: [{}] })),
  dispatchPowerAction: vi.fn(async () => undefined),
  PowerApprovalConflict: class PowerApprovalConflict extends Error {},
}));

import { startOpenclawUpdate, startUpdate } from "@/lib/updater";
import { requestPowerApproval } from "@/lib/power-approval";

let session: SessionFixture;

function bearerPost(url: string, body: unknown = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer agent-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ownerPost(url: string, body: unknown = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  session = installSessionFixture();
});

afterEach(() => {
  session.cleanup();
});

describe("POST /setup-api/update/request (the chat path, the control)", () => {
  it("asks the owner instead of starting the update for the bearer", async () => {
    const { POST } = await import("@/app/setup-api/update/request/route");
    const res = await POST(bearerPost("http://localhost/setup-api/update/request"));
    expect(res.status).toBe(202);
    expect(startUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/update/run", () => {
  const URL = "http://localhost/setup-api/update/run";

  it("does not start the update for the bearer: it asks the owner, as update/request does", async () => {
    const { POST } = await import("@/app/setup-api/update/run/route");

    const res = await POST(bearerPost(URL, { force: true, allowHarnessDowngrade: true }));

    expect(startUpdate).not.toHaveBeenCalled();
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      pendingApproval: true, action: "update", id: "p1", expiresAt: 1234, telegramPromptSent: true,
    });
    expect(requestPowerApproval).toHaveBeenCalledWith("update", expect.any(String));
  });

  it("still starts the update at once for the owner's own click", async () => {
    const { POST } = await import("@/app/setup-api/update/run/route");

    const res = await POST(ownerPost(URL, { force: true }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ started: true });
    expect(startUpdate).toHaveBeenCalledTimes(1);
    expect(requestPowerApproval).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/update/openclaw", () => {
  const URL = "http://localhost/setup-api/update/openclaw";

  it("refuses the bearer with 403 and starts nothing", async () => {
    const { POST } = await import("@/app/setup-api/update/openclaw/route");

    const res = await POST(bearerPost(URL));

    expect(startOpenclawUpdate).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });

  it("answers 401 to a caller with no session and starts nothing", async () => {
    const { POST } = await import("@/app/setup-api/update/openclaw/route");

    const res = await POST(new Request(URL, { method: "POST" }));

    expect(startOpenclawUpdate).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("still starts the OpenClaw update for a signed-in person", async () => {
    const { POST } = await import("@/app/setup-api/update/openclaw/route");

    const res = await POST(ownerPost(URL));

    expect(res.status).toBe(200);
    expect(startOpenclawUpdate).toHaveBeenCalledTimes(1);
  });
});
