import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-731 — an update that was accepted and then lost its process reported
 * NOTHING, and cost 45 minutes of runner time per occurrence.
 *
 * `startUpdate()` sets the module-level state to running and returns
 * `{ started: true }` synchronously; `runUpdate` then takes the on-disk lock
 * (`update_in_progress`) at its top. The step list's position lives only in
 * that process's memory. The continuation flag — the one thing that survives —
 * is written by the REBUILD step, near the end of the first half.
 *
 * So there is a window: between the POST that starts an update and the rebuild
 * step, a web server that is replaced takes the whole run with it. The next
 * process found the lock held, no continuation to resume, released the lock and
 * answered `phase: idle, currentStepIndex: -1`, every step pending — the state
 * of a box nobody had ever asked to update.
 *
 * Observed six times on e2e-install's `90-upgrade-main-to-beta` spec, on
 * branches that touch nothing near the updater:
 *
 *   update did not complete within 2700000ms; last state: {"phase":"idle",
 *   … every step "pending", "currentStepIndex":-1,
 *   "drift":{…"codes":["checkout-dirty"]}}
 *
 * `checkout-dirty` is part of the signature rather than a symptom of the branch
 * under test: the checkout had already been synced to the new commit while the
 * build on disk was still the old one — i.e. the first half HAD run, and then
 * the process was gone.
 *
 * The lock is the evidence and it is already on disk. Held with nothing to
 * resume means an update was interrupted, and the honest answer is a failure
 * with that cause — not silence.
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

/** The disk as this box would have it after the run was lost. */
function diskState({ locked, continuation }: { locked: boolean; continuation?: string }) {
  mockGet.mockImplementation(async (key: string) => {
    if (key === "update_in_progress") return locked ? true : undefined;
    if (key === "update_needs_continuation") return continuation;
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

describe("an update whose process was replaced is reported, not forgotten", () => {
  it("answers failed — with the reason — when the lock is held and nothing is left to resume", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: true });

    const resumed = await updater.checkContinuation();

    // Nothing to resume: that part is unchanged and correct.
    expect(resumed).toBe(false);
    const state = updater.getUpdateState();
    expect(
      state.phase,
      "an accepted update that died must not read as a box nobody asked to update",
    ).toBe("failed");
    expect(state.error).toMatch(/interrupted before it could finish/);
    expect(state.error).toMatch(/start the update again/i);
    // The operator's copy of the same sentence.
    expect(err.mock.calls.flat().join(" ")).toMatch(/interrupted before it could finish/);
  });

  it("still releases the desktop lock, which is what that branch was for", async () => {
    // The box must not be left redirected to /updating for ever. Reporting the
    // failure is in addition to the release, never instead of it.
    diskState({ locked: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await updater.checkContinuation();

    expect(mockSet).toHaveBeenCalledWith("update_in_progress", undefined);
  });

  it("says nothing at all on a box that simply has not updated", async () => {
    // No lock, no continuation: the ordinary boot. Inventing a failed update
    // there would be the mirror defect — every reboot of every box would show
    // one.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: false });

    const resumed = await updater.checkContinuation();

    expect(resumed).toBe(false);
    expect(updater.getUpdateState().phase).toBe("idle");
    expect(err).not.toHaveBeenCalled();
  });

  // The post-reboot half — lock held AND a continuation flag written — is a
  // different branch of the same function and is covered end to end in
  // src/tests/unit/updater.test.ts ("resumes the second half…", and the three
  // refusals around it). It is deliberately not re-driven here: it launches a
  // real run, which this file's `exec` mock never settles.

  it("does not report a box whose update finished and left the lock behind as interrupted twice", async () => {
    // The verdict is a state, not a marker, so a second poll on the same boot
    // must not re-decide it: the lock is gone by then and the failure has to
    // survive on its own.
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: true });
    await updater.checkContinuation();
    expect(updater.getUpdateState().phase).toBe("failed");

    diskState({ locked: false });
    await updater.checkContinuation();

    expect(
      updater.getUpdateState().phase,
      "the verdict must not be erased by the next poll, which finds a clean disk",
    ).toBe("failed");
  });
});
