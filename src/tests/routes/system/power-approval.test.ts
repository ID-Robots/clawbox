import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: exec }));
vi.mock("@/lib/email-approval", () => ({
  approvalBotToken: async () => null, chatApprovalEnabled: async () => false,
}));

describe("power confirmation boundary", () => {
  let session: SessionFixture;
  const token = "a".repeat(64);
  let request: typeof import("@/app/setup-api/system/power/route").POST;
  let decide: typeof import("@/app/setup-api/system/power/approval/route").POST;
  let pending: typeof import("@/lib/power-approval").pendingPowerApproval;
  beforeEach(async () => {
    vi.resetModules();
    session = installSessionFixture();
    fs.writeFileSync(path.join(session.root, "data/.mcp-token"), token);
    exec.mockReset();
    exec.mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: null, out: string, err: string) => void)(null, "", "");
    });
    request = (await import("@/app/setup-api/system/power/route")).POST;
    decide = (await import("@/app/setup-api/system/power/approval/route")).POST;
    pending = (await import("@/lib/power-approval")).pendingPowerApproval;
    const old = pending();
    if (old) await (await import("@/lib/power-approval")).resolvePowerApproval(old.id, old.action, false);
  });
  afterEach(() => { vi.useRealTimers(); session.cleanup(); });
  const req = (body: unknown, cookie?: string) => new Request("http://localhost/setup-api/system/power", {
    method: "POST", headers: cookie ? { Cookie: cookie } : { Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  it("an MCP bearer queues a question but cannot approve it, even with confirm=true", async () => {
    const response = await request(req({ action: "restart", confirm: true, reason: "test request" }));
    expect(response.status).toBe(202);
    const prompt = await response.json();
    expect(exec).not.toHaveBeenCalled();
    expect((await decide(req({ id: prompt.id, action: "restart", approve: true }))).status).toBe(403);
    expect(exec).not.toHaveBeenCalled();
  });
  it("returns a conflict without replacing a different pending action", async () => {
    expect((await request(req({ action: "restart" }))).status).toBe(202);
    expect((await request(req({ action: "shutdown" }))).status).toBe(409);
    expect(pending()?.action).toBe("restart");
    expect(exec).not.toHaveBeenCalled();
  });
  it("the owner can approve the exact action only once", async () => {
    const prompt = await (await request(req({ action: "restart" }))).json();
    expect((await decide(req({ id: prompt.id, action: "shutdown", approve: true }, session.cookie))).status).toBe(409);
    const decisions = await Promise.all([1, 2].map(() => decide(req({ id: prompt.id, action: "restart", approve: true }, session.cookie))));
    expect(decisions.map(r => r.status).sort()).toEqual([200, 409]);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][1]).toEqual(["/usr/bin/systemctl", "reboot"]);
  });
  it("expired requests cannot execute", async () => {
    const prompt = await (await request(req({ action: "shutdown" }))).json();
    vi.useFakeTimers(); vi.setSystemTime(prompt.expiresAt + 1);
    expect((await decide(req({ id: prompt.id, action: "shutdown", approve: true }, session.cookie))).status).toBe(409);
    expect(exec).not.toHaveBeenCalled();
  });
  it("rejects prototype names instead of dispatching them", async () => {
    expect((await request(req({ action: "constructor" }))).status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });
});
