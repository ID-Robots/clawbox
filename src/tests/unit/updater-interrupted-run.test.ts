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
import * as childProcess from "child_process";
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
  detail,
  warnings,
}: {
  locked: boolean;
  continuation?: string;
  completed?: boolean;
  interruptedAt?: string;
  /** Who took the lock, as `setUpdateLock` records it. */
  holder?: { pid: number; bootId: string | null; startedTicks?: string | null; at?: string; step?: string };
  /** How and where the last run was cut short, as the verdict records it beside the stamp. */
  detail?: { cause: "reboot" | "replaced" | "unknown"; step?: string };
  /** The drift warnings the interrupted run persisted before its first step. */
  warnings?: { code: string; message: string }[];
}) {
  mockGet.mockImplementation(async (key: string) => {
    if (key === "update_in_progress") return locked ? true : undefined;
    if (key === "update_needs_continuation") return continuation;
    if (key === "update_completed") return completed ? true : undefined;
    if (key === "update_interrupted_at") return interruptedAt;
    if (key === "update_interrupted_detail") return detail;
    if (key === "update_lock_holder") return holder;
    if (key === "update_warnings") return warnings ? JSON.stringify(warnings) : undefined;
    return undefined;
  });
}

/**
 * The network probe answers, and every other command parks for ever: a
 * resumed run then positions itself and waits on its first root step, which
 * is the state these cases read. The probe is `ping`, then an HTTPS HEAD.
 */
function networkAnswers(reachable: boolean) {
  vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (args[0] === "ping" && typeof cb === "function") {
      if (reachable) cb(null, "", "");
      else cb(new Error("ping: unreachable"), "", "");
    }
    return undefined as never;
  }) as never);
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (reachable) return { ok: true, status: 200 } as Response;
    throw new Error("offline");
  }));
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
  vi.unstubAllGlobals();
  vi.mocked(childProcess.execFile).mockReset();
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

/**
 * 2026-09-16 — three field boxes died mid-update and the verdict above blamed
 * the wrong thing. Each box went dark (no shutdown in any log, NUL-padded
 * syslog and npm log) inside step 6, "Updating OpenClaw", seconds after `npm
 * install -g openclaw@…` had finished — its files never reached the disk, so
 * the box had no runnable core. On the next boot this branch found the lock held by a holder from
 * ANOTHER boot with nothing to resume, released it, and reported "the web
 * server was replaced while it ran … start the update again": wrong cause,
 * thirteen grey dots, and a fresh start offered over a box with no assistant.
 *
 * The holder record has always carried the boot it was written on; it now
 * carries the step too (update-lock.ts), so the verdict names both — and
 * "Try again" continues from that step.
 */
describe("an interrupted run says which step died and what took the box, and resumes there", () => {
  const STAMP = "2026-09-16T18:27:49.910Z";
  const stepIndex = (id: string) => updater.getUpdateState().steps.findIndex((s) => s.id === id);

  it("names the step and the restart when the holder is from another boot", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({
      locked: true,
      holder: { pid: 5567, bootId: "a-previous-boot", startedTicks: "1", at: STAMP, step: "openclaw_install" },
    });

    await updater.checkContinuation();

    const state = updater.getUpdateState();
    const index = stepIndex("openclaw_install");
    expect(index).toBeGreaterThan(0);
    expect(state.phase).toBe("failed");
    expect(state.error).toMatch(/interrupted before it could finish/);
    expect(state.error, "the cause is the restart, not a replaced web server").toMatch(/the box restarted — or lost power —/);
    expect(state.error).not.toMatch(/web server was replaced/);
    expect(state.error, "the step is named").toContain('"Updating OpenClaw"');
    expect(state.error, "that step takes the core apart, so the owner is told").toMatch(/assistant may be unavailable/);
    expect(state.error, "and the panel's Resume is what continues it").toMatch(/Resume continues the update from there/);
    // The step list shows WHERE it stopped, not thirteen pending steps.
    expect(state.steps.slice(0, index).every((s) => s.status === "completed")).toBe(true);
    expect(state.steps[index].status).toBe("failed");
    expect(state.steps[index].error).toMatch(/restarted — or lost power — while this step was running/);
    expect(state.steps.slice(index + 1).every((s) => s.status === "pending")).toBe(true);
    // The record beside the stamp, written BEFORE it, is what the next boot
    // words the same verdict from — and what a resume starts from.
    const detailAt = mockSet.mock.calls.findIndex(([k]) => k === "update_interrupted_detail");
    const stampAt = mockSet.mock.calls.findIndex(([k]) => k === "update_interrupted_at");
    expect(detailAt).toBeGreaterThanOrEqual(0);
    expect(mockSet.mock.calls[detailAt][1]).toEqual({ cause: "reboot", step: "openclaw_install" });
    expect(stampAt).toBeGreaterThan(detailAt);
    expect(err.mock.calls.flat().join(" ")).toMatch(/restarted — or lost power —/);
  });

  it.skipIf(!thisBootId())("names the step and the replaced web server when the holder is from THIS boot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({
      locked: true,
      holder: {
        pid: 0x7ffffff0,
        bootId: thisBootId()!,
        startedTicks: "1",
        at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        step: "apt_update",
      },
    });

    await updater.checkContinuation();

    const state = updater.getUpdateState();
    expect(state.phase).toBe("failed");
    expect(state.error).toMatch(/the web server was replaced while "Updating system packages" was running/);
    expect(state.error, "apt does not touch the core").not.toMatch(/assistant/);
    expect(mockSet).toHaveBeenCalledWith("update_interrupted_detail", { cause: "replaced", step: "apt_update" });
  });

  it("words a holder with no step exactly as before", async () => {
    // A lock taken by a build that predates the step field, or the prologue's
    // own record: nothing new is known, so nothing new is claimed.
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: true, holder: { pid: 5567, bootId: "a-previous-boot", startedTicks: "1", at: STAMP } });

    await updater.checkContinuation();

    const state = updater.getUpdateState();
    expect(state.error).toMatch(/the box restarted — or lost power — while it ran/);
    expect(state.error).toMatch(/start the update again/);
    expect(state.steps.every((s) => s.status === "pending")).toBe(true);
    expect(mockSet).toHaveBeenCalledWith("update_interrupted_detail", { cause: "reboot" });
  });

  it("words the same verdict from the record on the next boot", async () => {
    // The process that decided the verdict may be gone; the record is what the
    // next one reads, so the sentence and the step list must not degrade to
    // the old wording on a reboot.
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: false, interruptedAt: STAMP, detail: { cause: "reboot", step: "openclaw_install" } });

    await updater.checkContinuation();

    const state = updater.getUpdateState();
    expect(state.phase).toBe("failed");
    expect(state.error).toContain('"Updating OpenClaw"');
    expect(state.error).toMatch(/the box restarted/);
    expect(state.steps[stepIndex("openclaw_install")].status).toBe("failed");
    expect(mockSet, "a remembered verdict is not re-stamped").not.toHaveBeenCalledWith("update_interrupted_at", expect.any(String));
  });

  it("ignores a record it does not recognise, and one whose step this list lacks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: false, interruptedAt: STAMP, detail: { cause: "reboot", step: "a_step_from_another_build" } });
    await updater.checkContinuation();
    let state = updater.getUpdateState();
    expect(state.phase).toBe("failed");
    expect(state.error).toMatch(/the box restarted — or lost power — while it ran/);
    expect(state.steps.every((s) => s.status === "pending")).toBe(true);

    updater.resetUpdateState();
    diskState({ locked: false, interruptedAt: STAMP, detail: { cause: "later", step: 7 } as never });
    await updater.checkContinuation();
    state = updater.getUpdateState();
    expect(state.phase).toBe("failed");
    expect(state.error).toBe(updater.INTERRUPTED_MESSAGE);
  });

  it("Resume continues from the interrupted step — no later than the power-profile step, which unpins the clocks", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    networkAnswers(true);
    const warnings = [{ code: "checkout-behind-pin", message: "The checkout was 71 commits behind its pin." }];
    diskState({ locked: false, interruptedAt: STAMP, detail: { cause: "reboot", step: "openclaw_install" }, warnings });
    const died = stepIndex("openclaw_install");
    const unpin = stepIndex("performance_mode");
    expect(died).toBeGreaterThan(unpin);
    expect(unpin).toBeGreaterThan(0);

    expect(updater.startUpdate()).toEqual({ started: true });

    // A power-cycled box boots with clawbox-performance.service pinning the
    // clocks again; a resume that skipped `performance_mode` would run the
    // npm install pinned — the very thing that step unpins under an update.
    // So the run picks up THERE, and parks on that step's (never-settling)
    // root dispatch — which is the state this case reads.
    await vi.waitFor(() => expect(updater.getUpdateState().currentStepIndex).toBe(unpin));
    const state = updater.getUpdateState();
    expect(state.phase).toBe("running");
    expect(state.steps.slice(0, unpin).every((s) => s.status === "completed")).toBe(true);
    expect(state.steps[unpin].status).not.toBe("completed");
    expect(state.steps[died].status).toBe("pending");
    // The interrupted run's own diagnosis travels with the resume.
    expect(state.warnings).toEqual(warnings);
    // The record is consumed by the prologue, so a run that dies AGAIN is
    // resumed from wherever that one died, never from a stale step.
    await vi.waitFor(() =>
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ update_interrupted_at: undefined, update_interrupted_detail: undefined }),
      ));
  });

  it("resumes at the recorded step itself when it is before the power-profile step", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    networkAnswers(true);
    diskState({ locked: false, interruptedAt: STAMP, detail: { cause: "replaced", step: "apt_update" } });
    const index = stepIndex("apt_update");
    expect(index).toBeGreaterThan(0);

    expect(updater.startUpdate()).toEqual({ started: true });

    await vi.waitFor(() => expect(updater.getUpdateState().currentStepIndex).toBe(index));
  });

  it("keeps its position when a resume is refused for want of a network", async () => {
    // These boxes are on WiFi and the desktop is reachable seconds after boot.
    // A resume that failed its probe used to have cleared the record first, so
    // the NEXT press started from step 1 over a box with no core.
    vi.spyOn(console, "log").mockImplementation(() => {});
    networkAnswers(false);
    diskState({ locked: false, interruptedAt: STAMP, detail: { cause: "reboot", step: "openclaw_install" } });

    expect(updater.startUpdate()).toEqual({ started: true });

    await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("failed"));
    expect(updater.getUpdateState().error).toMatch(/No internet connection/);
    // The lock is released, the record is NOT.
    expect(mockSetMany).toHaveBeenCalledWith(expect.objectContaining({ update_in_progress: undefined }));
    expect(mockSetMany).not.toHaveBeenCalledWith(expect.objectContaining({ update_interrupted_detail: undefined }));
    expect(mockSetMany).not.toHaveBeenCalledWith(expect.objectContaining({ update_interrupted_at: undefined }));
  });

  it("names the assistant for a run cut short before the gateway was started again", async () => {
    // `openclaw_install` stops the gateway and LEAVES it stopped; `gateway_setup`
    // restarts it. A run that died between the two has an intact core and no
    // assistant, so that step carries the sentence too.
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: false, interruptedAt: STAMP, detail: { cause: "reboot", step: "gateway_setup" } });

    await updater.checkContinuation();

    expect(updater.getUpdateState().error).toMatch(/assistant may be unavailable/);
  });

  it("starts from the top when the record names no step, or there is no stamp", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    diskState({ locked: false, detail: { cause: "reboot", step: "openclaw_install" } });

    expect(updater.startUpdate()).toEqual({ started: true });

    // No stamp: the detail alone must not move the start. The run parks on
    // the same probe; its position is what is asserted.
    await new Promise((r) => setTimeout(r, 20));
    const state = updater.getUpdateState();
    expect(state.currentStepIndex).toBe(0);
    expect(state.steps.every((s) => s.status !== "completed")).toBe(true);
  });

  it("Dismiss takes the step record with the stamp, so the next update starts from the top", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    diskState({ locked: false, interruptedAt: STAMP, detail: { cause: "reboot", step: "openclaw_install" } });
    await updater.checkContinuation();
    expect(updater.getUpdateState().phase).toBe("failed");

    expect(await updater.dismissSettledUpdate()).toEqual({ dismissed: true });

    expect(mockSet).toHaveBeenCalledWith("update_interrupted_at", undefined);
    expect(mockSet).toHaveBeenCalledWith("update_interrupted_detail", undefined);
    expect(updater.getUpdateState().phase).toBe("idle");
  });
});
