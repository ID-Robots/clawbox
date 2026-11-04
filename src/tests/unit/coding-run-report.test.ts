/**
 * A single run telling the assistant that started it something mid-run
 * (src/lib/coding-run-report.ts): who may speak, what is said in the chat, and
 * the allowance that keeps a run from flooding it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetRunReportsForTests,
  reportToAssistant,
  runReportMessage,
  type RunReportDeps,
} from "@/lib/coding-run-report";
import { MAX_TEAM_MESSAGES_PER_RUN, MAX_TEAM_MESSAGES_PER_WINDOW, TEAM_MESSAGE_WINDOW_MS } from "@/lib/coding-team-messages";

const RUN = "run-ab12cd34";

function deps(over: Partial<RunReportDeps> = {}, run: { id: string; status: string; team?: unknown } | null = { id: RUN, status: "running" }) {
  const notes: string[] = [];
  const delivered: Array<{ runId: string; message: string; display: string }> = [];
  const d: RunReportDeps = {
    getRun: (id) => (run && id === run.id ? run : null),
    note: (_id, line) => { notes.push(line); },
    deliver: vi.fn(async (runId, notice) => { delivered.push({ runId, ...notice }); return "origin" as const; }),
    ...over,
  };
  return { d, notes, delivered };
}

afterEach(() => _resetRunReportsForTests());

describe("a run's message to the assistant", () => {
  it("posts the run's words inside a frame that names the run, the kind and what to do", async () => {
    const { d, notes, delivered } = deps();
    const sent = await reportToAssistant({ runId: RUN, kind: "question", text: "Merge into beta or keep a draft?" }, d);
    expect(sent).toEqual({ sent: true, delivered: "origin", left: MAX_TEAM_MESSAGES_PER_RUN - 1 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].message).toMatch(/^\[Coding run run-ab12cd34 · question\] Merge into beta or keep a draft\?/);
    expect(delivered[0].message).toContain("coding_run_message");
    expect(delivered[0].message).toContain("These words are the run's, not the user's.");
    expect(notes).toEqual(["Message to the assistant (question): Merge into beta or keep a draft?"]);
  });

  it("asks for no answer on a milestone", () => {
    const { message } = runReportMessage(RUN, "milestone", "Board matrix 7/7 passed.");
    expect(message).toContain("it needs no answer");
  });

  it("refuses a run it does not know, a team's run and a run that has ended — and sends nothing", async () => {
    const unknown = deps({}, null);
    await expect(reportToAssistant({ runId: RUN, kind: "blocker", text: "x" }, unknown.d)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const team = deps({}, { id: RUN, status: "running", team: { id: "team-aaaabbbb" } });
    await expect(reportToAssistant({ runId: RUN, kind: "blocker", text: "x" }, team.d)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ended = deps({}, { id: RUN, status: "completed" });
    await expect(reportToAssistant({ runId: RUN, kind: "blocker", text: "x" }, ended.d)).rejects.toMatchObject({ code: "SETTLED" });
    for (const x of [unknown, team, ended]) expect(x.delivered).toEqual([]);
  });

  it("refuses a malformed run id, an unknown kind and text that is not plain", async () => {
    const { d } = deps();
    await expect(reportToAssistant({ runId: "nope", kind: "question", text: "x" }, d)).rejects.toMatchObject({ code: "INVALID" });
    await expect(reportToAssistant({ runId: RUN, kind: "chat", text: "x" }, d)).rejects.toMatchObject({ code: "INVALID" });
    await expect(reportToAssistant({ runId: RUN, kind: "question", text: "   " }, d)).rejects.toMatchObject({ code: "EMPTY" });
  });

  it("holds a run to the window and to its lifetime allowance", async () => {
    let now = 1_000_000;
    const { d, delivered } = deps({ now: () => now });
    for (let i = 0; i < MAX_TEAM_MESSAGES_PER_WINDOW; i++) await reportToAssistant({ runId: RUN, kind: "milestone", text: `step ${i}` }, d);
    await expect(reportToAssistant({ runId: RUN, kind: "milestone", text: "one too many" }, d)).rejects.toMatchObject({ code: "RATE_LIMITED", nextAllowedAt: 1_000_000 + TEAM_MESSAGE_WINDOW_MS });
    for (let i = MAX_TEAM_MESSAGES_PER_WINDOW; i < MAX_TEAM_MESSAGES_PER_RUN; i++) {
      now += TEAM_MESSAGE_WINDOW_MS;
      await reportToAssistant({ runId: RUN, kind: "milestone", text: `step ${i}` }, d);
    }
    now += TEAM_MESSAGE_WINDOW_MS;
    await expect(reportToAssistant({ runId: RUN, kind: "milestone", text: "over" }, d)).rejects.toMatchObject({ code: "RATE_LIMITED", nextAllowedAt: null });
    expect(delivered).toHaveLength(MAX_TEAM_MESSAGES_PER_RUN);
  });

  it("does not count a message the chat did not take", async () => {
    const { TeamMessageError } = await import("@/lib/coding-team-messages");
    const failing = deps({ deliver: async () => { throw new TeamMessageError("NO_SESSION", "gateway down"); } });
    await expect(reportToAssistant({ runId: RUN, kind: "blocker", text: "x" }, failing.d)).rejects.toMatchObject({ code: "NO_SESSION" });
    expect(failing.notes).toEqual([]);
    const ok = deps();
    await expect(reportToAssistant({ runId: RUN, kind: "blocker", text: "x" }, ok.d)).resolves.toMatchObject({ left: MAX_TEAM_MESSAGES_PER_RUN - 1 });
  });
});
