/**
 * /setup-api/coding-agent/team and /team/stop — the coding team's routes:
 * session-gated, the owner's cookie recorded as `source: "owner"` and the
 * MCP bearer as `"agent"`, the orchestrator's refusals passed through with
 * their status, the board answered as-is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { teamCard } from "@/lib/coding-agent-slim";

const team = vi.hoisted(() => ({
  startTeam: vi.fn(),
  stopTeam: vi.fn(),
  cancelQueuedTeam: vi.fn(),
  getTeam: vi.fn(),
  listTeams: vi.fn(),
  waitForTeam: vi.fn(),
}));
vi.mock("@/lib/coding-team", () => team);
const requireSession = vi.hoisted(() => vi.fn());
const hasPersonSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/route-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/route-auth")>("@/lib/route-auth");
  return { ...actual, requireSession };
});
vi.mock("@/lib/owner-session", () => ({ hasPersonSession }));

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
  hasPersonSession.mockResolvedValue(false);
  team.startTeam.mockResolvedValue(BOARD);
  team.stopTeam.mockReturnValue({ ...BOARD, status: "stopped" });
  team.getTeam.mockReturnValue(BOARD);
  team.listTeams.mockReturnValue([BOARD]);
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

  it("holds ?id=&wait= open on waitForTeam, seconds capped at MAX_WAIT_MS, and reads at once without it", async () => {
    const { MAX_WAIT_MS } = await import("@/lib/coding-agent");
    team.waitForTeam.mockResolvedValue({ ...BOARD, status: "done" });
    expect(await (await GET(req("team?id=team-abcd1234&wait=30"))).json()).toEqual({ team: { ...BOARD, status: "done" } });
    expect(team.waitForTeam).toHaveBeenCalledWith("team-abcd1234", 30_000);
    await GET(req("team?id=team-abcd1234&wait=9999"));
    expect(team.waitForTeam).toHaveBeenLastCalledWith("team-abcd1234", MAX_WAIT_MS);
    team.waitForTeam.mockClear();
    await GET(req("team?id=team-abcd1234&wait=0"));
    await GET(req("team?id=team-abcd1234&wait=nope"));
    expect(team.waitForTeam).not.toHaveBeenCalled();
    expect(team.getTeam).toHaveBeenCalled();
  });

  it("answers a settled board slim on ?slim=1 — no log, its tasks' text gone — and a working one whole", async () => {
    const task = { task_id: "t1", task_description: "Write the toggle", status: "complete", result: "wrote it", review: { verdict: "accepted" as const, notes: "fine", at: 1 } };
    const done = { ...BOARD, id: "team-done00001", status: "done", log: [{ type: "note", message: "planned" }], tasks: [task] };
    const working = { ...BOARD, id: "team-work00001", status: "working", log: [{ type: "note", message: "planned" }], tasks: [task] };
    team.listTeams.mockReturnValue([done, working]);
    const slim = await (await GET(req("team?slim=1"))).json();
    // Every slim board carries `card` — the chat's team card reads it.
    expect(slim.teams[0]).toEqual({ ...done, slim: true, log: [], tasks: [{ ...task, result: null, review: { verdict: "accepted", notes: "", at: 1 } }], card: teamCard(done) });
    expect(slim.teams[1]).toEqual({ ...working, card: teamCard(working) });
    expect(slim.teams[1].card).toMatchObject({ phase: "working", tasksDone: 1, tasksTotal: 1, prNumber: null });
    expect(await (await GET(req("team"))).json()).toEqual({ teams: [done, working] });
    // One board by id is never slim.
    team.getTeam.mockReturnValue(done);
    expect(await (await GET(req("team?id=team-done00001&slim=1"))).json()).toEqual({ team: done });
  });

  it("answers the board's shape and figures with it — what the bench reads", async () => {
    const metrics = { plannerRuns: 1, workerRuns: 2, reviewerRuns: 0, leadRuns: 1, tasksPlanned: 3, tasksAdded: 0, tasksRetired: 1, tasksAcceptedFirstTry: 2, tasksRejected: 0, tokensUsed: 42_000, wallMs: 90_000, messagesSent: 3, messagesToLead: 1, messagesToSibling: 2, messagesUndelivered: 0 };
    team.getTeam.mockReturnValueOnce({ ...BOARD, shape: { parallelism: 1, review: "final", rationale: "One file." }, dynamic: true, metrics });
    const body = await (await GET(req("team?id=team-abcd1234"))).json();
    expect(body.team).toMatchObject({ shape: { parallelism: 1, review: "final" }, dynamic: true, metrics });
  });

  it("answers each run's provider and model, and the cost by provider as the board keeps them", async () => {
    const runs = [
      { id: "run-00000001", role: "planner", taskId: null, tokens: 5_000, provider: "anthropic", model: "claude-fable-5-1", modelRole: "planner" },
      { id: "run-00000002", role: "worker", taskId: "t1", tokens: 80_000, provider: "clawbox-ai", model: "deepseek-v4-flash", modelRole: "worker" },
    ];
    const tasks = [{ task_id: "t1", task_description: "Scrape", status: "complete" }];
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
    hasPersonSession.mockResolvedValue(true);
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
  });

  it("records the owner's cookie as the source", async () => {
    hasPersonSession.mockResolvedValueOnce(true);
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
    hasPersonSession.mockResolvedValue(true);
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
    hasPersonSession.mockResolvedValueOnce(true);
    expect((await STOP(req("team/stop", { id: OWNERS.id }))).status).toBe(200);
    expect(team.stopTeam).toHaveBeenCalledWith(OWNERS.id);
  });
});

/**
 * `effort` on POST — the team's per-request level (2026-10-30): passed to the
 * orchestrator when named, left out when not, refused here when it is not one
 * the app offers.
 */
describe("POST effort", () => {
  it("hands an offered level to startTeam and leaves it out when none was named", async () => {
    await POST(req("team", { goal: "Build it", directory: "site", effort: "ultracode" }));
    expect(team.startTeam).toHaveBeenCalledWith({ goal: "Build it", projectId: null, directory: "site", source: "agent", effort: "ultracode" });
    await POST(req("team", { goal: "Build it", directory: "site" }));
    expect(team.startTeam.mock.calls[1][0]).not.toHaveProperty("effort");
  });

  it("refuses a level the app does not offer with 400 and a code, before startTeam", async () => {
    for (const effort of ["medium", "Max", "", 7]) {
      team.startTeam.mockClear();
      const res = await POST(req("team", { goal: "Build it", directory: "site", effort }));
      expect(res.status, String(effort)).toBe(400);
      expect(await res.json()).toMatchObject({ kind: "invalid", code: "effort" });
      expect(team.startTeam).not.toHaveBeenCalled();
    }
  });
});
