import { readFileSync } from "node:fs";
import path from "node:path";
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
 * `checkout-dirty` is part of the signature and NOT evidence about the run: it
 * comes from `git status --porcelain` being non-empty (src/lib/build-identity.ts),
 * which the e2e container permanently is, and says nothing about whether the
 * checkout moved — that would be `build-predates-checkout` or
 * `build-from-other-commit`, and neither is in the captured state. No artefact
 * from those six runs records whether `update_in_progress` was set, so this file
 * pins the BEHAVIOUR — an interrupted run is no longer silent — rather than
 * claiming to be the cause of them.
 *
 * The lock is the evidence and it is already on disk. Held with nothing to
 * resume, and no completed run to explain it, means an update was interrupted —
 * and the verdict is written back, because the fault being detected is "the web
 * server keeps being replaced" and a verdict kept in memory is one the next
 * replacement erases.
 */

vi.mock("@/lib/config-store", () => {
  // `getKnown` is the tri-state reader ("we could not read the file" is not
  // "the key is unset"), and it answers from the SAME mock every fixture in
  // this file already drives — so a case that wants an unreadable store says
  // so by overriding `getKnown` alone.
  const get = vi.fn();
  return {
    get,
    getKnown: vi.fn(async (key: string) => ({ value: await get(key), known: true })),
    set: vi.fn(),
    setMany: vi.fn(),
  };
});

vi.mock("child_process", () => ({ exec: vi.fn(), execFile: vi.fn() }));

import { get, set, setMany } from "@/lib/config-store";
import * as updater from "@/lib/updater";

const mockGet = vi.mocked(get);
const mockSet = vi.mocked(set);
const mockSetMany = vi.mocked(setMany);

/** The disk as this box would have it after the run was lost. */
function diskState({
  locked,
  continuation,
  completed = false,
  interruptedAt,
  holder,
}: {
  locked: boolean;
  continuation?: string;
  completed?: boolean;
  interruptedAt?: string;
  /** Who took the lock, as `setUpdateLock` records it. */
  holder?: { pid: number; bootId: string | null; startedTicks?: string | null; at?: string };
}) {
  mockGet.mockImplementation(async (key: string) => {
    if (key === "update_in_progress") return locked ? true : undefined;
    if (key === "update_needs_continuation") return continuation;
    if (key === "update_completed") return completed ? true : undefined;
    if (key === "update_interrupted_at") return interruptedAt;
    if (key === "update_lock_holder") return holder;
    return undefined;
  });
}

/** This boot, as `update-lock.ts` reads it. A box without one is not Linux. */
function thisBootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim() || null;
  } catch {
    return null;
  }
}

beforeEach(() => {
  updater.resetUpdateState();
  mockGet.mockReset();
  mockSet.mockReset();
  mockSet.mockResolvedValue(undefined as never);
  mockSetMany.mockReset();
  mockSetMany.mockResolvedValue(undefined as never);
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

    // Through `setMany` now: the flag and the record of WHO held it are
    // cleared together, or a released lock could keep a stale owner.
    expect(mockSetMany).toHaveBeenCalledWith(
      expect.objectContaining({ update_in_progress: undefined, update_lock_holder: undefined }),
    );
  });

  it.skipIf(!thisBootId())("leaves a lock alone while the update is STILL RUNNING in another process", async () => {
    // The false failure this branch produced on the box (2026-09-07): an update
    // restarts the web server by design, and the old process keeps working
    // through its last steps. The new one saw the same evidence a crash leaves
    // — lock held, nothing to resume — released the lock and stamped an
    // interruption, so a run whose journal shows every step completing and
    // BUILD IDENTITY OK was reported failed with every step pending.
    const boot = thisBootId()!;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // A record refreshed at the last step boundary — the heartbeat every step
    // rewrites — over a pid that is gone. This is the SHAPE the box produced:
    // the old web server was killed by `do_rebuild`, and the root step it
    // dispatched was still working when the new one booted and looked.
    diskState({
      locked: true,
      holder: { pid: 0x7ffffff0, bootId: boot, startedTicks: "1", at: new Date().toISOString() },
    });

    const resumed = await updater.checkContinuation();

    expect(resumed).toBe(false);
    expect(updater.getUpdateState().phase, "an update in flight is not a failed one").toBe("idle");
    expect(mockSet).not.toHaveBeenCalledWith("update_interrupted_at", expect.anything());
    expect(mockSetMany, "the lock belongs to the run that is still using it").not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it.skipIf(!thisBootId())("still reports the interruption when the process that held it is gone", async () => {
    // The other half, and the one the branch exists for: a pid that is not
    // there any more is a run that died.
    const boot = thisBootId()!;
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Gone, and its heartbeat is an hour old: the run is not moving.
    diskState({
      locked: true,
      holder: {
        pid: 0x7ffffff0,
        bootId: boot,
        startedTicks: "1",
        at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    });

    await updater.checkContinuation();

    expect(updater.getUpdateState().phase).toBe("failed");
  });

  it("ignores a holder recorded on ANOTHER boot, where a pid proves nothing", async () => {
    // The lock deliberately outlives the reboot the update performs, so a
    // record from before it names a pid this boot may have reused for anything.
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({
      locked: true,
      holder: {
        pid: process.ppid,
        bootId: "a-previous-boot",
        startedTicks: "1",
        at: new Date().toISOString(),
      },
    });

    await updater.checkContinuation();

    expect(updater.getUpdateState().phase).toBe("failed");
  });

  it.skipIf(!thisBootId())("does not take a REUSED pid for the process that took the lock", async () => {
    // A pid is not an identity: the kernel wraps `pid_max`, and an update
    // spawns thousands of processes through install.sh. Without the start time
    // beside it, a later unrelated process landing on the dead holder's pid
    // would hold the lock for the rest of the boot — the owner redirected to
    // /updating with nothing left to release it, which is worse than the false
    // failure this record is here to stop.
    const boot = thisBootId()!;
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({
      locked: true,
      holder: {
        pid: process.ppid, // alive, and not this process
        bootId: boot,
        startedTicks: "1", // …but not when THIS process started
        at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    });

    await updater.checkContinuation();

    expect(updater.getUpdateState().phase).toBe("failed");
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

  it("remembers it, so a second restart does not return the box to silence", async () => {
    // The fault being detected is "the web server keeps being replaced". A
    // process that reports the verdict in memory and then dies takes the only
    // record with it, and the next one finds a clean disk and answers idle —
    // for good. So the release WRITES the verdict.
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: true });
    await updater.checkContinuation();
    expect(mockSet).toHaveBeenCalledWith("update_interrupted_at", expect.any(String));

    // The next process: a clean disk except for the record.
    updater.resetUpdateState();
    diskState({ locked: false, interruptedAt: "2026-09-06T09:00:00.000Z" });
    await updater.checkContinuation();
    expect(updater.getUpdateState().phase).toBe("failed");
  });

  it("clears the completion markers in the same awaited prologue as the lock", () => {
    // update_completed is the discriminator the branch above uses. Left
    // standing, a FORCED run after a successful one — which is exactly what
    // e2e-install's upgrade spec does, twice — would be read as the finished
    // one if it died before the rebuild wrote its continuation flag.
    //
    // Asserted as TEXT because driving it means driving a whole run: what
    // matters is that the clear is awaited, is in the branch that takes the
    // lock, and is reported rather than swallowed when it fails.
    const src = readFileSync(path.join(process.cwd(), "src/lib/updater.ts"), "utf-8");
    const prologue = src.slice(src.indexOf("const ownsTheDesktop"), src.indexOf("let failed = false;"));
    expect(prologue).toContain("await setUpdateLock();");
    expect(prologue).toContain("await setMany({");
    expect(prologue).toContain("update_completed: undefined");
    expect(prologue).toContain("update_completed_at: undefined");
    expect(prologue).toContain("[UPDATE_INTERRUPTED_KEY]: undefined");
    // Reported, never fatal — the same rule setUpdateLock follows.
    expect(prologue).toMatch(/catch \(err\)[\s\S]*console\.warn/);
  });

  it("says nothing about a run that FINISHED and only failed to release its lock", async () => {
    // clearUpdateLock is documented to fail softly and launchUpdate fires it
    // unawaited, so a leftover flag over a completed run is a real state.
    // Reporting there would tell the owner to re-run an update that worked.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: true, completed: true });

    await updater.checkContinuation();

    expect(updater.getUpdateState().phase).toBe("idle");
    expect(err).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalledWith("update_interrupted_at", expect.any(String));
  });

  it("does not report a box whose update finished and left the lock behind as interrupted twice", async () => {
    // The verdict is a state, not a marker, so a second poll on the same boot
    // must not re-decide it: the lock is gone by then and the failure has to
    // survive on its own.
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: true });
    await updater.checkContinuation();
    expect(updater.getUpdateState().phase).toBe("failed");

    // The record the line above wrote is what the verdict rests on, so the
    // next poll's disk still carries it — a `set` this file mocks away is
    // still a `set` the box made.
    diskState({ locked: false, interruptedAt: "2026-09-06T09:00:00.000Z" });
    await updater.checkContinuation();

    expect(
      updater.getUpdateState().phase,
      "the verdict must not be erased by the next poll, which finds a clean disk",
    ).toBe("failed");
  });
});
