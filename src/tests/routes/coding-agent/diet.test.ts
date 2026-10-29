/**
 * What is left of the token diet (TASK-1749) at the route and the record:
 * POST /setup-api/coding-agent/enable no longer takes `{ diet }` (the knobs
 * were measured and deleted), the status no longer reports one, and a run
 * record freezes only the visual decision — a record from before the decision
 * existed (no `diet` object) reads as visual, so a resumed old session keeps
 * its browser tools. Against the real config store in a temp root.
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

const post = (body: unknown) => enableRoute.POST(new Request("http://localhost/setup-api/coding-agent/enable", {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: session.cookie },
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

describe("the diet setting is gone", () => {
  it("is refused by the enable route as an unknown body, and nothing is saved", async () => {
    const res = await post({ diet: { brief: "full" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).not.toContain("diet");
    expect(savedConfig()).not.toHaveProperty("coding_agent_diet");
  });

  it("is not in the status", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(await lib.getCodingAgentStatus()).not.toHaveProperty("diet");
  });
});

describe("a run record's frozen visual decision", () => {
  const record = (id: string, extra: Record<string, unknown>) => ({
    id,
    task: "build the site",
    directory: path.join(session.root, "site"),
    status: "completed",
    startedAt: 1_000,
    ...extra,
  });

  it("round-trips the decision, and reads a record from before it as visual", async () => {
    fs.writeFileSync(path.join(session.root, "data", "coding-agent-runs.json"), JSON.stringify([
      record("run-aaaaaaaa", { diet: { brief: "lean", helpers: "lean", visualTools: "auto", context: "full" }, visual: false }),
      // Before the decision existed: started with every tool, keeps them.
      record("run-bbbbbbbb", {}),
      // A record with the diet's field that never spawned: decided at its spawn.
      record("run-cccccccc", { diet: { brief: "short", helpers: "lean" }, visual: "yes" }),
      record("run-dddddddd", { visual: true }),
    ]));
    const lib = await import("@/lib/coding-agent");
    expect(lib.getRun("run-aaaaaaaa")!.visual).toBe(false);
    expect(lib.getRun("run-bbbbbbbb")!.visual).toBe(true);
    expect(lib.getRun("run-cccccccc")!.visual).toBeNull();
    expect(lib.getRun("run-dddddddd")!.visual).toBe(true);
    expect(lib.getRun("run-aaaaaaaa")).not.toHaveProperty("diet");
  });
});
