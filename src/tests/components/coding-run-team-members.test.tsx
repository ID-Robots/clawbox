/**
 * A run's teammates (src/components/CodingRunTeamMembers.tsx): read from the
 * team's board, each marked at work or done from the app's own run list,
 * polled while this run is live and read once when it has settled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunTeamMembers from "@/components/CodingRunTeamMembers";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const BOARD_RUNS = [
  { id: "run-plan", role: "planner", taskId: null },
  { id: "run-w1", role: "worker", taskId: "t1" },
  { id: "run-w2", role: "worker", taskId: "t2" },
  { id: "run-rev", role: "reviewer", taskId: "t1" },
];
const RUNS = [
  { id: "run-plan", status: "completed" as const },
  { id: "run-w1", status: "completed" as const },
  { id: "run-w2", status: "running" as const },
  { id: "run-rev", status: "running" as const },
];

function stub() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    calls.push(input.toString());
    return new Response(JSON.stringify({ team: { id: "team-1", runs: BOARD_RUNS } }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

describe("CodingRunTeamMembers", () => {
  it("draws the board as the tree and lists the TEAMMATES — never this run, which the card already names", async () => {
    const calls = stub();
    const onOpenRun = vi.fn();
    render(<CodingRunTeamMembers teamId="team-1" runId="run-w2" runs={RUNS} live onOpenRun={onOpenRun} />);
    const list = await screen.findByTestId("coding-agent-run-team-members");
    expect(calls[0]).toBe("/setup-api/coding-agent/team?id=team-1");
    expect(list).toHaveAttribute("data-working", "2");
    // The Team tab's own drawing, sized by THIS board: two workers, one
    // reviewer, and the pair that are at work lit.
    const tree = within(list).getByTestId("coding-team-tree");
    expect(tree).toHaveAttribute("data-shape", "team");
    expect(tree).toHaveAttribute("data-workers", "2");
    expect(tree).toHaveAttribute("data-reviewers", "1");
    expect(tree).toHaveAttribute("data-active", "1");
    expect(tree).toHaveAttribute("data-active-reviewers", "1");
    // Three rows, not four: run-w2 is the page this is on.
    const rows = within(list).getAllByTestId("coding-agent-team-member");
    expect(rows.map((r) => r.getAttribute("data-role"))).toEqual(["planner", "worker", "reviewer"]);
    expect(rows.map((r) => r.getAttribute("data-live"))).toEqual([null, null, "true"]);
    expect(list.textContent).not.toContain("run-w2");
    expect(rows[2].textContent).toContain(t("codingAgent.team.roleReviewer", { task: "t1" }));
    fireEvent.click(within(rows[0]).getByRole("button", { name: "run-plan" }));
    expect(onOpenRun).toHaveBeenCalledWith("run-plan");
  });

  // A worker whose run FAILED wore the same emerald check_circle as one that
  // finished — beside a status chip already reading "Did not finish" in red.
  it("marks a member that did not finish apart from one that did", async () => {
    stub();
    const runs = [
      { id: "run-plan", status: "completed" as const },
      { id: "run-w1", status: "failed" as const },
      { id: "run-w2", status: "stopped" as const },
      { id: "run-rev", status: "running" as const },
    ];
    // On the planner's own page, so the three rows are its teammates.
    render(<CodingRunTeamMembers teamId="team-1" runId="run-plan" runs={runs} live onOpenRun={() => {}} />);
    const list = await screen.findByTestId("coding-agent-run-team-members");
    const rows = within(list).getAllByTestId("coding-agent-team-member");
    expect(rows.map((r) => r.getAttribute("data-outcome"))).toEqual(["unfinished", "unfinished", "working"]);
    const glyph = (row: HTMLElement) => row.querySelector(".material-symbols-rounded") as HTMLElement;
    // The two that did not finish: no tick, and nothing green about them.
    for (const row of [rows[0], rows[1]]) {
      expect(glyph(row).textContent).toBe("error");
      expect(glyph(row).className).not.toContain("emerald");
    }
    expect(glyph(rows[2]).textContent).toBe("sync");
  });

  // A teammate's role, its run and whether it is at work are ALL the board
  // records about it: a chevron promising more would open on an empty panel.
  it("gives a teammate row no disclosure, and keeps its run one tap away", async () => {
    stub();
    render(<CodingRunTeamMembers teamId="team-1" runId="run-w2" runs={RUNS} live onOpenRun={() => {}} />);
    const list = await screen.findByTestId("coding-agent-run-team-members");
    const rows = within(list).getAllByTestId("coding-agent-team-member");
    for (const row of rows) {
      expect(within(row).queryByRole("button", { expanded: false })).toBeNull();
      expect(row.textContent).not.toContain("expand_more");
    }
    expect(within(rows[0]).getByRole("button", { name: "run-plan" })).toBeInTheDocument();
  });

  it("drops an older reply that lands after a newer one", async () => {
    const answers: Array<(runs: unknown[]) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      answers.push((runs) => resolve(new Response(JSON.stringify({ team: { id: "team-1", runs } }), { status: 200, headers: { "content-type": "application/json" } })));
    })));
    render(<CodingRunTeamMembers teamId="team-1" runId="run-w2" runs={RUNS} live pollMs={15} onOpenRun={() => {}} />);
    await waitFor(() => expect(answers.length).toBeGreaterThanOrEqual(2));
    // The newest read answers first, with two members; then the first — stale by now — with four.
    answers[answers.length - 1]([BOARD_RUNS[0], BOARD_RUNS[1]]);
    const list = await screen.findByTestId("coding-agent-run-team-members");
    expect(within(list).getAllByTestId("coding-agent-team-member")).toHaveLength(2);
    answers[0](BOARD_RUNS);
    await new Promise((r) => setTimeout(r, 30));
    expect(within(list).getAllByTestId("coding-agent-team-member")).toHaveLength(2);
  });

  it("polls while the run is live and stops once it has settled", async () => {
    vi.useFakeTimers();
    const calls = stub();
    const { rerender, unmount } = render(<CodingRunTeamMembers teamId="team-1" runId="run-w2" runs={RUNS} live onOpenRun={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);
    rerender(<CodingRunTeamMembers teamId="team-1" runId="run-w2" runs={RUNS} live={false} onOpenRun={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toHaveLength(after);
    unmount();
  });
});
