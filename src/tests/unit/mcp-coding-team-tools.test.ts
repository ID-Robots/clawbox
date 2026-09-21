/**
 * The coding team's MCP tools (mcp/tools/coding-agent.ts,
 * registerCodingTeamTools): registered beside the run tools under the same
 * switch, thin callers of /setup-api/coding-agent/team, and the words the
 * assistant gets back — what the team is doing and what to tell the user.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock("../../../mcp/lib/api", async () => {
  const { ApiError, matchRule } = await import("../../../mcp/lib/errors");
  const withRules =
    (fn: (...a: unknown[]) => unknown) =>
    async (path: string, ...rest: unknown[]) => {
      try {
        return await fn(path, ...rest);
      } catch (err) {
        const opts = (rest[rest.length - 1] ?? {}) as { rules?: Parameters<typeof matchRule>[1] };
        if (err instanceof ApiError) throw matchRule(err, opts?.rules) ?? err;
        throw err;
      }
    };
  return {
    apiGet: withRules(apiGet),
    apiPost: withRules(apiPost),
    apiTry: async () => null,
    API_BASE: "http://127.0.0.1:80",
    CLAWBOX_ROOT: "/home/clawbox/clawbox",
  };
});

import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerCodingTeamTools } from "../../../mcp/tools/coding-agent";
import { ApiError } from "../../../mcp/lib/errors";
import { BANNED_DESCRIPTION_RE, MAX_DESCRIPTION_CHARS } from "../../../mcp/lib/register";
import { PARAM_NAME_RE, TOOL_NAME_RE } from "../../../mcp/lib/schema";

const NAMES = ["coding_team_run", "coding_team_status", "coding_team_stop"];

function harness(edition: "openclaw" | "hermes" = "openclaw", codingAgent = true) {
  const h = captureRegistrar(edition);
  registerCodingTeamTools(h.reg, { codingAgent });
  return h;
}

const TEAM = {
  id: "team-k3x9q2ab",
  goal: "Build the invoice app with a printable PDF",
  projectId: null,
  directory: "/home/clawbox/Projects/invoice",
  status: "working",
  plannerRunId: "run-00000001",
  tasks: [
    { task_id: "t1", task_description: "Scaffold index.html", assigned_to: "run-00000002", status: "complete", result: "Built index.html; open it.", depends_on: [], review: { verdict: "accepted", notes: "" }, attempts: 1 },
    { task_id: "t2", task_description: "Wire app.js", assigned_to: "run-00000003", status: "in_progress", result: null, depends_on: ["t1"], review: null, attempts: 1 },
  ],
  log: [
    { ts: 1_700_000_000_000, actor: { kind: "owner" }, type: "team_created", message: "Team created" },
    { ts: 1_700_000_001_000, actor: { kind: "worker", id: "run-00000002" }, type: "result", message: "Task t1 result: Built index.html" },
  ],
  alerts: 1,
  error: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
};

async function ok(name: string, args: Record<string, unknown>): Promise<string> {
  const out = await harness().call(name, args);
  expect(out.isError, JSON.stringify(out)).toBe(false);
  return out.isError ? "" : out.text;
}

async function refused(name: string, args: Record<string, unknown>) {
  const out = await harness().call(name, args);
  expect(out.isError, JSON.stringify(out)).toBe(true);
  return out.isError ? out.error : { code: "", message: "", next: "" };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("registration", () => {
  it("registers the three team tools on both editions only while the coding agent is on", () => {
    expect(harness("openclaw", false).names()).toEqual([]);
    expect(harness("openclaw").names().sort()).toEqual([...NAMES].sort());
    expect(harness("hermes").names().sort()).toEqual([...NAMES].sort());
  });

  it("keeps names, parameters and descriptions inside the contract", () => {
    const h = harness();
    for (const name of NAMES) {
      const tool = h.get(name);
      expect(name).toMatch(TOOL_NAME_RE);
      for (const param of Object.keys(tool.shape)) expect(param).toMatch(PARAM_NAME_RE);
      expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      expect(tool.description).not.toMatch(BANNED_DESCRIPTION_RE);
      expect(tool.opts.editions).toEqual(["openclaw", "hermes"]);
    }
    expect(h.get("coding_team_status").opts.readOnly).toBe(true);
    expect(h.get("coding_team_run").opts.readOnly).toBe(false);
    // The run tool says when NOT to use it — a focused change is a run.
    expect(h.get("coding_team_run").description).toMatch(/coding_agent_run/);
  });
});

describe("coding_team_run", () => {
  it("posts the goal and the folder, and tells the assistant to stop and check later", async () => {
    apiPost.mockResolvedValue({ started: true, team: { ...TEAM, status: "planning", tasks: [] } });
    const text = await ok("coding_team_run", { goal: "Build the invoice app", directory: "invoice" });
    expect(apiPost).toHaveBeenCalledWith("/setup-api/coding-agent/team", { goal: "Build the invoice app", directory: "invoice" }, expect.anything());
    expect(text).toContain('Started coding team "team-k3x9q2ab"');
    expect(text).toMatch(/coding_team_status/);
  });

  it("words the switch and a team already working as conflicts the assistant must not retry", async () => {
    apiPost.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "off", kind: "disabled" })));
    const off = await refused("coding_team_run", { goal: "g" });
    expect(off).toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/switched off/) });
    apiPost.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "busy", kind: "busy" })));
    const busy = await refused("coding_team_run", { goal: "g" });
    expect(busy).toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/already working/), next: expect.stringMatching(/Do not start another/) });
  });

  it("passes a refused folder through as the route's own sentence", async () => {
    apiPost.mockRejectedValueOnce(new ApiError(400, JSON.stringify({ error: "That folder is outside the project folder." })));
    const out = await refused("coding_team_run", { goal: "g", directory: "/tmp/x" });
    expect(out).toMatchObject({ code: "BAD_ARGUMENT", message: expect.stringMatching(/outside the project folder/) });
  });
});

describe("coding_team_status", () => {
  it("lists recent teams without an id, and says so when there are none", async () => {
    apiGet.mockResolvedValueOnce({ teams: [] });
    expect(await ok("coding_team_status", { log: 0 })).toMatch(/no coding teams/);
    apiGet.mockResolvedValueOnce({ teams: [TEAM] });
    const listed = JSON.parse(await ok("coding_team_status", { log: 0 }));
    expect(listed).toEqual([{ team_id: TEAM.id, status: "working", goal: "Build the invoice app with a printable PDF", project_id: null, tasks: 2, complete: 1, alerts: 1 }]);
  });

  it("describes one team: goal, tasks with worker and result, alerts, and what to do next", async () => {
    apiGet.mockResolvedValueOnce({ team: TEAM });
    const text = await ok("coding_team_status", { team_id: TEAM.id, log: 1 });
    expect(apiGet).toHaveBeenCalledWith("/setup-api/coding-agent/team", expect.objectContaining({ query: { id: TEAM.id } }));
    expect(text).toContain("Team team-k3x9q2ab: working");
    expect(text).toContain("- t1 [complete, accepted] — Scaffold index.html — worker run-00000002 — result: Built index.html; open it.");
    expect(text).toContain("- t2 [in_progress] — Wire app.js — worker run-00000003 — after t1");
    expect(text).toContain("Alerts: 1");
    expect(text).toContain("worker run-00000002: Task t1 result");
    expect(text).toMatch(/Still working/);
    apiGet.mockResolvedValueOnce({ team: { ...TEAM, status: "done", alerts: 0 } });
    expect(await ok("coding_team_status", { team_id: TEAM.id, log: 0 })).toMatch(/Summarise the task results/);
    apiGet.mockResolvedValueOnce({ team: { ...TEAM, status: "failed", error: "Tasks t2 failed." } });
    expect(await ok("coding_team_status", { team_id: TEAM.id, log: 0 })).toMatch(/failed — Tasks t2 failed\./);
  });

  it("answers NOT_FOUND for an id the box does not know", async () => {
    apiGet.mockRejectedValueOnce(new ApiError(404, JSON.stringify({ error: "no", kind: "not_found" })));
    expect(await refused("coding_team_status", { team_id: "team-nope0000", log: 0 })).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("coding_team_stop", () => {
  it("posts the stop and describes the stopped team", async () => {
    apiPost.mockResolvedValueOnce({ team: { ...TEAM, status: "stopped" } });
    const text = await ok("coding_team_stop", { team_id: TEAM.id });
    expect(apiPost).toHaveBeenCalledWith("/setup-api/coding-agent/team/stop", { id: TEAM.id }, expect.anything());
    expect(text).toContain("Team team-k3x9q2ab is stopped.");
  });
});
