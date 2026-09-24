import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { act, render, renderHook, screen } from "@/tests/helpers/test-utils";
import CodingAgentActivityPill from "@/components/CodingAgentActivityPill";
import type { CodingRunStatus } from "@/lib/coding-agent-status";
import { CODING_RUN_AUTO_HIDE_MS, useCodingRunAutoHide } from "@/lib/use-coding-run-auto-hide";
import { translations } from "@/lib/translations";

/**
 * A chat run card that goes on its own once its run has finished cleanly.
 *
 * Pinned: the clock starts only when a run is SEEN reaching `completed` (a
 * run first seen finished stays); the card is there at 4.999 s and gone at
 * 5.000 s; no other status ever counts down; a run that stops being
 * `completed` loses its clock, comes back if it had gone, and gets a fresh
 * five seconds if it finishes again; each card has its own clock; unmounting
 * or losing the run clears the clock; `restore()` brings the cards back for
 * good. And the card's fade is timed to end at the same five seconds, with
 * no motion at all under reduced motion.
 */

type Run = { id: string; status: CodingRunStatus };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function mount(runs: Run[]) {
  const view = renderHook(({ runs }: { runs: Run[] }) => useCodingRunAutoHide(runs), { initialProps: { runs } });
  // Every poll hands the chat a NEW array, as the activity hook does.
  const push = (next: Run[]) => act(() => { view.rerender({ runs: [...next] }); });
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const hidden = () => [...view.result.current.hidden].sort();
  const finishing = () => [...view.result.current.finishing].sort();
  return { ...view, push, advance, hidden, finishing };
}

describe("useCodingRunAutoHide", () => {
  it("keeps a card for 4.999 s after its run is seen finishing, and hides it at 5.000 s", () => {
    const h = mount([{ id: "a", status: "running" }]);
    expect(h.finishing()).toEqual([]);
    h.push([{ id: "a", status: "completed" }]);
    expect(h.finishing()).toEqual(["a"]);
    // Literal numbers: the owner asked for five seconds, not "the constant".
    h.advance(4_999);
    expect(h.hidden()).toEqual([]);
    expect(h.finishing()).toEqual(["a"]);
    h.advance(1);
    expect(h.hidden()).toEqual(["a"]);
    expect(h.finishing()).toEqual([]);
  });

  it("leaves a run that was already finished when first seen", () => {
    const h = mount([{ id: "a", status: "completed" }]);
    h.push([{ id: "a", status: "completed" }]);
    h.advance(60_000);
    expect(h.finishing()).toEqual([]);
    expect(h.hidden()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does the same for a run first seen finished while others are already on screen", () => {
    const h = mount([{ id: "a", status: "running" }]);
    h.push([{ id: "a", status: "running" }, { id: "b", status: "completed" }]);
    h.advance(60_000);
    expect(h.hidden()).toEqual([]);
  });

  it.each<CodingRunStatus>(["running", "paused", "failed", "stopped", "gave_up", "draft"])(
    "never counts down a run that is %s",
    (status) => {
      const from: CodingRunStatus = status === "running" ? "paused" : "running";
      const h = mount([{ id: "a", status: from }]);
      h.push([{ id: "a", status }]);
      h.advance(60_000);
      expect(h.finishing()).toEqual([]);
      expect(h.hidden()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("counts down a run that reaches completed from failed or paused (resumed and finished)", () => {
    const h = mount([{ id: "a", status: "failed" }, { id: "b", status: "paused" }]);
    h.push([{ id: "a", status: "completed" }, { id: "b", status: "completed" }]);
    h.advance(CODING_RUN_AUTO_HIDE_MS);
    expect(h.hidden()).toEqual(["a", "b"]);
  });

  it("cancels the clock of a run that stops being completed before it runs out", () => {
    const h = mount([{ id: "a", status: "running" }]);
    h.push([{ id: "a", status: "completed" }]);
    h.advance(3_000);
    h.push([{ id: "a", status: "running" }]);
    expect(h.finishing()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // Well past where the old clock would have fired.
    h.advance(10_000);
    expect(h.hidden()).toEqual([]);
  });

  it("shows a hidden run again when it becomes non-terminal, and gives it a fresh five seconds", () => {
    const h = mount([{ id: "a", status: "running" }]);
    h.push([{ id: "a", status: "completed" }]);
    h.advance(CODING_RUN_AUTO_HIDE_MS);
    expect(h.hidden()).toEqual(["a"]);

    h.push([{ id: "a", status: "running" }]);
    expect(h.hidden()).toEqual([]);
    h.advance(20_000);
    expect(h.hidden()).toEqual([]);

    h.push([{ id: "a", status: "completed" }]);
    h.advance(CODING_RUN_AUTO_HIDE_MS - 1);
    expect(h.hidden()).toEqual([]);
    h.advance(1);
    expect(h.hidden()).toEqual(["a"]);
  });

  it("shows a hidden run again when it settles in a status that needs the owner", () => {
    const h = mount([{ id: "a", status: "running" }]);
    h.push([{ id: "a", status: "completed" }]);
    h.advance(CODING_RUN_AUTO_HIDE_MS);
    h.push([{ id: "a", status: "failed" }]);
    expect(h.hidden()).toEqual([]);
    h.advance(60_000);
    expect(h.hidden()).toEqual([]);
  });

  it("does not restart a running clock when a poll repeats the same statuses", () => {
    const h = mount([{ id: "a", status: "running" }]);
    h.push([{ id: "a", status: "completed" }]);
    h.advance(3_000);
    h.push([{ id: "a", status: "completed" }]);
    h.advance(2_000);
    expect(h.hidden()).toEqual(["a"]);
  });

  it("hides several finished cards independently, each on its own clock", () => {
    const h = mount([
      { id: "a", status: "running" },
      { id: "b", status: "running" },
      { id: "c", status: "running" },
    ]);
    h.push([
      { id: "a", status: "completed" },
      { id: "b", status: "running" },
      { id: "c", status: "running" },
    ]);
    h.advance(2_000);
    h.push([
      { id: "a", status: "completed" },
      { id: "b", status: "completed" },
      { id: "c", status: "failed" },
    ]);
    expect(h.finishing()).toEqual(["a", "b"]);

    h.advance(CODING_RUN_AUTO_HIDE_MS - 2_000 - 1);
    expect(h.hidden()).toEqual([]);
    h.advance(1);
    expect(h.hidden()).toEqual(["a"]);
    expect(h.finishing()).toEqual(["b"]);

    h.advance(2_000 - 1);
    expect(h.hidden()).toEqual(["a"]);
    h.advance(1);
    expect(h.hidden()).toEqual(["a", "b"]);
    h.advance(60_000);
    expect(h.hidden()).toEqual(["a", "b"]);
  });

  it("clears every clock on unmount, so nothing fires into an unmounted chat", () => {
    const h = mount([{ id: "a", status: "running" }, { id: "b", status: "running" }]);
    h.push([{ id: "a", status: "completed" }, { id: "b", status: "completed" }]);
    expect(vi.getTimerCount()).toBe(2);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    h.unmount();
    expect(vi.getTimerCount()).toBe(0);
    h.advance(60_000);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("forgets a run the activity hook lets go of — closing the chat clears the lot", () => {
    const h = mount([{ id: "a", status: "running" }, { id: "b", status: "running" }]);
    h.push([{ id: "a", status: "completed" }, { id: "b", status: "completed" }]);
    h.advance(CODING_RUN_AUTO_HIDE_MS);
    h.push([{ id: "c", status: "running" }]);
    expect(h.hidden()).toEqual([]);

    h.push([{ id: "c", status: "completed" }]);
    h.push([]);
    expect(h.finishing()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    // Back again, as a reopened chat adopts it: first seen finished, so it stays.
    h.push([{ id: "c", status: "completed" }]);
    h.advance(60_000);
    expect(h.hidden()).toEqual([]);
  });

  it("restore() brings back every card that went on its own, and they stay", () => {
    const h = mount([{ id: "a", status: "running" }, { id: "b", status: "running" }]);
    h.push([{ id: "a", status: "completed" }, { id: "b", status: "completed" }]);
    h.advance(CODING_RUN_AUTO_HIDE_MS);
    expect(h.hidden()).toEqual(["a", "b"]);
    act(() => { h.result.current.restore(); });
    expect(h.hidden()).toEqual([]);
    h.push([{ id: "a", status: "completed" }, { id: "b", status: "completed" }]);
    h.advance(60_000);
    expect(h.hidden()).toEqual([]);
  });
});

const en = translations.en;
const LABELS = {
  running: en["codingAgent.chatWorking"],
  runningOwner: en["codingAgent.chatWorkingOwner"],
  completed: en["codingAgent.chatFinished"],
  failed: en["codingAgent.chatFailed"],
  stopped: en["codingAgent.chatStopped"],
  paused: en["codingAgent.chatPaused"],
  draft: en["codingAgent.chatDraft"],
  gave_up: en["codingAgent.chatGaveUp"],
  timeLeft: en["codingAgent.timeLeft"],
};
const RUN = {
  id: "run-fade01", projectId: "timer", task: "Build a timer",
  startedAt: 0, completedAt: 30_000, status: "completed" as const, source: "agent" as const,
  subagentsTotal: 0, subagentsActive: 0, subagentsByType: {}, tokensUsed: 0, thinkingTokens: 0,
  filesTouched: 0, numTurns: 0, progress: [], screenshots: [], todos: [],
  transcriptPath: null, sessionId: null, directory: null,
};

describe("the card while it counts down", () => {
  it("carries the fade class only while it is auto-hiding", () => {
    const { rerender } = render(<CodingAgentActivityPill run={RUN} labels={LABELS} openLabel="View" />);
    expect(screen.getByTestId("coding-agent-activity")).not.toHaveClass("coding-agent-autohide");
    rerender(<CodingAgentActivityPill run={RUN} labels={LABELS} openLabel="View" autoHiding />);
    expect(screen.getByTestId("coding-agent-activity")).toHaveClass("coding-agent-autohide");
  });
});

describe("the fade in globals.css", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");

  it("ends exactly when the chat removes the card", () => {
    const rule = /\.coding-agent-autohide\s*\{[^}]*animation:\s*coding-agent-autohide\s+(\d+)ms\s+\S+\s+(\d+)ms\s+forwards;/.exec(css);
    expect(rule).not.toBeNull();
    const [duration, delay] = [Number(rule![1]), Number(rule![2])];
    expect(duration).toBeGreaterThan(0);
    expect(duration).toBeLessThanOrEqual(400);
    expect(duration + delay).toBe(CODING_RUN_AUTO_HIDE_MS);
  });

  it("is switched off under reduced motion", () => {
    const blocks = css.split("@media (prefers-reduced-motion: reduce)").slice(1);
    const guarded = blocks.some((block) => /\.coding-agent-autohide\s*\{\s*animation:\s*none;/.test(block.slice(0, 200)));
    expect(guarded).toBe(true);
  });
});
