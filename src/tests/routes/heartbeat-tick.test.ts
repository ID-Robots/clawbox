/**
 * What the five-minute tick does with a hostname that has stopped existing.
 *
 * Before this, it pushed whatever was in tunnel.url. Cloudflare reaps quick
 * tunnels, cloudflared keeps running, the file keeps a corpse, and the portal
 * showed a green Online next to a dead link on 5 of 30 live devices.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const routeAuth = { requireSession: vi.fn() };
const internalToken = { isInternalRequest: vi.fn() };

const cloudflared = {
  readTunnelUrl: vi.fn(),
  startTunnelService: vi.fn(),
};
const heartbeat = { pushHeartbeatTick: vi.fn() };
const liveness = {
  checkTunnelLiveness: vi.fn(),
  mayRestart: vi.fn(),
  markRestarted: vi.fn(),
};
const persona = {
  applyDeferredLanguagePersona: vi.fn(),
  retireOnboardingRitual: vi.fn(),
  openclawWorkspaceDir: vi.fn(),
};
const harness = { getActiveHarness: vi.fn() };
const gatewayWs = { gatewayWsCall: vi.fn() };

vi.mock("@/lib/language-persona", () => persona);
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: harness.getActiveHarness,
}));
// Partial, so the real error classes survive for the code's `instanceof`.
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()),
  gatewayWsCall: gatewayWs.gatewayWsCall,
}));
vi.mock("@/lib/cloudflared", () => cloudflared);
vi.mock("@/lib/portal-heartbeat", () => heartbeat);
vi.mock("@/lib/tunnel-liveness", () => liveness);
vi.mock("@/lib/route-auth", () => routeAuth);
vi.mock("@/lib/internal-token", () => internalToken);

function request(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1/setup-api/portal/heartbeat-tick", { headers });
}

async function tick(req: Request = request()) {
  const mod = await import("@/app/setup-api/portal/heartbeat-tick/route");
  return mod.GET(req);
}

let scratch: string;

beforeEach(() => {
  vi.resetModules();
  // Every tick also looks at AGENTS.md. By default it is an OpenClaw box whose
  // workspace has none, so that step returns before any gateway call; a call
  // nobody set up fails loudly.
  scratch = mkdtempSync(path.join(tmpdir(), "heartbeat-tick-"));
  harness.getActiveHarness.mockResolvedValue("openclaw");
  persona.openclawWorkspaceDir.mockReturnValue(path.join(scratch, "workspace"));
  gatewayWs.gatewayWsCall.mockRejectedValue(new Error("unexpected gateway call"));
  liveness.mayRestart.mockReturnValue(true);
  cloudflared.startTunnelService.mockResolvedValue({ bootPersisted: true, bootPersistWarning: null });
  persona.applyDeferredLanguagePersona.mockResolvedValue(false);
  persona.retireOnboardingRitual.mockResolvedValue(false);
  // Default for the behavioural tests below: the systemd unit, presenting the
  // install's internal token.
  internalToken.isInternalRequest.mockReturnValue(true);
  routeAuth.requireSession.mockResolvedValue(null);
});

afterEach(() => {
  for (const fn of [
    ...Object.values(cloudflared),
    ...Object.values(heartbeat),
    ...Object.values(liveness),
    ...Object.values(routeAuth),
    ...Object.values(internalToken),
    ...Object.values(persona),
    ...Object.values(harness),
    ...Object.values(gatewayWs),
  ]) {
    fn.mockReset();
  }
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The tick is pre-auth in middleware because the timer runs on a device nobody
 * has logged into. That had become "anyone may call it" — and the dead-tunnel
 * branch RESTARTS clawbox-tunnel, so any LAN neighbour, or anyone holding the
 * box's public tunnel URL, could bounce a systemd unit four times an hour
 * (TASK-446).
 */
describe("who may call the tick", () => {
  beforeEach(() => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://dead-tunnel-example.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("dead");
  });

  it("refuses an anonymous caller, and restarts nothing", async () => {
    internalToken.isInternalRequest.mockReturnValue(false);
    routeAuth.requireSession.mockResolvedValue(
      NextResponse.json({ error: "Authentication required" }, { status: 401 }),
    );

    const res = await tick();

    expect(res.status).toBe(401);
    expect(cloudflared.startTunnelService).not.toHaveBeenCalled();
    expect(heartbeat.pushHeartbeatTick).not.toHaveBeenCalled();
  });

  it("accepts our own unit on its internal token, with no session", async () => {
    internalToken.isInternalRequest.mockReturnValue(true);
    routeAuth.requireSession.mockResolvedValue(
      NextResponse.json({ error: "Authentication required" }, { status: 401 }),
    );

    const res = await tick(request({ "x-clawbox-internal-token": "a".repeat(64) }));

    expect(res.status).toBe(200);
    // The token is checked BEFORE the session, so the timer never depends on
    // anyone being logged in.
    expect(routeAuth.requireSession).not.toHaveBeenCalled();
  });

  it("accepts the owner's browser on its session cookie", async () => {
    internalToken.isInternalRequest.mockReturnValue(false);
    routeAuth.requireSession.mockResolvedValue(null);

    const res = await tick();

    expect(res.status).toBe(200);
  });
});

describe("a live tunnel", () => {
  it("is reported, as before", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://alive.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("alive");

    const res = await tick();
    expect(res.status).toBe(200);
    expect(heartbeat.pushHeartbeatTick).toHaveBeenCalledWith("https://alive.trycloudflare.com");
    expect(cloudflared.startTunnelService).not.toHaveBeenCalled();
  });
});

describe("a dead tunnel", () => {
  beforeEach(() => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://dead-tunnel-example.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("dead");
  });

  it("is never reported", async () => {
    // The whole bug in one assertion.
    await tick();
    expect(heartbeat.pushHeartbeatTick).not.toHaveBeenCalled();
  });

  it("restarts the tunnel so a fresh hostname is minted", async () => {
    await tick();
    expect(cloudflared.startTunnelService).toHaveBeenCalledTimes(1);
    expect(liveness.markRestarted).toHaveBeenCalled();
  });

  it("says what it did, so the timer's log is diagnosable", async () => {
    const res = await tick();
    expect(await res.json()).toEqual({ ok: true, tunnel: "dead", restarted: true });
  });

  it("respects the cooldown rather than restarting every five minutes", async () => {
    liveness.mayRestart.mockReturnValue(false);
    const res = await tick();
    expect(cloudflared.startTunnelService).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, tunnel: "dead", restarted: false });
  });

  it("still answers 200 when the restart itself fails", async () => {
    // A 500 here would make the systemd unit flap.
    cloudflared.startTunnelService.mockRejectedValue(new Error("sudo: no tty"));
    const res = await tick();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tunnel: "dead", restarted: false });
  });
});

describe("when the box cannot tell", () => {
  it("keeps reporting, because the fault is probably our own network", async () => {
    // Dropped uplink. Going quiet here would mark a healthy box Offline, and
    // restarting its tunnel would fix nothing.
    cloudflared.readTunnelUrl.mockResolvedValue("https://maybe.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("unknown");

    await tick();
    expect(heartbeat.pushHeartbeatTick).toHaveBeenCalledWith("https://maybe.trycloudflare.com");
    expect(cloudflared.startTunnelService).not.toHaveBeenCalled();
  });

  it("passes a missing url straight through, as it always did", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue(null);
    liveness.checkTunnelLiveness.mockResolvedValue("unknown");

    const res = await tick();
    expect(res.status).toBe(200);
    expect(heartbeat.pushHeartbeatTick).toHaveBeenCalledWith(null);
  });
});

/**
 * The tick is also what pays back a language pick OpenClaw's
 * first-conversation ritual made ClawBox defer.
 *
 * POST /setup-api/preferences refuses to write USER.md/SOUL.md while the
 * introduction is armed or unstarted — creating those files is what suppressed
 * the ritual on every box that shipped — and records the debt instead. Nothing
 * restarts the gateway when the agent finishes the introduction, so the
 * ExecStartPre that re-applies the pick can sit unrun for as long as the box
 * stays up: the desktop in the owner's language, the agent's persona with no
 * language directive at all. This five-minute tick is the only thing on a
 * running box that fires without anyone touching it, so it is where the debt
 * is drained.
 */
describe("the deferred language pick", () => {
  it("is drained on an ordinary tick", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://alive.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("alive");

    await tick();
    expect(persona.applyDeferredLanguagePersona).toHaveBeenCalledTimes(1);
  });

  it("is drained on the dead-tunnel path too, which returns early", async () => {
    // The tunnel and the persona have nothing to do with each other; a box
    // whose tunnel died must still learn the owner's language.
    cloudflared.readTunnelUrl.mockResolvedValue("https://dead.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("dead");

    const res = await tick();
    expect(res.status).toBe(200);
    expect(persona.applyDeferredLanguagePersona).toHaveBeenCalledTimes(1);
  });

  it("is not drained for a caller the tick refuses", async () => {
    // The drain writes the agent's system prompt from stored state. It belongs
    // behind the same door as the unit restart below it.
    internalToken.isInternalRequest.mockReturnValue(false);
    routeAuth.requireSession.mockResolvedValue(
      NextResponse.json({ error: "Authentication required" }, { status: 401 }),
    );

    const res = await tick();
    expect(res.status).toBe(401);
    expect(persona.applyDeferredLanguagePersona).not.toHaveBeenCalled();
  });
});

/**
 * TASK-1528: a set-up box runs no first-conversation ritual. A box updated
 * while one was still pending, and whose gateway has not restarted since, has
 * nothing but this tick to retire it — and the language payback waits on
 * exactly that retirement, so it has to come first.
 */
describe("the pending first-conversation ritual", () => {
  it("is retired on every tick, before the language payback", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://alive.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("alive");

    await tick();
    expect(persona.retireOnboardingRitual).toHaveBeenCalledTimes(1);
    expect(persona.retireOnboardingRitual.mock.invocationCallOrder[0]).toBeLessThan(
      persona.applyDeferredLanguagePersona.mock.invocationCallOrder[0],
    );
  });

  it("is retired on the dead-tunnel path too", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://dead.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("dead");

    const res = await tick();
    expect(res.status).toBe(200);
    expect(persona.retireOnboardingRitual).toHaveBeenCalledTimes(1);
  });

  it("is not touched for a caller the tick refuses", async () => {
    internalToken.isInternalRequest.mockReturnValue(false);
    routeAuth.requireSession.mockResolvedValue(
      NextResponse.json({ error: "Authentication required" }, { status: 401 }),
    );

    const res = await tick();
    expect(res.status).toBe(401);
    expect(persona.retireOnboardingRitual).not.toHaveBeenCalled();
  });
});

/**
 * ClawBox's AGENTS.md rules on a freshly set-up box. OpenClaw creates
 * AGENTS.md on the agent's first run, which there comes after the gateway's
 * last start, so the ExecStartPre that appends the rules found no file, and the
 * box ran without them until something restarted its gateway. The tick is what
 * runs in between.
 */
describe("ClawBox's AGENTS.md rules", () => {
  // OpenClaw's own template, the way it lands on the first run: no ClawBox section.
  const TEMPLATE = "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n\n"
    + "## Red Lines\n\n- Don't exfiltrate private data. Ever.\n\n## Related\n\n- Default AGENTS.md\n";
  const savedHome = process.env.OPENCLAW_HOME;
  let workspace: string;
  let agentsMd: string;

  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const callsTo = (method: string) =>
    gatewayWs.gatewayWsCall.mock.calls.filter(([m]) => m === method).map(([, params]) => params);

  /** The gateway's side of `agents.files.get` / `set`, serving `content`. */
  function gatewayServing(content: string) {
    gatewayWs.gatewayWsCall.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "agents.files.get") {
        return {
          agentId: params.agentId,
          workspace,
          file: { name: "AGENTS.md", path: agentsMd, missing: false, content, hash: sha256(content) },
        };
      }
      if (method === "agents.files.set") return { ok: true, agentId: params.agentId, workspace };
      throw new Error(`unexpected gateway call ${method}`);
    });
  }

  beforeEach(() => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://alive.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("alive");
    // The agent's own workspace, pinned in its roster entry. Not the persona
    // mock's directory: an earlier case's un-awaited run may still be going,
    // and it reads that mock's CURRENT value, so it stays an empty directory.
    workspace = path.join(scratch, "agent-workspace");
    agentsMd = path.join(workspace, "AGENTS.md");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(agentsMd, TEMPLATE);
    // The box's one agent is called `default`, as on the TASK-2248 box: the
    // gateway refuses an id its config does not name, so "main" would fail.
    const home = path.join(scratch, "openclaw");
    mkdirSync(home, { recursive: true });
    const config = { agents: { entries: { default: { workspace } } } };
    writeFileSync(path.join(home, "openclaw.json"), JSON.stringify(config));
    process.env.OPENCLAW_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = savedHome;
  });

  it("appends every missing section through the gateway's own file RPC", async () => {
    gatewayServing(TEMPLATE);

    const res = await tick();
    expect(res.status).toBe(200);

    // The step is not awaited by the tick, so wait for the write itself.
    await vi.waitFor(() => expect(callsTo("agents.files.set")).toHaveLength(1));
    expect(callsTo("agents.files.get")).toEqual([{ agentId: "default", name: "AGENTS.md" }]);
    const [set] = callsTo("agents.files.set");
    expect(set).toMatchObject({
      agentId: "default",
      name: "AGENTS.md",
      expectedHash: sha256(TEMPLATE),
      expectedWorkspace: workspace,
    });
    const content = String(set.content);
    expect(content.startsWith(TEMPLATE)).toBe(true);
    // Loaded only after the assertions above, so a tree without the module
    // fails on them rather than on a missing import.
    const { CLAWBOX_AGENTS_SECTIONS } = await import("@/lib/clawbox-agents-sections");
    expect(CLAWBOX_AGENTS_SECTIONS.length).toBeGreaterThanOrEqual(3);
    for (const { heading } of CLAWBOX_AGENTS_SECTIONS) {
      expect(content.split("\n").filter((line) => line === heading), heading).toHaveLength(1);
    }
  });

  it("answers the tick while the gateway has not answered", async () => {
    // The unit's curl gives the tick 10 s, and gateway calls took seconds on
    // a busy board.
    gatewayWs.gatewayWsCall.mockImplementation(() => new Promise(() => {}));

    const res = await tick();

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(callsTo("agents.files.get")).toHaveLength(1));
  });
});
