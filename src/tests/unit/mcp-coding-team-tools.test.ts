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
    expect(busy).toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/as many coding teams waiting as it allows/), next: expect.stringMatching(/Do not start another/) });
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

describe("coding_team_status — shape, lead and figures (TASK-1099)", () => {
  it("names the planner's shape, whether the lead may change the plan, the figures, a lead's task and the final review", async () => {
    apiGet.mockResolvedValueOnce({
      team: {
        ...TEAM,
        status: "done",
        alerts: 0,
        agents: { planner: 1, workers: 3, reviewers: 1, leads: 2, total: 7 },
        shape: { parallelism: 2, review: "final", rationale: "Two independent files, one look at the whole." },
        dynamic: true,
        finalReview: { verdict: "accepted", notes: "" },
        tasks: [...TEAM.tasks.map((t) => ({ ...t, status: "complete" })), { task_id: "t3", task_description: "Add a favicon", assigned_to: "run-00000005", status: "complete", result: "done", depends_on: ["t1"], review: { verdict: "accepted", notes: "" }, attempts: 1, origin: "lead" }],
        metrics: { plannerRuns: 1, workerRuns: 3, reviewerRuns: 1, leadRuns: 2, tasksPlanned: 2, tasksAdded: 1, tasksRetired: 0, tasksAcceptedFirstTry: 3, tasksRejected: 0, tokensUsed: 184_000, wallMs: 754_400, messagesSent: 4, messagesToLead: 1, messagesToSibling: 2, messagesUndelivered: 1 },
      },
    });
    const text = await ok("coding_team_status", { team_id: TEAM.id, log: 0 });
    expect(text).toContain("Agents: 7 — 1 planner, 3 worker(s), 1 reviewer(s), 2 lead turn(s).");
    expect(text).toContain("Shape: up to 2 worker(s) side by side, review final — Two independent files, one look at the whole.");
    expect(text).toContain("Lead: on");
    expect(text).toContain("Metrics: runs planner 1, worker 3, reviewer 1, lead 2; tasks planned 2, added 1, retired 0, accepted first try 3, rejected 0; tokens 184000; wall 754 s. Messages: 4 sent — 1 to the lead, 2 to a sibling, 1 not delivered.");
    expect(text).toContain("- t3 [complete, accepted] — Add a favicon — added by the lead — worker run-00000005");
    expect(text).toContain("Final review: accepted");
  });

  it("does not count a retired task among a listed team's tasks — it will never be complete", async () => {
    apiGet.mockResolvedValueOnce({ teams: [{ ...TEAM, status: "done", tasks: [...TEAM.tasks.map((x) => ({ ...x, status: "complete" })), { ...TEAM.tasks[1], task_id: "t3", status: "retired", assigned_to: null }] }] });
    const listed = JSON.parse(await ok("coding_team_status", { log: 0 }));
    expect(listed[0]).toMatchObject({ status: "done", tasks: 2, complete: 2 });
  });

  it("leaves the message counts out when the server's figures have none", async () => {
    apiGet.mockResolvedValueOnce({
      team: { ...TEAM, metrics: { plannerRuns: 1, workerRuns: 1, reviewerRuns: 0, leadRuns: 0, tasksPlanned: 1, tasksAdded: 0, tasksRetired: 0, tasksAcceptedFirstTry: 0, tasksRejected: 0, tokensUsed: 0, wallMs: 0 } },
    });
    const text = await ok("coding_team_status", { team_id: TEAM.id, log: 0 });
    expect(text).toContain("Metrics: runs planner 1");
    expect(text).not.toContain("Messages:");
  });

  it("says none of it for a board from an older server", async () => {
    apiGet.mockResolvedValueOnce({ team: TEAM });
    const text = await ok("coding_team_status", { team_id: TEAM.id, log: 0 });
    expect(text).not.toMatch(/Shape:|Lead:|Metrics:|Final review:/);
  });
});

describe("a second team: queued, not refused", () => {
  it("coding_team_run says QUEUED with its place", async () => {
    apiPost.mockResolvedValueOnce({ started: false, queued: true, team: { ...TEAM, status: "queued", queuePosition: 1, tasks: [] } });
    const text = await ok("coding_team_run", { goal: "Build it" });
    expect(text).toMatch(/^Queued coding team "team-k3x9q2ab"/);
    expect(text).toMatch(/number 1 in line/);
    expect(text).toMatch(/only the owner can cancel it/);
  });

  it("coding_team_status lists a queued team's place and says what it waits for", async () => {
    apiGet.mockResolvedValueOnce({ teams: [{ ...TEAM, status: "queued", queuePosition: 2, tasks: [] }] });
    const list = JSON.parse(await ok("coding_team_status", { log: 0 })) as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ status: "queued", queue_position: 2 });
    apiGet.mockResolvedValueOnce({ team: { ...TEAM, status: "queued", queuePosition: 2, tasks: [] } });
    const one = await ok("coding_team_status", { team_id: TEAM.id, log: 0 });
    expect(one).toMatch(/^Team team-k3x9q2ab: queued — number 2 in line/);
    expect(one).toMatch(/only the owner can cancel it/);
  });

  it("coding_team_stop explains that a queued team is the owner's to cancel", async () => {
    apiPost.mockRejectedValueOnce(new ApiError(403, JSON.stringify({ error: "That team is waiting in the queue; only the owner can cancel a queued team.", kind: "owner_only" })));
    const out = await refused("coding_team_stop", { team_id: TEAM.id });
    expect(out).toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/only the owner can cancel a queued team/), next: expect.stringMatching(/Coding Agent app/) });
  });
});

describe("a team's pull request", () => {
  it("coding_team_status says where it stands, its CI rounds and what still fails", async () => {
    const pr = { number: 41, url: "https://github.com/o/r/pull/41", branch: "clawbox/team-k3x9q2ab", base: "main", phase: "failed_checks", checks: { total: 2, passed: 1, failed: 1, pending: 0 }, merge: true, ciRounds: 1, failure: { tests: ["app.test.js > submits"], checks: ["test"] }, detail: null };
    apiGet.mockResolvedValueOnce({ team: { ...TEAM, branch: "clawbox/team-k3x9q2ab", base: "main", pr } });
    const text = await ok("coding_team_status", { team_id: TEAM.id, log: 0 });
    expect(text).toMatch(/Pull request #41 \(https:\/\/github\.com\/o\/r\/pull\/41\), clawbox\/team-k3x9q2ab → main: its CI failed; the tasks it points at are being fixed\. 1 of 2 checks passed\. CI fix rounds: 1 of 2\. Failing tests: app\.test\.js > submits\. The goal asks for the merge/);
    apiGet.mockResolvedValueOnce({ teams: [{ ...TEAM, pr }] });
    const list = JSON.parse(await ok("coding_team_status", { log: 0 })) as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ pull_request: "#41 failed_checks" });
  });
});

describe("run or team, and what each role cost", () => {
  it("says in the run tool's own description when a single run is the cheaper tool", () => {
    const description = harness().get("coding_team_run").description;
    expect(description).toMatch(/Prefer ONE coding_agent_run/);
    expect(description).toMatch(/one focused change/);
    expect(description).toMatch(/edit mostly the same files/);
    expect(description).toMatch(/one-task plan runs as one run/);
  });

  it("tells the assistant at the start that a one-task plan runs as one run and that the status will say so", async () => {
    apiPost.mockResolvedValue({ started: true, team: { ...TEAM, status: "planning", tasks: [] } });
    const text = await ok("coding_team_run", { goal: "Build the invoice app", directory: "invoice" });
    expect(text).toMatch(/one task it runs as one ordinary run/);
    expect(text).toMatch(/when a single run would have been cheaper/);
  });

  it("answers the advice, the single run and the tokens per role in coding_team_status", async () => {
    apiGet.mockResolvedValue({
      team: {
        ...TEAM,
        status: "done",
        advice: { reason: "overlap", overlap: 83 },
        repoMap: { files: ["index.html"], entryPoints: ["index.html"], testCommands: ["npm test"], gotchas: [] },
        metrics: { plannerRuns: 1, workerRuns: 2, reviewerRuns: 2, leadRuns: 0, tasksPlanned: 2, tasksAdded: 0, tasksRetired: 0, tasksAcceptedFirstTry: 2, tasksRejected: 0, tokensUsed: 163000, tokensByRole: { planner: 12000, worker: 140000, reviewer: 11000, lead: 0 }, wallMs: 60000 },
      },
    });
    const text = await ok("coding_team_status", { team_id: TEAM.id });
    expect(text).toContain("tokens 163000 (planner 12000, workers 140000, reviewers 11000, lead 0)");
    expect(text).toMatch(/Advice: 83% of the files this plan's tasks name are shared with another task/);
    expect(text).toMatch(/a single coding_agent_run would likely have been cheaper/);
    expect(text).toMatch(/Repo map \(the planner's, handed to every worker\): 1 file\(s\).*tests: npm test/);

    apiGet.mockResolvedValue({ team: { ...TEAM, status: "done", singleRun: true, advice: { reason: "one_task", overlap: 100 } } });
    const single = await ok("coding_team_status", { team_id: TEAM.id });
    expect(single).toMatch(/Single run: the plan had one task, so it ran as one ordinary coding run/);
    expect(single).not.toMatch(/Advice:/);

    apiGet.mockResolvedValue({ team: { ...TEAM, status: "working", advice: { reason: "one_task", overlap: 100 } } });
    expect(await ok("coding_team_status", { team_id: TEAM.id })).toMatch(/Advice: the plan has one task — a single coding_agent_run would have been cheaper/);
  });

  it("answers the team's tokens by kind in coding_team_status, and nothing of it from an older server", async () => {
    const metrics = { plannerRuns: 1, workerRuns: 1, reviewerRuns: 1, leadRuns: 0, tasksPlanned: 1, tasksAdded: 0, tasksRetired: 0, tasksAcceptedFirstTry: 1, tasksRejected: 0, tokensUsed: 174_500, wallMs: 60000 };
    const tokenBreakdown = { input: 9700, output: 1800, cacheCreation: 2000, cacheRead: 161000 };
    apiGet.mockResolvedValue({ team: { ...TEAM, status: "done", metrics: { ...metrics, tokenBreakdown } } });
    expect(await ok("coding_team_status", { team_id: TEAM.id })).toContain("tokens 174500 — input 9700, output 1800, cache write 2000, cache read 161000; wall 60 s.");

    apiGet.mockResolvedValue({ team: { ...TEAM, status: "done", metrics } });
    const older = await ok("coding_team_status", { team_id: TEAM.id });
    expect(older).toContain("tokens 174500; wall 60 s.");
    expect(older).not.toContain("cache read");
  });

  it("marks a single run and the advice in the list of teams", async () => {
    apiGet.mockResolvedValue({ teams: [
      { ...TEAM, id: "team-aaaaaaaa", singleRun: true },
      { ...TEAM, id: "team-bbbbbbbb", advice: { reason: "overlap", overlap: 70 } },
      { ...TEAM, id: "team-cccccccc" },
    ] });
    const rows = JSON.parse(await ok("coding_team_status", {})) as Array<Record<string, unknown>>;
    expect(rows[0].single_run).toBe(true);
    expect(rows[1].advice).toBe("a single run would have been cheaper: 70% of the files overlap");
    expect(rows[2]).not.toHaveProperty("advice");
    expect(rows[2]).not.toHaveProperty("single_run");
  });

  it("reads an older server's answer, which has none of it, as before", async () => {
    apiGet.mockResolvedValue({ team: { ...TEAM, metrics: { plannerRuns: 1, workerRuns: 1, reviewerRuns: 0, leadRuns: 0, tasksPlanned: 2, tasksAdded: 0, tasksRetired: 0, tasksAcceptedFirstTry: 0, tasksRejected: 0, tokensUsed: 500, wallMs: 1000 } } });
    const text = await ok("coding_team_status", { team_id: TEAM.id });
    expect(text).toContain("tokens 500; wall 1 s.");
    expect(text).not.toMatch(/Advice|Single run|Repo map/);
  });
});
