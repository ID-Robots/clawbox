/**
 * /setup-api/coding-agent/team and /team/stop — the coding team's routes:
 * session-gated, the owner's cookie recorded as `source: "owner"` and the
 * MCP bearer as `"agent"`, the orchestrator's refusals passed through with
 * their status, the board answered as-is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const team = vi.hoisted(() => ({
  startTeam: vi.fn(),
  stopTeam: vi.fn(),
  cancelQueuedTeam: vi.fn(),
  getTeam: vi.fn(),
  listTeams: vi.fn(),
}));
vi.mock("@/lib/coding-team", () => team);
const requireSession = vi.hoisted(() => vi.fn());
const hasOwnerSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/route-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/route-auth")>("@/lib/route-auth");
  return { ...actual, requireSession };
});
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession }));
// The owner's default time budget (none unless a case sets one) and the box's zone.
const getDefaultTimeBudget = vi.hoisted(() => vi.fn());
const getTokenLimit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  getDefaultTimeBudget,
  getTokenLimit,
}));
vi.mock("@/lib/timezone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/timezone")>()),
  readOsTimeZone: vi.fn(async () => "Europe/Sofia"),
}));
// A budgeted team's time record, as the store would answer it (none unless a case says).
const readTimeRecordSummary = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-time-record", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-time-record")>()),
  readTimeRecordSummary,
}));

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let STOP: (req: Request) => Promise<Response>;

const BOARD = { id: "team-abcd1234", goal: "g", source: "agent", status: "planning", tasks: [], log: [], alerts: 0, error: null };
const OWNERS = { ...BOARD, id: "team-owner001", source: "owner" };

function req(path: string, body?: unknown): Request {
  return new Request(`http://localhost/setup-api/coding-agent/${path}`, body === undefined
    ? { headers: { host: "localhost" } }
    : { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  requireSession.mockResolvedValue(null);
  hasOwnerSession.mockResolvedValue(false);
  getDefaultTimeBudget.mockResolvedValue(null);
  getTokenLimit.mockResolvedValue(null);
  team.startTeam.mockResolvedValue(BOARD);
  team.stopTeam.mockReturnValue({ ...BOARD, status: "stopped" });
  team.getTeam.mockReturnValue(BOARD);
  team.listTeams.mockReturnValue([BOARD]);
  readTimeRecordSummary.mockReturnValue(null);
  ({ GET, POST } = await import("@/app/setup-api/coding-agent/team/route"));
  ({ POST: STOP } = await import("@/app/setup-api/coding-agent/team/stop/route"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET", () => {
  it("answers one board by id, the list without, and 404 for an id it does not know", async () => {
    expect(await (await GET(req("team?id=team-abcd1234"))).json()).toEqual({ team: BOARD });
    expect(await (await GET(req("team"))).json()).toEqual({ teams: [BOARD] });
    team.getTeam.mockReturnValueOnce(null);
    const res = await GET(req("team?id=team-nope0000"));
    expect(res.status).toBe(404);
    expect((await res.json()).kind).toBe("not_found");
  });

  it("answers the board's shape and figures with it — what the bench reads", async () => {
    const metrics = { plannerRuns: 1, workerRuns: 2, reviewerRuns: 0, leadRuns: 1, tasksPlanned: 3, tasksAdded: 0, tasksRetired: 1, tasksAcceptedFirstTry: 2, tasksRejected: 0, tokensUsed: 42_000, wallMs: 90_000, messagesSent: 3, messagesToLead: 1, messagesToSibling: 2, messagesUndelivered: 0 };
    team.getTeam.mockReturnValueOnce({ ...BOARD, shape: { parallelism: 1, review: "final", rationale: "One file." }, dynamic: true, metrics });
    const body = await (await GET(req("team?id=team-abcd1234"))).json();
    expect(body.team).toMatchObject({ shape: { parallelism: 1, review: "final" }, dynamic: true, metrics });
  });

  it("answers each run's provider and model, a task's bulk role, and the cost by provider as the board keeps them", async () => {
    const runs = [
      { id: "run-00000001", role: "planner", taskId: null, tokens: 5_000, provider: "anthropic", model: "claude-fable-5-1", modelRole: "planner" },
      { id: "run-00000002", role: "worker", taskId: "t1", tokens: 80_000, provider: "clawbox-ai", model: "deepseek-v4-flash", modelRole: "bulk" },
    ];
    const tasks = [{ task_id: "t1", task_description: "Scrape", status: "complete", role: "bulk" }];
    team.getTeam.mockReturnValueOnce({ ...BOARD, runs, tasks, metrics: { tokensUsed: 85_000, tokensByProvider: { "clawbox-ai": 80_000, anthropic: 5_000 } } });
    const body = await (await GET(req("team?id=team-abcd1234"))).json();
    expect(body.team.runs).toEqual(runs);
    expect(body.team.tasks).toEqual(tasks);
    expect(body.team.metrics.tokensByProvider).toEqual({ "clawbox-ai": 80_000, anthropic: 5_000 });
  });

  it("needs a session", async () => {
    requireSession.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect((await GET(req("team"))).status).toBe(401);
    expect(team.listTeams).not.toHaveBeenCalled();
  });

  it("shows the bearer only the teams it started, and refuses an owner's team with 403", async () => {
    team.listTeams.mockReturnValue([BOARD, OWNERS]);
    team.getTeam.mockImplementation((id: string) => (id === OWNERS.id ? OWNERS : BOARD));
    // The bearer: the owner's team is neither listed nor readable.
    expect((await (await GET(req("team"))).json()).teams.map((t: { id: string }) => t.id)).toEqual([BOARD.id]);
    const refused = await GET(req(`team?id=${OWNERS.id}`));
    expect(refused.status).toBe(403);
    expect((await refused.json()).kind).toBe("owner_only");
    expect((await GET(req(`team?id=${BOARD.id}`))).status).toBe(200);
    // The owner: everything.
    hasOwnerSession.mockResolvedValue(true);
    expect((await (await GET(req("team"))).json()).teams).toHaveLength(2);
    expect((await GET(req(`team?id=${OWNERS.id}`))).status).toBe(200);
  });
});

describe("POST", () => {
  it("starts a team for the agent, recording the source, and answers 202 with the board", async () => {
    const res = await POST(req("team", { goal: "Build it", directory: "site" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: true, queued: false, team: BOARD });
    expect(team.startTeam).toHaveBeenCalledWith({ goal: "Build it", projectId: null, directory: "site", source: "agent" });
    // Absent, not `undefined`: toHaveBeenCalledWith cannot tell the two apart.
    expect(team.startTeam.mock.calls[0][0]).not.toHaveProperty("timeBudget");
  });

  it("records the owner's cookie as the source", async () => {
    hasOwnerSession.mockResolvedValueOnce(true);
    await POST(req("team", { goal: "Build it", projectId: "site" }));
    expect(team.startTeam).toHaveBeenCalledWith({ goal: "Build it", projectId: "site", directory: null, source: "owner" });
  });

  it("passes the orchestrator's refusals through with their status", async () => {
    const { CodingAgentError, httpStatusForCodingError } = await import("@/lib/coding-agent");
    for (const kind of ["disabled", "not_ready", "busy", "invalid", "not_found"] as const) {
      team.startTeam.mockRejectedValueOnce(new CodingAgentError(kind, `refused: ${kind}`));
      const res = await POST(req("team", { goal: "g" }));
      expect(res.status, kind).toBe(httpStatusForCodingError(kind));
      expect(await res.json()).toEqual({ error: `refused: ${kind}`, kind });
    }
  });

  it("answers 409 not_ready with the role, the provider and why, when a team role's account cannot run", async () => {
    const { CodingAgentError } = await import("@/lib/coding-agent");
    const words = "The team's reviewer runs on Anthropic (anthropic), which cannot run right now: Anthropic is not connected on this ClawBox. Connect it, or choose another provider for the reviewer under Team models in the Coding Agent settings.";
    team.startTeam.mockRejectedValueOnce(new CodingAgentError("not_ready", words));
    const res = await POST(req("team", { goal: "Build it", directory: "site" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: words, kind: "not_ready" });
  });

  it("refuses a body that is not JSON, and needs a session", async () => {
    expect((await POST(req("team", "{nope"))).status).toBe(400);
    requireSession.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect((await POST(req("team", { goal: "g" }))).status).toBe(401);
    expect(team.startTeam).not.toHaveBeenCalled();
  });
});

describe("a second team", () => {
  it("is answered QUEUED, with its place, not refused", async () => {
    const queued = { ...BOARD, status: "queued", queuePosition: 1 };
    team.startTeam.mockResolvedValueOnce(queued);
    const res = await POST(req("team", { goal: "Build it" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: false, queued: true, team: queued });
  });

  it("is canceled by the owner alone — the bearer that queued it may not", async () => {
    const queued = { ...BOARD, status: "queued", queuePosition: 1 };
    team.getTeam.mockReturnValue(queued);
    team.cancelQueuedTeam.mockReturnValue({ ...queued, status: "stopped" });
    const refused = await STOP(req("team/stop", { id: BOARD.id }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ kind: "owner_only", error: expect.stringMatching(/only the owner can cancel a queued team/) });
    hasOwnerSession.mockResolvedValue(true);
    const ok = await STOP(req("team/stop", { id: BOARD.id }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).team.status).toBe("stopped");
    expect(team.cancelQueuedTeam).toHaveBeenCalledWith(BOARD.id);
    expect(team.stopTeam).not.toHaveBeenCalled();
  });
});

describe("POST stop", () => {
  it("stops the named team and answers the board", async () => {
    const res = await STOP(req("team/stop", { id: "team-abcd1234" }));
    expect(res.status).toBe(200);
    expect((await res.json()).team.status).toBe("stopped");
    expect(team.stopTeam).toHaveBeenCalledWith("team-abcd1234");
  });

  it("needs an id, and answers 404 for a team that is not there", async () => {
    expect((await STOP(req("team/stop", {}))).status).toBe(400);
    team.getTeam.mockReturnValueOnce(null);
    expect((await STOP(req("team/stop", { teamId: "team-zzzz0000" }))).status).toBe(404);
    expect(team.stopTeam).not.toHaveBeenCalled();
  });

  it("refuses the bearer stopping an owner's team, and lets the owner", async () => {
    team.getTeam.mockReturnValue(OWNERS);
    const refused = await STOP(req("team/stop", { id: OWNERS.id }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).kind).toBe("owner_only");
    expect(team.stopTeam).not.toHaveBeenCalled();
    hasOwnerSession.mockResolvedValueOnce(true);
    expect((await STOP(req("team/stop", { id: OWNERS.id }))).status).toBe(200);
    expect(team.stopTeam).toHaveBeenCalledWith(OWNERS.id);
  });
});

/**
 * THE TIME BUDGET a team works to (src/lib/coding-time-budget.ts): the
 * picker's `budget`, else the goal's own words, else the owner's default —
 * resolved here on the box's clock and handed to the orchestrator, which keeps
 * it on the board. Without one, the call and the answer are what they were.
 */
describe("POST with a time budget", () => {
  const MIN = 60_000;
  const span = (b: { deadline: string; setAt: string }) => Date.parse(b.deadline) - Date.parse(b.setAt);

  it("hands the picker's budget to the orchestrator and names it in the answer", async () => {
    const res = await POST(req("team", { goal: "Build it", projectId: "site", budget: "1d" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ started: true, queued: false, team: BOARD, timeBudget: { preset: "1d", source: "picker", label: "1 day" } });
    expect(span(body.timeBudget)).toBe(24 * 60 * MIN);
    expect(team.startTeam).toHaveBeenCalledWith({ goal: "Build it", projectId: "site", directory: null, source: "agent", timeBudget: body.timeBudget });
  });

  it("reads the goal's words when the picker named none, and lets the picker beat them", async () => {
    const said = await (await POST(req("team", { goal: "Arbeite bis morgen früh an dem Scraper" }))).json();
    expect(said.timeBudget).toMatchObject({ preset: "morning", source: "text" });
    const picked = await (await POST(req("team", { goal: "You have 2 hours", budget: "1h" }))).json();
    expect(picked.timeBudget).toMatchObject({ preset: "1h", source: "picker" });
  });

  it("falls back to the owner's default, which \"none\" overrides", async () => {
    getDefaultTimeBudget.mockResolvedValue("morning");
    const fallback = await (await POST(req("team", { goal: "Build it" }))).json();
    expect(fallback.timeBudget).toMatchObject({ preset: "morning", source: "default" });
    const none = await (await POST(req("team", { goal: "Build it", budget: "none" }))).json();
    expect(none).toEqual({ started: true, queued: false, team: BOARD });
    expect(team.startTeam).toHaveBeenLastCalledWith({ goal: "Build it", projectId: null, directory: null, source: "agent" });
    expect(team.startTeam.mock.calls[team.startTeam.mock.calls.length - 1][0]).not.toHaveProperty("timeBudget");
  });

  it("lets the goal's words beat the owner's default", async () => {
    getDefaultTimeBudget.mockResolvedValue("morning");
    const body = await (await POST(req("team", { goal: "You have 2 hours: build the invoice app" }))).json();
    expect(body.timeBudget).toMatchObject({ preset: "custom", source: "text", label: "2 hours" });
    expect(team.startTeam).toHaveBeenLastCalledWith(expect.objectContaining({ timeBudget: body.timeBudget }));
  });

  it("turns an unexpected failure into a 500 with a plain message", async () => {
    team.startTeam.mockRejectedValueOnce(new Error("disk full"));
    const res = await POST(req("team", { goal: "Build it", budget: "1h" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("disk full");
  });

  it("refuses a budget it cannot read, or one in the past, with 400 and a sentence — no team started", async () => {
    for (const budget of ["later", "2020-01-01T00:00:00Z", { preset: "custom" }]) {
      const res = await POST(req("team", { goal: "Build it", budget }));
      expect(res.status, JSON.stringify(budget)).toBe(400);
      expect(await res.json()).toMatchObject({ kind: "invalid", code: "budget", error: expect.stringMatching(/time budget/) });
    }
    expect(team.startTeam).not.toHaveBeenCalled();
  });

  it("answers a queued team with its budget too", async () => {
    team.startTeam.mockResolvedValueOnce({ ...BOARD, status: "queued", queuePosition: 2 });
    const body = await (await POST(req("team", { goal: "Build it", budget: "1h" }))).json();
    expect(body).toMatchObject({ started: false, queued: true, timeBudget: { preset: "1h" } });
  });

  it("carries the owner's token cap on a budget over two hours as its spend ceiling", async () => {
    getTokenLimit.mockResolvedValue(750_000);
    // "1d", not "morning": the morning's length depends on the hour the suite runs at.
    const body = await (await POST(req("team", { goal: "Scrape the catalogue", budget: "1d" }))).json();
    expect(body.timeBudget).toMatchObject({ preset: "1d", tokenCap: 750_000 });
    expect(team.startTeam).toHaveBeenLastCalledWith(expect.objectContaining({ timeBudget: body.timeBudget }));
  });
});

describe("GET a team with a time budget", () => {
  const BUDGET = { deadline: "2026-10-15T05:00:00.000Z", label: "Until tomorrow morning", preset: "morning", source: "picker", setAt: "2026-10-14T15:00:00.000Z" };
  const TIMED = { ...BOARD, id: "team-timed001", timeBudget: BUDGET };
  const RECORD = { budget: BUDGET, estimateMs: 3_600_000, tasks: [{ taskId: "t1", estimateMs: 3_600_000, actualMs: null }], startedAt: "2026-10-14T15:01:00.000Z", finishedAt: null, usedMs: 60_000, leftMs: null, stopReason: null, tokenCap: null, tokensUsed: null, extras: [], skipped: ["the e2e suite"], records: [], omittedRecords: 0 };

  it("carries its time record — the plan, estimates and skips as of now — and no key without a budget or a record", async () => {
    team.getTeam.mockReturnValueOnce(TIMED);
    readTimeRecordSummary.mockReturnValueOnce(RECORD);
    expect(await (await GET(req("team?id=team-timed001"))).json()).toEqual({ team: { ...TIMED, timeRecord: RECORD } });
    expect(readTimeRecordSummary).toHaveBeenCalledWith("team-timed001", expect.any(Number), undefined);
    // A budget, but no record yet (still queued): the board as it is.
    team.getTeam.mockReturnValueOnce(TIMED);
    expect(await (await GET(req("team?id=team-timed001"))).json()).toEqual({ team: TIMED });
    // No budget: the store is not even asked.
    readTimeRecordSummary.mockClear();
    expect(await (await GET(req("team?id=team-abcd1234"))).json()).toEqual({ team: BOARD });
    expect(readTimeRecordSummary).not.toHaveBeenCalled();
  });

  it("carries it on each budgeted team of the list, cut to the latest record lines", async () => {
    team.listTeams.mockReturnValueOnce([TIMED, BOARD]);
    readTimeRecordSummary.mockImplementation((id: string) => (id === TIMED.id ? RECORD : null));
    expect(await (await GET(req("team"))).json()).toEqual({ teams: [{ ...TIMED, timeRecord: RECORD }, BOARD] });
    expect(readTimeRecordSummary).toHaveBeenCalledTimes(1);
    expect(readTimeRecordSummary).toHaveBeenCalledWith("team-timed001", expect.any(Number), 50);
  });
});
