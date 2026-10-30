/**
 * The chat's TEAM card (src/components/CodingTeamActivityCard.tsx): one card
 * per coding team, live then settled, the run card's sibling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingTeamActivityCard from "@/components/CodingTeamActivityCard";
import { teamCardLabels } from "@/components/CodingChatCards";
import type { TeamActivity } from "@/lib/use-coding-agent-activity";

const en = translations.en;
const t = (key: string) => en[key] ?? key;
const LABELS = teamCardLabels(t);
const OPEN = en["codingAgent.liveView"];
const NOW = Date.now();

const TEAM: TeamActivity = {
  id: "team-k3x9q2ab",
  projectId: "sca-experiment",
  directory: "/srv/projects/sca-experiment",
  goal: "Settings drawer, shortcuts and export\nThe long second line of the goal.",
  status: "working",
  source: "agent",
  startedAt: NOW - 12 * 60_000,
  finishedAt: null,
  tasksDone: 1,
  tasksTotal: 3,
  tasks: [
    { id: "T1", title: "Settings drawer", status: "complete", verdict: "accepted", workerRunId: "run-00000002", reviewerRunId: "run-00000004" },
    { id: "T2", title: "Keyboard shortcuts", status: "in_progress", verdict: null, workerRunId: "run-00000003", reviewerRunId: null },
    { id: "T3", title: "Export button", status: "pending", verdict: null, workerRunId: null, reviewerRunId: null },
  ],
  prNumber: null,
  resultLine: null,
  agents: [
    { role: "planner", runId: "run-00000001", state: "done" },
    { role: "worker", runId: "run-00000002", state: "done" },
    { role: "reviewer", runId: "run-00000004", state: "done" },
    { role: "worker", runId: "run-00000003", state: "active" },
  ],
  tokensUsed: 46_000,
  errorLine: null,
};

afterEach(() => cleanup());

describe("CodingTeamActivityCard", () => {
  it("draws the goal's first line, the status chip, the phase line and a progress bar of tasks done while live", () => {
    render(<CodingTeamActivityCard team={TEAM} labels={LABELS} openLabel={OPEN} />);
    const card = screen.getByTestId("coding-team-activity");
    expect(card).toHaveAttribute("data-team-id", "team-k3x9q2ab");
    expect(card).toHaveAttribute("data-status", "working");
    expect(screen.getByTestId("coding-team-activity-toggle")).toHaveTextContent("Settings drawer, shortcuts and export");
    expect(screen.getByTestId("coding-team-activity-toggle")).not.toHaveTextContent("long second line");
    expect(screen.getByTestId("coding-team-activity-status")).toHaveTextContent("Working");
    expect(screen.getByTestId("coding-team-activity-phase")).toHaveTextContent("sca-experiment");
    expect(screen.getByTestId("coding-team-activity-phase")).toHaveTextContent("1 of 3 tasks");
    const bar = screen.getByTestId("coding-team-activity-progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "3");
    // Nothing is expanded until asked; the live card has no result line.
    expect(screen.queryByTestId("coding-team-activity-tasks")).toBeNull();
    expect(screen.queryByTestId("coding-team-activity-result")).toBeNull();
  });

  it("expands to the tasks in outline order with their marks and states, then the counters", () => {
    render(<CodingTeamActivityCard team={TEAM} labels={LABELS} openLabel={OPEN} />);
    fireEvent.click(screen.getByTestId("coding-team-activity-toggle"));
    expect(screen.getByTestId("coding-team-activity")).toHaveAttribute("data-expanded", "true");
    const rows = screen.getByTestId("coding-team-activity-tasks").querySelectorAll("li");
    expect([...rows].map((li) => li.getAttribute("data-task-id"))).toEqual(["T1", "T2", "T3"]);
    expect(rows[0]).toHaveTextContent("✓");
    expect(rows[0]).toHaveTextContent("Settings drawer — reviewed, approved");
    expect(rows[1]).toHaveTextContent("●");
    expect(rows[1]).toHaveTextContent("Keyboard shortcuts — in progress");
    expect(rows[1]).toHaveAttribute("aria-current", "step");
    expect(rows[2]).toHaveTextContent("○");
    expect(rows[2]).toHaveTextContent("Export button — waiting");
    expect(screen.queryByTestId("coding-team-activity-tasks-more")).toBeNull();
    const counters = screen.getByTestId("coding-team-activity-counters");
    expect(counters).toHaveTextContent("4 agents");
    expect(counters).toHaveTextContent("46k tokens");
    // Clicking inside the panel does not collapse it.
    fireEvent.click(counters);
    expect(screen.getByTestId("coding-team-activity")).toHaveAttribute("data-expanded", "true");
  });

  it("folds a long task list into +N more after six", () => {
    const tasks = Array.from({ length: 9 }, (_, i) => ({ id: `T${i + 1}`, title: `Task ${i + 1}`, status: "pending", verdict: null, workerRunId: null, reviewerRunId: null }));
    render(<CodingTeamActivityCard team={{ ...TEAM, tasks, tasksTotal: 9, tasksDone: 0 }} labels={LABELS} openLabel={OPEN} />);
    fireEvent.click(screen.getByTestId("coding-team-activity-toggle"));
    expect(screen.getByTestId("coding-team-activity-tasks").querySelectorAll("li")).toHaveLength(6);
    expect(screen.getByTestId("coding-team-activity-tasks-more")).toHaveTextContent("+3 more");
  });

  it("Open and × ask the host, without toggling the card; Open is the run card's 32-px green outline, × a 44-px target", () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render(<CodingTeamActivityCard team={TEAM} labels={LABELS} openLabel={OPEN} onOpen={onOpen} onDismiss={onDismiss} />);
    const open = screen.getByTestId("coding-team-activity-open");
    expect(open).toHaveTextContent("Open");
    expect(open.style.minHeight).toBe("32px");
    expect(open.style.background).toBe("transparent");
    expect(open.style.border).toBe("1px solid rgba(52, 211, 153, 0.35)");
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const dismiss = screen.getByTestId("coding-team-activity-dismiss");
    expect(dismiss).toHaveAttribute("aria-label", en["codingAgent.chatDismiss"]);
    expect(dismiss.style.width).toBe("44px");
    expect(dismiss.style.height).toBe("44px");
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("coding-team-activity")).toHaveAttribute("data-expanded", "false");
  });

  it("has no Open and no × without handlers", () => {
    render(<CodingTeamActivityCard team={TEAM} labels={LABELS} openLabel={OPEN} />);
    expect(screen.queryByTestId("coding-team-activity-open")).toBeNull();
    expect(screen.queryByTestId("coding-team-activity-dismiss")).toBeNull();
  });

  it("settled: the phase line names the counts and the pull request, the body is the result's first sentence, no bar", () => {
    const done: TeamActivity = { ...TEAM, status: "done", finishedAt: NOW, tasksDone: 3, prNumber: 12, resultLine: "Every task landed and the suite is green.", agents: TEAM.agents.map((a) => ({ ...a, state: "done" as const })) };
    render(<CodingTeamActivityCard team={done} labels={LABELS} openLabel={OPEN} />);
    expect(screen.getByTestId("coding-team-activity-status")).toHaveTextContent("Done");
    const phase = screen.getByTestId("coding-team-activity-phase");
    expect(phase).toHaveTextContent("3 of 3 tasks");
    expect(phase).toHaveTextContent("PR #12");
    expect(screen.queryByTestId("coding-team-activity-progressbar")).toBeNull();
    const result = screen.getByTestId("coding-team-activity-result");
    expect(result).toHaveTextContent("Every task landed and the suite is green.");
    expect(result).toHaveAttribute("data-tone", "result");
    expect(screen.getByTestId("coding-team-activity")).toHaveAttribute("aria-live", "off");
  });

  it("failed: says why it stopped in the danger tone", () => {
    render(<CodingTeamActivityCard team={{ ...TEAM, status: "failed", finishedAt: NOW, errorLine: "The planner gave no plan." }} labels={LABELS} openLabel={OPEN} />);
    expect(screen.getByTestId("coding-team-activity-status")).toHaveTextContent("Failed");
    const result = screen.getByTestId("coding-team-activity-result");
    expect(result).toHaveTextContent("Stopped: The planner gave no plan.");
    expect(result).toHaveAttribute("data-tone", "danger");
  });

  it("fades out while the chat counts down to putting it away", () => {
    render(<CodingTeamActivityCard team={{ ...TEAM, status: "done" }} labels={LABELS} openLabel={OPEN} autoHiding />);
    expect(screen.getByTestId("coding-team-activity")).toHaveClass("coding-agent-autohide");
  });
});
