import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-731, follow-up: the interruption record outlived the update that
 * finished, and every normal in-app update ended on "Update failed".
 *
 * The marker is written where the desktop lock is released — "the lock is
 * held, there is nothing to resume, and no completed run explains it". That
 * describes a run whose process was replaced (which is what the record is for),
 * and it ALSO describes the second half of an ordinary update as seen by a
 * reader that is not the one running it: `resumeContinuation` consumes
 * `update_needs_continuation` before the resumed steps run, so from that
 * moment until the run writes `update_completed` the disk says exactly
 * "locked, nothing to resume, not completed".
 *
 * Measured on the Hermes box after an update that WORKED (2026-09-06):
 *
 *   update_interrupted_at = 2026-09-06T11:45:58.469Z
 *   update_completed      = true
 *   update_completed_at   = 2026-09-06T11:47:09.590Z
 *
 * The marker is stamped 71 seconds BEFORE the completion — by the restart step
 * the update performs on its own normal path — and nothing ever cleared it, so
 * the box answered `failed` with every step `pending` over a finished update,
 * on that boot and on every boot after it.
 *
 * Two records, two timestamps: the newer one is the true one. A completion
 * that came after an interruption voids it; an interruption with no completion
 * after it is still a failure, and still says why — that is TASK-731's own fix
 * and it must survive this one.
 */

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(),
  setMany: vi.fn(),
}));

vi.mock("child_process", () => ({ exec: vi.fn(), execFile: vi.fn() }));

import { get, set } from "@/lib/config-store";
import * as updater from "@/lib/updater";

const mockGet = vi.mocked(get);
const mockSet = vi.mocked(set);

/** The moment the restart step replaced the web server. */
const INTERRUPTED_AT = "2026-09-06T11:45:58.469Z";
/** 71 seconds later: the same run, finished. */
const COMPLETED_AT = "2026-09-06T11:47:09.590Z";

function diskState({
  locked,
  continuation,
  completed = false,
  completedAt,
  interruptedAt,
}: {
  locked: boolean;
  continuation?: string;
  completed?: boolean;
  completedAt?: string;
  interruptedAt?: string;
}) {
  mockGet.mockImplementation(async (key: string) => {
    if (key === "update_in_progress") return locked ? true : undefined;
    if (key === "update_needs_continuation") return continuation;
    if (key === "update_completed") return completed ? true : undefined;
    if (key === "update_completed_at") return completedAt;
    if (key === "update_interrupted_at") return interruptedAt;
    return undefined;
  });
}

beforeEach(() => {
  updater.resetUpdateState();
  mockGet.mockReset();
  mockSet.mockReset();
  mockSet.mockResolvedValue(undefined as never);
});

afterEach(() => {
  updater.resetUpdateState();
  vi.restoreAllMocks();
});

describe("an interruption never outlives a completion newer than it", () => {
  it("reads the box the owner reported as finished, not failed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // The exact disk of 192.168.1.47 after the update that worked.
    diskState({
      locked: false,
      completed: true,
      completedAt: COMPLETED_AT,
      interruptedAt: INTERRUPTED_AT,
    });

    await updater.checkContinuation();

    expect(
      updater.getUpdateState().phase,
      "the completion is 71s NEWER than the interruption, so the update finished",
    ).toBe("idle");
    expect(err).not.toHaveBeenCalled();
  });

  it("forgets the voided record, so the next boot does not raise it again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({
      locked: false,
      completed: true,
      completedAt: COMPLETED_AT,
      interruptedAt: INTERRUPTED_AT,
    });

    await updater.checkContinuation();

    expect(mockSet).toHaveBeenCalledWith("update_interrupted_at", undefined);
  });

  it("still reports a genuinely killed update, with the cause", async () => {
    // TASK-731's own fix, in the other direction: no completion at all means
    // nothing overtook the interruption, and the box must say so.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: true });

    await updater.checkContinuation();

    const state = updater.getUpdateState();
    expect(state.phase).toBe("failed");
    expect(state.error).toMatch(/interrupted before it could finish/);
    expect(err.mock.calls.flat().join(" ")).toMatch(/interrupted before it could finish/);
  });

  it("keeps a run that died AFTER the last completed one failed", async () => {
    // A box that updated on Tuesday and had Wednesday's update killed: the
    // completion is real and is OLDER than the interruption, so it explains
    // nothing about the run that died.
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({
      locked: false,
      completed: true,
      completedAt: "2026-09-05T09:00:00.000Z",
      interruptedAt: INTERRUPTED_AT,
    });

    await updater.checkContinuation();

    expect(updater.getUpdateState().phase).toBe("failed");
    expect(mockSet).not.toHaveBeenCalledWith("update_interrupted_at", undefined);
  });

  it("does not let an undated completion outrank a dated interruption", async () => {
    // Older boxes carried `update_completed = true` for ever with no time
    // beside it. "Some completion happened at some point" cannot prove it came
    // after this interruption, and guessing that it did would be the silence
    // TASK-731 was filed for.
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: false, completed: true, interruptedAt: INTERRUPTED_AT });

    await updater.checkContinuation();

    expect(updater.getUpdateState().phase).toBe("failed");
  });

  it("drops the verdict this process is holding once its record is gone", async () => {
    // The verdict is remembered in memory as well as on disk, and the two
    // readers are not the same process. What clears the record — a completion,
    // the next run's prologue, the owner's Dismiss — has to clear the verdict
    // built from it too, or the page keeps showing a failure that the box no
    // longer has any evidence for.
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: true });
    await updater.checkContinuation();
    expect(updater.getUpdateState().phase).toBe("failed");

    diskState({ locked: false, completed: true, completedAt: COMPLETED_AT });
    await updater.checkContinuation();

    expect(updater.getUpdateState().phase).toBe("idle");
  });
});

describe("dismissing a settled run", () => {
  it("waits for the write and says so when it could not be made", async () => {
    // `void set(...)` returned `true` whatever the store did with it: the
    // route answered 200, the owner's Dismiss appeared to take, and the record
    // was still on disk for the next poll to raise the same failure from.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    diskState({ locked: true });
    await updater.checkContinuation();
    expect(updater.getUpdateState().phase).toBe("failed");

    mockSet.mockRejectedValueOnce(new Error("EACCES: data/config.json") as never);
    const result = await updater.dismissSettledUpdate();

    expect(result.dismissed, "a write that did not happen is not a dismissal").toBe(false);
    if (result.dismissed) throw new Error("unreachable");
    expect(result.reason).toBe("not-written");
    expect(result.error).toMatch(/EACCES/);
    expect(
      updater.getUpdateState().phase,
      "the run stays settled-failed: nothing was forgotten",
    ).toBe("failed");
  });

  it("forgets the record when the write goes through", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: true });
    await updater.checkContinuation();

    const result = await updater.dismissSettledUpdate();

    expect(result.dismissed).toBe(true);
    expect(mockSet).toHaveBeenCalledWith("update_interrupted_at", undefined);
    expect(updater.getUpdateState().phase).toBe("idle");
  });
});
