/**
 * The time budget on the coding MCP tools (mcp/tools/coding-agent.ts):
 * coding_agent_run and coding_team_run take an optional `budget` token and a
 * `budget_token_cap`, send them as the routes' `budget` field only when named,
 * and say what the answer's `timeBudget` / `timeBudgetIgnored` mean — on the
 * box's clock. A budget over 30 minutes makes the run route start a TEAM, and
 * the run tool has to say so instead of reporting a run that never started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, apiTry } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiTry: vi.fn() }));

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
    apiTry: (...a: unknown[]) => apiTry(...a),
    API_BASE: "http://127.0.0.1:80",
    CLAWBOX_ROOT: "/home/clawbox/clawbox",
  };
});

import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerCodingAgentTools, registerCodingTeamTools, startBudgetField } from "../../../mcp/tools/coding-agent";
import { ApiError } from "../../../mcp/lib/errors";
import { MAX_PARAM_DESCRIPTION_CHARS } from "../../../mcp/lib/register";
import { PARAM_NAME_RE } from "../../../mcp/lib/schema";

/** 2026-10-14 12:00 UTC — 15:00 in Sofia. */
const NOW = Date.UTC(2026, 9, 14, 12, 0);

function harness() {
  const h = captureRegistrar("openclaw");
  registerCodingAgentTools(h.reg, { codingAgent: true });
  registerCodingTeamTools(h.reg, { codingAgent: true });
  return h;
}

const RUN = {
  id: "run-k3x9q2ab",
  task: "Add a dark mode toggle",
  directory: "/home/clawbox/Projects/site",
  projectId: null,
  source: "agent",
  status: "running",
  startedAt: NOW,
  completedAt: null,
};

const TEAM = {
  id: "team-k3x9q2ab",
  goal: "Add a dark mode toggle",
  projectId: null,
  directory: "/home/clawbox/Projects/site",
  status: "planning",
  plannerRunId: null,
  tasks: [],
  log: [],
  alerts: 0,
  error: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/** What the routes answer for a 1-hour chip picked at NOW. */
const ONE_HOUR = {
  deadline: new Date(NOW + 3_600_000).toISOString(),
  label: "1 hour",
  preset: "1h",
  source: "picker",
  setAt: new Date(NOW).toISOString(),
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  apiGet.mockReset();
  apiPost.mockReset();
  apiTry.mockReset();
  apiTry.mockResolvedValue({ timeZone: "Europe/Sofia" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the budget parameters", () => {
  it("are on both start tools, inside the parameter contract", () => {
    const h = harness();
    for (const name of ["coding_agent_run", "coding_team_run"]) {
      const shape = h.get(name).shape;
      for (const param of ["budget", "budget_token_cap"]) {
        expect(Object.keys(shape)).toContain(param);
        expect(param).toMatch(PARAM_NAME_RE);
        expect((shape[param].description ?? "").length).toBeLessThanOrEqual(MAX_PARAM_DESCRIPTION_CHARS);
      }
      expect(shape.budget.safeParse(undefined).success).toBe(true);
      expect(shape.budget_token_cap.parse(undefined)).toBe(0);
      expect(h.get(name).description).toMatch(/budget/);
    }
    // The tokens the routes read are what the description names.
    expect(h.get("coding_agent_run").shape.budget.description).toMatch(/30m, 1h, morning, 1d/);
  });
});

describe("startBudgetField", () => {
  it("sends nothing without a budget, and a token as it was given without a ceiling", () => {
    expect(startBudgetField(undefined, undefined, NOW)).toBeUndefined();
    expect(startBudgetField(undefined, 0, NOW)).toBeUndefined();
    expect(startBudgetField("  ", 0, NOW)).toBeUndefined();
    expect(startBudgetField("1h", 0, NOW)).toBe("1h");
    expect(startBudgetField("2026-10-15T18:00", undefined, NOW)).toBe("2026-10-15T18:00");
    expect(startBudgetField("none", 0, NOW)).toBe("none");
  });

  it("carries a ceiling in the routes' object shape, keeping box-local times untouched", () => {
    expect(startBudgetField("1h", 50_000, NOW)).toEqual({ preset: "1h", tokenCap: 50_000 });
    expect(startBudgetField("tomorrow-morning", 50_000, NOW)).toEqual({ preset: "morning", tokenCap: 50_000 });
    expect(startBudgetField("60m", 50_000, NOW)).toEqual({ preset: "1h", tokenCap: 50_000 });
    expect(startBudgetField("2026-10-15T18:00", 50_000, NOW)).toEqual({ preset: "custom", end: "2026-10-15T18:00", tokenCap: 50_000 });
    expect(startBudgetField("2026-10-15T09:00/2026-10-15T18:00", 50_000, NOW))
      .toEqual({ preset: "custom", start: "2026-10-15T09:00", end: "2026-10-15T18:00", tokenCap: 50_000 });
    // A length that is no chip becomes the end it comes to.
    expect(startBudgetField("90m", 50_000, NOW)).toEqual({ preset: "custom", end: new Date(NOW + 90 * 60_000).toISOString(), tokenCap: 50_000 });
    // One it cannot place still travels with its ceiling, for the device to refuse.
    expect(startBudgetField("someday", 50_000, NOW)).toEqual({ preset: "someday", tokenCap: 50_000 });
  });

  it("refuses a ceiling with no budget, with none, or under the floor", () => {
    expect(() => startBudgetField(undefined, 50_000, NOW)).toThrow(/no budget was given/);
    expect(() => startBudgetField("none", 50_000, NOW)).toThrow(/nothing for budget_token_cap/);
    expect(() => startBudgetField("1h", 9_999, NOW)).toThrow(/at least 10000/);
  });
});

describe("coding_agent_run with a budget", () => {
  it("sends the token as body.budget and words the deadline on the box's clock", async () => {
    apiPost.mockResolvedValue({ started: true, run: RUN, timeBudget: { ...ONE_HOUR, deadline: new Date(NOW + 30 * 60_000).toISOString(), label: "30 minutes", preset: "30m" } });
    const text = await ok("coding_agent_run", { task: "Add a dark mode toggle", directory: "site", budget: "30m" });
    expect(apiPost).toHaveBeenCalledWith(
      "/setup-api/coding-agent/run",
      { task: "Add a dark mode toggle", directory: "site", budget: "30m" },
      expect.anything(),
    );
    expect(apiTry).toHaveBeenCalledWith("/setup-api/coding-agent/status", expect.anything());
    expect(text).toContain('Started coding run "run-k3x9q2ab"');
    // 12:30 UTC is 15:30 in Sofia (EEST, UTC+3).
    expect(text).toMatch(/Time budget: 30 minutes, until Wed 14 Oct, 15:30 \(Europe\/Sofia\) — 30 minutes left/);
    expect(text).toMatch(/stops it cleanly at the deadline/);
  });

  it("sends a ceiling with the budget in the object shape", async () => {
    apiPost.mockResolvedValue({ started: true, run: RUN, timeBudget: { ...ONE_HOUR, deadline: new Date(NOW + 20 * 60_000).toISOString(), label: "Until Wed 14 Oct, 15:20", preset: "custom", tokenCap: 40_000 } });
    const text = await ok("coding_agent_run", { task: "t", directory: "site", budget: "2026-10-14T15:20", budget_token_cap: 40_000 });
    expect(apiPost.mock.calls[0][1]).toEqual({ task: "t", directory: "site", budget: { preset: "custom", end: "2026-10-14T15:20", tokenCap: 40_000 } });
    expect(text).toMatch(/at most 40000 tokens/);
  });

  it("falls back to UTC when the status route does not answer", async () => {
    apiTry.mockResolvedValue(null);
    apiPost.mockResolvedValue({ started: true, run: RUN, timeBudget: { ...ONE_HOUR, deadline: new Date(NOW + 20 * 60_000).toISOString(), label: "20 minutes", preset: "custom" } });
    const text = await ok("coding_agent_run", { task: "t", directory: "site", budget: "20m" });
    expect(text).toMatch(/until Wed 14 Oct, 12:20 \(UTC\)/);
  });

  it("says the task's words were ignored when the box would not take their budget", async () => {
    apiPost.mockResolvedValue({ started: true, run: RUN, timeBudgetIgnored: { phrase: "until last Friday", error: "The time budget ends in the past." } });
    const text = await ok("coding_agent_run", { task: "Work until last Friday", directory: "site" });
    expect(apiPost.mock.calls[0][1]).toEqual({ task: "Work until last Friday", directory: "site" });
    expect(apiTry).not.toHaveBeenCalled();
    expect(text).toMatch(/"until last Friday" named a time budget the ClawBox would not take \(The time budget ends in the past\.\)/);
  });

  it("says nothing about a budget when the answer has none — the answer it always was", async () => {
    apiPost.mockResolvedValue({ started: true, run: RUN });
    const text = await ok("coding_agent_run", { task: "t", directory: "site" });
    expect(text).not.toMatch(/budget/i);
    expect(apiTry).not.toHaveBeenCalled();
  });

  it("follows the team the route started for a budget over 30 minutes", async () => {
    apiPost.mockResolvedValue({ started: true, queued: false, team: TEAM, routedToTeam: true, timeBudget: ONE_HOUR });
    const text = await ok("coding_agent_run", { task: "Add a dark mode toggle", directory: "site", budget: "1h" });
    expect(text).toMatch(/over 30 minutes, so the ClawBox handed the task to a coding team/);
    expect(text).toContain('Started coding team "team-k3x9q2ab"');
    expect(text).toMatch(/coding_team_status/);
    expect(text).toMatch(/Time budget: 1 hour, until Wed 14 Oct, 16:00 \(Europe\/Sofia\)/);
    expect(text).not.toMatch(/coding_agent_status/);
  });

  it("says a routed team is queued when it is", async () => {
    apiPost.mockResolvedValue({ started: false, queued: true, team: { ...TEAM, status: "queued", queuePosition: 2 }, routedToTeam: true, timeBudget: ONE_HOUR });
    const text = await ok("coding_agent_run", { task: "t", directory: "site", budget: "1h" });
    expect(text).toMatch(/Queued coding team "team-k3x9q2ab".*number 2 in line/);
    expect(text).toMatch(/Do NOT start it again/);
  });

  it("passes on why a long budget stayed one run", async () => {
    apiPost.mockResolvedValue({ started: true, run: RUN, timeBudget: ONE_HOUR, routedToTeam: false, routeNote: "A budget over 30 minutes normally starts a coding team, but this request names deliverable, which only a single run carries — so it runs as one run with the budget." });
    const text = await ok("coding_agent_run", { task: "t", directory: "site", budget: "1h", deliverable_files: "index.html" });
    expect(text).toMatch(/so it runs as one run with the budget/);
    expect(text).toContain('Started coding run "run-k3x9q2ab"');
  });

  it("turns the route's budget refusal into advice about the budget, not the folder", async () => {
    apiPost.mockRejectedValueOnce(new ApiError(400, JSON.stringify({ error: "A time budget can run at most 14 days; that one ends 2026-11-30T18:00:00.000Z.", kind: "invalid", code: "budget" })));
    const out = await refused("coding_agent_run", { task: "t", directory: "site", budget: "2026-11-30T18:00" });
    expect(out).toMatchObject({ code: "BAD_ARGUMENT", message: expect.stringMatching(/at most 14 days/), next: expect.stringMatching(/folder was not the problem/) });
  });

  it("refuses a ceiling without a budget before anything is sent", async () => {
    const out = await refused("coding_agent_run", { task: "t", directory: "site", budget_token_cap: 50_000 });
    expect(out).toMatchObject({ code: "BAD_ARGUMENT", message: expect.stringMatching(/no budget was given/) });
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe("coding_team_run with a budget", () => {
  it("sends the token as body.budget and words the deadline", async () => {
    apiPost.mockResolvedValue({ started: true, team: TEAM, timeBudget: { ...ONE_HOUR, deadline: new Date(Date.UTC(2026, 9, 15, 5, 0)).toISOString(), label: "Until tomorrow morning", preset: "morning" } });
    const text = await ok("coding_team_run", { goal: "Scrape until morning", directory: "site", budget: "morning" });
    expect(apiPost).toHaveBeenCalledWith("/setup-api/coding-agent/team", { goal: "Scrape until morning", directory: "site", budget: "morning" }, expect.anything());
    expect(text).toMatch(/Time budget: Until tomorrow morning \(Thu 15 Oct, 08:00\) \(Europe\/Sofia\)/);
    // The budget comes before the closing instruction.
    expect(text.indexOf("Time budget")).toBeLessThan(text.indexOf("Tell the user it is running and stop"));
  });

  it("sends nothing about a budget when none was named", async () => {
    apiPost.mockResolvedValue({ started: true, team: TEAM });
    const text = await ok("coding_team_run", { goal: "g", directory: "site" });
    expect(apiPost.mock.calls[0][1]).toEqual({ goal: "g", directory: "site" });
    expect(text).not.toMatch(/budget/i);
  });

  it("passes a ceiling on and turns a budget refusal into budget advice", async () => {
    apiPost.mockRejectedValueOnce(new ApiError(400, JSON.stringify({ error: "The time budget ends in the past (2026-10-13T18:00:00.000Z). Pick an end later than now.", kind: "invalid", code: "budget" })));
    const out = await refused("coding_team_run", { goal: "g", directory: "site", budget: "1d", budget_token_cap: 300_000 });
    expect(apiPost.mock.calls[0][1]).toEqual({ goal: "g", directory: "site", budget: { preset: "1d", tokenCap: 300_000 } });
    expect(out).toMatchObject({ code: "BAD_ARGUMENT", message: expect.stringMatching(/ends in the past/), next: expect.stringMatching(/budget the ClawBox takes/) });
  });
});
