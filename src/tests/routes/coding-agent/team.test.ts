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
    expect(await res.json()).toEqual({ started: true, team: BOARD });
    expect(team.startTeam).toHaveBeenCalledWith({ goal: "Build it", projectId: null, directory: "site", source: "agent" });
  });

  it("records the owner's cookie as the source", async () => {
    hasOwnerSession.mockResolvedValueOnce(true);
    await POST(req("team", { goal: "Build it", projectId: "site" }));
    expect(team.startTeam).toHaveBeenCalledWith({ goal: "Build it", projectId: "site", directory: null, source: "owner" });
  });

  it("passes the orchestrator's refusals through with their status", async () => {
    const { CodingAgentError, httpStatusForCodingError } = await import("@/lib/coding-agent");
    for (const kind of ["disabled", "busy", "invalid", "not_found"] as const) {
      team.startTeam.mockRejectedValueOnce(new CodingAgentError(kind, `refused: ${kind}`));
      const res = await POST(req("team", { goal: "g" }));
      expect(res.status, kind).toBe(httpStatusForCodingError(kind));
      expect(await res.json()).toEqual({ error: `refused: ${kind}`, kind });
    }
  });

  it("refuses a body that is not JSON, and needs a session", async () => {
    expect((await POST(req("team", "{nope"))).status).toBe(400);
    requireSession.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect((await POST(req("team", { goal: "g" }))).status).toBe(401);
    expect(team.startTeam).not.toHaveBeenCalled();
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
