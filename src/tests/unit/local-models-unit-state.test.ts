import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `readUnitState` — telling "the unit file is absent" from "systemd never
 * answered", on both systemd generations ClawBox runs on.
 *
 * The distinction is not cosmetic here. `probeLocalTtsEngine` reports "could
 * not ask" off `answered`, and the ClawBox AI link path uses that to decide
 * whether a box can still speak for itself — a decision that is permanent
 * (`step_openclaw_tts` then preserves the new selection as the owner's
 * choice). `present` decides the other direction: a unit read as present when
 * it does not exist keeps a stamped box on an on-device engine it no longer
 * has, which is the mute box TASK-699 is about.
 *
 * Measured, not assumed. `systemctl --user is-enabled <missing>.service`:
 *   - systemd 249 (Ubuntu 22.04, the shipped Jetson): exit 1, stdout EMPTY,
 *     stderr `Failed to get unit file state for x.service: No such file or
 *     directory`.
 *   - systemd 255 (Ubuntu 24.04): exit 4, stdout `not-found`, stderr empty.
 * Both are systemd ANSWERING "there is no such unit". Neither is silence.
 */

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ execFile: execFileMock }));

/** Drive the callback-style execFile `promisify` wraps. */
function answer(handler: (args: string[]) => { stdout?: string; stderr?: string; fail?: boolean }) {
  execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const { stdout = "", stderr = "", fail = false } = handler(args);
    if (fail) {
      const err = Object.assign(new Error("Command failed"), { stdout, stderr });
      cb(err);
      return;
    }
    // `promisify` with no custom symbol resolves with the callback's FIRST
    // value, and every caller here destructures `{ stdout, stderr }` off it.
    cb(null, { stdout, stderr });
  });
}

async function readUnit() {
  const { readUnitState } = await import("@/lib/local-models");
  return readUnitState("kokoro-tts.service", "user");
}

describe("readUnitState", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  it("reads a running, enabled unit", async () => {
    answer((args) => (args.includes("is-active") ? { stdout: "active\n" } : { stdout: "enabled\n" }));

    expect(await readUnit()).toMatchObject({
      present: true, active: true, enabled: true, failed: false, answered: true,
    });
  });

  it("calls an absent unit absent — and ANSWERED — on the systemd the box runs", async () => {
    // The 249 shape: the whole answer is on stderr. Read as silence, this box
    // says "could not ask", and a stamped box that has lost its unit is then
    // left on an on-device engine it cannot speak with.
    answer((args) => args.includes("is-active")
      ? { stdout: "inactive\n", fail: true }
      : { stdout: "", stderr: "Failed to get unit file state for kokoro-tts.service: No such file or directory\n", fail: true });

    expect(await readUnit()).toMatchObject({ present: false, enabled: false, answered: true });
  });

  it("calls an absent unit absent on the newer systemd too", async () => {
    // The 255 shape: `not-found` on stdout. Read as a state word, `present`
    // was TRUE for a unit that does not exist.
    answer((args) => args.includes("is-active")
      ? { stdout: "inactive\n", fail: true }
      : { stdout: "not-found\n", fail: true });

    expect(await readUnit()).toMatchObject({ present: false, enabled: false, answered: true });
  });

  it("does not turn a wedged user bus into an answer", async () => {
    // The state `answered` exists for: no unit file was named, so nothing was
    // learned about this box. It must stay silence even though stderr spoke.
    answer(() => ({ stdout: "", stderr: "Failed to connect to bus: No such file or directory\n", fail: true }));

    expect(await readUnit()).toMatchObject({ present: false, answered: false });
  });

  it("does not turn a timeout into an answer", async () => {
    answer(() => ({ stdout: "", stderr: "", fail: true }));

    expect(await readUnit()).toMatchObject({ present: false, answered: false });
  });
});
