/**
 * A long run's history, honestly.
 *
 * The runner keeps a bounded window of progress lines, and it used to be a
 * plain tail: on a 109-step run the window began at "+28m 59s" — the model it
 * started with, the branch it took and its first edits were gone, and nothing
 * on the record said so, so every surface drew a partial history as if it were
 * the whole one. The window now keeps the run's FIRST steps as well as its
 * newest, with one line between them counting what fell out.
 */
import { describe, expect, it, vi } from "vitest";

const configGet = vi.hoisted(() => vi.fn());
const configGetAll = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  getAll: configGetAll,
  set: configSet,
}));

import { trimProgressForTests as trimProgress } from "@/lib/coding-agent";
import { describeProgressLine, RUNNER_STEP } from "@/lib/coding-agent-progress";

/** A run's feed after `n` steps, one a second, trimmed the way pushProgress trims it. */
function feed(n: number): { progress: string[]; progressAt: number[] } {
  const run = { progress: [] as string[], progressAt: [] as number[] };
  for (let i = 0; i < n; i += 1) {
    run.progress.push(`step ${i}`);
    run.progressAt.push(1_000 + i * 1_000);
    trimProgress(run);
  }
  return run;
}

const KEEP = 60;
const HEAD = 20;

describe("a long run's progress window", () => {
  it("leaves a short run alone", () => {
    const run = feed(KEEP);
    expect(run.progress).toHaveLength(KEEP);
    expect(run.progress[0]).toBe("step 0");
    expect(run.progress.at(-1)).toBe(`step ${KEEP - 1}`);
  });

  it("keeps the run's first steps, its newest, and says how many went", () => {
    const run = feed(200);
    expect(run.progress).toHaveLength(KEEP);
    // The opening — "Started with …" lives here on a real run — survives.
    expect(run.progress.slice(0, HEAD)).toEqual(Array.from({ length: HEAD }, (_, i) => `step ${i}`));
    // And the newest, which is where a live run is looked at.
    expect(run.progress.at(-1)).toBe("step 199");
    const dropped = 200 - KEEP + 1;
    expect(run.progress[HEAD]).toBe(RUNNER_STEP.dropped(dropped));
    // One marker, never a stack of them: a second trim adds to its count.
    expect(run.progress.filter((l) => l.startsWith("… "))).toHaveLength(1);
    // Nothing is claimed that is not there: head + marker + tail = the window.
    expect(dropped + HEAD + (KEEP - HEAD - 1)).toBe(200);
  });

  it("holds the bound whatever the run's length", () => {
    for (const n of [61, 100, 500, 2_000]) {
      const run = feed(n);
      expect(run.progress.length, `${n}`).toBe(KEEP);
      expect(run.progressAt.length, `${n}`).toBe(KEEP);
      expect(run.progress[HEAD], `${n}`).toBe(RUNNER_STEP.dropped(n - KEEP + 1));
    }
  });

  it("keeps the times one for one, and stamps the gap with the last step it swallowed", () => {
    const run = feed(200);
    expect(run.progressAt).toHaveLength(run.progress.length);
    expect(run.progressAt.every((at, i) => i === 0 || at >= run.progressAt[i - 1])).toBe(true);
    // The gap ends where the surviving tail begins: its time is the newest
    // dropped step's, so "and then, later, this" still reads true.
    const firstTail = run.progress[HEAD + 1];
    const tailIndex = Number(firstTail.split(" ")[1]);
    expect(run.progressAt[HEAD]).toBe(1_000 + (tailIndex - 1) * 1_000);
  });

  it("says nothing about times for a record that never had them", () => {
    const run = { progress: Array.from({ length: 200 }, (_, i) => `step ${i}`), progressAt: [] as number[] };
    trimProgress(run);
    expect(run.progressAt).toEqual([]);
    expect(run.progress).toHaveLength(KEEP);
    expect(run.progress[HEAD]).toBe(RUNNER_STEP.dropped(141));
  });

  it("the gap is a step a surface can word in the owner's language", () => {
    const step = describeProgressLine(RUNNER_STEP.dropped(141));
    expect(step.labelKey).toBe("droppedSteps");
    expect(step.params).toEqual({ count: 141 });
  });
});
