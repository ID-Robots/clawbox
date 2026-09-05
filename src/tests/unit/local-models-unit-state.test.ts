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
function answer(
  handler: (args: string[], opts: { env?: NodeJS.ProcessEnv }) => { stdout?: string; stderr?: string; fail?: boolean },
) {
  type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void;
  execFileMock.mockImplementation((_cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }, cb: Cb) => {
    const { stdout = "", stderr = "", fail = false } = handler(args, opts ?? {});
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

async function readUnit(scope: "user" | "system" = "user") {
  const { readUnitState, KOKORO_UNIT } = await import("@/lib/local-models");
  return readUnitState(KOKORO_UNIT, scope);
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
      : { stdout: "", stderr: "Failed to get unit file state for kokoro-server.service: No such file or directory\n", fail: true });

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

  it("does not turn any OTHER lookup failure into a present unit", async () => {
    // `Failed to get unit file state for %s: %s` is systemd's format string for
    // EVERY failure of that lookup, not just for a missing file. `present` is
    // computed by exclusion, so a sentence reaching it reads as a state word
    // and a unit that could not be looked up is reported installed, enabled
    // and answered — which then keeps a stamped box on an engine it cannot
    // speak with, permanently. The phrase alone is not the answer; the errno
    // is the other half of it.
    for (const tail of ["Connection reset by peer", "Access denied", "Invalid argument"]) {
      answer((args) => args.includes("is-active")
        ? { stdout: "inactive\n", fail: true }
        : { stdout: "", stderr: `Failed to get unit file state for x.service: ${tail}\n`, fail: true });

      expect(await readUnit(), tail).toMatchObject({ present: false, enabled: false, answered: false });
    }
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

  it("asks the USER manager on the bus it can actually reach", async () => {
    // Without XDG_RUNTIME_DIR a `--user` call from a system service answers
    // "Failed to connect to bus" for everything — which is silence, so every
    // box would read as "could not ask" and the link path would leave every one
    // of them exactly where it found it, with the whole suite green. The scope
    // ternary that supplies it is one character from being inverted.
    answer((args, opts) => {
      expect(args, "a user-scope query must carry --user").toContain("--user");
      expect(opts.env?.XDG_RUNTIME_DIR, "no user bus address was passed").toBeTruthy();
      return args.includes("is-active") ? { stdout: "active\n" } : { stdout: "enabled\n" };
    });

    expect(await readUnit()).toMatchObject({ present: true, answered: true });
  });

  it("asks a SYSTEM unit exactly the same way", async () => {
    // The embedder's unit is a system one and the whole question is the same,
    // so the two scopes must not answer "absent" differently. They used to:
    // the system branch went through the module's generic command helper,
    // which drops stderr, so on the older systemd only the user scope could
    // tell an absent unit from a wedged one.
    answer((args) => {
      expect(args, "a system-scope query must not carry --user").not.toContain("--user");
      return args.includes("is-active")
        ? { stdout: "inactive\n", fail: true }
        : { stdout: "", stderr: "Failed to get unit file state for x.service: No such file or directory\n", fail: true };
    });

    expect(await readUnit("system")).toMatchObject({ present: false, answered: true });
  });
});
