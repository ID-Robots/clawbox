/**
 * The coding team's card on the project page (src/components/CodingTeamCard.tsx):
 * the goal form while no team works here, the board — status, tasks, workers,
 * results, verdicts, alerts — the audit log on request, Stop while a team
 * works, and the poll that follows it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingTeamCard, { type TeamView } from "@/components/CodingTeamCard";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DIR = "/home/clawbox/Projects/invoice";

const WORKING: TeamView = {
  id: "team-k3x9q2ab",
  goal: "Build the invoice app",
  projectId: null,
  directory: DIR,
  status: "working",
  plannerRunId: "run-00000001",
  tasks: [
    { task_id: "t1", task_description: "Scaffold index.html", assigned_to: "run-00000002", status: "complete", result: "Built index.html; open it.", depends_on: [], review: { verdict: "accepted", notes: "", at: 1 }, attempts: 1 },
    { task_id: "t2", task_description: "Wire app.js", assigned_to: "run-00000003", status: "in_progress", result: null, depends_on: ["t1"], review: null, attempts: 1 },
  ],
  log: [
    { ts: 1_700_000_000_000, actor: { kind: "owner" }, type: "team_created", message: "Team created" },
    { ts: 1_700_000_001_000, actor: { kind: "system" }, type: "alert", message: "ALERT: Worker run-00000002 touched files outside its task: secrets.env" },
  ],
  alerts: 1,
  error: null,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now(),
};

let posts: { url: string; body: unknown }[];
let teams: TeamView[];

function stub() {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "/setup-api/coding-agent/team" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ url, body });
      const started: TeamView = { ...WORKING, id: "team-new00001", goal: body.goal, status: "planning", tasks: [], log: [], alerts: 0, plannerRunId: null };
      teams = [started, ...teams];
      return json({ started: true, team: started }, 202);
    }
    if (url === "/setup-api/coding-agent/team/stop") {
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      teams = teams.map((x) => ({ ...x, status: "stopped" as const }));
      return json({ team: teams[0] });
    }
    if (url.startsWith("/setup-api/coding-agent/team")) return json({ teams });
    return json({ error: "unexpected" }, 404);
  }));
}

beforeEach(() => { teams = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("with no team yet", () => {
  it("draws the team's shape — three workers and a reviewer — beside the words", async () => {
    stub();
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={() => {}} onPlan={() => {}} />);
    const card = await screen.findByTestId("coding-team-card");
    const tree = within(card).getByTestId("coding-team-tree");
    expect(tree).toHaveAttribute("data-workers", "3");
    expect(tree).toHaveAttribute("data-reviewer", "true");
    expect(tree).toHaveAttribute("data-active", "0");
  });

  it("offers to plan the team in the chat, and hands over on a click", async () => {
    stub();
    const onPlan = vi.fn();
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={vi.fn()} onPlan={onPlan} />);
    await screen.findByTestId("coding-team-form");
    expect(screen.queryByTestId("coding-team-board")).toBeNull();
    // No textarea: the goal is written in the chat's Create App card, the
    // way every other task is, so the assistant carries it.
    expect(screen.queryByTestId("coding-team-goal")).toBeNull();
    expect(screen.queryByTestId("coding-team-start")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-team-plan"));
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([]);
  });

  it("shows nothing to press on a page with no chat to hand to", async () => {
    stub();
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={vi.fn()} />);
    await screen.findByTestId("coding-team-card");
    expect(screen.queryByTestId("coding-team-form")).toBeNull();
    expect(screen.queryByTestId("coding-team-plan")).toBeNull();
  });
});

describe("with a team working here", () => {
  it("sizes the tree by the board: the workers who worked, the ones at work pulsing", async () => {
    stub();
    teams = [{ ...WORKING, agents: { planner: 1, workers: 2, reviewers: 1, total: 4 } }];
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={() => {}} />);
    const tree = await screen.findByTestId("coding-team-tree");
    expect(tree).toHaveAttribute("data-workers", "2");
    expect(tree).toHaveAttribute("data-reviewer", "true");
    // t2 is in progress: one worker at work.
    expect(tree).toHaveAttribute("data-active", "1");
  });

  it("says who worked and on which branch, and links each task's reviewer beside its worker", async () => {
    teams = [{
      ...WORKING,
      branch: "clawbox/team-k3x9q2ab",
      base: "master",
      agents: { planner: 1, workers: 2, reviewers: 1, total: 4 },
      tasks: [{ ...WORKING.tasks[0], reviewRunId: "run-00000004" }, WORKING.tasks[1]],
    }];
    stub();
    const onOpenRun = vi.fn();
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={onOpenRun} onPlan={vi.fn()} />);
    const agents = await screen.findByTestId("coding-team-agents");
    expect(agents.textContent).toContain(t("codingAgent.team.agents", { total: 4, planner: 1, workers: 2, reviewers: 1 }));
    expect(agents.textContent).toContain(t("codingAgent.team.branch", { branch: "clawbox/team-k3x9q2ab", base: "master" }));
    fireEvent.click(screen.getByTestId("coding-team-reviewer-t1"));
    expect(onOpenRun).toHaveBeenCalledWith("run-00000004");
    expect(screen.queryByTestId("coding-team-reviewer-t2")).toBeNull();
  });

  it("shows the board: status, progress, alerts, each task with its worker, result and verdict; opens runs; shows the log on request; stops", async () => {
    teams = [WORKING, { ...WORKING, id: "team-older0001", status: "done", directory: DIR }, { ...WORKING, id: "team-elsewhere", directory: "/other" }];
    stub();
    const onOpenRun = vi.fn();
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={onOpenRun} onPlan={vi.fn()} />);
    const board = await screen.findByTestId("coding-team-board");
    expect(board).toHaveAttribute("data-team-id", "team-k3x9q2ab");
    expect(screen.getByTestId("coding-team-status")).toHaveTextContent(t("codingAgent.team.status.working"));
    expect(screen.getByTestId("coding-team-progress")).toHaveTextContent(t("codingAgent.team.progress", { done: 1, total: 2 }));
    expect(screen.getByTestId("coding-team-alerts")).toHaveTextContent(t("codingAgent.team.alerts", { n: 1 }));
    // One earlier team on this folder is counted; the other folder's is not.
    expect(screen.getByText(`· ${t("codingAgent.team.earlier", { n: 1 })}`)).toBeInTheDocument();
    expect(screen.queryByTestId("coding-team-form")).toBeNull();

    const t1 = screen.getByTestId("coding-team-task-t1");
    expect(t1).toHaveAttribute("data-status", "complete");
    expect(t1).toHaveTextContent("Scaffold index.html");
    expect(t1).toHaveTextContent("Built index.html; open it.");
    expect(t1).toHaveTextContent(t("codingAgent.team.review.accepted"));
    const t2 = screen.getByTestId("coding-team-task-t2");
    expect(t2).toHaveTextContent(t("codingAgent.team.after", { ids: "t1" }));
    fireEvent.click(within(t2).getByTestId("coding-team-worker-t2"));
    expect(onOpenRun).toHaveBeenCalledWith("run-00000003");
    fireEvent.click(screen.getByTestId("coding-team-planner"));
    expect(onOpenRun).toHaveBeenCalledWith("run-00000001");

    expect(screen.queryByTestId("coding-team-log")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-team-log-toggle"));
    const log = screen.getByTestId("coding-team-log");
    expect(log).toHaveTextContent("ALERT: Worker run-00000002 touched files outside its task");
    expect(log).toHaveTextContent("owner Team created");

    fireEvent.click(screen.getByTestId("coding-team-stop"));
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/team/stop", body: { id: "team-k3x9q2ab" } }]));
    expect(await screen.findByTestId("coding-team-status")).toHaveTextContent(t("codingAgent.team.status.stopped"));
    expect(await screen.findByTestId("coding-team-form")).toBeInTheDocument();
  });

  it("follows the team while it works, and stops asking once it settled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    teams = [WORKING];
    stub();
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={vi.fn()} />);
    await screen.findByTestId("coding-team-board");
    const reads = () => vi.mocked(fetch).mock.calls.filter(([u, i]) => String(u) === "/setup-api/coding-agent/team" && !i?.method).length;
    const before = reads();
    teams = [{ ...WORKING, status: "done", tasks: WORKING.tasks.map((x) => ({ ...x, status: "complete" as const })) }];
    await vi.advanceTimersByTimeAsync(5_100);
    expect(reads()).toBe(before + 1);
    expect(await screen.findByTestId("coding-team-status")).toHaveTextContent(t("codingAgent.team.status.done"));
    const settled = reads();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(reads()).toBe(settled);
  });

  it("shows why a team failed", async () => {
    teams = [{ ...WORKING, status: "failed", error: "Stopped after 3 alerts." }];
    stub();
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={vi.fn()} onPlan={vi.fn()} />);
    expect(await screen.findByTestId("coding-team-reason")).toHaveTextContent("Stopped after 3 alerts.");
    expect(screen.getByTestId("coding-team-form")).toBeInTheDocument();
  });
});
