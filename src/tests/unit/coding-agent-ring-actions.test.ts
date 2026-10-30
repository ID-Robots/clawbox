/**
 * The owner-notice ring actions the coding routes and the team's finish push
 * (the 2026-10-30 redesign's step 3): `coding_run` from POST run, `coding_team
 * started` from POST team, and `coding_team settled` — a finish CARD, not a
 * toast — from `announceCodingTeam`. The ROUTES push, not the MCP tools, so a
 * run started from another device, the owner's click or the review pass shows
 * up as a chat card within one poll (page.tsx nudges the cards on them).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamBoard } from "@/lib/coding-team-board";

const desktop = vi.hoisted(() => [] as { action: Record<string, unknown>; id?: string }[]);
vi.mock("@/lib/pending-actions", () => ({
  pushPendingAction: vi.fn(async (action: Record<string, unknown>, id?: string) => {
    desktop.push({ action, id });
    return { ...action, id: id ?? "id", ts: 0 };
  }),
}));

const startOrQueueRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, startOrQueueRun };
});
const team = vi.hoisted(() => ({ startTeam: vi.fn(), getTeam: vi.fn(), listTeams: vi.fn(), waitForTeam: vi.fn(), stopTeam: vi.fn(), cancelQueuedTeam: vi.fn() }));
vi.mock("@/lib/coding-team", () => team);
vi.mock("@/lib/route-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/route-auth")>("@/lib/route-auth");
  return { ...actual, requireSession: vi.fn(async () => null) };
});
vi.mock("@/lib/owner-session", () => ({ hasPersonSession: vi.fn(async () => true) }));
// The Telegram leg of the team's notice is switched off by the environment,
// so this test is about the desktop leg alone.
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw"), getEdition: vi.fn(() => "openclaw") }));

// The routes import the coding-agent module, which is large: loaded once, with room.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let runRoute: typeof import("@/app/setup-api/coding-agent/run/route");
let teamRoute: typeof import("@/app/setup-api/coding-agent/team/route");
let notify: typeof import("@/lib/coding-agent-notify");
let CodingAgentError: typeof import("@/lib/coding-agent").CodingAgentError;
beforeAll(async () => {
  runRoute = await import("@/app/setup-api/coding-agent/run/route");
  teamRoute = await import("@/app/setup-api/coding-agent/team/route");
  notify = await import("@/lib/coding-agent-notify");
  ({ CodingAgentError } = await import("@/lib/coding-agent"));
});

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost/setup-api/coding-agent/${path}`, {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const RUN = { id: "run-k3x9q2ab", projectId: "site", directory: "/srv/projects/site", task: "Add a toggle", status: "running", team: null };
const BOARD = { id: "team-k3x9q2ab", goal: "Build the invoice app\nwith a printable PDF", projectId: null, directory: "/srv/projects/invoice", source: "owner", status: "planning", tasks: [], log: [], alerts: 0, error: null };

beforeEach(() => {
  desktop.length = 0;
  vi.clearAllMocks();
  process.env.CLAWBOX_CODING_AGENT_TELEGRAM = "off";
});
afterEach(() => {
  delete process.env.CLAWBOX_CODING_AGENT_TELEGRAM;
});

describe("POST coding-agent/run", () => {
  it("pushes a coding_run action named after the run — started, or queued with the run's team when it has one", async () => {
    const { POST } = runRoute;
    startOrQueueRun.mockResolvedValueOnce({ run: RUN, queued: false });
    expect((await POST(post("run", { task: "Add a toggle", projectId: "site" }))).status).toBe(202);
    await vi.waitFor(() => expect(desktop).toHaveLength(1));
    expect(desktop[0]).toEqual({ action: { type: "coding_run", phase: "started", runId: "run-k3x9q2ab", projectId: "site" }, id: "coding-run:run-k3x9q2ab" });

    startOrQueueRun.mockResolvedValueOnce({ run: { ...RUN, id: "run-queued001", status: "queued", team: { id: "team-k3x9q2ab", role: "worker", taskId: "T1" } }, queued: true });
    await POST(post("run", { task: "Add a toggle", projectId: "site" }));
    await vi.waitFor(() => expect(desktop).toHaveLength(2));
    expect(desktop[1].action).toEqual({ type: "coding_run", phase: "queued", runId: "run-queued001", projectId: "site", teamId: "team-k3x9q2ab" });
  });

  it("pushes nothing when the run was refused", async () => {
    const { POST } = runRoute;
    startOrQueueRun.mockRejectedValueOnce(new CodingAgentError("disabled", "off"));
    expect((await POST(post("run", { task: "Add a toggle" }))).status).toBe(409);
    expect(desktop).toEqual([]);
  });
});

describe("POST coding-agent/team", () => {
  it("pushes a coding_team started action with the goal's first line, named after the team", async () => {
    const { POST } = teamRoute;
    team.startTeam.mockResolvedValueOnce(BOARD);
    expect((await POST(post("team", { goal: BOARD.goal, directory: "invoice" }))).status).toBe(202);
    await vi.waitFor(() => expect(desktop).toHaveLength(1));
    expect(desktop[0]).toEqual({
      action: { type: "coding_team", phase: "started", teamId: "team-k3x9q2ab", projectId: null, goal: "Build the invoice app" },
      id: "coding-team:team-k3x9q2ab",
    });
    team.startTeam.mockResolvedValueOnce({ ...BOARD, id: "team-queued01", status: "queued" });
    await POST(post("team", { goal: BOARD.goal, directory: "invoice" }));
    await vi.waitFor(() => expect(desktop).toHaveLength(2));
    expect(desktop[1].action).toMatchObject({ type: "coding_team", phase: "queued", teamId: "team-queued01" });
  });
});

describe("announceCodingTeam", () => {
  it("pushes a coding_team settled card — status, task counts, the pull request — in place of the toast", async () => {
    const { announceCodingTeam, buildTeamAnnouncement } = notify;
    const board = {
      ...BOARD,
      status: "done",
      branch: "clawbox/team-k3x9q2ab",
      pr: { number: 12 },
      tasks: [
        { task_id: "T1", status: "complete" },
        { task_id: "T2", status: "complete" },
        { task_id: "T3", status: "failed" },
        { task_id: "T4", status: "retired" },
      ],
    } as unknown as TeamBoard;
    await announceCodingTeam(board);
    expect(desktop).toHaveLength(1);
    expect(desktop[0].id).toBe("coding-team:team-k3x9q2ab");
    expect(desktop[0].action).toEqual({
      type: "coding_team",
      phase: "settled",
      teamId: "team-k3x9q2ab",
      projectId: null,
      status: "done",
      tasksDone: 2,
      tasksTotal: 3,
      prNumber: 12,
      message: buildTeamAnnouncement(board),
    });
    // Never the toast shape: the desktop draws a finish card with Open.
    expect(desktop[0].action.type).not.toBe("notify");
  });
});
