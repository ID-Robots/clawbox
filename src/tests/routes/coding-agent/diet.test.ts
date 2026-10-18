/**
 * POST /setup-api/coding-agent/enable { diet } (TASK-1749): the owner's token
 * diet — a partial patch merged over what is stored, refused whole with a
 * stable code on an unknown key or value — the status reporting the effective
 * value, and a run record freezing it (a record from before the field reads as
 * the default). Against the real config store in a temp root.
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

describe("the diet setting", () => {
  it("reports the lean defaults (TASK-1749's measurement) on a box that never set it", async () => {
    const lib = await import("@/lib/coding-agent");
    expect((await lib.getCodingAgentStatus()).diet).toEqual({ brief: "lean", helpers: "lean", visualTools: "auto" });
    expect(await lib.getDiet()).toEqual({ brief: "lean", helpers: "lean", visualTools: "auto" });
    expect(savedConfig()).not.toHaveProperty("coding_agent_diet");
  });

  it("merges a partial patch over the lean defaults when nothing is stored, then over what is stored", async () => {
    let res = await post({ diet: { brief: "full" } });
    expect(res.status).toBe(200);
    expect((await res.json()).diet).toEqual({ brief: "full", helpers: "lean", visualTools: "auto" });
    expect(savedConfig().coding_agent_diet).toEqual({ brief: "full", helpers: "lean", visualTools: "auto" });
    res = await post({ diet: { visualTools: "always", helpers: "always" } });
    expect((await res.json()).diet).toEqual({ brief: "full", helpers: "always", visualTools: "always" });
    expect(savedConfig().coding_agent_diet).toEqual({ brief: "full", helpers: "always", visualTools: "always" });
  });

  it.each([
    [{ brief: "tiny" }, "diet_invalid_value"],
    [{ visualTools: false }, "diet_invalid_value"],
    [{ tools: "none" }, "diet_unknown_key"],
    ["lean", "diet_not_object"],
    [null, "diet_not_object"],
  ])("refuses %j with %s before anything is saved", async (diet, code) => {
    // A second field rides along to prove the refusal comes before ANY setter.
    const res = await post({ diet, autoPr: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code, kind: "invalid" });
    expect(savedConfig()).not.toHaveProperty("coding_agent_diet");
    expect(savedConfig()).not.toHaveProperty("coding_agent_auto_pr");
  });

  it("is the owner's: the agent's bearer cannot change it", async () => {
    const res = await post({ diet: { brief: "lean" } }, false);
    expect(res.status).toBe(403);
    expect(savedConfig()).not.toHaveProperty("coding_agent_diet");
  });

  it("reports a stored junk value as the default it reads as", async () => {
    fs.writeFileSync(path.join(session.root, "data", "config.json"), JSON.stringify({ ...savedConfig(), coding_agent_diet: { brief: "tiny", visualTools: "always" } }));
    const lib = await import("@/lib/coding-agent");
    expect((await lib.getCodingAgentStatus()).diet).toEqual({ brief: "lean", helpers: "lean", visualTools: "always" });
  });

  it("is cleared by the reset with every other setting", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(lib.CODING_AGENT_RESET_KEYS).toContain(lib.CODING_AGENT_DIET_CONFIG_KEY);
    expect(lib.CODING_AGENT_DIET_CONFIG_KEY).toBe("coding_agent_diet");
  });
});

describe("a run record's frozen diet", () => {
  const record = (id: string, extra: Record<string, unknown>) => ({
    id,
    task: "build the site",
    directory: path.join(session.root, "site"),
    status: "completed",
    startedAt: 1_000,
    ...extra,
  });

  // A record is read against LEGACY_DIET, NOT the lean DEFAULT_DIET: a run
  // started before the diet existed was opened with the full prompt, and its
  // resumes must keep it byte for byte.
  it("round-trips the diet and the visual decision, and reads a record from before them as the legacy full prompt", async () => {
    fs.writeFileSync(path.join(session.root, "data", "coding-agent-runs.json"), JSON.stringify([
      record("run-aaaaaaaa", { diet: { brief: "lean", helpers: "lean", visualTools: "auto" }, visual: false }),
      record("run-bbbbbbbb", {}),
      record("run-cccccccc", { diet: { brief: "short", helpers: "lean" }, visual: "yes" }),
    ]));
    const lib = await import("@/lib/coding-agent");
    const a = lib.getRun("run-aaaaaaaa")!;
    expect(a.diet).toEqual({ brief: "lean", helpers: "lean", visualTools: "auto" });
    expect(a.visual).toBe(false);
    const b = lib.getRun("run-bbbbbbbb")!;
    expect(b.diet).toEqual({ brief: "full", helpers: "always", visualTools: "always" });
    expect(b.visual).toBeNull();
    const c = lib.getRun("run-cccccccc")!;
    expect(c.diet).toEqual({ brief: "full", helpers: "lean", visualTools: "always" });
    expect(c.visual).toBeNull();
  });
});
