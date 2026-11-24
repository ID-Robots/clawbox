// /setup-api/update/request: the chat path to a software update. The MCP
// bearer only raises the owner's question; the update starts on the owner's
// approval, once.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
const startUpdate = vi.hoisted(() => vi.fn((): { started: boolean; error?: string } => ({ started: true })));
// Whether an update is already in flight (the updater's own answer is pinned in updater.test.ts).
const inFlight = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/lib/updater", () => ({
  startUpdate, startWouldOverlapUpdate: inFlight, UPDATE_ALREADY_IN_PROGRESS: "Update already in progress",
}));
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
    inFlight.mockReset();
    inFlight.mockResolvedValue(false);
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

  it("raises no question and starts nothing while an update is already in flight", async () => {
    inFlight.mockResolvedValue(true);
    const asked = await request(req({ reason: "update please" }));
    expect(asked.status).toBe(409);
    expect((await asked.json()).error).toBe("An update is already running; the desktop shows how it ends.");
    expect((await import("@/lib/power-approval")).pendingPowerApproval()).toBeNull();

    const owner = await request(req({}, session.cookie));
    expect(owner.status).toBe(409);
    expect(startUpdate).not.toHaveBeenCalled();
  });

  it("starts nothing when the owner confirms after an update has begun", async () => {
    // Asked first; an update started from the desktop before the Confirm. A
    // restarted server's update that it has not asked about yet counts too.
    const prompt = await (await request(req({ reason: "update please" }))).json();
    inFlight.mockResolvedValue(true);
    const confirmed = await decide(req({ id: prompt.id, action: "update", approve: true }, session.cookie));
    expect(startUpdate).not.toHaveBeenCalled();
    // The desktop card shows this sentence; it is not "the power command failed".
    expect(confirmed.status).toBe(409);
    expect(await confirmed.json()).toEqual({ error: "An update is already running; the desktop shows how it ends." });
  });

  it("says an update is running when the start itself refuses for that reason", async () => {
    // An update took the box between the check and the start, and may be gone
    // again by any second look: the refusal itself is the answer.
    const prompt = await (await request(req({ reason: "update please" }))).json();
    startUpdate.mockReturnValueOnce({ started: false, error: "Update already in progress" });
    const confirmed = await decide(req({ id: prompt.id, action: "update", approve: true }, session.cookie));
    expect(confirmed.status).toBe(409);
    expect(await confirmed.json()).toEqual({ error: "An update is already running; the desktop shows how it ends." });
  });

  it("keeps every other failure of the owner's Confirm as it was", async () => {
    const prompt = await (await request(req({ reason: "update please" }))).json();
    startUpdate.mockReturnValueOnce({ started: false, error: "OpenClaw database maintenance is running" });
    const confirmed = await decide(req({ id: prompt.id, action: "update", approve: true }, session.cookie));
    expect(confirmed.status).toBe(500);
    expect(await confirmed.json()).toEqual({ error: "Power command failed; request it again to retry" });
  });

  it("the power route still refuses action=update", async () => {
    const power = (await import("@/app/setup-api/system/power/route")).POST;
    expect((await power(req({ action: "update" }))).status).toBe(400);
  });
});
