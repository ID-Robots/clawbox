/**
 * The coding team's own page (src/components/CodingTeamPage.tsx, the
 * 2026-10-30 redesign's step 5): the status, the goal, the phase, Stop as two
 * taps, the chart drawn once, the tasks in outline order with their worker's
 * and reviewer's state, the pull request, the result, and the Details fold.
 * The page reads no list of its own: the host hands its copy of the team in
 * and re-reads when Stop answers; the one read the page makes by id is a
 * board the list lacks, or the whole copy of a settled board the list sent
 * slim.
 */
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingTeamPage, { activeRunOf, type TeamView } from "@/components/CodingTeamPage";
import type { DiagramRun } from "@/components/CodingAgentDiagram";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const NOW = Date.now();
const DIR = "/srv/projects/invoice";

const WORKING: TeamView = {
  id: "team-k3x9q2ab",
  goal: "Build the invoice app",
  projectId: null,
  directory: DIR,
  status: "working",
  plannerRunId: "run-00000001",
  branch: "clawbox/team-k3x9q2ab",
  base: "master",
  agents: { planner: 1, workers: 2, reviewers: 1, total: 4 },
  runs: [
    { id: "run-00000001", role: "planner", taskId: null },
    { id: "run-00000002", role: "worker", taskId: "t1" },
    { id: "run-00000004", role: "reviewer", taskId: "t1" },
    { id: "run-00000003", role: "worker", taskId: "t2" },
  ],
  tasks: [
    { task_id: "t1", task_description: "Scaffold index.html", assigned_to: "run-00000002", status: "complete", result: "Built index.html; open it.", depends_on: [], review: { verdict: "accepted", notes: "", at: 1 }, reviewRunId: "run-00000004", attempts: 1 },
    { task_id: "t2", task_description: "Wire app.js", assigned_to: "run-00000003", status: "in_progress", result: null, depends_on: ["t1"], review: null, attempts: 1 },
    { task_id: "t3", task_description: "Export to PDF", assigned_to: null, status: "pending", result: null, depends_on: ["t2"], review: null, attempts: 0 },
  ],
  log: [
    { ts: 1_700_000_000_000, actor: { kind: "owner" }, type: "team_created", message: "Team created" },
    { ts: 1_700_000_001_000, actor: { kind: "system" }, type: "alert", message: "ALERT: Worker run-00000002 touched files outside its task: secrets.env" },
    { ts: 1_700_000_002_000, actor: { kind: "worker", id: "run-00000003" }, type: "message", message: "worker run-00000003 to the lead", payload: { from: "run-00000003", to: "lead", text: "t2 needs the schema from t1", delivered: true } },
  ],
  alerts: 1,
  error: null,
  createdAt: NOW - 60_000,
  updatedAt: NOW,
};

const run = (id: string, over: Partial<DiagramRun> = {}): DiagramRun => ({
  id, task: `Task of ${id}`, status: "completed", startedAt: NOW - 300_000, completedAt: NOW - 100_000, numTurns: 3, tokensUsed: 1_000, filesTouched: [], progress: [], ...over,
});
const RUNS: DiagramRun[] = [run("run-00000001"), run("run-00000002"), run("run-00000004"), run("run-00000003", { status: "running", completedAt: null })];

let posts: { url: string; body: unknown }[];
let reads: string[];
/** The whole copy of a board, as `GET team?id=` answers it. */
let whole: Record<string, TeamView>;

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "/setup-api/users/me") return json({ username: "clawbox", isOwner: true });
    if (url === "/setup-api/coding-agent/team/stop" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { id: string };
      posts.push({ url, body });
      return json({ team: { ...WORKING, id: body.id, status: "stopped" } });
    }
    if (url.startsWith("/setup-api/coding-agent/team?id=")) {
      reads.push(url);
      const id = decodeURIComponent(url.split("id=")[1]);
      return whole[id] ? json({ team: whole[id] }) : json({ error: "no such team" }, 404);
    }
    return json({ error: "unexpected" }, 404);
  }));
}

/** The host: holds the page's team the way the app does and re-reads it when the page says something changed. */
function Page(props: Partial<ComponentProps<typeof CodingTeamPage>> & { team: TeamView | null; after?: TeamView | null }) {
  const [team, setTeam] = useState<TeamView | null>(props.team);
  return (
    <CodingTeamPage
      teamId={props.teamId ?? props.team?.id ?? "team-missing01"}
      team={team}
      runs={props.runs ?? RUNS}
      onOpenRun={props.onOpenRun ?? vi.fn()}
      onChanged={props.onChanged ?? (() => setTeam(props.after ?? team))}
    />
  );
}

beforeEach(() => {
  posts = [];
  reads = [];
  whole = {};
  stub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the Team page", () => {
  it("draws the status, the goal, the phase line and the chart ONCE, with no input anywhere", () => {
    render(<Page team={WORKING} />);
    const page = screen.getByTestId("coding-agent-team-page");
    expect(page).toHaveAttribute("data-team-id", WORKING.id);
    expect(screen.getByTestId("coding-team-status")).toHaveTextContent(t("codingAgent.team.status.working"));
    expect(screen.getByTestId("coding-team-goal")).toHaveTextContent("Build the invoice app");
    // One line of a goal that is one line: no "Show the whole goal".
    expect(screen.queryByTestId("coding-team-goal-open")).toBeNull();
    expect(screen.getByTestId("coding-team-meta")).toHaveTextContent("clawbox/team-k3x9q2ab");
    expect(screen.getByTestId("coding-team-meta")).toHaveTextContent(t("codingAgent.chatAgents", { n: 4 }));
    // Working · 1 of 3 tasks done: t1 is complete and accepted.
    const phase = screen.getByTestId("coding-team-phase");
    expect(phase).toHaveTextContent(t("codingAgent.team.phase.working", { done: 1, total: 3 }));
    expect(phase).toHaveAttribute("data-done", "1");
    expect(within(phase).getByTestId("coding-team-alerts")).toHaveTextContent(t("codingAgent.team.alerts", { n: 1 }));
    // The real chart, drawn exactly once, four agents on the cast list and the
    // placeholder for the task nobody has taken.
    const charts = screen.getAllByTestId("coding-team-diagram");
    expect(charts).toHaveLength(1);
    expect(charts[0]).toHaveAttribute("data-shape", "team");
    const nodes = within(charts[0]).getAllByTestId("coding-agent-node");
    expect(nodes.map((n) => n.getAttribute("data-key"))).toEqual(["run-00000001", "run-00000002", "run-00000004", "run-00000003", "task:t3"]);
    expect(screen.queryByTestId("coding-team-tree")).toBeNull();
    // Nothing on the page is an input: the chat composes, the app shows.
    expect(page.querySelectorAll("input, textarea, select")).toHaveLength(0);
  });

  it("lists the tasks in outline order with the worker's and the reviewer's state, and a task opens the run at work on it", () => {
    const onOpenRun = vi.fn();
    render(<Page team={WORKING} onOpenRun={onOpenRun} />);
    const tasks = screen.getByTestId("coding-team-tasks");
    const rows = Array.from(tasks.children).map((li) => li.getAttribute("data-testid"));
    expect(rows).toEqual(["coding-team-task-t1", "coding-team-task-t2", "coding-team-task-t3"]);
    // Dependency depth is an indent: t2 waits for t1, t3 for t2.
    expect(screen.getByTestId("coding-team-task-t1")).toHaveAttribute("data-depth", "0");
    expect(screen.getByTestId("coding-team-task-t2")).toHaveAttribute("data-depth", "1");
    expect(screen.getByTestId("coding-team-task-t3")).toHaveAttribute("data-depth", "2");
    // The second line: worker and reviewer, in words.
    expect(screen.getByTestId("coding-team-task-state-t1")).toHaveTextContent(`${t("codingAgent.team.taskWorker", { state: t("codingAgent.diagram.state.done") })} · ${t("codingAgent.team.taskReviewer", { state: t("codingAgent.team.review.accepted") })}`);
    expect(screen.getByTestId("coding-team-task-state-t2")).toHaveTextContent(t("codingAgent.team.taskWorker", { state: t("codingAgent.diagram.state.working") }));
    expect(screen.getByTestId("coding-team-task-state-t3")).toHaveTextContent(t("codingAgent.team.waitingFor", { ids: "t2" }));
    // A tap: the worker while it works, the worker's run once done; nothing for a task nobody has taken.
    fireEvent.click(screen.getByTestId("coding-team-task-open-t2"));
    expect(onOpenRun).toHaveBeenLastCalledWith("run-00000003");
    fireEvent.click(screen.getByTestId("coding-team-task-open-t1"));
    expect(onOpenRun).toHaveBeenLastCalledWith("run-00000002");
    expect(screen.queryByTestId("coding-team-task-open-t3")).toBeNull();
    // A complete task awaiting its reviewer opens the reviewer.
    expect(activeRunOf({ ...WORKING.tasks[0], review: null })).toBe("run-00000004");
  });

  it("stops the team in two taps — the first arms, the second posts — and an armed Stop disarms itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onChanged = vi.fn();
    render(<Page team={WORKING} onChanged={onChanged} />);
    const stop = screen.getByTestId("coding-team-stop");
    expect(stop).toHaveTextContent(t("codingAgent.team.stop"));
    fireEvent.click(stop);
    expect(posts).toEqual([]);
    expect(stop).toHaveAttribute("data-armed", "true");
    expect(stop).toHaveTextContent(t("codingAgent.team.stopConfirm"));
    // Left alone, the offer is taken back.
    act(() => { vi.advanceTimersByTime(5_100); });
    expect(stop).not.toHaveAttribute("data-armed");
    expect(stop).toHaveTextContent(t("codingAgent.team.stop"));
    // Two taps post the team's id, once, and the host re-reads.
    fireEvent.click(stop);
    fireEvent.click(stop);
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/team/stop", body: { id: WORKING.id } }]));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    // Not for a page with no chat, not for anyone but a tap: no confirm() dialog.
    expect(screen.queryByTestId("coding-team-cancel")).toBeNull();
  });

  it("offers Cancel — the same two taps — to a team still in line, and says its place", () => {
    render(<Page team={{ ...WORKING, status: "queued", queuePosition: 2, tasks: [], runs: [], agents: undefined }} />);
    expect(screen.getByTestId("coding-team-queue-position")).toHaveTextContent(t("codingAgent.team.queuePosition", { n: 2 }));
    expect(screen.getByTestId("coding-team-phase")).toHaveTextContent(t("codingAgent.team.phase.queued", { done: 0, total: 0 }));
    const cancel = screen.getByTestId("coding-team-cancel");
    expect(screen.queryByTestId("coding-team-stop")).toBeNull();
    fireEvent.click(cancel);
    expect(cancel).toHaveTextContent(t("codingAgent.team.cancelConfirm"));
    expect(posts).toEqual([]);
  });

  it("shows the pull request, the final review as the result and why a team failed", () => {
    render(<Page team={{
      ...WORKING,
      status: "failed",
      error: "The planner could not read the folder.",
      finalReview: { verdict: "rejected", notes: "The **export** button is missing.", at: NOW },
      pr: { number: 12, url: "https://github.com/owner/invoice/pull/12", branch: "clawbox/team-k3x9q2ab", base: "master", phase: "failed_checks", checks: { total: 3, passed: 1, failed: 1, pending: 1 }, merge: true, ciRounds: 2, failure: { tests: ["lint", "unit"], checks: [] }, detail: null },
    }} />);
    expect(screen.getByTestId("coding-team-reason")).toHaveTextContent("The planner could not read the folder.");
    expect(screen.queryByTestId("coding-team-stop")).toBeNull();
    const pr = screen.getByTestId("coding-team-pr");
    expect(pr).toHaveAttribute("data-phase", "failed_checks");
    expect(pr).toHaveTextContent(t("codingAgent.team.pr", { n: 12 }));
    expect(pr).toHaveTextContent(t("codingAgent.team.prChecks", { passed: 1, total: 3 }));
    expect(within(pr).getByTestId("coding-team-ci-rounds")).toBeInTheDocument();
    expect(within(pr).getByTestId("coding-team-ci-failing")).toHaveTextContent("lint, unit");
    const review = screen.getByTestId("coding-team-final-review");
    expect(review).toHaveAttribute("data-verdict", "rejected");
    expect(review).toHaveTextContent(t("codingAgent.team.review.rejected"));
    // Markdown, not raw text.
    expect(within(review).getByTestId("coding-team-final-review-notes").querySelector("strong")).toHaveTextContent("export");
  });

  it("folds the branch, the planner, the advice and the log under Details, closed until asked", () => {
    const onOpenRun = vi.fn();
    render(<Page team={{ ...WORKING, advice: { reason: "overlap", overlap: 60 } }} onOpenRun={onOpenRun} />);
    const details = screen.getByTestId("coding-team-details");
    expect(details.tagName).toBe("DETAILS");
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByTestId("coding-team-branch")).toHaveTextContent(t("codingAgent.team.branch", { branch: "clawbox/team-k3x9q2ab", base: "master" }));
    expect(within(details).getByTestId("coding-team-advice")).toHaveAttribute("data-reason", "overlap");
    fireEvent.click(within(details).getByTestId("coding-team-planner"));
    expect(onOpenRun).toHaveBeenCalledWith("run-00000001");
    // The log, on request, a message in it worded whole; no inbox, no messages list.
    expect(screen.queryByTestId("coding-team-log")).toBeNull();
    expect(screen.queryByTestId("coding-team-inbox")).toBeNull();
    expect(screen.queryByTestId("coding-team-messages")).toBeNull();
    fireEvent.click(within(details).getByTestId("coding-team-log-toggle"));
    const log = screen.getByTestId("coding-team-log");
    expect(log.children).toHaveLength(3);
    expect(within(log).getByTestId("coding-team-log-message")).toHaveTextContent("t2 needs the schema from t1");
    expect(within(log).getByTestId("coding-team-log-message")).toHaveTextContent(t("codingAgent.team.messageToLead"));
  });

  it("opens the whole goal in the task dialog when it says more than its first line", () => {
    render(<Page team={{ ...WORKING, goal: "Build the invoice app\n\nWith a PDF export and a customer list." }} />);
    expect(screen.getByTestId("coding-team-goal")).toHaveTextContent("Build the invoice app");
    expect(screen.getByTestId("coding-team-goal")).not.toHaveTextContent("PDF export");
    fireEvent.click(screen.getByTestId("coding-team-goal-open"));
    const dialog = screen.getByTestId("coding-agent-task-dialog");
    expect(within(dialog).getByTestId("coding-agent-task-dialog-body")).toHaveTextContent("With a PDF export and a customer list.");
  });

  it("reads no list of its own: a team at work is drawn from what the host hands in, with not one GET", () => {
    render(<Page team={WORKING} />);
    expect(reads).toEqual([]);
  });

  it("reads a settled board the list sent slim once, whole, by id — the log and the tasks' text come from that copy", async () => {
    const slim: TeamView = { ...WORKING, status: "done", slim: true, log: [], tasks: WORKING.tasks.map((x) => ({ ...x, task_description: "", result: null })) };
    whole[WORKING.id] = { ...WORKING, status: "done" };
    const { rerender } = render(<Page team={slim} />);
    await waitFor(() => expect(reads).toEqual([`/setup-api/coding-agent/team?id=${WORKING.id}`]));
    await waitFor(() => expect(screen.getByTestId("coding-team-task-t1")).toHaveTextContent("Scaffold index.html"));
    expect(screen.getByTestId("coding-team-log-toggle")).toHaveTextContent(t("codingAgent.team.log", { n: 3 }));
    // The host's next list does not make it ask again.
    rerender(<Page team={{ ...slim, updatedAt: NOW + 1 }} />);
    expect(reads).toHaveLength(1);
  });

  it("reads a board the list lacks by id, and says it is reading meanwhile", async () => {
    whole["team-older0001"] = { ...WORKING, id: "team-older0001", status: "done" };
    render(<Page team={null} teamId="team-older0001" />);
    expect(screen.getByTestId("coding-team-loading")).toHaveTextContent(t("codingAgent.team.loading"));
    await waitFor(() => expect(screen.getByTestId("coding-team-status")).toHaveTextContent(t("codingAgent.team.status.done")));
    expect(reads).toEqual(["/setup-api/coding-agent/team?id=team-older0001"]);
    expect(screen.getByTestId("coding-agent-team-page")).toHaveAttribute("data-team-id", "team-older0001");
  });
});

describe("the models the team runs on (the owner, 2026-11-01)", () => {
  it("names the team's models in its status block and each task's worker model on its row", () => {
    const team: TeamView = { ...WORKING, runs: [
      { id: "run-00000001", role: "planner", taskId: null, model: "claude-opus-5-5" },
      { id: "run-00000002", role: "worker", taskId: "t1", model: "claude-sonnet-5" },
      { id: "run-00000004", role: "reviewer", taskId: "t1" },
      { id: "run-00000003", role: "worker", taskId: "t2", model: "claude-sonnet-5" },
    ] };
    // The run record's answer beats the cast list's.
    const runs = RUNS.map((r) => (r.id === "run-00000003" ? { ...r, model: "gpt-5.6-sol" } : r));
    render(<Page team={team} runs={runs} />);
    expect(screen.getByTestId("coding-team-model")).toHaveTextContent("Sonnet 5 · GPT 5.6 Sol +1");
    expect(screen.getByTestId("coding-team-task-model-t1")).toHaveTextContent("Sonnet 5");
    expect(screen.getByTestId("coding-team-task-model-t2")).toHaveTextContent("GPT 5.6 Sol");
    expect(screen.getByTestId("coding-team-task-model-t2")).toHaveAttribute("title", "gpt-5.6-sol");
    // No worker yet: no model.
    expect(screen.queryByTestId("coding-team-task-model-t3")).toBeNull();
  });

  it("names nothing on a board from before the models were kept", () => {
    render(<Page team={WORKING} />);
    expect(screen.queryByTestId("coding-team-model")).toBeNull();
    expect(screen.queryByTestId("coding-team-task-model-t1")).toBeNull();
  });
});
