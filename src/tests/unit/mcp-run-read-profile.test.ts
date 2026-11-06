/**
 * The `run-read` MCP profile — the clawbox server a coding-agent run gets when
 * its project ticked "ClawBox read-only tools" (src/lib/project-mcp-servers.ts).
 *
 * Two promises rest on it, and both are pinned against the REAL registrars:
 *
 *  - the server registers the browser family as the `browser` profile does,
 *    plus the tools that declare `readOnly: true`, and nothing that writes;
 *  - the runner approves exactly that readOnly set by name
 *    (src/lib/clawbox-run-read-tools.ts → MCP_READ_ONLY_TOOLS): an EQUALITY,
 *    so a tool that gains or loses the declaration fails here instead of
 *    being registered and refused, or approved and missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { saveEnv } from "@/tests/helpers/env";

// The module claims stdio the moment it is imported, and its API base is read
// at import: both set before it, the way mcp-idle-exit.test.ts does. The API
// base is a port nothing listens on, so the context probes fail fast and never
// reach a ClawBox this suite happens to run beside.
vi.hoisted(() => {
  process.env.CLAWBOX_MCP_NO_AUTOSTART = "1";
  process.env.CLAWBOX_API_BASE = "http://127.0.0.1:9";
});
import { buildServer } from "../../../mcp/clawbox-mcp";
import { createRegistrar } from "../../../mcp/lib/register";
import { profileForActiveModel } from "../../../mcp/lib/profile";
import { CLAWBOX_READ_ONLY_TOOLS, RUN_READ_PROFILE } from "@/lib/clawbox-run-read-tools";

/** Every capability on, as mcp/check-tools.ts builds its widest posture. */
const ALL = {
  capabilities: { screenGrabber: "scrot" as const, imageConvert: true, journal: true, du: true },
  emailCanRead: true,
  codingAgent: true,
  canGenerateImages: true,
  providers: ["anthropic", "openai"],
};
/**
 * Every capability off: the other end of each gate. Not redundant with ALL —
 * a gate can point the other way (`image_generate` exists only where the box
 * CANNOT draw), and a readOnly tool behind one is still in a run's set.
 */
const NONE = {
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: false,
  providers: [],
};
const POSTURES = [ALL, NONE];

let restore: () => void;

beforeEach(() => {
  restore = saveEnv("CLAWBOX_RUN_DIR", "CLAWBOX_RUN_ARTIFACTS_DIR", "CLAWBOX_RUN_MEDIA", "CLAWBOX_RUN_BROWSER", "CLAWBOX_MCP_CODING_TOOLS", "CLAWBOX_MCP_PROFILE");
  // Inside a run, as the runner starts it, with the coding family's env gate
  // off — it is in every run.
  process.env.CLAWBOX_RUN_DIR = "/tmp/run-dir";
  process.env.CLAWBOX_RUN_ARTIFACTS_DIR = "/tmp/run-dir-artifacts/run-abcd1234";
  process.env.CLAWBOX_RUN_MEDIA = "images,audio";
  delete process.env.CLAWBOX_RUN_BROWSER;
  delete process.env.CLAWBOX_MCP_CODING_TOOLS;
});

afterEach(() => restore());

async function registered(edition: "openclaw" | "hermes", profile: "browser" | "run-read" | "full", posture: typeof ALL | typeof NONE = ALL) {
  const { reg } = await buildServer(edition, profile, edition, posture);
  return reg.list();
}

describe("the run-read profile", () => {
  it("registers the browser family plus every readOnly tool, and nothing that writes", async () => {
    for (const [edition, posture] of (["openclaw", "hermes"] as const).flatMap((e) => POSTURES.map((p) => [e, p] as const))) {
      const tools = await registered(edition, "run-read", posture);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.opts.family === "browser" || tool.opts.readOnly === true, `${edition}: ${tool.name}`).toBe(true);
        expect(tool.opts.destructive, `${edition}: ${tool.name}`).not.toBe(true);
      }
      const names = tools.map((t) => t.name);
      // What the browser profile has, it still has.
      for (const name of (await registered(edition, "browser")).map((t) => t.name)) expect(names, edition).toContain(name);
      // And the write tools the full profile has are not here.
      for (const write of ["email_send", "coding_agent_run", "skill_install", "app_install"]) expect(names, edition).not.toContain(write);
    }
  }, 60_000);

  it("is the list the runner approves — the same readOnly set, on both editions and every posture together", async () => {
    const readOnly = new Set<string>();
    for (const edition of ["openclaw", "hermes"] as const) {
      for (const posture of POSTURES) {
        for (const tool of await registered(edition, "run-read", posture)) {
          if (tool.opts.readOnly === true && tool.opts.family !== "browser") readOnly.add(tool.name);
        }
      }
    }
    expect([...readOnly].sort()).toEqual([...CLAWBOX_READ_ONLY_TOOLS].sort());
    // And the full profile's readOnly set is no wider: run-read drops nothing that reads.
    const fullReadOnly = new Set<string>();
    for (const edition of ["openclaw", "hermes"] as const) {
      for (const posture of POSTURES) {
        for (const tool of await registered(edition, "full", posture)) {
          if (tool.opts.readOnly === true && tool.opts.family !== "browser") fullReadOnly.add(tool.name);
        }
      }
    }
    expect([...fullReadOnly].sort()).toEqual([...readOnly].sort());
  }, 60_000);

  it("gates on the declaration, never the name", () => {
    const server = { registerTool: vi.fn(), server: { setRequestHandler: vi.fn() } } as unknown as McpServer;
    const reg = createRegistrar(server, "openclaw", "run-read");
    const noop = async () => ({ content: [] });
    reg.tool("status_reader", "x", {}, { readOnly: true }, noop);
    reg.tool("device_status_impostor", "x", {}, {}, noop);
    reg.tool("family_member", "x", {}, { family: "browser" }, noop);
    expect(reg.list().map((t) => t.name).sort()).toEqual(["family_member", "status_reader"]);
  });

  it("is what CLAWBOX_MCP_PROFILE=run-read asks for, and only that spelling", () => {
    expect(profileForActiveModel(null, { CLAWBOX_MCP_PROFILE: RUN_READ_PROFILE } as unknown as NodeJS.ProcessEnv)).toBe("run-read");
    expect(profileForActiveModel(null, { CLAWBOX_MCP_PROFILE: "RUN-READ" } as unknown as NodeJS.ProcessEnv)).toBe("run-read");
    expect(profileForActiveModel(null, { CLAWBOX_MCP_PROFILE: "read" } as unknown as NodeJS.ProcessEnv)).toBe("full");
  });

  it("drops the browser family for a run judged not visual, as the browser profile does", async () => {
    process.env.CLAWBOX_RUN_BROWSER = "0";
    const names = (await registered("openclaw", "run-read")).map((t) => t.name);
    expect(names).not.toContain("browser_open");
    expect(names).not.toContain("browser_screenshot");
    expect(names).toContain("device_status");
  }, 60_000);
});
