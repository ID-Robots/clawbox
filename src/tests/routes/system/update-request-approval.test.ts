// /setup-api/update/request: the chat path to a software update. The MCP
// bearer only raises the owner's question; the update starts on the owner's
// approval, once.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
const startUpdate = vi.hoisted(() => vi.fn(() => ({ started: true })));
vi.mock("@/lib/updater", () => ({ startUpdate }));
vi.mock("@/lib/update-whats-new-server", () => ({ prefetchUpdateWhatsNew: async () => undefined }));
vi.mock("@/lib/email-approval", () => ({
  approvalBotToken: async () => null, chatApprovalEnabled: async () => false,
}));

describe("update from chat", () => {
  let session: SessionFixture;
  const token = "b".repeat(64);
  let request: typeof import("@/app/setup-api/update/request/route").POST;
  let decide: typeof import("@/app/setup-api/system/power/approval/route").POST;
  beforeEach(async () => {
    vi.resetModules();
    session = installSessionFixture();
    fs.writeFileSync(path.join(session.root, "data/.mcp-token"), token);
    startUpdate.mockClear();
    request = (await import("@/app/setup-api/update/request/route")).POST;
    decide = (await import("@/app/setup-api/system/power/approval/route")).POST;
    const lib = await import("@/lib/power-approval");
    const old = lib.pendingPowerApproval();
    if (old) await lib.resolvePowerApproval(old.id, old.action, false);
    const state = (globalThis as typeof globalThis & { [key: symbol]: { deniedAt?: number } })[Symbol.for("clawbox.power-approval")];
    delete state.deniedAt;
  });
  afterEach(() => session.cleanup());
  const req = (body: unknown, cookie?: string) => new Request("http://localhost/setup-api/update/request", {
    method: "POST", headers: cookie ? { Cookie: cookie } : { Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });

  it("the MCP bearer only asks; it cannot approve its own request", async () => {
    const response = await request(req({ reason: "user asked to update" }));
    expect(response.status).toBe(202);
    const prompt = await response.json();
    expect(prompt).toMatchObject({ pendingApproval: true, action: "update" });
    expect((await decide(req({ id: prompt.id, action: "update", approve: true }))).status).toBe(403);
    expect(startUpdate).not.toHaveBeenCalled();
  });

  it("the owner's approval starts the update exactly once", async () => {
    const prompt = await (await request(req({ reason: "update please" }))).json();
    const decisions = await Promise.all([1, 2].map(() => decide(req({ id: prompt.id, action: "update", approve: true }, session.cookie))));
    expect(decisions.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(startUpdate).toHaveBeenCalledOnce();
  });

  it("a declined update never starts", async () => {
    const prompt = await (await request(req({ reason: "update please" }))).json();
    expect((await decide(req({ id: prompt.id, action: "update", approve: false }, session.cookie))).status).toBe(200);
    expect(startUpdate).not.toHaveBeenCalled();
  });

  it("the power route still refuses action=update", async () => {
    const power = (await import("@/app/setup-api/system/power/route")).POST;
    expect((await power(req({ action: "update" }))).status).toBe(400);
  });
});
