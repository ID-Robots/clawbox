/**
 * The cards in the seconds-to-minutes between asking for a run or a team and
 * its first piece of work (src/lib/coding-start-phase.ts): "Starting…" with
 * the step, the id and the clock from the moment the request reached the box;
 * the record taking the card over under the same id; the reason when the box
 * refused; the quick beat while anything is starting. The owner's report:
 * minutes after the chat was asked to build an app, nothing on screen said a
 * team had begun.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { cleanup, renderHook } from "@testing-library/react";
import { translations } from "@/lib/translations";
import CodingAgentActivityPill from "@/components/CodingAgentActivityPill";
import CodingTeamActivityCard from "@/components/CodingTeamActivityCard";
import CodingAgentLiveAgents from "@/components/CodingAgentLiveAgents";
import { runCardLabels, teamCardLabels } from "@/components/CodingChatCards";
import type { TeamView } from "@/components/CodingTeamPage";
import { START_POLL_MS, START_WATCH_MS, useCodingAgentActivity, type CodingAgentActivity, type TeamActivity } from "@/lib/use-coding-agent-activity";
import type { CodingStartView } from "@/lib/coding-start-phase";

const en = translations.en;
const t = (key: string) => en[key] ?? key;
// The app's Now section reads the catalogue through useT.
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));
const RUN_LABELS = runCardLabels(t);
const TEAM_LABELS = teamCardLabels(t);
const OPEN = en["codingAgent.liveView"];
const NOW = Date.now();

const START: CodingStartView = {
  id: "run-abc12345",
  kind: "run",
  task: "Build an invoice reader app\nNext.js, TypeScript, Bun",
  projectId: "invoice-reader",
  directory: null,
  source: "agent",
  requestedAt: NOW - 3_000,
  step: "worktree",
  error: null,
  failedAt: null,
};

const RECORD = {
  id: "run-abc12345",
  projectId: "invoice-reader",
  task: "Build an invoice reader app",
  status: "running",
  startedAt: NOW - 1_000,
  completedAt: null,
  source: "agent",
};

function listResponse(runs: unknown[], starting: unknown[] = []) {
  return new Response(JSON.stringify({ runs, starting }), { status: 200, headers: { "content-type": "application/json" } });
}
function teamsResponse(teams: unknown[] = []) {
  return new Response(JSON.stringify({ teams }), { status: 200, headers: { "content-type": "application/json" } });
}
/** One poll is two requests (runs and teams); a test about the beat counts the runs reads. */
const runPolls = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/coding-agent/runs")).length;

const activity = (over: Partial<CodingAgentActivity>): CodingAgentActivity => ({
  id: "run-abc12345", projectId: "invoice-reader", task: "Build an invoice reader app", startedAt: NOW - 3_000, completedAt: null,
  status: "running", source: "agent", subagentsTotal: 0, subagentsActive: 0, subagentsByType: {}, tokensUsed: 0, thinkingTokens: 0,
  filesTouched: 0, numTurns: 0, progress: [], screenshots: [], todos: [], transcriptPath: null, sessionId: null, directory: null,
  ...over,
});

const team = (over: Partial<TeamActivity>): TeamActivity => ({
  id: "team-k3x9q2ab", projectId: "invoice-reader", directory: null, goal: "Build an invoice reader app", status: "planning", source: "agent",
  startedAt: NOW - 40_000, finishedAt: null, tasksDone: 0, tasksTotal: 0, tasks: [], prNumber: null, resultLine: null, agents: [],
  tokensUsed: 0, errorLine: null, ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the run card while a run starts", () => {
  it("says Starting…, the step and the run's id — and offers no Pause for a run with no record yet", () => {
    render(<CodingAgentActivityPill run={activity({ announced: true, startStep: "worktree" })} labels={RUN_LABELS} openLabel={OPEN} canControl />);
    expect(screen.getByTestId("coding-agent-activity")).toHaveTextContent("Starting…");
    const line = screen.getByTestId("coding-agent-activity-start");
    expect(line).toHaveAttribute("data-step", "worktree");
    expect(line).toHaveTextContent("Preparing its own copy of the project");
    expect(screen.getByTestId("coding-agent-activity-run-id")).toHaveTextContent("run-abc12345");
    // Pause lives on the expanded card: expanded, there is still none.
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.queryByTestId("coding-agent-activity-pause")).toBeNull();
    expect(screen.queryByTestId("coding-agent-progressbar")).toBeNull();
  });

  it("names the wait for the harness's first word once the record is written", () => {
    render(<CodingAgentActivityPill run={activity({ startStep: "agent" })} labels={RUN_LABELS} openLabel={OPEN} canControl />);
    expect(screen.getByTestId("coding-agent-activity-start")).toHaveTextContent("Waiting for the coding agent's first step");
    // A record exists: Pause is the owner's again.
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.getByTestId("coding-agent-activity-pause")).toBeInTheDocument();
  });

  it("says Could not start, with the reason, for a start the box refused", () => {
    render(<CodingAgentActivityPill run={activity({ announced: true, status: "failed", completedAt: NOW, errorLine: "That folder is busy with run-zzzz0000." })} labels={RUN_LABELS} openLabel={OPEN} />);
    expect(screen.getByTestId("coding-agent-activity")).toHaveTextContent("Could not start");
    expect(screen.getByTestId("coding-agent-activity-result")).toHaveTextContent("That folder is busy with run-zzzz0000.");
    expect(screen.queryByTestId("coding-agent-activity-start")).toBeNull();
  });
});

describe("the team card while a team starts", () => {
  it("names the planner's step and the team's id under the status", () => {
    render(<CodingTeamActivityCard team={team({ startStep: "planning" })} labels={TEAM_LABELS} openLabel={OPEN} />);
    expect(screen.getByTestId("coding-team-activity-status")).toHaveTextContent("Planning");
    const line = screen.getByTestId("coding-team-activity-start");
    expect(line).toHaveAttribute("data-step", "planning");
    expect(line).toHaveTextContent("The planner is reading the project and splitting the goal");
    expect(screen.getByTestId("coding-team-activity-id")).toHaveTextContent("team-k3x9q2ab");
  });

  it("says Could not start with the reason itself — never \"Stopped:\" — for a team the box refused", () => {
    render(<CodingTeamActivityCard team={team({ id: "start-1a2b3c4d", status: "failed", announced: true, finishedAt: NOW, errorLine: "Claude Code is not signed in." })} labels={TEAM_LABELS} openLabel={OPEN} />);
    expect(screen.getByTestId("coding-team-activity-status")).toHaveTextContent("Could not start");
    expect(screen.getByTestId("coding-team-activity-result")).toHaveTextContent(/^Claude Code is not signed in\.$/);
  });
});

describe("useCodingAgentActivity while something starts", () => {
  it("shows an announced start at once, re-asks on the start beat, and lets the record take the card over in place", async () => {
    vi.useFakeTimers();
    let phase: "start" | "record" = "start";
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/team")) return teamsResponse();
      return phase === "start" ? listResponse([], [START]) : listResponse([{ ...RECORD, sessionId: "sess-1" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0]).toMatchObject({ id: "run-abc12345", status: "running", announced: true, startStep: "worktree", startedAt: START.requestedAt });

    phase = "record";
    await act(async () => { await vi.advanceTimersByTimeAsync(START_POLL_MS + 50); });
    expect(runPolls(fetchMock)).toBe(2);
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0]).toMatchObject({ id: "run-abc12345", announced: false, startStep: null, sessionId: "sess-1" });
    // The record is stamped when it was written; the card's clock keeps
    // counting from the request rather than jumping back by the start's work.
    expect(RECORD.startedAt).toBeGreaterThan(START.requestedAt);
    expect(result.current.runs[0].startedAt).toBe(START.requestedAt);
  });

  it("keeps a refused start's card with its reason after the box forgets it, and drops a start that vanished", async () => {
    vi.useFakeTimers();
    const vanished = { ...START, id: "run-vanish00" };
    const refused = { ...START, id: "run-refused1", step: "checking", error: "The coding agent is switched off.", failedAt: NOW };
    let round = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/team")) return teamsResponse();
      return round === 0 ? listResponse([], [vanished, refused]) : listResponse([], []);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.runs.map((r) => r.id).sort()).toEqual(["run-refused1", "run-vanish00"]);
    expect(result.current.runs.find((r) => r.id === "run-refused1")).toMatchObject({ status: "failed", announced: true, errorLine: "The coding agent is switched off." });

    round = 1;
    await act(async () => { await vi.advanceTimersByTimeAsync(START_POLL_MS + 50); });
    expect(result.current.runs.map((r) => r.id)).toEqual(["run-refused1"]);
  });

  it("shows a team the box refused to start as a failed team card", async () => {
    const refused = { ...START, id: "start-1a2b3c4d", kind: "team", task: "Build an invoice reader app", error: "Claude Code is not signed in.", failedAt: NOW };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("/team") ? teamsResponse() : listResponse([], [refused]))));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await vi.waitFor(() => expect(result.current.teams).toHaveLength(1));
    expect(result.current.teams[0]).toMatchObject({ id: "start-1a2b3c4d", status: "failed", announced: true, errorLine: "Claude Code is not signed in." });
    expect(result.current.runs).toEqual([]);
  });

  it("carries a planning team's step off its card, and keeps the start beat while its planner is starting", async () => {
    vi.useFakeTimers();
    const board = { id: "team-k3x9q2ab", goal: "Build it", status: "planning", createdAt: NOW, card: { phase: "planning", startStep: "planner_starting", tasksDone: 0, tasksTotal: 0, tasks: [], agents: [] } };
    const fetchMock = vi.fn(async (url: string) => (String(url).includes("/team") ? teamsResponse([board]) : listResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.teams[0]).toMatchObject({ id: "team-k3x9q2ab", startStep: "planner_starting" });
    await act(async () => { await vi.advanceTimersByTimeAsync(START_POLL_MS + 50); });
    expect(runPolls(fetchMock)).toBe(2);
  });

  it("keeps the start beat for a while after a coding tool went by, then slows down", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => (String(url).includes("/team") ? teamsResponse() : listResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(runPolls(fetchMock)).toBe(1);
    // The chat saw `coding_agent_run` start: its request may land a moment later.
    await act(async () => { result.current.nudge(); await Promise.resolve(); });
    expect(runPolls(fetchMock)).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(START_POLL_MS + 50); });
    expect(runPolls(fetchMock)).toBe(3);
    const atWatchEnd = runPolls(fetchMock);
    await act(async () => { await vi.advanceTimersByTimeAsync(START_WATCH_MS + 6_000); });
    const settled = runPolls(fetchMock);
    // Past the watch: at most one more round, then nothing until the idle check.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(runPolls(fetchMock)).toBe(settled);
    expect(settled).toBeGreaterThan(atWatchEnd);
  });
});

describe("the app's Now section while something starts", () => {
  const TEAM: TeamView = {
    id: "team-k3x9q2ab",
    goal: "Build an invoice reader app",
    projectId: null,
    directory: "/srv/projects/invoice",
    status: "planning",
    plannerRunId: null,
    runs: [{ id: "run-plan0001", role: "planner", taskId: null }],
    tasks: [],
    log: [],
    alerts: 0,
    error: null,
    createdAt: NOW - 30_000,
    updatedAt: NOW,
  } as unknown as TeamView;

  it("draws a start on its way and a refused one as rows, and a planning team's step under its heading", () => {
    const refused: CodingStartView = { ...START, id: "run-refused1", step: "checking", error: "The coding agent is switched off.", failedAt: NOW };
    render(<CodingAgentLiveAgents runs={[]} teams={[TEAM]} starts={[START, refused]} now={NOW} onOpenRun={vi.fn()} onOpenTeam={vi.fn()} />);
    const section = screen.getByTestId("coding-agent-live-agents");
    // The team and the start on its way are at work; the refusal is not.
    expect(section).toHaveAttribute("data-live", "2");
    const row = screen.getByTestId("coding-agent-live-start-run-abc12345");
    expect(row).toHaveAttribute("data-step", "worktree");
    expect(row).toHaveTextContent("Starting…");
    expect(row).toHaveTextContent("Build an invoice reader app");
    expect(screen.getByTestId("coding-agent-live-start-step-run-abc12345")).toHaveTextContent("Preparing its own copy of the project");
    expect(screen.getByTestId("coding-agent-live-start-step-run-abc12345-id")).toHaveTextContent("run-abc12345");
    expect(screen.getByTestId("coding-agent-live-start-step-run-abc12345")).toHaveTextContent("3s");
    expect(screen.getByTestId("coding-agent-live-start-run-refused1")).toHaveTextContent("Could not start");
    expect(screen.getByTestId("coding-agent-live-start-error-run-refused1")).toHaveTextContent("The coding agent is switched off.");
    expect(screen.getByTestId("coding-agent-live-team-step-team-k3x9q2ab")).toHaveTextContent("The planner is reading the project and splitting the goal");
  });

  it("hands a start's row over to its record once the record is listed", () => {
    render(<CodingAgentLiveAgents runs={[{ ...RECORD, numTurns: 0, tokensUsed: 0, filesTouched: [], progress: [], progressAt: [], summary: null, error: null } as never]} teams={[]} starts={[START]} now={NOW} onOpenRun={vi.fn()} onOpenTeam={vi.fn()} />);
    expect(screen.queryByTestId("coding-agent-live-start-run-abc12345")).toBeNull();
    expect(screen.getByTestId("coding-agent-live-run-run-abc12345")).toBeInTheDocument();
    // Its harness has not spoken: the row says so, with the id.
    expect(screen.getByTestId("coding-agent-live-run-step-run-abc12345")).toHaveTextContent("Waiting for the coding agent's first step");
  });
});
