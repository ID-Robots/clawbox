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
    const state = (globalThis as typeof globalThis & { [key: symbol]: { deniedAt?: number } })[Symbol.for("clawbox.power-approval")];
    delete state.deniedAt;
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
  it("denial rate-limits the agent but never blocks direct owner power", async () => {
    vi.useFakeTimers();
    const prompt = await (await request(req({ action: "restart" }))).json();
    expect((await decide(req({ id: prompt.id, action: "restart", approve: false }, session.cookie))).status).toBe(200);
    expect((await request(req({ action: "restart" }))).status).toBe(409);
    expect((await request(req({ action: "shutdown" }))).status).toBe(409);
    expect(exec).not.toHaveBeenCalled();
    expect((await request(req({ action: "restart" }, session.cookie))).status).toBe(200);
    vi.advanceTimersByTime(60_001);
    expect((await request(req({ action: "restart" }))).status).toBe(202);
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

  // The desktop's prompt no longer asks the approval route every 5 s: it asks
  // when the owner-notice ring (src/lib/pending-actions.ts), which every
  // desktop reads every 2 s, says something about a power request changed.
  describe("telling the open desktops", () => {
    type Entry = Record<string, unknown> & { id: string };
    const noticesFor = async (id: string): Promise<Entry[]> => {
      const { kvGet } = await import("@/lib/kv-store");
      const ring = JSON.parse(kvGet("ui:pending-actions") ?? "[]") as Entry[];
      return ring.filter((e) => e.id.startsWith(`power-approval:${id}:`));
    };
    const live = () => (globalThis as typeof globalThis & { [key: symbol]: { pending: unknown } })[Symbol.for("clawbox.power-approval")].pending;

    it("says a request was asked — and nothing of what it asks", async () => {
      const prompt = await (await request(req({ action: "restart", reason: "agent's words" }))).json();
      await vi.waitFor(async () => expect(await noticesFor(prompt.id)).toHaveLength(1));
      const [entry] = await noticesFor(prompt.id);
      expect(entry).toMatchObject({ id: `power-approval:${prompt.id}:asked`, type: "power_approval" });
      // The ring is a file the agent can write and the bearer can read; the
      // prompt's content comes from the owner-gated route alone.
      expect(Object.keys(entry).sort()).toEqual(["id", "ts", "type"]);
    });

    it("asks once per request: the same question again is no new notice", async () => {
      const prompt = await (await request(req({ action: "restart" }))).json();
      expect((await request(req({ action: "restart" }))).status).toBe(202);
      await vi.waitFor(async () => expect(await noticesFor(prompt.id)).toHaveLength(1));
    });

    it.each([true, false])("says it was settled when the owner answers it (approve: %s)", async (approve) => {
      const prompt = await (await request(req({ action: "restart" }))).json();
      expect((await decide(req({ id: prompt.id, action: "restart", approve }, session.cookie))).status).toBe(200);
      await vi.waitFor(async () => expect((await noticesFor(prompt.id)).map((e) => e.id)).toEqual([
        `power-approval:${prompt.id}:asked`, `power-approval:${prompt.id}:settled`,
      ]));
    });

    it("expires a request nobody answers on time, and says so, with nobody asking", async () => {
      vi.useFakeTimers();
      const prompt = await (await request(req({ action: "shutdown" }))).json();
      await vi.advanceTimersByTimeAsync(119_000);
      expect(live()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(2_000);
      // Read off the state itself: asking `pendingPowerApproval()` would
      // expire it lazily and prove nothing about the timer.
      expect(live()).toBeNull();
      // Only the settlement: the ring's writer drops what is older than a
      // minute, and the question was asked two minutes ago.
      expect((await noticesFor(prompt.id)).map((e) => e.id)).toEqual([`power-approval:${prompt.id}:settled`]);
      expect(exec).not.toHaveBeenCalled();
    });

    it("judges expiry by the same wall clock as before when the box's clock is stepped back", async () => {
      // No RTC: NTP can step the clock back. By the test the request has
      // always been judged by, it is then still live — so the timer looks
      // again later instead of expiring it early.
      vi.useFakeTimers();
      const prompt = await (await request(req({ action: "restart" }))).json();
      vi.setSystemTime(Date.now() - 600_000);
      await vi.advanceTimersByTimeAsync(121_000);
      expect(live()).not.toBeNull();
      expect(await noticesFor(prompt.id)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(live()).toBeNull();
      expect((await noticesFor(prompt.id)).map((e) => e.id)).toContain(`power-approval:${prompt.id}:settled`);
    });

    it("does not let a failed notice turn a decision into an error", async () => {
      const prompt = await (await request(req({ action: "restart" }))).json();
      // The box's store refuses every write from here on.
      const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("EROFS"); });
      const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("EROFS"); });
      try {
        expect((await decide(req({ id: prompt.id, action: "restart", approve: true }, session.cookie))).status).toBe(200);
        expect(exec).toHaveBeenCalledOnce();
        // The write was attempted, and refused.
        await vi.waitFor(() => expect(rename.mock.calls.length + write.mock.calls.length).toBeGreaterThan(0));
      } finally {
        rename.mockRestore();
        write.mockRestore();
      }
    });
  });
});
