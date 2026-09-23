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
    expect(tree).toHaveAttribute("data-reviewers", "1");
    expect(tree).toHaveAttribute("data-active", "0");
    // The sentence stands beneath the tree, not beside it.
    const wrap = tree.parentElement!;
    expect(wrap.className).toContain("flex-col");
    expect(wrap.lastElementChild?.textContent).toBe(t("codingAgent.team.help"));
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
    teams = [{ ...WORKING, agents: { planner: 1, workers: 5, reviewers: 3, total: 9 } }];
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={() => {}} />);
    const tree = await screen.findByTestId("coding-team-tree");
    // Nine agents stated, nine drawn: the planner, five workers, three reviewers.
    expect(tree).toHaveAttribute("data-workers", "5");
    expect(tree).toHaveAttribute("data-reviewers", "3");
    expect(within(tree).getAllByTestId("coding-team-tree-worker")).toHaveLength(5);
    expect(within(tree).getAllByTestId("coding-team-tree-reviewer")).toHaveLength(3);
    // t2 is in progress: one worker at work; t1 is complete and reviewed: no reviewer deciding.
    expect(tree).toHaveAttribute("data-active", "1");
    expect(tree).toHaveAttribute("data-active-reviewers", "0");
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

describe("what the team's runs said", () => {
  const MESSAGES: TeamView["log"] = [
    { ts: 1_700_000_002_000, actor: { kind: "worker", id: "run-00000003" }, type: "message", message: "worker run-00000003 → the lead: t2 needs …", payload: { from: "run-00000003", to: "lead", text: "t2 needs index.html's form ids first.\nWhich ones are final?" } },
    { ts: 1_700_000_003_000, actor: { kind: "worker", id: "run-00000003" }, type: "message", message: "worker run-00000003 → run-00000002: hi", payload: { from: "run-00000003", to: "sibling", toRunId: "run-00000002", text: "Are the form ids final?" } },
    { ts: 1_700_000_004_000, actor: { kind: "planner" }, type: "message", message: "planner run-00000001 → the assistant (not delivered: NO_SESSION): Stripe?", payload: { from: "run-00000001", to: "owner_agent", text: "Stripe or PayPal?", delivered: false, code: "NO_SESSION" } },
  ];

  it("shows the messages on the board itself, whole, with whom each went to and whether it arrived", async () => {
    stub();
    teams = [{ ...WORKING, log: [...WORKING.log, ...MESSAGES] }];
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={() => {}} />);
    const list = await screen.findByTestId("coding-team-messages");
    expect(list).toHaveTextContent(t("codingAgent.team.messagesTitle", { n: 3 }));
    const rows = within(list).getAllByTestId("coding-team-message");
    expect(rows.map((r) => r.getAttribute("data-to"))).toEqual(["lead", "sibling", "owner_agent"]);
    expect(rows[0]).toHaveTextContent("worker run-00000003");
    expect(rows[0]).toHaveTextContent(t("codingAgent.team.messageToLead"));
    // The words in full, not the log line's first line.
    expect(rows[0].textContent).toContain("t2 needs index.html's form ids first.\nWhich ones are final?");
    expect(rows[1]).toHaveTextContent(t("codingAgent.team.messageToRun", { run: "run-00000002" }));
    expect(rows[2]).toHaveTextContent(`planner run-00000001 ${t("codingAgent.team.messageToAssistant")}`);
    expect(rows[2]).toHaveAttribute("data-delivered", "false");
    expect(rows[2]).toHaveTextContent(t("codingAgent.team.messageUndelivered"));
    expect(rows[0]).toHaveAttribute("data-delivered", "true");
    expect(within(rows[0]).queryByText(t("codingAgent.team.messageUndelivered"), { exact: false })).toBeNull();
  });

  it("draws a message the same way in the log, and every other entry as before", async () => {
    stub();
    teams = [{ ...WORKING, log: [...WORKING.log, MESSAGES[0]] }];
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={() => {}} />);
    fireEvent.click(await screen.findByTestId("coding-team-log-toggle"));
    const log = screen.getByTestId("coding-team-log");
    expect(log).toHaveTextContent("Team created");
    expect(log).toHaveTextContent("t2 needs index.html's form ids first.");
    expect(log).not.toHaveTextContent("worker run-00000003 → the lead: t2 needs …");
  });

  it("puts what was said to the lead in its own inbox, above the messages: who, which task, the words whole", async () => {
    stub();
    teams = [{ ...WORKING, log: [...WORKING.log, { ...MESSAGES[0], task_id: "t2" }, MESSAGES[1], MESSAGES[2]] }];
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={() => {}} />);
    const inbox = await screen.findByTestId("coding-team-inbox");
    expect(inbox).toHaveTextContent(t("codingAgent.team.inboxTitle", { n: 1 }));
    const rows = within(inbox).getAllByTestId("coding-team-inbox-message");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe("worker run-00000003 · t2 · t2 needs index.html's form ids first.\nWhich ones are final?");
    // Above the newest messages, which still list every one of them.
    const list = screen.getByTestId("coding-team-messages");
    expect(inbox.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(list).getAllByTestId("coding-team-message")).toHaveLength(3);
  });

  it("shows the newest five messages to the lead, and counts them all", async () => {
    stub();
    const asks = Array.from({ length: 7 }, (_, i) => ({ ...MESSAGES[0], ts: 1_700_000_010_000 + i, payload: { from: "run-00000003", to: "lead", text: `ask ${i + 1}` } }));
    teams = [{ ...WORKING, log: [...WORKING.log, ...asks] }];
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={() => {}} />);
    const inbox = await screen.findByTestId("coding-team-inbox");
    expect(inbox).toHaveTextContent(t("codingAgent.team.inboxTitle", { n: 7 }));
    const rows = within(inbox).getAllByTestId("coding-team-inbox-message");
    expect(rows.map((r) => r.textContent)).toEqual([3, 4, 5, 6, 7].map((n) => `worker run-00000003 · ask ${n}`));
  });

  it("has no inbox while nothing was said to the lead", async () => {
    stub();
    teams = [{ ...WORKING, log: [...WORKING.log, MESSAGES[1], MESSAGES[2]] }];
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={() => {}} />);
    expect(await screen.findByTestId("coding-team-messages")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-team-inbox")).toBeNull();
  });

  it("has no messages section while nobody has said anything, and ignores a message entry it cannot read", async () => {
    stub();
    teams = [{ ...WORKING, log: [...WORKING.log, { ts: 1, actor: { kind: "worker", id: "run-00000003" }, type: "message", message: "worker run-00000003 → the lead: hi" }] }];
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={() => {}} />);
    await screen.findByTestId("coding-team-board");
    expect(screen.queryByTestId("coding-team-messages")).toBeNull();
    expect(screen.queryByTestId("coding-team-inbox")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-team-log-toggle"));
    expect(screen.getByTestId("coding-team-log")).toHaveTextContent("worker run-00000003 → the lead: hi");
  });
});

describe("the team's shape, its lead and its figures (TASK-1099)", () => {
  const METRICS = { plannerRuns: 1, workerRuns: 2, reviewerRuns: 1, leadRuns: 2, tasksPlanned: 3, tasksAdded: 1, tasksRetired: 1, tasksAcceptedFirstTry: 2, tasksRejected: 1, tokensUsed: 184_300, wallMs: 754_000 };
  const SHAPED: TeamView = {
    ...WORKING,
    status: "done",
    alerts: 0,
    agents: { planner: 1, workers: 2, reviewers: 1, leads: 2, total: 6 },
    shape: { parallelism: 2, review: "final", rationale: "Two independent files, one look at the whole." },
    dynamic: true,
    finalReview: { verdict: "accepted", notes: "", at: 5 },
    metrics: METRICS,
    tasks: [
      { ...WORKING.tasks[0] },
      { ...WORKING.tasks[1], status: "complete", review: { verdict: "accepted", notes: "", at: 2 }, attempts: 2 },
      { task_id: "t3", task_description: "Write the README", assigned_to: null, status: "retired", result: null, depends_on: ["t1"], review: null, attempts: 0, origin: "plan" },
      { task_id: "t4", task_description: "Add a favicon", assigned_to: "run-00000009", status: "complete", result: "Added favicon.ico.", depends_on: ["t1"], review: { verdict: "accepted", notes: "", at: 3 }, attempts: 1, origin: "lead" },
    ],
  };

  it("shows the shape with its reason, the lead's switch, the figures, a retired task, the lead's own task and the final review", async () => {
    teams = [SHAPED];
    stub();
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={vi.fn()} onPlan={vi.fn()} />);
    await screen.findByTestId("coding-team-board");
    // The retired task is not in the count: a finished team reads finished.
    expect(screen.getByTestId("coding-team-progress")).toHaveTextContent(t("codingAgent.team.progress", { done: 3, total: 3 }));
    const shape = screen.getByTestId("coding-team-shape");
    expect(shape).toHaveTextContent(`${t("codingAgent.team.shape", { n: 2 })} · ${t("codingAgent.team.reviewMode.final")}`);
    expect(shape).toHaveTextContent("Two independent files, one look at the whole.");
    expect(within(shape).getByTestId("coding-team-dynamic")).toHaveTextContent(t("codingAgent.team.leadOn"));
    const metrics = screen.getByTestId("coding-team-metrics");
    expect(within(metrics).getByTestId("coding-team-metric-tokens")).toHaveTextContent(t("codingAgent.team.metricTokens", { n: "184k" }));
    expect(metrics).toHaveTextContent(t("codingAgent.team.metricTime", { time: "12 min 34 s" }));
    // Of the tasks that count: planned + added − retired.
    expect(within(metrics).getByTestId("coding-team-metric-first-try")).toHaveTextContent(t("codingAgent.team.metricFirstTry", { n: 2, total: 3 }));
    expect(metrics).toHaveTextContent(t("codingAgent.team.metricRejected", { n: 1 }));
    expect(metrics).toHaveTextContent(t("codingAgent.team.metricAdded", { n: 1 }));
    expect(metrics).toHaveTextContent(t("codingAgent.team.metricRetired", { n: 1 }));
    expect(screen.getByTestId("coding-team-agents")).toHaveTextContent(t("codingAgent.team.agentsWithLead", { total: 6, planner: 1, workers: 2, reviewers: 1, leads: 2 }));
    const retired = screen.getByTestId("coding-team-task-t3");
    expect(retired).toHaveAttribute("data-status", "retired");
    expect(retired).toHaveTextContent(t("codingAgent.team.task.retired"));
    expect(screen.getByTestId("coding-team-added-t4")).toHaveTextContent(t("codingAgent.team.addedByLead"));
    expect(screen.queryByTestId("coding-team-added-t1")).toBeNull();
    const final = screen.getByTestId("coding-team-final-review");
    expect(final).toHaveAttribute("data-verdict", "accepted");
    expect(final).toHaveTextContent(`${t("codingAgent.team.finalReview")}: ${t("codingAgent.team.review.accepted")}`);
    // The tree draws the lead's turns under the planner.
    expect(screen.getByTestId("coding-team-tree")).toHaveAttribute("data-leads", "2");
  });

  it("says nothing of a shape for a default team, and waits for a worker before the figures while it plans", async () => {
    teams = [{ ...WORKING, status: "planning", tasks: [], metrics: { ...METRICS, workerRuns: 0, leadRuns: 0 } }];
    stub();
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={vi.fn()} />);
    await screen.findByTestId("coding-team-board");
    expect(screen.queryByTestId("coding-team-shape")).toBeNull();
    expect(screen.queryByTestId("coding-team-metrics")).toBeNull();
    expect(screen.queryByTestId("coding-team-final-review")).toBeNull();
    expect(screen.getByTestId("coding-team-tree")).toHaveAttribute("data-leads", "0");
  });

  it("shows a rejected final review with its notes", async () => {
    teams = [{ ...SHAPED, status: "failed", error: "The final review rejected the merged work: app.js never loads.", finalReview: { verdict: "rejected", notes: "app.js never loads.", at: 5 } }];
    stub();
    render(<CodingTeamCard directory={DIR} projectId={null} onOpenRun={vi.fn()} />);
    const final = await screen.findByTestId("coding-team-final-review");
    expect(final).toHaveAttribute("data-verdict", "rejected");
    expect(final).toHaveTextContent("app.js never loads.");
  });
});
