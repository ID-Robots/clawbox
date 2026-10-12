/**
 * The agent chart (src/components/CodingAgentDiagram.tsx) and the home's
 * live charts (CodingAgentLiveAgents.tsx): nodes from a board and from a run,
 * each a button with its full name; the arrow keys between them; a click,
 * Enter or Space opening what the agent does NOW — for a worker, a reviewer,
 * the planner, a helper and a task nobody has taken — and the open panel
 * following the host's next read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentDiagram, { DiagramDetails, SHEET_BELOW, resetDiagramOwnerCache, type DiagramRun } from "@/components/CodingAgentDiagram";
import CodingAgentLiveAgents, { RunAgentsDiagram } from "@/components/CodingAgentLiveAgents";
import type { TeamView } from "@/components/CodingTeamCard";

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

const TEAM: TeamView = {
  id: "team-chart001",
  goal: "Build the invoice app\nwith a PDF export",
  projectId: null,
  directory: "/home/clawbox/Projects/invoice",
  status: "working",
  plannerRunId: "run-plan0001",
  runs: [
    { id: "run-plan0001", role: "planner", taskId: null, tokens: 8_000 },
    { id: "run-work0001", role: "worker", taskId: "t1", tokens: 50_000 },
    { id: "run-revw0001", role: "reviewer", taskId: "t1", tokens: 6_000 },
    { id: "run-work0002", role: "worker", taskId: "t2" },
  ],
  tasks: [
    { task_id: "t1", task_description: "Scaffold index.html", assigned_to: "run-work0001", status: "complete", result: "Built index.html; open it.", depends_on: [], review: { verdict: "rejected", notes: "The header overlaps the table.", at: 1 }, reviewRunId: "run-revw0001", attempts: 1 },
    { task_id: "t2", task_description: "Wire app.js to the form", assigned_to: "run-work0002", status: "in_progress", result: null, depends_on: ["t1"], review: null, attempts: 1 },
    { task_id: "t3", task_description: "Export to PDF", assigned_to: null, status: "pending", result: null, depends_on: ["t2"], review: null, attempts: 0 },
  ],
  log: [],
  alerts: 0,
  error: null,
  createdAt: NOW - 600_000,
  updatedAt: NOW,
  metrics: { plannerRuns: 1, workerRuns: 2, reviewerRuns: 1, leadRuns: 0, tasksPlanned: 3, tasksAdded: 0, tasksRetired: 0, tasksAcceptedFirstTry: 0, tasksRejected: 1, tokensUsed: 64_000, wallMs: 600_000 },
};

const run = (id: string, over: Partial<DiagramRun> = {}): DiagramRun => ({
  id,
  task: `Task of ${id}`,
  status: "completed",
  startedAt: NOW - 300_000,
  completedAt: NOW - 100_000,
  numTurns: 12,
  tokensUsed: 21_000,
  filesTouched: [],
  progress: [],
  progressAt: [],
  summary: null,
  error: null,
  ...over,
});

const RUNS: Record<string, DiagramRun> = {
  "run-plan0001": run("run-plan0001"),
  "run-work0001": run("run-work0001", { filesTouched: ["index.html", "style.css"] }),
  "run-revw0001": run("run-revw0001"),
  "run-work0002": run("run-work0002", {
    status: "running",
    completedAt: null,
    numTurns: 7,
    tokensUsed: 33_000,
    filesTouched: Array.from({ length: 8 }, (_, i) => `src/file${i}.ts`),
    progress: Array.from({ length: 14 }, (_, i) => `$ step ${i}`),
    progressAt: Array.from({ length: 14 }, (_, i) => NOW - 200_000 + i * 1_000),
  }),
};

let fetches: { url: string; body?: unknown }[];
let isOwner: boolean | null;

beforeEach(() => {
  fetches = [];
  isOwner = true;
  resetDiagramOwnerCache();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    fetches.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/setup-api/users/me") return isOwner === null ? json({}, 404) : json({ username: "clawbox", isOwner });
    if (url === "/setup-api/coding-agent/stop") return json({ run: {} });
    if (url.startsWith("/setup-api/coding-agent/runs?id=")) {
      const id = decodeURIComponent(url.split("id=")[1]);
      return json({ run: run(id, { task: "Fetched by id", progress: ["$ fetched step"] }) });
    }
    if (url.startsWith("/setup-api/coding-agent/team?id=")) return json({ team: TEAM });
    return json({ error: "unexpected" }, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const node = (key: string) => document.querySelector(`[data-testid="coding-agent-node"][data-key="${key}"]`) as HTMLButtonElement;

function renderTeam(props: Partial<Parameters<typeof CodingAgentDiagram>[0]> = {}) {
  const onOpenRun = vi.fn();
  const onChanged = vi.fn();
  const utils = render(
    <CodingAgentDiagram source={{ kind: "team", team: TEAM }} runOf={(id) => RUNS[id]} onOpenRun={onOpenRun} onChanged={onChanged} {...props} />,
  );
  return { ...utils, onOpenRun, onChanged };
}

describe("the chart of a team", () => {
  it("draws one node per agent on the cast list and a placeholder for the task nobody has taken", () => {
    renderTeam();
    const nodes = screen.getAllByTestId("coding-agent-node");
    expect(nodes.map((n) => [n.getAttribute("data-key"), n.getAttribute("data-role"), n.getAttribute("data-state")])).toEqual([
      ["run-plan0001", "planner", "done"],
      ["run-work0001", "worker", "rejected"],
      ["run-revw0001", "reviewer", "rejected"],
      ["run-work0002", "worker", "working"],
      ["task:t3", "worker", "queued"],
    ]);
    expect(node("task:t3")).toHaveAttribute("data-placeholder", "true");
  });

  it("is a labelled group of buttons, never hidden from assistive tech, each named in full with its state", () => {
    renderTeam();
    const group = screen.getByRole("group", { name: t("codingAgent.diagram.label", { name: "Build the invoice app" }) });
    expect(group).not.toHaveAttribute("aria-hidden");
    expect(group).toHaveAccessibleDescription(t("codingAgent.diagram.hint"));
    const worker = screen.getByRole("button", { name: new RegExp(`${t("codingAgent.team.roleWorker", { task: "t2" })}.*${t("codingAgent.diagram.state.working")}`) });
    expect(worker).toBe(node("run-work0002"));
    expect(screen.getByRole("button", { name: new RegExp(t("codingAgent.team.roleReviewer", { task: "t1" })) })).toBe(node("run-revw0001"));
    expect(screen.getByRole("button", { name: new RegExp(t("codingAgent.diagram.name.next", { task: "t3" })) })).toBe(node("task:t3"));
  });

  it("gives every state a colour AND an icon, pulses only the agents at work, flows only the edges into them", () => {
    const { container } = renderTeam();
    expect(node("run-work0002")).toHaveAttribute("data-active", "true");
    expect(node("run-work0002").querySelector(".ct-art-live")).not.toBeNull();
    expect(node("run-work0001").querySelector(".ct-art-live")).toBeNull();
    expect(within(node("run-work0002")).getByTestId("coding-agent-node-state")).toHaveTextContent("progress_activity");
    expect(within(node("run-revw0001")).getByTestId("coding-agent-node-state")).toHaveTextContent("thumb_down");
    expect(within(node("task:t3")).getByTestId("coding-agent-node-state")).toHaveTextContent("schedule");
    const flowing = container.querySelectorAll("path.ct-art-flow");
    expect(flowing).toHaveLength(1);
    expect(flowing[0]).toHaveAttribute("data-kind", "assign");
    // Dependencies are drawn: t1 → t2 → t3, an arrow into the dependent.
    expect(container.querySelectorAll('path[data-kind="depends"][marker-end]')).toHaveLength(2);
    // The legend counts each state with its word.
    const legend = screen.getByTestId("coding-agent-diagram-legend");
    expect(within(legend).getByText(t("codingAgent.diagram.state.rejected")).parentElement).toHaveTextContent("2");
  });

  it("shows the team's figures as chips and bars: tasks, tokens per role, wall time", () => {
    renderTeam();
    expect(screen.getByTestId("coding-agent-diagram-tasks")).toHaveTextContent(t("codingAgent.diagram.tasks", { done: 1, total: 3 }));
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "1");
    const tokens = screen.getByTestId("coding-agent-diagram-tokens");
    // planner 8k, workers 50k + 33k (live, from its record), reviewers 6k.
    expect(tokens).toHaveTextContent(t("codingAgent.team.metricTokens", { n: "97k" }));
    expect(within(tokens).getByRole("img")).toHaveAccessibleName(t("codingAgent.diagram.tokensSplit", { planner: "8k", workers: "83k", reviewers: "6k" }));
    expect(screen.getByTestId("coding-agent-diagram-wall")).toHaveTextContent("10m 0s");
  });

  it("keeps one node in the tab order and moves between nodes with the arrow keys, Home and End", () => {
    renderTeam();
    const tabbable = screen.getAllByTestId("coding-agent-node").filter((n) => n.tabIndex === 0);
    expect(tabbable).toEqual([node("run-plan0001")]);
    node("run-plan0001").focus();
    fireEvent.keyDown(node("run-plan0001"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(node("run-work0001"));
    fireEvent.keyDown(node("run-work0001"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(node("run-revw0001"));
    expect(node("run-revw0001").tabIndex).toBe(0);
    expect(node("run-plan0001").tabIndex).toBe(-1);
    fireEvent.keyDown(node("run-revw0001"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(node("run-work0002"));
    fireEvent.keyDown(node("run-work0002"), { key: "End" });
    expect(document.activeElement).toBe(node("task:t3"));
    fireEvent.keyDown(node("task:t3"), { key: "Home" });
    expect(document.activeElement).toBe(node("run-plan0001"));
    // No panel opened on the way: moving is not choosing.
    expect(screen.queryByTestId("coding-agent-node-panel")).toBeNull();
  });
});

describe("the panel: what an agent is doing now", () => {
  it("opens beside the chart on a worker's click with its step, last ten steps, figures, files and task", async () => {
    const { onOpenRun } = renderTeam();
    fireEvent.click(node("run-work0002"));
    const panel = screen.getByTestId("coding-agent-node-panel");
    expect(node("run-work0002")).toHaveAttribute("aria-expanded", "true");
    expect(node("run-work0002")).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("role", "region");
    expect(panel).not.toHaveAttribute("data-sheet");
    expect(within(panel).getByTestId("coding-agent-node-panel-title")).toHaveTextContent(t("codingAgent.team.roleWorker", { task: "t2" }));
    expect(within(panel).getByTestId("coding-agent-node-panel-state")).toHaveTextContent(t("codingAgent.diagram.state.working"));
    expect(within(panel).getByTestId("coding-agent-node-panel-now")).toHaveTextContent("step 13");
    expect(panel).toHaveTextContent(t("codingAgent.diagram.now"));
    expect(within(panel).getAllByTestId("coding-agent-node-panel-steps-step")).toHaveLength(10);
    expect(within(panel).getByTestId("coding-agent-node-panel-elapsed")).toHaveTextContent(/Elapsed \d+m/);
    const figures = within(panel).getByTestId("coding-agent-node-panel-figures");
    expect(figures).toHaveTextContent(t("codingAgent.diagram.turns", { n: 7 }));
    expect(figures).toHaveTextContent(t("codingAgent.team.metricTokens", { n: "33k" }));
    const files = within(panel).getByTestId("coding-agent-node-panel-files");
    expect(files).toHaveTextContent("src/file0.ts");
    expect(files).toHaveTextContent(t("codingAgent.diagram.moreFiles", { n: 2 }));
    expect(within(panel).getByTestId("coding-agent-node-panel-task")).toHaveTextContent("Wire app.js to the form");
    fireEvent.click(within(panel).getByTestId("coding-agent-node-panel-open"));
    expect(onOpenRun).toHaveBeenCalledWith("run-work0002");
    // The owner may stop it; a message box opens on request.
    expect(await within(panel).findByTestId("coding-agent-node-panel-stop")).toBeInTheDocument();
    fireEvent.click(within(panel).getByTestId("coding-agent-node-panel-message"));
    expect(within(panel).getByRole("textbox")).toBeInTheDocument();
  });

  it("opens a reviewer on Enter with its verdict and notes, and a worker's result on Space", () => {
    renderTeam();
    node("run-revw0001").focus();
    fireEvent.keyDown(node("run-revw0001"), { key: "Enter" });
    // Enter and Space reach a button as a click; the browser does that, jsdom does not.
    fireEvent.click(node("run-revw0001"));
    const panel = screen.getByTestId("coding-agent-node-panel");
    expect(panel).toHaveAttribute("data-role", "reviewer");
    const verdict = within(panel).getByTestId("coding-agent-node-panel-verdict");
    expect(verdict).toHaveAttribute("data-verdict", "rejected");
    expect(verdict).toHaveTextContent("The header overlaps the table.");
    // A settled run offers no Stop and no message.
    expect(within(panel).queryByTestId("coding-agent-node-panel-stop")).toBeNull();
    expect(within(panel).queryByTestId("coding-agent-node-panel-message")).toBeNull();
    fireEvent.click(node("run-work0001"));
    const worker = screen.getByTestId("coding-agent-node-panel");
    expect(within(worker).getByTestId("coding-agent-node-panel-result")).toHaveTextContent("Built index.html; open it.");
  });

  it("opens the planner with the goal and the size of the plan", () => {
    renderTeam();
    fireEvent.click(node("run-plan0001"));
    const panel = screen.getByTestId("coding-agent-node-panel");
    expect(panel).toHaveTextContent("Build the invoice app");
    expect(panel).toHaveTextContent(t("codingAgent.diagram.planned", { n: 3 }));
    expect(within(panel).getByTestId("coding-agent-node-panel-title")).toHaveTextContent(t("codingAgent.team.rolePlanner"));
    // It has finished: the panel says what it did last, not what it does "now".
    expect(panel).toHaveTextContent(t("codingAgent.diagram.lastStep"));
    expect(within(panel).getByTestId("coding-agent-node-panel-now")).toHaveTextContent(t("codingAgent.diagram.nothingYet"));
  });

  it("says a task nobody has taken is waiting, and on whom", () => {
    renderTeam();
    fireEvent.click(node("task:t3"));
    const panel = screen.getByTestId("coding-agent-node-panel");
    expect(within(panel).getByTestId("coding-agent-node-panel-now")).toHaveTextContent(t("codingAgent.diagram.notStarted"));
    expect(panel).toHaveTextContent(t("codingAgent.team.waitingFor", { ids: "t2" }));
    expect(within(panel).queryByTestId("coding-agent-node-panel-open")).toBeNull();
  });

  it("follows the arrow keys while open, closes on Escape and hands focus back", () => {
    renderTeam();
    fireEvent.click(node("run-work0001"));
    fireEvent.keyDown(node("run-work0001"), { key: "ArrowRight" });
    expect(screen.getByTestId("coding-agent-node-panel")).toHaveAttribute("data-key", "run-revw0001");
    fireEvent.keyDown(screen.getByTestId("coding-agent-node-panel"), { key: "Escape" });
    expect(screen.queryByTestId("coding-agent-node-panel")).toBeNull();
    expect(document.activeElement).toBe(node("run-revw0001"));
    // A second click on the open node closes it too.
    fireEvent.click(node("run-plan0001"));
    fireEvent.click(node("run-plan0001"));
    expect(screen.queryByTestId("coding-agent-node-panel")).toBeNull();
  });

  it("stays live: the host's next read moves the open panel and the node with it", () => {
    const view = renderTeam();
    fireEvent.click(node("run-work0002"));
    expect(screen.getByTestId("coding-agent-node-panel-now")).toHaveTextContent("step 13");
    const later = { ...RUNS["run-work0002"], progress: [...RUNS["run-work0002"].progress!, "$ npm test"], progressAt: [...RUNS["run-work0002"].progressAt!, NOW] };
    view.rerender(
      <CodingAgentDiagram source={{ kind: "team", team: TEAM }} runOf={(id) => (id === "run-work0002" ? later : RUNS[id])} onOpenRun={vi.fn()} />,
    );
    expect(screen.getByTestId("coding-agent-node-panel-now")).toHaveTextContent("npm test");
    // It settles and its task goes to review: the node and the panel say so.
    const done = { ...later, status: "completed" as const, completedAt: NOW };
    const reviewed = { ...TEAM, tasks: TEAM.tasks.map((x) => (x.task_id === "t2" ? { ...x, status: "complete" as const } : x)) };
    view.rerender(
      <CodingAgentDiagram source={{ kind: "team", team: reviewed }} runOf={(id) => (id === "run-work0002" ? done : RUNS[id])} onOpenRun={vi.fn()} />,
    );
    expect(node("run-work0002")).toHaveAttribute("data-state", "reviewing");
    expect(screen.getByTestId("coding-agent-node-panel")).toHaveAttribute("data-state", "reviewing");
    expect(screen.queryByTestId("coding-agent-node-panel-stop")).toBeNull();
  });

  it("stops a live agent through the existing route and asks the host to read again", async () => {
    const { onChanged } = renderTeam();
    fireEvent.click(node("run-work0002"));
    fireEvent.click(await screen.findByTestId("coding-agent-node-panel-stop"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetches.find((f) => f.url === "/setup-api/coding-agent/stop")?.body).toEqual({ runId: "run-work0002" });
  });

  it("says a refused Stop above the buttons, and brings it on screen", async () => {
    const answered = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (input.toString() === "/setup-api/coding-agent/stop") return json({ error: "That run was started by the owner; only the owner can stop it.", kind: "owner_only" }, 403);
      return answered(input, init);
    }));
    // jsdom has no scrollIntoView: lend one for this test and take it back after.
    const original = Element.prototype.scrollIntoView;
    const shown = vi.fn();
    Element.prototype.scrollIntoView = shown;
    try {
      const { onChanged } = renderTeam();
      fireEvent.click(node("run-work0002"));
      fireEvent.click(await screen.findByTestId("coding-agent-node-panel-stop"));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("only the owner can stop it");
      // Before the row of buttons in the panel, not after it.
      const actions = screen.getByTestId("coding-agent-node-panel-actions");
      expect(alert.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(shown).toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("offers no Stop to a session that is not the owner's", async () => {
    isOwner = false;
    renderTeam();
    fireEvent.click(node("run-work0002"));
    await waitFor(() => expect(fetches.some((f) => f.url === "/setup-api/users/me")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("coding-agent-node-panel-stop")).toBeNull());
  });

  it("asks the box for a run the host does not hold", async () => {
    renderTeam({ runOf: (id) => (id === "run-plan0001" ? undefined : RUNS[id]) });
    fireEvent.click(node("run-plan0001"));
    expect(screen.getByTestId("coding-agent-node-panel-now")).toHaveTextContent(t("codingAgent.diagram.loading"));
    // The planner is done by the board's word: not "now", even before its record lands.
    expect(screen.getByTestId("coding-agent-node-panel-now-label")).toHaveTextContent(t("codingAgent.diagram.lastStep"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-node-panel-now")).toHaveTextContent("fetched step"));
    expect(fetches.some((f) => f.url === "/setup-api/coding-agent/runs?id=run-plan0001")).toBe(true);
  });

  it("asks once for a run the box no longer has, however often the host reads again", async () => {
    const answered = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/coding-agent/runs?id=")) {
        fetches.push({ url });
        return json({ error: "There is no coding run with that id." }, 404);
      }
      return answered(input, init);
    }));
    const runOf = (id: string) => (id === "run-plan0001" ? undefined : RUNS[id]);
    const view = render(<CodingAgentDiagram source={{ kind: "team", team: TEAM }} runOf={runOf} onOpenRun={vi.fn()} refreshKey={1} />);
    fireEvent.click(node("run-plan0001"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-node-panel-now")).toHaveTextContent(t("codingAgent.diagram.noRecord")));
    // The host's live poll moves on twice; the answer would not change.
    for (const k of [2, 3]) view.rerender(<CodingAgentDiagram source={{ kind: "team", team: TEAM }} runOf={runOf} onOpenRun={vi.fn()} refreshKey={k} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(fetches.filter((f) => f.url === "/setup-api/coding-agent/runs?id=run-plan0001")).toHaveLength(1);
    expect(screen.getByTestId("coding-agent-node-panel-now")).toHaveTextContent(t("codingAgent.diagram.noRecord"));
  });

  it("opens as a sheet under the chart in a narrow window", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: SHEET_BELOW - 200, height: 600, top: 0, left: 0, right: SHEET_BELOW - 200, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    renderTeam();
    expect(screen.getByTestId("coding-agent-diagram")).toHaveAttribute("data-layout", "sheet");
    fireEvent.click(node("run-work0001"));
    expect(screen.getByTestId("coding-agent-node-panel")).toHaveAttribute("data-sheet", "true");
  });
});

describe("the chart of one run", () => {
  const SOLO = run("run-solo0001", {
    status: "running",
    completedAt: null,
    activeSubagents: [{ type: "Explore", description: "Map the components folder", startedAt: NOW - 30_000 }],
    subagents: [{ type: "general-purpose", description: "Write the tests", startedAt: NOW - 90_000, endedAt: NOW - 60_000, refused: false }],
  });

  it("draws the run and its helpers, marks this page's run, and opens a helper's errand", () => {
    render(<CodingAgentDiagram source={{ kind: "run", run: SOLO }} current="run-solo0001" onOpenRun={vi.fn()} />);
    const nodes = screen.getAllByTestId("coding-agent-node");
    expect(nodes.map((n) => [n.getAttribute("data-role"), n.getAttribute("data-state")])).toEqual([["run", "working"], ["helper", "done"], ["helper", "working"]]);
    expect(nodes[0]).toHaveAttribute("data-current", "true");
    expect(nodes[0]).toHaveAccessibleName(new RegExp(t("codingAgent.diagram.name.thisRun")));
    expect(screen.getByTestId("coding-agent-diagram-turns")).toHaveTextContent(t("codingAgent.diagram.turns", { n: 12 }));
    fireEvent.click(nodes[2]);
    const panel = screen.getByTestId("coding-agent-node-panel");
    expect(within(panel).getByTestId("coding-agent-node-panel-now")).toHaveTextContent("Map the components folder");
    expect(panel).toHaveTextContent(t("codingAgent.diagram.sentBy", { run: "run-solo0001" }));
    // This page IS the helper's run: no link to where the owner already is.
    expect(within(panel).queryByTestId("coding-agent-node-panel-open")).toBeNull();
  });

  it("draws a team run's TEAM on its page, the run marked, reading the board by id when the list lacks it", async () => {
    const member = { ...RUNS["run-work0002"], team: { id: TEAM.id, role: "worker" as const, taskId: "t2" } };
    render(<RunAgentsDiagram run={member} teams={[]} runOf={(id) => RUNS[id]} onOpenRun={vi.fn()} />);
    // The run's own chart stands in until the board is read.
    expect(screen.getByTestId("coding-agent-run-diagram")).toHaveAttribute("data-shape", "run");
    await waitFor(() => expect(screen.getByTestId("coding-agent-run-diagram")).toHaveAttribute("data-shape", "team"));
    expect(node("run-work0002")).toHaveAttribute("data-current", "true");
  });
});

describe("home: the agents first", () => {
  const SOLO_LIVE = run("run-solo0002", { status: "running", completedAt: null, task: "Fix the login form" });

  it("draws every team and run at work, a team's runs inside its own chart only", () => {
    const teamRun = { ...RUNS["run-work0002"], team: { id: TEAM.id, role: "worker" as const, taskId: "t2" } };
    render(<CodingAgentLiveAgents runs={[SOLO_LIVE, teamRun]} teams={[TEAM]} onOpenRun={vi.fn()} openTeamFor={() => vi.fn()} />);
    const section = screen.getByTestId("coding-agent-live-agents");
    expect(section).toHaveAttribute("data-live", "2");
    expect(screen.getByTestId(`coding-agent-live-team-${TEAM.id}`)).toHaveAttribute("data-shape", "team");
    expect(screen.getByTestId("coding-agent-live-run-run-solo0002")).toHaveAttribute("data-shape", "run");
    expect(screen.queryByTestId("coding-agent-live-run-run-work0002")).toBeNull();
    expect(screen.getByTestId(`coding-agent-live-open-team-${TEAM.id}`)).toHaveTextContent(t("codingAgent.diagram.openTeam"));
  });

  it("shows the newest that was when nothing is at work, and a word when there was nothing", () => {
    const old = run("run-old00001", { task: "An older run", completedAt: NOW - 5_000_000 });
    const settledTeam = { ...TEAM, status: "done" as const, updatedAt: NOW - 1_000 };
    const view = render(<CodingAgentLiveAgents runs={[old]} teams={[settledTeam]} onOpenRun={vi.fn()} />);
    expect(screen.getByTestId("coding-agent-live-agents")).toHaveAttribute("data-live", "0");
    expect(screen.getByTestId(`coding-agent-live-team-${TEAM.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-live-run-run-old00001")).toBeNull();
    view.rerender(<CodingAgentLiveAgents runs={[]} teams={[]} onOpenRun={vi.fn()} />);
    expect(screen.getByTestId("coding-agent-live-empty")).toHaveTextContent(t("codingAgent.diagram.empty"));
  });

  it("opens a live run's page from its chart's heading", () => {
    const onOpenRun = vi.fn();
    render(<CodingAgentLiveAgents runs={[SOLO_LIVE]} teams={[]} onOpenRun={onOpenRun} />);
    fireEvent.click(screen.getByTestId("coding-agent-live-open-run-run-solo0002"));
    expect(onOpenRun).toHaveBeenCalledWith("run-solo0002");
  });
});

describe("Details", () => {
  it("folds the words under the chart, closed until asked", async () => {
    render(<DiagramDetails><p>The board</p></DiagramDetails>);
    const details = screen.getByTestId("coding-agent-diagram-details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByTestId("coding-agent-diagram-details-toggle")).toHaveTextContent(t("codingAgent.diagram.details"));
    await act(async () => {
      (details as HTMLDetailsElement).open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(details).toHaveAttribute("open");
  });
});
