/**
 * The coding team's card on the project page (src/components/CodingTeamCard.tsx):
 * the goal form while no team works here, the board — status, tasks, workers,
 * results, verdicts, alerts — the audit log on request, Stop while a team
 * works. The card reads no list of its own: the host hands its teams in (the
 * app's list, filtered to the card's scope) and re-reads them when Stop
 * answers; the one read the card makes is a settled board the list sent slim.
 */
import { useState, type ComponentProps } from "react";
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
/** The whole copy of a board the list sent slim, as `GET team?id=` answers it. */
let whole: Record<string, TeamView>;

/** The host: holds the card's teams the way the app does — its list on this scope — and re-reads them when the card says something changed. */
function Card(props: Omit<ComponentProps<typeof CodingTeamCard>, "teams" | "onChanged">) {
  const mine = () => teams.filter((x) => x.directory === DIR);
  const [shown, setShown] = useState(mine);
  return <CodingTeamCard {...props} teams={shown} onChanged={() => setShown(mine())} />;
}

function stub() {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/team?id=")) {
      const id = decodeURIComponent(url.slice("/setup-api/coding-agent/team?id=".length));
      const team = whole[id] ?? teams.find((x) => x.id === id);
      return team ? json({ team }) : json({ error: "There is no coding team with that id." }, 404);
    }
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
    return json({ error: "unexpected" }, 404);
  }));
}

beforeEach(() => { teams = []; whole = {}; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("with no team yet", () => {
  it("draws the team's shape — three workers and a reviewer — beside the words", async () => {
    stub();
    render(<Card onOpenRun={() => {}} onPlan={() => {}} />);
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
    render(<Card onOpenRun={vi.fn()} onPlan={onPlan} />);
    await screen.findByTestId("coding-team-form");
    expect(screen.queryByTestId("coding-team-board")).toBeNull();
    // No textarea, and no goal line with no team to have one: the goal is
    // written in the chat's Create App card, the way every other task is.
    expect(screen.queryByTestId("coding-team-goal")).toBeNull();
    expect(screen.queryByTestId("coding-team-start")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-team-plan"));
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([]);
  });

  it("shows nothing to press on a page with no chat to hand to", async () => {
    stub();
    render(<Card onOpenRun={vi.fn()} />);
    await screen.findByTestId("coding-team-card");
    expect(screen.queryByTestId("coding-team-form")).toBeNull();
    expect(screen.queryByTestId("coding-team-plan")).toBeNull();
  });
});

describe("with a team working here", () => {
  it("draws the team as a chart: one node per agent on the cast list, the one at work pulsing", async () => {
    stub();
    teams = [{
      ...WORKING,
      agents: { planner: 1, workers: 2, reviewers: 1, total: 4 },
      runs: [
        { id: "run-00000001", role: "planner", taskId: null },
        { id: "run-00000002", role: "worker", taskId: "t1" },
        { id: "run-00000004", role: "reviewer", taskId: "t1" },
        { id: "run-00000003", role: "worker", taskId: "t2" },
      ],
    }];
    render(<Card onOpenRun={() => {}} />);
    const chart = await screen.findByTestId("coding-team-diagram");
    // The chart replaced the tree: four agents stated, four nodes drawn.
    expect(screen.queryByTestId("coding-team-tree")).toBeNull();
    const nodes = within(chart).getAllByTestId("coding-agent-node");
    expect(nodes.map((n) => n.getAttribute("data-key"))).toEqual(["run-00000001", "run-00000002", "run-00000004", "run-00000003"]);
    // t1 is complete and accepted; t2 is in progress — the one node at work.
    expect(nodes.map((n) => n.getAttribute("data-state"))).toEqual(["done", "accepted", "accepted", "working"]);
    expect(chart.querySelectorAll('[data-testid="coding-agent-node"][data-active]')).toHaveLength(1);
    // The board is one click away, not gone; the chart's figures row says
    // who worked and how far along, so no line repeats it in words.
    const details = screen.getByTestId("coding-team-details");
    expect(details.tagName).toBe("DETAILS");
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByTestId("coding-team-board")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-team-agents")).toBeNull();
  });

  it("names the team branch under the fold, and links each task's reviewer beside its worker", async () => {
    teams = [{
      ...WORKING,
      branch: "clawbox/team-k3x9q2ab",
      base: "master",
      agents: { planner: 1, workers: 2, reviewers: 1, total: 4 },
      tasks: [{ ...WORKING.tasks[0], reviewRunId: "run-00000004" }, WORKING.tasks[1]],
    }];
    stub();
    const onOpenRun = vi.fn();
    render(<Card onOpenRun={onOpenRun} onPlan={vi.fn()} />);
    const branch = await screen.findByTestId("coding-team-branch");
    expect(branch).toHaveTextContent(t("codingAgent.team.branch", { branch: "clawbox/team-k3x9q2ab", base: "master" }));
    expect(within(screen.getByTestId("coding-team-details")).getByTestId("coding-team-branch")).toBe(branch);
    fireEvent.click(screen.getByTestId("coding-team-reviewer-t1"));
    expect(onOpenRun).toHaveBeenCalledWith("run-00000004");
    expect(screen.queryByTestId("coding-team-reviewer-t2")).toBeNull();
  });

  it("shows the board: status, alerts, one line of the goal, each task with its worker, result and verdict; opens runs; shows the log on request; stops", async () => {
    teams = [WORKING, { ...WORKING, id: "team-older0001", status: "done", directory: DIR }, { ...WORKING, id: "team-elsewhere", directory: "/other" }];
    stub();
    const onOpenRun = vi.fn();
    render(<Card onOpenRun={onOpenRun} onPlan={vi.fn()} />);
    const board = await screen.findByTestId("coding-team-board");
    expect(board).toHaveAttribute("data-team-id", "team-k3x9q2ab");
    expect(screen.getByTestId("coding-team-status")).toHaveTextContent(t("codingAgent.team.status.working"));
    expect(screen.getByTestId("coding-team-alerts")).toHaveTextContent(t("codingAgent.team.alerts", { n: 1 }));
    // The goal stands above the chart, one line, the whole of it on hover;
    // the task count is the chart's own figures row.
    const goal = screen.getByTestId("coding-team-goal");
    expect(goal).toHaveTextContent("Build the invoice app");
    expect(goal).toHaveAttribute("title", "Build the invoice app");
    expect(goal.compareDocumentPosition(screen.getByTestId("coding-team-diagram")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("coding-team-progress")).toBeNull();
    expect(screen.getByTestId("coding-agent-diagram-tasks")).toHaveTextContent(t("codingAgent.diagram.tasks", { done: 1, total: 2 }));
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

  it("reads no list of its own: a team at work is drawn from what the host hands in, with not one GET", async () => {
    teams = [WORKING];
    stub();
    render(<Card onOpenRun={vi.fn()} />);
    await screen.findByTestId("coding-team-board");
    expect(screen.getByTestId("coding-team-status")).toHaveTextContent(t("codingAgent.team.status.working"));
    expect(vi.mocked(fetch).mock.calls.filter(([, i]) => !i?.method)).toHaveLength(0);
  });

  it("reads a settled board the list sent slim once, whole, by id — the log and the tasks' text come from that copy", async () => {
    const done: TeamView = { ...WORKING, status: "done", slim: true, log: [], tasks: WORKING.tasks.map((x) => ({ ...x, result: null, review: x.review && { ...x.review, notes: "" } })) };
    teams = [done];
    whole = { [done.id]: { ...WORKING, status: "done" } };
    stub();
    render(<Card onOpenRun={vi.fn()} />);
    expect(await screen.findByTestId("coding-team-status")).toHaveTextContent(t("codingAgent.team.status.done"));
    const reads = () => vi.mocked(fetch).mock.calls.filter(([, i]) => !i?.method).map(([u]) => String(u));
    await waitFor(() => expect(reads()).toEqual([`/setup-api/coding-agent/team?id=${done.id}`]));
    expect(await screen.findByText("Built index.html; open it.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("coding-team-log-toggle"));
    expect(screen.getByTestId("coding-team-log")).toHaveTextContent("owner Team created");
    expect(reads()).toHaveLength(1);
  });

  it("shows why a team failed", async () => {
    teams = [{ ...WORKING, status: "failed", error: "Stopped after 3 alerts." }];
    stub();
    render(<Card onOpenRun={vi.fn()} onPlan={vi.fn()} />);
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
    render(<Card onOpenRun={() => {}} />);
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
    render(<Card onOpenRun={() => {}} />);
    fireEvent.click(await screen.findByTestId("coding-team-log-toggle"));
    const log = screen.getByTestId("coding-team-log");
    expect(log).toHaveTextContent("Team created");
    expect(log).toHaveTextContent("t2 needs index.html's form ids first.");
    expect(log).not.toHaveTextContent("worker run-00000003 → the lead: t2 needs …");
  });

  it("puts what was said to the lead in its own inbox, above the messages: who, which task, the words whole", async () => {
    stub();
    teams = [{ ...WORKING, log: [...WORKING.log, { ...MESSAGES[0], task_id: "t2" }, MESSAGES[1], MESSAGES[2]] }];
    render(<Card onOpenRun={() => {}} />);
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
    render(<Card onOpenRun={() => {}} />);
    const inbox = await screen.findByTestId("coding-team-inbox");
    expect(inbox).toHaveTextContent(t("codingAgent.team.inboxTitle", { n: 7 }));
    const rows = within(inbox).getAllByTestId("coding-team-inbox-message");
    expect(rows.map((r) => r.textContent)).toEqual([3, 4, 5, 6, 7].map((n) => `worker run-00000003 · ask ${n}`));
  });

  it("has no inbox while nothing was said to the lead", async () => {
    stub();
    teams = [{ ...WORKING, log: [...WORKING.log, MESSAGES[1], MESSAGES[2]] }];
    render(<Card onOpenRun={() => {}} />);
    expect(await screen.findByTestId("coding-team-messages")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-team-inbox")).toBeNull();
  });

  it("has no messages section while nobody has said anything, and ignores a message entry it cannot read", async () => {
    stub();
    teams = [{ ...WORKING, log: [...WORKING.log, { ts: 1, actor: { kind: "worker", id: "run-00000003" }, type: "message", message: "worker run-00000003 → the lead: hi" }] }];
    render(<Card onOpenRun={() => {}} />);
    await screen.findByTestId("coding-team-board");
    expect(screen.queryByTestId("coding-team-messages")).toBeNull();
    expect(screen.queryByTestId("coding-team-inbox")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-team-log-toggle"));
    expect(screen.getByTestId("coding-team-log")).toHaveTextContent("worker run-00000003 → the lead: hi");
  });

  it("words a late answer to a sibling that had finished in the reader's language — a quiet note, not an alert, not a message", async () => {
    stub();
    const english = "Refused message from worker run-00000003: SETTLED: run-00000002 has finished; there is nothing left to tell it.";
    const unreached = { ts: 1_700_000_020_000, actor: { kind: "system" }, type: "note", message: english, payload: { undelivered: { code: "SETTLED", from: "run-00000003", role: "worker", to: "sibling", toRunId: "run-00000002" } } };
    // …and one whose payload does not read back: drawn as its line, like any other note.
    const unreadable = { ...unreached, ts: 1_700_000_021_000, message: "a note with a broken payload", payload: { undelivered: { code: "SETTLED", from: "<b>x</b>", role: "worker", to: "sibling", toRunId: "run-00000002" } } };
    teams = [{ ...WORKING, log: [...WORKING.log, unreached, unreadable] }];
    render(<Card onOpenRun={() => {}} />);
    await screen.findByTestId("coding-team-board");
    // Not one of the team's messages: nothing was said to anybody.
    expect(screen.queryByTestId("coding-team-messages")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-team-log-toggle"));
    const rows = screen.getAllByTestId("coding-team-log-unreached");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(`worker run-00000003 ${t("codingAgent.team.messageToRun", { run: "run-00000002" })} · ${t("codingAgent.team.messageUndelivered")}: ${t("codingAgent.team.messageReceiverFinished", { run: "run-00000002" })}`);
    expect(rows[0]).not.toHaveTextContent("Refused message");
    expect(rows[0].className).not.toContain("text-amber-400");
    const log = screen.getByTestId("coding-team-log");
    expect(log).toHaveTextContent("a note with a broken payload");
    expect(log).not.toHaveTextContent(english);
  });
});

describe("a team with a lead, a retired task and a final review (TASK-1099)", () => {
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
    runs: [
      { id: "run-00000001", role: "planner", taskId: null },
      { id: "run-00000002", role: "worker", taskId: "t1" },
      { id: "run-00000005", role: "worker", taskId: "t2" },
      { id: "run-00000007", role: "lead", taskId: "t1" },
      { id: "run-00000003", role: "worker", taskId: "t2" },
      { id: "run-00000008", role: "lead", taskId: "t2" },
      { id: "run-00000009", role: "worker", taskId: "t4" },
      { id: "run-00000006", role: "reviewer", taskId: null },
    ],
    tasks: [
      { ...WORKING.tasks[0] },
      { ...WORKING.tasks[1], status: "complete", review: { verdict: "accepted", notes: "", at: 2 }, attempts: 2 },
      { task_id: "t3", task_description: "Write the README", assigned_to: null, status: "retired", result: null, depends_on: ["t1"], review: null, attempts: 0, origin: "plan" },
      { task_id: "t4", task_description: "Add a favicon", assigned_to: "run-00000009", status: "complete", result: "Added favicon.ico.", depends_on: ["t1"], review: { verdict: "accepted", notes: "", at: 3 }, attempts: 1, origin: "lead" },
    ],
  };

  it("shows a retired task, the lead's own task and the final review, and no line of figures beside the chart", async () => {
    teams = [SHAPED];
    stub();
    render(<Card onOpenRun={vi.fn()} onPlan={vi.fn()} />);
    await screen.findByTestId("coding-team-board");
    // The shape, the figures and the roll-call were the chart said again in
    // words; the chart is the one place they are drawn now.
    expect(screen.queryByTestId("coding-team-shape")).toBeNull();
    expect(screen.queryByTestId("coding-team-metrics")).toBeNull();
    expect(screen.queryByTestId("coding-team-agents")).toBeNull();
    const retired = screen.getByTestId("coding-team-task-t3");
    expect(retired).toHaveAttribute("data-status", "retired");
    expect(retired).toHaveTextContent(t("codingAgent.team.task.retired"));
    expect(screen.getByTestId("coding-team-added-t4")).toHaveTextContent(t("codingAgent.team.addedByLead"));
    expect(screen.queryByTestId("coding-team-added-t1")).toBeNull();
    const final = screen.getByTestId("coding-team-final-review");
    expect(final).toHaveAttribute("data-verdict", "accepted");
    expect(final).toHaveTextContent(`${t("codingAgent.team.finalReview")}: ${t("codingAgent.team.review.accepted")}`);
    // The chart draws the lead's turns beside the planner, t2's rejected
    // first attempt before its accepted second, the retired task as done, and
    // the one review of the merged result in a lane of its own.
    const chart = screen.getByTestId("coding-team-diagram");
    const node = (key: string) => chart.querySelector(`[data-testid="coding-agent-node"][data-key="${key}"]`);
    expect(chart.querySelectorAll('[data-testid="coding-agent-node"][data-role="lead"]')).toHaveLength(2);
    expect(node("run-00000005")).toHaveAttribute("data-state", "rejected");
    expect(node("run-00000003")).toHaveAttribute("data-attempt", "2");
    expect(node("run-00000003")).toHaveAttribute("data-state", "accepted");
    expect(node("task:t3")).toHaveAttribute("data-state", "done");
    expect(node("run-00000006")).toHaveAttribute("data-state", "accepted");
  });

  it("draws the planner alone while it plans, and no final review yet", async () => {
    teams = [{ ...WORKING, status: "planning", tasks: [], metrics: { ...METRICS, workerRuns: 0, leadRuns: 0 } }];
    stub();
    render(<Card onOpenRun={vi.fn()} />);
    await screen.findByTestId("coding-team-board");
    expect(screen.queryByTestId("coding-team-final-review")).toBeNull();
    // The planner is the one agent yet, and it is at work; no lead has had a turn.
    const chart = screen.getByTestId("coding-team-diagram");
    const nodes = within(chart).getAllByTestId("coding-agent-node");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toHaveAttribute("data-role", "planner");
    expect(nodes[0]).toHaveAttribute("data-state", "working");
  });

  it("shows a rejected final review with its notes", async () => {
    teams = [{ ...SHAPED, status: "failed", error: "The final review rejected the merged work: app.js never loads.", finalReview: { verdict: "rejected", notes: "app.js never loads.", at: 5 } }];
    stub();
    render(<Card onOpenRun={vi.fn()} />);
    const final = await screen.findByTestId("coding-team-final-review");
    expect(final).toHaveAttribute("data-verdict", "rejected");
    expect(final).toHaveTextContent("app.js never loads.");
  });
});

describe("dependency gating and holds on the board", () => {
  it("says what a pending task waits for, and why a held one went back", async () => {
    teams = [{
      ...WORKING,
      tasks: [
        { task_id: "t1", task_description: "Scaffold index.html", assigned_to: "run-00000002", status: "complete", result: "Built it.", depends_on: [], review: null, attempts: 1 },
        { task_id: "t2", task_description: "Wire app.js", assigned_to: null, status: "pending", result: null, depends_on: ["t1"], review: null, attempts: 1, hold: { dependency: "t1", reason: "rejected — the form does not submit", was: "complete", at: 1 } },
        { task_id: "t3", task_description: "Docs", assigned_to: null, status: "pending", result: null, depends_on: [], review: null, attempts: 0 },
      ],
    }];
    stub();
    render(<Card onOpenRun={() => {}} />);
    // t1 is finished but not reviewed yet: t2 waits for it to be ACCEPTED.
    expect(await screen.findByTestId("coding-team-waiting-t2")).toHaveTextContent("Waiting for t1 to be accepted");
    expect(screen.getByTestId("coding-team-held-t2")).toHaveTextContent("Held — t1 was reopened");
    expect(within(screen.getByTestId("coding-team-task-t2")).getByText("rejected — the form does not submit")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-team-waiting-t3")).toBeNull();
  });
});

describe("a team waiting in the queue", () => {
  it("shows the team at work first, the queued one behind it with its place, and cancels it for the owner", async () => {
    const queued: TeamView = { ...WORKING, id: "team-queued01", goal: "Then build the reports", status: "queued", queuePosition: 1, tasks: [], log: [], alerts: 0, plannerRunId: null, createdAt: Date.now() };
    teams = [queued, WORKING];
    stub();
    render(<Card onOpenRun={() => {}} />);
    expect(await screen.findByTestId("coding-team-status")).toHaveTextContent("Working");
    const row = await screen.findByTestId("coding-team-queued-team-queued01");
    expect(row).toHaveTextContent("Queued");
    expect(row).toHaveTextContent("#1 in line");
    expect(row).toHaveTextContent("Then build the reports");
    fireEvent.click(screen.getByTestId("coding-team-cancel-team-queued01"));
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/team/stop", body: { id: "team-queued01" } }));
  });

  it("shows a queued team on its own with its place and a Cancel, not a Stop", async () => {
    teams = [{ ...WORKING, status: "queued", queuePosition: 2, tasks: [], log: [], alerts: 0, plannerRunId: null }];
    stub();
    render(<Card onOpenRun={() => {}} />);
    expect(await screen.findByTestId("coding-team-status")).toHaveTextContent("Queued");
    expect(screen.getByTestId("coding-team-queue-position")).toHaveTextContent("#2 in line");
    expect(screen.queryByTestId("coding-team-stop")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-team-cancel"));
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/team/stop", body: { id: WORKING.id } }));
  });
});

describe("the team's pull request", () => {
  it("shows the pull request the goal asked for: its phase, checks, CI rounds and what fails", async () => {
    teams = [{
      ...WORKING,
      status: "working",
      pr: { number: 41, url: "https://github.com/o/r/pull/41", branch: "clawbox/team-k3x9q2ab", base: "main", phase: "failed_checks", checks: { total: 2, passed: 1, failed: 1, pending: 0 }, merge: true, ciRounds: 1, failure: { tests: ["app.test.js > submits"], checks: ["test"] }, detail: null },
    }];
    stub();
    render(<Card onOpenRun={() => {}} />);
    const pr = await screen.findByTestId("coding-team-pr");
    expect(pr).toHaveAttribute("data-phase", "failed_checks");
    expect(pr).toHaveTextContent("Team pull request #41");
    expect(pr).toHaveTextContent("CI failed");
    expect(pr).toHaveTextContent("1 of 2 checks passed");
    expect(screen.getByTestId("coding-team-ci-rounds")).toHaveTextContent("CI fix rounds: 1 of 2");
    expect(pr).toHaveTextContent("merges when every check passes");
    expect(screen.getByTestId("coding-team-ci-failing")).toHaveTextContent("Failing: app.test.js > submits");
  });
});

describe("whether a single run was cheaper", () => {
  const METRICS = { plannerRuns: 1, workerRuns: 2, reviewerRuns: 2, leadRuns: 0, tasksPlanned: 2, tasksAdded: 0, tasksRetired: 0, tasksAcceptedFirstTry: 2, tasksRejected: 0, tokensUsed: 163_000, tokensByRole: { planner: 12_000, worker: 140_000, reviewer: 11_000, lead: 0 }, wallMs: 60_000 };

  it("shows the overlap advice under the fold, and neither the tokens by role nor the repo map", async () => {
    teams = [{
      ...WORKING,
      status: "done",
      alerts: 0,
      metrics: METRICS,
      advice: { reason: "overlap", overlap: 83 },
      repoMap: { files: ["index.html — the page", "app.js"], entryPoints: ["index.html"], testCommands: ["npm test"], gotchas: [] },
      tasks: WORKING.tasks.map((x) => ({ ...x, status: "complete" as const, review: { verdict: "accepted" as const, notes: "", at: 1 } })),
    }];
    stub();
    render(<Card onOpenRun={vi.fn()} />);
    const advice = await screen.findByTestId("coding-team-advice");
    expect(advice).toHaveAttribute("data-reason", "overlap");
    expect(advice).toHaveTextContent(t("codingAgent.team.adviceOverlap", { n: 83 }));
    // Advice is for the next team, not this one's progress: it sits under
    // the fold with the board rather than beside the chart.
    expect(within(screen.getByTestId("coding-team-details")).getByTestId("coding-team-advice")).toBe(advice);
    // The per-role tokens are the chart's, and the repo map is the planner's
    // working note — neither is drawn on the card any more.
    expect(screen.queryByTestId("coding-team-role-tokens")).toBeNull();
    expect(screen.queryByTestId("coding-team-repo-map")).toBeNull();
  });

  it("says a one-task plan — or an overlapping one — ran as one run, and says nothing for a plan that split well or a server that predates it", async () => {
    teams = [{ ...WORKING, status: "done", singleRun: true, advice: { reason: "one_task", overlap: 100 }, tasks: [{ ...WORKING.tasks[0] }] }];
    stub();
    const { unmount } = render(<Card onOpenRun={vi.fn()} />);
    const advice = await screen.findByTestId("coding-team-advice");
    expect(advice).toHaveAttribute("data-reason", "single_run");
    expect(advice).toHaveTextContent(t("codingAgent.team.adviceSingleRun"));
    unmount();

    // A plan whose tasks mostly touch the same files ran as one run too: said with its share, never as "one task".
    teams = [{ ...WORKING, status: "done", singleRun: true, advice: { reason: "overlap", overlap: 96 } }];
    stub();
    const overlap = render(<Card onOpenRun={vi.fn()} />);
    const ran = await screen.findByTestId("coding-team-advice");
    expect(ran).toHaveAttribute("data-reason", "single_run");
    expect(ran).toHaveTextContent(t("codingAgent.team.adviceOverlapRun", { n: 96 }));
    overlap.unmount();

    teams = [{ ...WORKING, advice: null, metrics: { ...METRICS, tokensByRole: undefined } }];
    stub();
    render(<Card onOpenRun={vi.fn()} />);
    await screen.findByTestId("coding-team-board");
    expect(screen.queryByTestId("coding-team-advice")).toBeNull();
  });
});

/**
 * A team's roles may run on different accounts — the planner on Anthropic, a
 * bulk task on the plan's flash tier — so the chart's figures split its tokens
 * by account beside the split by role.
 */
describe("tokens by account", () => {
  const RUNS = [
    { id: "run-00000001", role: "planner" as const, taskId: null, tokens: 12_000, provider: "anthropic" as const, model: "claude-fable-5-1", modelRole: "planner" as const },
    { id: "run-00000002", role: "worker" as const, taskId: "t1", tokens: 140_000, provider: "anthropic" as const, model: "claude-opus-5-5", modelRole: "worker" as const },
    { id: "run-00000003", role: "worker" as const, taskId: "t2", tokens: 11_000, provider: "clawbox-ai" as const, model: "deepseek-v4-flash", modelRole: "bulk" as const },
  ];
  const split = (s: string) => t("codingAgent.team.tokensByProvider", { split: s });

  it("adds up each account's runs, largest first, right beside the tokens by role", async () => {
    stub();
    teams = [{ ...WORKING, runs: RUNS }];
    render(<Card onOpenRun={() => {}} />);
    const chip = await screen.findByTestId("coding-agent-diagram-provider-tokens");
    expect(chip).toHaveTextContent(split("Anthropic 152k · ClawBox AI 11k"));
    // Beside, not elsewhere: the same row of figures as the split by role.
    expect(chip.parentElement).toBe(screen.getByTestId("coding-agent-diagram-tokens").parentElement);
  });

  it("reads the server's own tally where the cast list does not say which account a run was on", async () => {
    stub();
    teams = [{
      ...WORKING,
      runs: RUNS.map(({ id, role, taskId, tokens }) => ({ id, role, taskId, tokens })),
      metrics: { plannerRuns: 1, workerRuns: 2, reviewerRuns: 0, leadRuns: 0, tasksPlanned: 2, tasksAdded: 0, tasksRetired: 0, tasksAcceptedFirstTry: 1, tasksRejected: 0, tokensUsed: 163_000, tokensByProvider: { "clawbox-ai": 163_000 }, wallMs: 60_000 },
    }];
    render(<Card onOpenRun={() => {}} />);
    expect(await screen.findByTestId("coding-agent-diagram-provider-tokens")).toHaveTextContent(split("ClawBox AI 163k"));
  });

  it("draws no split for a team from before the field", async () => {
    stub();
    teams = [{ ...WORKING, runs: RUNS.map(({ id, role, taskId, tokens }) => ({ id, role, taskId, tokens })) }];
    render(<Card onOpenRun={() => {}} />);
    await screen.findByTestId("coding-agent-diagram-tokens");
    expect(screen.queryByTestId("coding-agent-diagram-provider-tokens")).toBeNull();
  });
});
