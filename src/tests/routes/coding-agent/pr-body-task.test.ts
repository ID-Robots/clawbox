/**
 * POST /setup-api/coding-agent/enable { prBodyIncludesTask } (TASK-1366): how
 * much of a run's task the pull request the box opens carries. Against the
 * real config store in a temp root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

vi.mock("@/lib/coding-agent-mcp-refresh", () => ({ refreshCodingAgentToolsIfChanged: vi.fn(async () => undefined) }));

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";

let session: SessionFixture;
let restore: () => void;
let enableRoute: typeof import("@/app/setup-api/coding-agent/enable/route");

const post = (body: unknown, owner = true) => enableRoute.POST(new Request("http://localhost/setup-api/coding-agent/enable", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(owner ? { Cookie: session.cookie } : { Authorization: `Bearer ${MCP_TOKEN}` }) },
  body: JSON.stringify(body),
}));

const savedConfig = (): Record<string, unknown> => {
  const file = path.join(session.root, "data", "config.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {};
};

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  enableRoute = await import("@/app/setup-api/coding-agent/enable/route");
});

afterEach(async () => {
  const lib = await import("@/lib/coding-agent");
  await lib._resetCodingAgentStateForTests();
  session.cleanup();
  restore();
  fs.rmSync(session.root, { recursive: true, force: true });
});

describe("prBodyIncludesTask", () => {
  it("is summary on a box that never chose", async () => {
    const lib = await import("@/lib/coding-agent");
    expect((await lib.getCodingAgentStatus()).prBodyIncludesTask).toBe("summary");
    expect(await lib.getPrBodyIncludesTask()).toBe("summary");
  });

  it.each(["full-redacted", "none", "summary"])("saves %s and answers the status carrying it", async (mode) => {
    const res = await post({ prBodyIncludesTask: mode });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ prBodyIncludesTask: mode });
    expect(savedConfig()).toMatchObject({ coding_agent_pr_body_includes_task: mode });
  });

  it.each([["everything"], ["full"], [true], [null], [3]])("refuses %j before anything is saved", async (value) => {
    // A second field rides along to prove the refusal comes before ANY setter.
    const res = await post({ prBodyIncludesTask: value, autoPr: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must be one of: summary, full-redacted, none/);
    expect(savedConfig()).not.toHaveProperty("coding_agent_pr_body_includes_task");
    expect(savedConfig()).not.toHaveProperty("coding_agent_auto_pr");
  });

  it("is the owner's: the agent's bearer cannot change it", async () => {
    const res = await post({ prBodyIncludesTask: "full-redacted" }, false);
    expect(res.status).toBe(403);
    expect(savedConfig()).not.toHaveProperty("coding_agent_pr_body_includes_task");
  });

  it("is cleared by the reset with every other setting", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(lib.CODING_AGENT_RESET_KEYS).toContain(lib.CODING_AGENT_PR_BODY_TASK_CONFIG_KEY);
  });
});
