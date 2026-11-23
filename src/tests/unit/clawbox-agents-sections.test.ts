import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The heartbeat's half of ClawBox's AGENTS.md rules, awaited here: the
 * route does not wait for it, so "no gateway call" there would hold whether or
 * not the step had run yet.
 *
 * What it must never do: create AGENTS.md (the harness owns that), write over a
 * file the agent changed since the read, write into a workspace that is not the
 * one ClawBox resolves, start the OpenClaw CLI on a box whose gateway is down,
 * or say it appended something the gateway did not take.
 */

const harness = vi.hoisted(() => ({ getActiveHarness: vi.fn() }));
const gatewayWs = vi.hoisted(() => ({ gatewayWsCall: vi.fn() }));
const persona = vi.hoisted(() => ({ openclawWorkspaceDir: vi.fn() }));
// The CLI fallback `callGatewayRpc` would take. Nothing here may start it.
const cli = vi.hoisted(() => ({
  spawn: vi.fn(() => {
    throw new Error("no CLI in this test");
  }),
  execFile: vi.fn(() => {
    throw new Error("no CLI in this test");
  }),
}));

vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: harness.getActiveHarness,
}));
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()),
  gatewayWsCall: gatewayWs.gatewayWsCall,
}));
vi.mock("@/lib/language-persona", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/language-persona")>()),
  openclawWorkspaceDir: persona.openclawWorkspaceDir,
}));
vi.mock("child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("child_process")>();
  const mocked = { ...real, spawn: cli.spawn, execFile: cli.execFile };
  return { ...mocked, default: mocked };
});

// OpenClaw's own template, the way it lands on the agent's first run.
const TEMPLATE = "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n\n"
  + "## Red Lines\n\n- Don't exfiltrate private data. Ever.\n";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

let scratch: string;
let workspace: string;
let agentsMd: string;
const savedHome = process.env.OPENCLAW_HOME;

async function load() {
  return import("@/lib/clawbox-agents-sections");
}

const callsTo = (method: string) =>
  gatewayWs.gatewayWsCall.mock.calls.filter(([m]) => m === method).map(([, params]) => params);

/** The gateway's side of `agents.files.get` / `set`; `get` serves what is on disk unless told otherwise. */
function gateway(opts: {
  workspace?: string;
  file?: Record<string, unknown>;
  set?: () => Promise<unknown>;
} = {}) {
  gatewayWs.gatewayWsCall.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "agents.files.get") {
      const content = readFileSync(agentsMd, "utf-8");
      return {
        agentId: params.agentId,
        workspace: opts.workspace ?? workspace,
        file: opts.file ?? { name: "AGENTS.md", path: agentsMd, missing: false, content, hash: sha256(content) },
      };
    }
    if (method === "agents.files.set") return opts.set ? opts.set() : { ok: true, agentId: params.agentId };
    throw new Error(`unexpected gateway call ${method}`);
  });
}

beforeEach(() => {
  vi.resetModules();
  scratch = mkdtempSync(path.join(tmpdir(), "clawbox-agents-"));
  workspace = path.join(scratch, "workspace");
  agentsMd = path.join(workspace, "AGENTS.md");
  mkdirSync(workspace, { recursive: true });
  const home = path.join(scratch, "openclaw");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "openclaw.json"), JSON.stringify({ agents: { entries: { default: {} } } }));
  process.env.OPENCLAW_HOME = home;
  harness.getActiveHarness.mockResolvedValue("openclaw");
  persona.openclawWorkspaceDir.mockReturnValue(workspace);
  gatewayWs.gatewayWsCall.mockRejectedValue(new Error("unexpected gateway call"));
});

// The suite's config resets every mock before each test (vitest.config.ts).
afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = savedHome;
  rmSync(scratch, { recursive: true, force: true });
});

describe("ensureClawboxAgentsSections", () => {
  it("appends what is missing through agents.files.set, bound to what it read", async () => {
    writeFileSync(agentsMd, TEMPLATE);
    gateway();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ensureClawboxAgentsSections, withClawboxAgentsSections, CLAWBOX_AGENTS_SECTIONS } = await load();

    await ensureClawboxAgentsSections();

    // The config's own agent, never "main" by assumption.
    expect(callsTo("agents.files.get")).toEqual([{ agentId: "default", name: "AGENTS.md" }]);
    expect(callsTo("agents.files.set")).toEqual([{
      agentId: "default",
      name: "AGENTS.md",
      content: withClawboxAgentsSections(TEMPLATE),
      expectedHash: sha256(TEMPLATE),
      expectedWorkspace: workspace,
    }]);
    // The journal says what landed, in pre-start's words, after the write.
    expect(log.mock.calls.map(([line]) => line)).toEqual(
      CLAWBOX_AGENTS_SECTIONS.map((s) => `[agents-md] ${s.appendedLine}`),
    );
  });

  it("creates nothing and calls nothing when there is no AGENTS.md yet", async () => {
    const { ensureClawboxAgentsSections } = await load();

    await ensureClawboxAgentsSections();

    expect(gatewayWs.gatewayWsCall).not.toHaveBeenCalled();
    expect(existsSync(agentsMd)).toBe(false);
  });

  it("calls nothing when every section is already there", async () => {
    const { ensureClawboxAgentsSections, withClawboxAgentsSections } = await load();
    writeFileSync(agentsMd, withClawboxAgentsSections(TEMPLATE));

    await ensureClawboxAgentsSections();

    expect(gatewayWs.gatewayWsCall).not.toHaveBeenCalled();
  });

  it("leaves an owner's own section under one of the headings as it is", async () => {
    const existing = `${TEMPLATE}\n## Voice notes on this ClawBox\n\nAnswer voice notes in Bulgarian.\n`;
    writeFileSync(agentsMd, existing);
    gateway();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { ensureClawboxAgentsSections } = await load();

    await ensureClawboxAgentsSections();

    const content = String(callsTo("agents.files.set")[0].content);
    expect(content.startsWith(existing)).toBe(true);
    expect(content.match(/^## Voice notes on this ClawBox$/gm)).toHaveLength(1);
    expect(content).toMatch(/^## ClawBox integration$/m);
  });

  it("does not write when the gateway's workspace is not the one ClawBox resolves", async () => {
    writeFileSync(agentsMd, TEMPLATE);
    gateway({ workspace: path.join(scratch, "elsewhere") });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ensureClawboxAgentsSections } = await load();

    await ensureClawboxAgentsSections();
    await ensureClawboxAgentsSections();

    expect(callsTo("agents.files.get")).toHaveLength(2);
    expect(callsTo("agents.files.set")).toHaveLength(0);
    // Said once, not on every tick.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/workspace/);
  });

  it("does not write when the gateway says the file is gone", async () => {
    writeFileSync(agentsMd, TEMPLATE);
    gateway({ file: { name: "AGENTS.md", path: agentsMd, missing: true } });
    const { ensureClawboxAgentsSections } = await load();

    await ensureClawboxAgentsSections();

    expect(callsTo("agents.files.set")).toHaveLength(0);
  });

  it("never writes without the read's hash: that would be an unconditional overwrite", async () => {
    writeFileSync(agentsMd, TEMPLATE);
    gateway({ file: { name: "AGENTS.md", path: agentsMd, missing: false, content: TEMPLATE } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ensureClawboxAgentsSections } = await load();

    await ensureClawboxAgentsSections();

    expect(callsTo("agents.files.set")).toHaveLength(0);
  });

  it("leaves a file whose bytes the gateway could not decode to the next gateway start", async () => {
    // The hash is of the bytes on disk; content decoded with U+FFFD in place of
    // invalid bytes hashes differently, and writing it back would replace them.
    writeFileSync(agentsMd, TEMPLATE);
    gateway({
      file: { name: "AGENTS.md", path: agentsMd, missing: false, content: `${TEMPLATE}�`, hash: sha256(TEMPLATE) },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ensureClawboxAgentsSections } = await load();

    await ensureClawboxAgentsSections();

    expect(callsTo("agents.files.set")).toHaveLength(0);
  });

  it("skips quietly when the gateway is down, and starts no CLI", async () => {
    writeFileSync(agentsMd, TEMPLATE);
    const { GatewayWsUnavailableError } = await import("@/lib/openclaw-gateway-ws");
    gatewayWs.gatewayWsCall.mockRejectedValue(new GatewayWsUnavailableError("connect ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ensureClawboxAgentsSections } = await load();

    await ensureClawboxAgentsSections();

    expect(callsTo("agents.files.set")).toHaveLength(0);
    expect(cli.spawn).not.toHaveBeenCalled();
    expect(cli.execFile).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves when the write is refused, says so once, and claims no append", async () => {
    writeFileSync(agentsMd, TEMPLATE);
    const { GatewayRpcError } = await import("@/lib/openclaw-gateway-ws");
    const conflict = new GatewayRpcError('agent file "AGENTS.md" changed since it was read', "INVALID_REQUEST");
    gateway({ set: () => Promise.reject(conflict) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ensureClawboxAgentsSections } = await load();

    await expect(ensureClawboxAgentsSections()).resolves.toBeUndefined();
    await ensureClawboxAgentsSections();

    // Retried on the next call, reported once.
    expect(callsTo("agents.files.set")).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/changed since it was read/);
    expect(log).not.toHaveBeenCalled();
  });

  it("does nothing while Hermes is the harness", async () => {
    writeFileSync(agentsMd, TEMPLATE);
    harness.getActiveHarness.mockResolvedValue("hermes");
    const { ensureClawboxAgentsSections } = await load();

    await ensureClawboxAgentsSections();

    expect(gatewayWs.gatewayWsCall).not.toHaveBeenCalled();
    expect(readFileSync(agentsMd, "utf-8")).toBe(TEMPLATE);
  });

  it("runs one pass at a time", async () => {
    writeFileSync(agentsMd, TEMPLATE);
    let answer: (value: unknown) => void = () => {};
    gatewayWs.gatewayWsCall.mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const { ensureClawboxAgentsSections } = await load();

    const first = ensureClawboxAgentsSections();
    const second = ensureClawboxAgentsSections();
    await vi.waitFor(() => expect(callsTo("agents.files.get")).toHaveLength(1));
    answer({ workspace, file: { missing: true } });
    await Promise.all([first, second]);

    expect(callsTo("agents.files.get")).toHaveLength(1);
  });
});
