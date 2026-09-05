/**
 * A run's teammates (src/components/CodingRunTeamMembers.tsx): read from the
 * team's board, each marked at work or done from the app's own run list,
 * polled while this run is live and read once when it has settled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/tests/helpers/test-utils";
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
  it("lists every member with its role, at work or done, names this run without a link and opens the others", async () => {
    const calls = stub();
    const onOpenRun = vi.fn();
    render(<CodingRunTeamMembers teamId="team-1" runId="run-w2" runs={RUNS} live onOpenRun={onOpenRun} />);
    const list = await screen.findByTestId("coding-agent-run-team-members");
    expect(calls[0]).toBe("/setup-api/coding-agent/team?id=team-1");
    expect(list).toHaveAttribute("data-working", "2");
    expect(list.textContent).toContain(t("codingAgent.agentsWorking", { n: 2 }));
    expect(list.textContent).toContain(t("codingAgent.agentsFinished", { n: 2 }));
    const rows = within(list).getAllByTestId("coding-agent-team-member");
    expect(rows.map((r) => r.getAttribute("data-role"))).toEqual(["planner", "worker", "worker", "reviewer"]);
    expect(rows.map((r) => r.getAttribute("data-live"))).toEqual([null, null, "true", "true"]);
    expect(rows[2]).toHaveAttribute("data-me", "true");
    expect(within(rows[2]).queryByRole("button")).toBeNull();
    expect(rows[3].textContent).toContain(t("codingAgent.team.roleReviewer", { task: "t1" }));
    fireEvent.click(within(rows[0]).getByRole("button", { name: "run-plan" }));
    expect(onOpenRun).toHaveBeenCalledWith("run-plan");
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
