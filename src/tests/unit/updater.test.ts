import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import * as fs from "fs/promises";
import { existsSync } from "fs";

vi.mock("child_process", () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

// `realpath` beside `readFile`: readBuildId follows `.next/standalone/server.js`
// through the link `postbuild` writes for the NESTED standalone layout, so a
// mock without it would make every case that reaches the entry throw inside
// readBuildId's `try` and answer "" — i.e. pass for the wrong reason.
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  realpath: vi.fn(),
}));

// `existsSync` is how readBuildId decides WHICH tree the server runs from — the
// standalone entry point, not a BUILD_ID that a failed rebuild may have taken
// with it. Partial, because `updater.ts` is not the only module in this graph
// that touches `fs`.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  // The REAL implementation by default — other code in this graph asks whether
  // real files exist (the build-identity script, for one) and a blanket `false`
  // would rewrite those tests' subject. Only the case that is about WHICH build
  // tree the server runs from overrides it.
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

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

// `waitForGateway` is the readiness wait, and it is what these tests drive: the
// polling loop lives in port-probe now (shared with restartGateway's own wait),
// and mocking the whole wait keeps each case a single "is the gateway up at
// this point in the sequence?" predicate rather than a call sequence a fast
// poll could consume. The loop itself is covered in port-probe.test.ts.
vi.mock("@/lib/port-probe", async (orig) => ({
  ...(await orig<typeof import("@/lib/port-probe")>()),
  waitForPortOpen: vi.fn(),
}));

// The Hermes version probe goes through the shared CLI wrapper, so the wrapper
// is the seam: nothing in these tests may spawn a real `hermes`.
const { mockRunHermesCli } = vi.hoisted(() => ({ mockRunHermesCli: vi.fn() }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: mockRunHermesCli }));

// The TASK-606 marker, mocked so the clears the repair paths owe can be seen.
// `readPluginRepairs` answers `{}`, which is what the real one answers under
// this file's mocked `fs/promises` anyway — so nothing else moves.
const { mockClearPluginRepair, mockReadPluginRepairs, mockClawboxDisabledEntryId } = vi.hoisted(() => ({
  mockClearPluginRepair: vi.fn(async () => true),
  mockReadPluginRepairs: vi.fn(async () => ({})),
  // Null by default: no row says ClawBox switched anything off, so a payload
  // repair clears the marker without touching the config.
  mockClawboxDisabledEntryId: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("@/lib/plugin-repair", () => ({
  clearPluginRepair: mockClearPluginRepair,
  readPluginRepairs: mockReadPluginRepairs,
  clawboxDisabledEntryId: mockClawboxDisabledEntryId,
}));

import { get, set, setMany } from "@/lib/config-store";
import { waitForPortOpen } from "@/lib/port-probe";
import { deferred } from "@/tests/helpers/deferred";

const mockGet = vi.mocked(get);
const mockSet = vi.mocked(set);
const mockSetMany = vi.mocked(setMany);
const mockExec = vi.mocked(childProcess.exec);
const mockExecFile = vi.mocked(childProcess.execFile);
const mockReadFile = vi.mocked(fs.readFile);
const mockRealpath = vi.mocked(fs.realpath);
const mockExists = vi.mocked(existsSync);
const mockGatewayUp = vi.mocked(waitForPortOpen);

/**
 * A box whose rebuild produced a build, and no other readable file.
 *
 * These cases mean "there is nothing else on disk to read", and they used to
 * say it with a blanket ENOENT. An absent `.next/BUILD_ID` is now a failed
 * rebuild in its own right (TASK-709) — nothing is never evidence of a build —
 * so the one file that decides whether the continuation may run has to be
 * stated rather than left to the same rejection as everything else.
 */
function mockRebuiltBox(buildId = "rebuilt-build-id"): void {
  mockReadFile.mockImplementation(async (file) => {
    if (String(file).endsWith("BUILD_ID")) return `${buildId}\n`;
    throw new Error("ENOENT");
  });
}
let execFileFallbackResults: Record<string, { stdout: string; stderr: string } | Error> = {};

function setupExecMock(results: Record<string, { stdout: string; stderr: string } | Error> = {}) {
  // Git used to run through `exec`; it now correctly uses `execFile` argv.
  // Keep one result vocabulary so the behavioral tests below describe the
  // command once while both process mocks can answer during the migration.
  execFileFallbackResults = results;
  mockExec.mockImplementation(((
    cmd: string,
    optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
    maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    let result: { stdout: string; stderr: string } | Error | undefined;
    for (const k of Object.keys(results)) {
      if (cmd.includes(k)) {
        result = results[k];
        break;
      }
    }

    const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;

    if (callback) {
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else if (result) {
        callback(null, result);
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }

    const returnObj = {
      then: (resolve: (value: { stdout: string; stderr: string }) => void, reject: (err: Error) => void) => {
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result || { stdout: "", stderr: "" });
        }
        return returnObj;
      },
      catch: (reject: (err: Error) => void) => {
        if (result instanceof Error) {
          reject(result);
        }
        return returnObj;
      },
    };
    return returnObj as unknown as ReturnType<typeof childProcess.exec>;
  }) as unknown as typeof childProcess.exec);
}

function setupExecFileMock(results: Record<string, { stdout: string; stderr: string } | Error> = {}) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
    maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    const key = `${cmd} ${args.join(" ")}`;

    let result: { stdout: string; stderr: string } | Error | undefined;
    for (const k of [...Object.keys(results), ...Object.keys(execFileFallbackResults)]) {
      if (key.includes(k) || k.includes(cmd)) {
        result = results[k] ?? execFileFallbackResults[k];
        break;
      }
    }

    const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;

    if (callback) {
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else if (result) {
        callback(null, result);
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }

    const returnObj = {
      then: (resolve: (value: { stdout: string; stderr: string }) => void, reject: (err: Error) => void) => {
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result || { stdout: "", stderr: "" });
        }
        return returnObj;
      },
      catch: (reject: (err: Error) => void) => {
        if (result instanceof Error) {
          reject(result);
        }
        return returnObj;
      },
    };
    return returnObj as unknown as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("updater", () => {
  let updater: typeof import("@/lib/updater");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.GATEWAY_HEALTH_WAIT_MS = "1";
    process.env.GATEWAY_RECOVERY_WAIT_MS = "1";
    process.env.GATEWAY_WAIT_INTERVAL_MS = "1";
    // Pin the SKU: the step list is edition-dependent, so without this the
    // expectations below that look for `gateway_verify` would fail on a Hermes
    // box, where it is (correctly) filtered out. Only the edition VALUE is set
    // here — vitest.config.ts already points CLAWBOX_EDITION_FILE at a path
    // that cannot exist, which is what makes process.env authoritative.
    process.env.CLAWBOX_EDITION = "openclaw";

    mockGet.mockResolvedValue(undefined);
    mockSet.mockResolvedValue();
    mockSetMany.mockResolvedValue();
    // A box that got through the rebuild has a BUILD_ID; an absent one is now
    // itself proof the rebuild failed (TASK-709), so the default fixture is a
    // box that DID build and every case about a missing or unchanged build
    // says so explicitly.
    mockReadFile.mockImplementation(async (file) => {
      if (String(file).endsWith("BUILD_ID")) return "rebuilt-build-id\n";
      throw new Error("ENOENT");
    });
    // The FLAT standalone layout — the entry is where it looks like it is.
    // The nested one has a case of its own.
    mockRealpath.mockImplementation((async (p: unknown) => String(p)) as never);
    mockGatewayUp.mockResolvedValue(true);

    setupExecMock({
      "ls-remote": { stdout: "abc123\trefs/tags/v1.0.0\ndef456\trefs/tags/v1.1.0\n", stderr: "" },
      "symbolic-ref": { stdout: "main\n", stderr: "" },
      "npm view": { stdout: "1.0.0\n", stderr: "" },
    });

    setupExecFileMock({
      ping: { stdout: "", stderr: "" },
      systemctl: { stdout: "", stderr: "" },
      openclaw: { stdout: "1.0.0", stderr: "" },
    });

    updater = await import("@/lib/updater");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete process.env.GATEWAY_HEALTH_WAIT_MS;
    delete process.env.GATEWAY_RECOVERY_WAIT_MS;
    delete process.env.GATEWAY_WAIT_INTERVAL_MS;
    // NOT CLAWBOX_EDITION_FILE — that is a suite-wide guarantee from
    // vitest.config.ts, and deleting it here would leave later files in this
    // worker reading the real /etc/clawbox/edition.env.
    delete process.env.CLAWBOX_EDITION;
  });

  describe("getUpdateState", () => {
    it("returns idle state initially", () => {
      const state = updater.getUpdateState();

      expect(state.phase).toBe("idle");
      expect(state.steps.length).toBeGreaterThan(0);
      expect(state.steps[0].id).toBe("bootstrap_updater");
      expect(state.currentStepIndex).toBe(-1);
    });

    it("returns a copy of the state", () => {
      const state1 = updater.getUpdateState();
      const state2 = updater.getUpdateState();

      expect(state1).not.toBe(state2);
      expect(state1.steps).not.toBe(state2.steps);
    });
  });

  describe("resetUpdateState", () => {
    it("resets state to idle", () => {
      updater.resetUpdateState();

      const state = updater.getUpdateState();
      expect(state.phase).toBe("idle");
      expect(state.steps.every(s => s.status === "pending")).toBe(true);
    });
  });

  /**
   * The run state is this process's memory, and on 2026-09-05 the step that
   * FAILED was the restart — so nothing was going to clear it. System Update
   * adopts such a failure now instead of showing "1 update available" over it,
   * which only works if the owner's Dismiss can reach the server's copy.
   */
  describe("dismissSettledUpdate", () => {
    it("forgets a settled run", async () => {
      // Driven through the post-restart continuation, the way the advisory
      // case above is: a full `startUpdate` never settles in a test, because
      // rebuild_reboot waits to be killed by the restart it asks for.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": new Error("systemctl failed"),
        "show clawbox-root-update@post_update.service": { stdout: "failed\n", stderr: "" },
        "/usr/bin/journalctl": { stdout: "Error: rebuild failed (exit 137)\n", stderr: "" },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      mockGet.mockResolvedValue(true);
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => {
        expect(updater.getUpdateState().phase).toBe("failed");
      });

      await vi.waitFor(async () => {
        expect((await updater.dismissSettledUpdate()).dismissed).toBe(true);
      });
      const state = updater.getUpdateState();
      expect(state.phase).toBe("idle");
      expect(state.steps.every((step) => step.status === "pending")).toBe(true);
    });

    it("refuses while a run owns the box, so it cannot clear a live run's state", async () => {
      updater.resetUpdateState();
      updater.startUpdate();

      expect(await updater.dismissSettledUpdate()).toEqual({
        dismissed: false,
        reason: "in-progress",
        error: "An update is in progress",
      });
      expect(updater.getUpdateState().phase).toBe("running");
    });
  });

  describe("isUpdateCompleted", () => {
    it("returns false when update not completed", async () => {
      mockGet.mockResolvedValue(undefined);

      const completed = await updater.isUpdateCompleted();
      expect(completed).toBe(false);
    });

    it("returns true when update completed", async () => {
      mockGet.mockResolvedValue(true);

      const completed = await updater.isUpdateCompleted();
      expect(completed).toBe(true);
    });
  });

  describe("startUpdate", () => {
    it("starts update when not running", () => {
      updater.resetUpdateState();
      const result = updater.startUpdate();

      expect(result.started).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("returns error when already running", () => {
      updater.resetUpdateState();
      updater.startUpdate();

      const result = updater.startUpdate();

      expect(result.started).toBe(false);
      expect(result.error).toContain("already in progress");
    });

    it("sets phase to running", () => {
      updater.resetUpdateState();
      updater.startUpdate();

      const state = updater.getUpdateState();
      expect(state.phase).toBe("running");
    });

    it("uses the root step journal output when a root update step fails", async () => {
      setupExecFileMock({
        "clawbox-run-root-step.sh apt_update": new Error("systemctl failed"),
        // The journal only overrides the error when the unit reports failed.
        "show clawbox-root-update@apt_update.service": { stdout: "failed\n", stderr: "" },
        "/usr/bin/journalctl": {
          stdout: "Waiting for apt lock...\nE: Could not get lock /var/lib/dpkg/lock-frontend\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(undefined);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      updater.startUpdate();
      await vi.waitFor(() => {
        const state = updater.getUpdateState();
        const aptStep = state.steps.find((step) => step.id === "apt_update");
        expect(aptStep?.status).toBe("failed");
      });

      const state = updater.getUpdateState();
      const aptStep = state.steps.find((step) => step.id === "apt_update");
      expect(aptStep?.status).toBe("failed");
      expect(aptStep?.error).toBe("E: Could not get lock /var/lib/dpkg/lock-frontend");
    });

    /**
     * 2026-09-05, on the box: the rebuild was OOM-killed and the failed step
     * recorded "clawbox-root-update@rebuild_reboot.service: Consumed 8.523s CPU
     * time." as the reason — systemd's accounting epilogue, which is ALWAYS the
     * last line after a unit exits — while `Error: rebuild failed (exit 137)`
     * sat four lines above it. The journal below is that tail, sudo/PAM noise
     * and all; the step here is apt_update only because it is the one this
     * harness can drive, the reader is the same one.
     */
    it("names the step's own error, not systemd's epilogue, when a root step fails", async () => {
      setupExecFileMock({
        "clawbox-run-root-step.sh apt_update": new Error("systemctl failed"),
        "show clawbox-root-update@apt_update.service": { stdout: "failed\n", stderr: "" },
        "/usr/bin/journalctl": {
          stdout: [
            "Starting ClawBox Root Update Step (apt_update).",
            "    root : PWD=/ ; USER=clawbox ; COMMAND=/usr/bin/systemctl --user stop kokoro-server.service",
            "pam_unix(sudo:session): session opened for user clawbox(uid=1000) by (uid=0)",
            "Running bun build...",
            "(to clawbox) root on none",
            "Error: rebuild failed (exit 137)",
            "  Restored the previous build; the dashboard answers on :80 again",
            "clawbox-root-update@apt_update.service: Main process exited, code=exited, status=137/n/a",
            "clawbox-root-update@apt_update.service: Failed with result 'exit-code'.",
            "Failed to start ClawBox Root Update Step (apt_update).",
            "clawbox-root-update@apt_update.service: Consumed 8.523s CPU time.",
            "",
          ].join("\n"),
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(undefined);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      updater.startUpdate();
      await vi.waitFor(() => {
        expect(updater.getUpdateState().steps.find((s) => s.id === "apt_update")?.status).toBe("failed");
      });

      const aptStep = updater.getUpdateState().steps.find((step) => step.id === "apt_update");
      expect(aptStep?.error).toBe("Error: rebuild failed (exit 137)");
    });

    it("falls back to the step's last own line when nothing said 'Error:'", async () => {
      // Neither systemd's summary nor the sudo session pair the rebuild leaves
      // behind is the reason a step failed, so the fallback has to reach past
      // both to the last thing the STEP itself wrote.
      setupExecFileMock({
        "clawbox-run-root-step.sh apt_update": new Error("systemctl failed"),
        "show clawbox-root-update@apt_update.service": { stdout: "failed\n", stderr: "" },
        "/usr/bin/journalctl": {
          stdout: [
            "E: Could not get lock /var/lib/dpkg/lock-frontend",
            "pam_unix(sudo:session): session closed for user clawbox",
            "clawbox-root-update@apt_update.service: Failed with result 'exit-code'.",
            "clawbox-root-update@apt_update.service: Consumed 1.204s CPU time.",
            "",
          ].join("\n"),
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(undefined);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      updater.startUpdate();
      await vi.waitFor(() => {
        expect(updater.getUpdateState().steps.find((s) => s.id === "apt_update")?.status).toBe("failed");
      });

      const aptStep = updater.getUpdateState().steps.find((step) => step.id === "apt_update");
      expect(aptStep?.error).toBe("E: Could not get lock /var/lib/dpkg/lock-frontend");
    });

    it("reports a budget overrun instead of the journal when a root step times out", async () => {
      // execFile kills the blocking `systemctl start` when OUR timeout
      // expires (err.killed) — the unit itself usually keeps running. The
      // journal's last line at that moment is just whatever fixup finished
      // most recently and must NOT be presented as the failure.
      const timeoutErr = Object.assign(new Error("Command failed"), { killed: true });
      setupExecFileMock({
        "clawbox-run-root-step.sh apt_update": timeoutErr,
        "show clawbox-root-update@apt_update.service": { stdout: "success\n", stderr: "" },
        "/usr/bin/journalctl": {
          stdout: "Linkdown routing sysctl installed\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(undefined);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      updater.startUpdate();
      await vi.waitFor(() => {
        const state = updater.getUpdateState();
        const aptStep = state.steps.find((step) => step.id === "apt_update");
        expect(aptStep?.status).toBe("failed");
      });

      const aptStep = updater.getUpdateState().steps.find((step) => step.id === "apt_update");
      expect(aptStep?.error).toContain("was still running after");
      expect(aptStep?.error).not.toContain("Linkdown");
    });

    it("treats a post_update budget overrun as advisory — the update still completes", async () => {
      // post_update's content is non-fatal by design (every fixup is
      // `|| warn`); an overrun just means cold caches made it slow. Failing
      // the whole update over it painted "Update failed" (with a Retry that
      // re-runs everything) on a successful update.
      const timeoutErr = Object.assign(new Error("Command failed"), { killed: true });
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": timeoutErr,
        "show clawbox-root-update@post_update.service -p ActiveState": { stdout: "inactive\n", stderr: "" },
        "show clawbox-root-update@post_update.service -p Result": { stdout: "success\n", stderr: "" },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(undefined);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");

      // Drive it through the post-restart continuation: resumes at post_update.
      updater.resetUpdateState();
      mockGet.mockResolvedValue(true);
      const result = await updater.checkContinuation();
      expect(result).toBe(true);

      await vi.waitFor(() => {
        expect(updater.getUpdateState().phase).toBe("completed");
      });
      const postStep = updater.getUpdateState().steps.find((step) => step.id === "post_update");
      expect(postStep?.status).toBe("completed");
      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      const settleIndex = calls.findIndex((call) =>
        call.includes("show clawbox-root-update@post_update.service -p ActiveState --value"),
      );
      const firstUnmaskIndex = calls.findIndex((call) =>
        call.includes("systemctl --runtime unmask clawbox-gateway.service"),
      );
      expect(settleIndex).toBeGreaterThanOrEqual(0);
      expect(firstUnmaskIndex).toBeGreaterThan(settleIndex);
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ update_completed: true }),
      );
    });

    it("clears the interruption record in the same write that records the completion", async () => {
      // Any reader that finds "locked, nothing left to resume, not completed"
      // stamps `update_interrupted_at` — and that is exactly what the SECOND
      // half of an ordinary update looks like from a process that is not the
      // one running it. A completion that leaves the record standing is the
      // false failure of 2026-09-06: the box answered "Update failed", every
      // step pending, over an update that had finished 71 seconds later.
      vi.resetModules();
      mockGet.mockResolvedValue(undefined);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      mockGet.mockResolvedValue(true);
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => {
        expect(updater.getUpdateState().phase).toBe("completed");
      });

      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ update_completed: true, update_interrupted_at: undefined }),
      );
    });

    it("does not stop the gateway while its pre-start is still running", async () => {
      // At boot clawbox-gateway.service and clawbox-setup.service start
      // together, and the gateway's ExecStartPre (gateway-pre-start.sh) can
      // spend minutes in a plugin install on a cold box. The second half of
      // an update is resumed from boot now, and its first act is to quiesce
      // the gateway — `systemctl stop` on a unit in `start-pre` kills that
      // migration halfway, the very thing the pre-start budget exists to
      // prevent. The quiesce has to let the pre-start finish first.
      const preStart = { stdout: "start-pre\n", stderr: "" };
      setupExecFileMock({
        "show clawbox-gateway.service -p SubState": preStart,
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });
      // The first query sees the pre-start running; every later one sees it
      // done (the mock reads `preStart` at call time).
      const answer = mockExecFile.getMockImplementation()!;
      let preStartQueries = 0;
      mockExecFile.mockImplementation(((cmd: string, args: string[], ...rest: unknown[]) => {
        if (args.join(" ").includes("clawbox-gateway.service -p SubState") && preStartQueries++ > 0) {
          preStart.stdout = "running\n";
        }
        return (answer as (...a: unknown[]) => unknown)(cmd, args, ...rest);
      }) as unknown as typeof childProcess.execFile);

      updater.resetUpdateState();
      mockGet.mockResolvedValue(true);
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => {
        expect(updater.getUpdateState().phase).toBe("completed");
      });

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      const firstMask = calls.findIndex((call) => call.includes("systemctl --runtime mask clawbox-gateway.service"));
      const firstStop = calls.findIndex((call) => call.includes("systemctl stop clawbox-gateway.service"));
      const subStateQueries = calls
        .map((call, index) => call.includes("show clawbox-gateway.service -p SubState --value") ? index : -1)
        .filter((index) => index >= 0);
      expect(firstMask).toBeGreaterThan(-1);
      expect(firstStop).toBeGreaterThan(firstMask);
      // Masked first (nothing can enter start-pre behind the wait), then
      // asked, saw the pre-start running, asked again, and only then stopped.
      expect(subStateQueries[0]).toBeGreaterThan(firstMask);
      expect(subStateQueries.filter((index) => index < firstStop).length).toBeGreaterThanOrEqual(2);
    });

    it("keeps waiting when the pre-start state cannot be read", async () => {
      // A `systemctl show` that times out under a cold box's load says
      // nothing about the pre-start. Treating "unanswered" as "finished"
      // would stop the gateway mid-migration on exactly the boot this wait
      // exists for. Ask again; stop only once the unit is seen out of
      // `start-pre`.
      const preStart = { stdout: "start-pre\n", stderr: "" };
      setupExecFileMock({
        "show clawbox-gateway.service -p SubState": preStart,
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });
      const answer = mockExecFile.getMockImplementation()!;
      const answers = [new Error("systemctl timed out"), { stdout: "start-pre\n", stderr: "" }, { stdout: "running\n", stderr: "" }];
      let query = 0;
      mockExecFile.mockImplementation(((cmd: string, args: string[], ...rest: unknown[]) => {
        if (args.join(" ").includes("clawbox-gateway.service -p SubState")) {
          const next = answers[Math.min(query++, answers.length - 1)];
          if (next instanceof Error) {
            const callback = rest.find((arg) => typeof arg === "function") as
              ((error: Error | null, result: { stdout: string; stderr: string }) => void) | undefined;
            callback?.(next, { stdout: "", stderr: "" });
            return { then: (_: unknown, reject: (err: Error) => void) => reject(next) };
          }
          preStart.stdout = next.stdout;
        }
        return (answer as (...a: unknown[]) => unknown)(cmd, args, ...rest);
      }) as unknown as typeof childProcess.execFile);

      updater.resetUpdateState();
      mockGet.mockResolvedValue(true);
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => {
        expect(updater.getUpdateState().phase).toBe("completed");
      });

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      const firstStop = calls.findIndex((call) => call.includes("systemctl stop clawbox-gateway.service"));
      const subStateQueriesBeforeStop = calls
        .slice(0, firstStop)
        .filter((call) => call.includes("show clawbox-gateway.service -p SubState --value"));
      expect(firstStop).toBeGreaterThan(-1);
      // Unanswered, then start-pre, then running — and only then stopped.
      expect(subStateQueriesBeforeStop.length).toBeGreaterThanOrEqual(3);
    });

    it("fails when an overrun post_update later settles with a systemd error result", async () => {
      const timeoutErr = Object.assign(new Error("Command failed"), { killed: true });
      setupExecFileMock({
        // The root step goes through the sudo launcher now (TASK-539), so the
        // simulated client timeout has to land on that call — an injection at
        // `systemctl start clawbox-root-update@…` would never fire.
        "clawbox-run-root-step.sh post_update": timeoutErr,
        "show clawbox-root-update@post_update.service -p ActiveState": {
          stdout: "failed\n",
          stderr: "",
        },
        "show clawbox-root-update@post_update.service -p Result": {
          stdout: "exit-code\n",
          stderr: "",
        },
        "/usr/bin/journalctl -u clawbox-root-update@post_update.service": {
          stdout: "post_update exited with status 1\n",
          stderr: "",
        },
        "/usr/bin/journalctl -u clawbox-gateway.service": { stdout: "", stderr: "" },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(
        () => expect(updater.getUpdateState().phase).toBe("failed"),
        { timeout: 5_000 },
      );

      const postStep = updater.getUpdateState().steps.find((step) => step.id === "post_update");
      expect(postStep?.status).toBe("failed");
      expect(postStep?.error).toBe("post_update exited with status 1");
      // No COMPLETION was persisted. `setMany` itself is called once per run
      // now — the prologue clears the previous run's markers with it
      // (TASK-731) — so the assertion is about the payload, not the call.
      expect(mockSetMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ update_completed: true }),
      );
    });

    it("fails the continuation when gateway verification still finds no known recovery path", async () => {
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: "gateway crashed for an unrelated reason\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockGatewayUp.mockResolvedValue(false);
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      const result = await updater.checkContinuation();
      expect(result).toBe(true);

      await vi.waitFor(() => {
        const state = updater.getUpdateState();
        expect(state.phase).toBe("failed");
        expect(state.error).toContain("OpenClaw gateway is not listening on port 18789");
      });
    });

    it("serializes post_update and repairs reported Codex consent before one recovery restart", async () => {
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: "Plugin \"codex\" requires capability consent\n[sqlite/transaction] SQLite transaction lock wait failed\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "Codex runtime plugin capabilities accepted/current\n", stderr: "" },
      });

      const priorRoot = process.env.CLAWBOX_ROOT;
      process.env.CLAWBOX_ROOT = process.cwd();
      vi.stubEnv("CLAWBOX_OPENCLAW_HOME", "/tmp/clawbox-updater-openclaw-home");
      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      // Health is impossible until BOTH explicit consent and the later system
      // restart occurred. Merely invoking pre-start must never make this green.
      mockGatewayUp.mockImplementation(async () => {
        const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
          `${cmd} ${(args as string[]).join(" ")}`,
        );
        const consentIndex = calls.findIndex((call) =>
          call.includes("plugins install @openclaw/codex@2026.8.1 --force --accept-capabilities"),
        );
        const restartIndex = calls.findIndex((call) =>
          call.includes("systemctl restart clawbox-gateway.service"),
        );
        return consentIndex >= 0 && restartIndex > consentIndex;
      });
      // The state the boot script's own boot-without leaves behind: the payload
      // could not be installed, so the entry was switched off and the row says
      // ClawBox did it. That is what the repair below has to undo.
      mockReadPluginRepairs.mockResolvedValue({
        codex: {
          id: "codex", stage: "install", reason: "offline", atMs: 1,
          disabled: true, spec: "@openclaw/codex@2026.8.1",
        },
      });
      mockClawboxDisabledEntryId.mockResolvedValue("codex");
      // openclaw.json as `plugins enable codex` leaves it. The repair proves its
      // re-enable against the FILE rather than against an exit code, so the
      // fixture has to model the write the verb performs — a stub that answered
      // the exit code alone would have blessed a clear this test is about.
      mockReadFile.mockImplementation(async (file) => {
        if (String(file).endsWith("BUILD_ID")) return "rebuilt-build-id\n";
        if (String(file).endsWith("/openclaw.json")) {
          const enabled = mockExecFile.mock.calls.some(([, args]) =>
            (args as string[] | undefined)?.join(" ").includes("plugins enable codex"),
          );
          return JSON.stringify({ plugins: { entries: { codex: { enabled } } } });
        }
        throw new Error("ENOENT");
      });
      updater = await import("@/lib/updater");
      if (priorRoot === undefined) delete process.env.CLAWBOX_ROOT;
      else process.env.CLAWBOX_ROOT = priorRoot;

      updater.resetUpdateState();
      const result = await updater.checkContinuation();
      expect(result).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      const postUpdateIndex = calls.findIndex((call) =>
        call.includes("/usr/bin/sudo -n /usr/local/libexec/clawbox/clawbox-run-root-step.sh post_update"),
      );
      const preStartIndex = calls.findIndex((call) =>
        call.includes("/bin/bash") && call.includes("scripts/gateway-pre-start.sh"),
      );
      const maskIndexes = calls
        .map((call, index) => call.includes("systemctl --runtime mask clawbox-gateway.service") ? index : -1)
        .filter((index) => index >= 0);
      const stopIndexes = calls
        .map((call, index) => call.includes("systemctl stop clawbox-gateway.service") ? index : -1)
        .filter((index) => index >= 0);
      const unmaskIndexes = calls
        .map((call, index) => call.includes("systemctl --runtime unmask clawbox-gateway.service") ? index : -1)
        .filter((index) => index >= 0);
      const consentIndex = calls.findIndex((call) =>
        call.includes("plugins install @openclaw/codex@2026.8.1 --force --accept-capabilities"),
      );
      const doctorIndex = calls.findIndex((call) =>
        call.includes("openclaw doctor --fix --yes --non-interactive"),
      );
      const restartIndexes = calls
        .map((call, index) => call.includes("systemctl restart clawbox-gateway.service") ? index : -1)
        .filter((index) => index >= 0);

      // The OTHER half of the same repair (TASK-606): the boot script marked
      // codex as needing repair, this update put the payload back, and a marker
      // only the boot script ever cleared would leave a permanent "Needs
      // repair" badge on a plugin that is now fine.
      expect(mockClearPluginRepair.mock.calls.flat()).toContain("codex");

      // …and the entry the boot script switched off is put back BEFORE the
      // badge goes. `plugins install` leaves an explicitly disabled entry
      // alone, so clearing on the install alone would take the badge off a
      // plugin that is still switched off — the false success this card is
      // about. `plugins enable` is the harness's own verb for it, and it also
      // re-records the consent surface.
      const enableIndex = calls.findIndex((call) =>
        call.includes("plugins enable codex --accept-capabilities"),
      );
      expect(enableIndex).toBeGreaterThanOrEqual(0);
      expect(enableIndex).toBeGreaterThan(consentIndex);

      expect(maskIndexes).toHaveLength(2);
      expect(stopIndexes).toHaveLength(2);
      expect(unmaskIndexes).toHaveLength(2);
      expect(maskIndexes[0]).toBeLessThan(stopIndexes[0]);
      expect(stopIndexes[0]).toBeLessThan(postUpdateIndex);
      expect(postUpdateIndex).toBeLessThan(unmaskIndexes[0]);
      expect(maskIndexes[1]).toBeLessThan(stopIndexes[1]);
      expect(stopIndexes[1]).toBeLessThan(preStartIndex);
      expect(preStartIndex).toBeLessThan(consentIndex);
      expect(consentIndex).toBeLessThan(doctorIndex);
      expect(doctorIndex).toBeLessThan(unmaskIndexes[1]);
      expect(restartIndexes).toHaveLength(1);
      expect(restartIndexes[0]).toBeGreaterThan(unmaskIndexes[1]);
      const preStartOptions = mockExecFile.mock.calls[preStartIndex]?.[2] as
        | { env?: NodeJS.ProcessEnv }
        | undefined;
      // The OpenClaw CLI reads OPENCLAW_HOME as the ACCOUNT home and would
      // put its tree at <that>/.openclaw: the pre-start must get ClawBox's
      // name for the directory and the CLI's two canonical overrides, never
      // the misread one.
      expect(preStartOptions?.env?.OPENCLAW_HOME).toBeUndefined();
      expect(preStartOptions?.env?.CLAWBOX_OPENCLAW_HOME)
        .toBe("/tmp/clawbox-updater-openclaw-home");
      expect(preStartOptions?.env?.OPENCLAW_STATE_DIR)
        .toBe("/tmp/clawbox-updater-openclaw-home");
      expect(preStartOptions?.env?.OPENCLAW_CONFIG_PATH)
        .toBe("/tmp/clawbox-updater-openclaw-home/openclaw.json");
    });

    it("records consent for a NON-Codex managed plugin the gateway named", async () => {
      // TASK-603. The 2026-09-01 outage was `discord`, not `codex`: the core
      // refuses readiness for any enabled plugin whose declared capability
      // surface is unconsented, names it, and tells the operator to rerun with
      // --accept-capabilities. This recovery matched the literal word `codex`,
      // so the box went through the whole quiesce/pre-start/doctor/restart pass
      // untouched and the owner was handed that sentence about a CLI he never
      // ran. `plugins enable <id> --accept-capabilities` is the harness's own
      // idempotent consent verb — the same one gateway-pre-start.sh uses for
      // Codex — and it touches no registry, which matters on a box whose
      // network may be why the update is being repaired.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: "Plugin \"discord\" requires capability consent; rerun with --accept-capabilities.\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      // Health is impossible until the consent AND the later restart happened,
      // so merely running the pre-start can never make this green.
      mockGatewayUp.mockImplementation(async () => {
        const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
          `${cmd} ${(args as string[]).join(" ")}`,
        );
        const consentIndex = calls.findIndex((call) =>
          call.includes("plugins enable discord --accept-capabilities"),
        );
        const restartIndex = calls.findIndex((call) =>
          call.includes("systemctl restart clawbox-gateway.service"),
        );
        return consentIndex >= 0 && restartIndex > consentIndex;
      });
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) => call.includes("plugins enable discord --accept-capabilities")))
        .toBe(true);
      // Never a reinstall for this arm: the package is on disk (the gateway
      // would not be naming it otherwise) and an unpinned npm fetch mid-update
      // is the failure this repair exists to get out of.
      expect(calls.some((call) => call.includes("plugins install @openclaw/discord"))).toBe(false);
    });

    it("repairs EVERY managed plugin the boot journal names, not just the first", async () => {
      // The journal tail is the whole boot (`journalctl -b`) and the gateway
      // restarts several times during an update, so a stale line can sit ahead
      // of the live one. Reading only the first match repaired codex — already
      // consented by the pre-start — while `getGatewayFailureDetail`, which
      // scans in reverse, handed the owner the DISCORD sentence. Same call,
      // two halves disagreeing about which plugin is blocking.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: [
            'Plugin "codex" requires capability consent; rerun with --accept-capabilities.',
            "Codex runtime plugin capabilities accepted/current",
            'Plugin "discord" requires capability consent; rerun with --accept-capabilities.',
            "",
          ].join("\n"),
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockGatewayUp.mockImplementation(async () =>
        mockExecFile.mock.calls.some(([cmd, args]) =>
          `${cmd} ${(args as string[]).join(" ")}`
            .includes("plugins enable discord --accept-capabilities"),
        ),
      );
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) => call.includes("plugins install @openclaw/codex@2026.8.1 --force --accept-capabilities")))
        .toBe(true);
      expect(calls.some((call) => call.includes("plugins enable discord --accept-capabilities")))
        .toBe(true);
    });

    it("leaves a managed plugin the OWNER switched off switched off", async () => {
      // `plugins enable` writes `plugins.entries.<id>.enabled = true`, and the
      // journal tail predates the pre-start. So an owner who reached for the
      // Terminal and ran `openclaw plugins disable discord` to get his box back
      // would have had the channel — and consent in his name — restored by the
      // next update. The Codex arm has always respected this; the new one must.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: 'Plugin "discord" requires capability consent; rerun with --accept-capabilities.\n',
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockReadFile.mockImplementation(async (file) => {
        const name = String(file);
        if (name.endsWith("BUILD_ID")) return "rebuilt-build-id\n";
        if (name.endsWith("openclaw.json")) {
          return JSON.stringify({ plugins: { entries: { discord: { enabled: false } } } });
        }
        throw new Error("ENOENT");
      });
      mockGatewayUp.mockResolvedValue(false);
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("failed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) => call.includes("plugins enable discord"))).toBe(false);
    });

    it("repairs a plugin named twice under different spellings only ONCE", async () => {
      // One boot's journal can carry both spellings — a restart before the
      // registry key changed, an alias from `plugins list`. Repairing per raw
      // name would give the pinned force-install two six-minute budgets back
      // to back on a Jetson for one plugin.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: [
            'Plugin "discord" requires capability consent; rerun with --accept-capabilities.',
            'Plugin "openclaw-discord" requires capability consent; rerun with --accept-capabilities.',
            "",
          ].join("\n"),
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockGatewayUp.mockImplementation(async () =>
        mockExecFile.mock.calls.some(([cmd, args]) =>
          `${cmd} ${(args as string[]).join(" ")}`.includes("plugins enable"),
        ),
      );
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const enables = mockExecFile.mock.calls
        .map(([cmd, args]) => `${cmd} ${(args as string[]).join(" ")}`)
        .filter((call) => call.includes("plugins enable"));
      expect(enables).toHaveLength(1);
      // The FIRST spelling the journal used — the name the registry answered to
      // when it refused.
      expect(enables[0]).toContain("plugins enable discord --accept-capabilities");
    });

    it("respects an owner-disabled plugin recorded under its ALIAS", async () => {
      // The journal names the core's own plugin id (`discord`), while
      // `plugins.entries` can be keyed under the alias `ensureChannelPlugin`
      // enabled it as (`openclaw-discord`). A literal lookup misses the
      // owner's explicit `enabled: false` and reads it as "no opinion", so the
      // repair switches his channel back on with consent granted in his name.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: 'Plugin "discord" requires capability consent; rerun with --accept-capabilities.\n',
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockReadFile.mockImplementation(async (file) => {
        const name = String(file);
        if (name.endsWith("BUILD_ID")) return "rebuilt-build-id\n";
        if (name.endsWith("openclaw.json")) {
          return JSON.stringify({
            plugins: { entries: { "openclaw-discord": { enabled: false } } },
          });
        }
        throw new Error("ENOENT");
      });
      mockGatewayUp.mockResolvedValue(false);
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("failed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) => call.includes("plugins enable discord"))).toBe(false);
    });

    it("leaves a plugin ClawBox does not manage to its owner", async () => {
      // Consenting on the owner's behalf is only defensible for a package
      // ClawBox chose and installed. Something he added from the Terminal has
      // an owner who can answer for it, and the failure detail still names it.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: "Plugin \"weatherbot\" requires capability consent; rerun with --accept-capabilities.\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockGatewayUp.mockResolvedValue(false);
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => {
        const state = updater.getUpdateState();
        expect(state.phase).toBe("failed");
        expect(state.error).toContain('Plugin "weatherbot" requires capability consent');
      });

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) => call.includes("plugins enable weatherbot"))).toBe(false);
    });

    it("reinstalls a managed plugin whose payload a core upgrade orphaned", async () => {
      // TASK-602. A core bump re-keys `~/.openclaw/npm/projects/` by the new
      // generation, so the payloads installed against the old one are no longer
      // reachable. The core then refuses readiness with a DIFFERENT sentence
      // from the consent one — `configured plugin payload verification failed`
      // — and `plugins enable` cannot answer it: the package is not on disk to
      // be consented to. The repair that works is the pinned reinstall, the
      // same one the Codex arm already runs.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: [
            "OpenClaw plugin verification failed; refusing to report the gateway ready.",
            '- Plugin "discord": configured plugin payload verification failed '
              + "(missing-install-path): install path is missing. "
              + "Run `openclaw update repair` to retry plugin repair.",
            "Resolve the plugin verification errors above, then restart the Gateway.",
            "clawbox-gateway.service: Start request repeated too quickly.",
            "",
          ].join("\n"),
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      // Only the reinstall can make this box healthy: consenting to a package
      // that is not on disk changes nothing.
      mockGatewayUp.mockImplementation(async () => {
        const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
          `${cmd} ${(args as string[]).join(" ")}`,
        );
        const repairIndex = calls.findIndex((call) =>
          call.includes("plugins install @openclaw/discord@2026.8.1 --force --accept-capabilities"),
        );
        const restartIndex = calls.findIndex((call) =>
          call.includes("systemctl restart clawbox-gateway.service"),
        );
        return repairIndex >= 0 && restartIndex > repairIndex;
      });
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) =>
        call.includes("plugins install @openclaw/discord@2026.8.1 --force --accept-capabilities"),
      )).toBe(true);
    });

    it("names the plugin the core refused, not the systemd start-limit line", async () => {
      // TASK-602's customer-visible half. systemd gives up after the core has
      // exited 21 times, so the LAST journal line on the box is its own
      // start-limit message. With no pattern for the verification refusal the
      // owner was handed that line — nothing about a plugin, nothing to act on
      // — while the sentence naming the plugin sat a few lines above it.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: [
            "OpenClaw plugin verification failed; refusing to report the gateway ready.",
            '- Plugin "whatsapp": configured plugin payload verification failed '
              + "(missing-install-path): install path is missing. "
              + "Run `openclaw update repair` to retry plugin repair.",
            "clawbox-gateway.service: Start request repeated too quickly.",
            "clawbox-gateway.service: Failed with result 'exit-code'.",
            "",
          ].join("\n"),
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockGatewayUp.mockResolvedValue(false);
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("failed"));

      const error = updater.getUpdateState().error ?? "";
      expect(error).toContain('Plugin "whatsapp"');
      expect(error).toContain("configured plugin payload verification failed");
      expect(error).not.toContain("Start request repeated too quickly");
    });

    it("continues to doctor and restart when the targeted Codex repair fails", async () => {
      setupExecFileMock({
        // BOTH specs: the pinned one and the unpinned fallback behind it. With
        // only the pinned one refused this would exercise the fallback path
        // succeeding, not the failure this case is about.
        "plugins install @openclaw/codex": new Error(
          "Codex repair timed out",
        ),
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: "Plugin \"codex\" requires capability consent\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockGatewayUp.mockImplementation(async () =>
        mockExecFile.mock.calls.some(([cmd, args]) =>
          cmd === "/usr/bin/sudo"
            && (args as string[]).join(" ").includes("systemctl restart clawbox-gateway.service"),
        ),
      );
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[Updater] payload repair for \"@openclaw/codex\" did not complete:",
        "Codex repair timed out",
      );
      // ONE spec for a consent refusal: the package is on disk, only its
      // consent record is stale, so the unpinned fallback (which exists for a
      // payload that is gone) would be a second npm minute for nothing.
      expect(calls.filter((call) => call.includes("plugins install @openclaw/codex")))
        .toHaveLength(1);
      expect(calls.some((call) => call.includes("openclaw doctor --fix --yes --non-interactive")))
        .toBe(true);
      expect(calls.some((call) => call.includes("systemctl restart clawbox-gateway.service")))
        .toBe(true);
      warnSpy.mockRestore();
    });

    it("falls back to the unpinned spec when the pinned payload is not published", async () => {
      // npm republishes a release under a build suffix (2026.7.1 -> 2026.7.1-2)
      // and a plugin published only under the base version 404s on a pin
      // carrying one. `deepseekPluginSpecs` already answers this the same way.
      setupExecFileMock({
        "plugins install @openclaw/whatsapp@2026.8.1": new Error("404 Not Found"),
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: '- Plugin "whatsapp": configured plugin payload verification failed '
            + "(missing-install-path): install path is missing.\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockGatewayUp.mockImplementation(async () =>
        mockExecFile.mock.calls.some(([cmd, args]) =>
          `${cmd} ${(args as string[]).join(" ")}`
            .includes("plugins install @openclaw/whatsapp --force --accept-capabilities"),
        ),
      );
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.filter((call) => call.includes("plugins install @openclaw/whatsapp")))
        .toEqual([
          expect.stringContaining("plugins install @openclaw/whatsapp@2026.8.1 --force --accept-capabilities"),
          expect.stringContaining("plugins install @openclaw/whatsapp --force --accept-capabilities"),
        ]);
    });

    it("still records local consent when the payload install could not run", async () => {
      // `plugins enable` is the one repair here that touches no registry, and
      // the network is often exactly why the update is being repaired. Treating
      // an ATTEMPTED reinstall as a repair would drop it.
      setupExecFileMock({
        "plugins install @openclaw/discord": new Error("getaddrinfo ENOTFOUND registry.npmjs.org"),
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: [
            '- Plugin "discord": configured plugin payload verification failed '
              + "(missing-install-path): install path is missing.",
            'Plugin "discord" requires capability consent; rerun with --accept-capabilities.',
            "",
          ].join("\n"),
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockGatewayUp.mockImplementation(async () =>
        mockExecFile.mock.calls.some(([cmd, args]) =>
          `${cmd} ${(args as string[]).join(" ")}`
            .includes("plugins enable discord --accept-capabilities"),
        ),
      );
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) => call.includes("plugins enable discord --accept-capabilities")))
        .toBe(true);
    });

    it("does not re-install a payload the gateway pre-start just put back", async () => {
      // The pre-start reinstalls the channel payloads too, and it runs a moment
      // before this. Re-issuing the identical install would pay a second npm
      // fetch per plugin for a package already back on disk.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: '- Plugin "discord": configured plugin payload verification failed '
            + "(missing-install-path): install path is missing.\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        // The pre-start's own report, in its own words.
        "/bin/bash": {
          stdout: "  discord plugin payload reinstalled (@openclaw/discord@2026.8.1)\n",
          stderr: "",
        },
      });

      // The pre-start has to actually RUN for its report to exist.
      const priorRoot = process.env.CLAWBOX_ROOT;
      process.env.CLAWBOX_ROOT = process.cwd();
      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      mockGatewayUp.mockImplementation(async () =>
        mockExecFile.mock.calls.some(([cmd, args]) =>
          `${cmd} ${(args as string[]).join(" ")}`
            .includes("systemctl restart clawbox-gateway.service"),
        ),
      );
      updater = await import("@/lib/updater");
      if (priorRoot === undefined) delete process.env.CLAWBOX_ROOT;
      else process.env.CLAWBOX_ROOT = priorRoot;

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) => call.includes("scripts/gateway-pre-start.sh"))).toBe(true);
      expect(calls.some((call) => call.includes("plugins install @openclaw/discord"))).toBe(false);
    });

    it("spends no npm install after the pre-start itself failed", async () => {
      // A payload reinstall is minutes per plugin on a `customRun` step whose
      // timeoutMs is unenforced, spent after a pre-start that just died — and
      // the update reports that failure either way. Consent only there.
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: '- Plugin "discord": configured plugin payload verification failed '
            + "(missing-install-path): install path is missing.\n",
          stderr: "",
        },
        "/bin/bash": new Error("pre-start failed"),
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      const priorRoot = process.env.CLAWBOX_ROOT;
      process.env.CLAWBOX_ROOT = process.cwd();
      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");
      if (priorRoot === undefined) delete process.env.CLAWBOX_ROOT;
      else process.env.CLAWBOX_ROOT = priorRoot;

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("failed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) => call.includes("plugins install @openclaw/discord"))).toBe(false);
    });

    it("retries a failed maintenance unmask and surfaces the cleanup failure", async () => {
      setupExecFileMock({
        "systemctl --runtime unmask clawbox-gateway.service": new Error("unmask failed"),
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(
        () => expect(updater.getUpdateState().phase).toBe("failed"),
        { timeout: 5_000 },
      );

      const unmaskCalls = mockExecFile.mock.calls.filter(([cmd, args]) =>
        cmd === "/usr/bin/sudo"
          && (args as string[]).join(" ").includes("systemctl --runtime unmask clawbox-gateway.service"),
      );
      expect(unmaskCalls.length).toBeGreaterThanOrEqual(3);
      expect(updater.getUpdateState().steps.find((step) => step.id === "post_update")?.error)
        .toContain("unmask failed");
      errorSpy.mockRestore();
    });

    it("keeps the repair record when `plugins enable` exits 0 without writing", async () => {
      // The read-back's own case. `plugins enable` returning 0 is not the same
      // as the entry being on, and clearing the badge on the exit code alone is
      // the exact false success this card is about — one screen further out
      // than the boot script's "gateway will still start".
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: "Plugin \"codex\" requires capability consent\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockReadPluginRepairs.mockResolvedValue({
        codex: {
          id: "codex", stage: "install", reason: "offline", atMs: 1,
          disabled: true, spec: "@openclaw/codex@2026.8.1",
        },
      });
      mockClawboxDisabledEntryId.mockResolvedValue("codex");
      // The verb exits 0 and the config still says the entry is off.
      mockReadFile.mockImplementation(async (file) => {
        if (String(file).endsWith("BUILD_ID")) return "rebuilt-build-id\n";
        if (String(file).endsWith("/openclaw.json")) {
          return JSON.stringify({ plugins: { entries: { codex: { enabled: false } } } });
        }
        throw new Error("ENOENT");
      });
      mockGatewayUp.mockResolvedValue(true);
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      // The badge stays: the plugin is installed and still switched off, and
      // the row is the only thing that says so.
      expect(mockClearPluginRepair).not.toHaveBeenCalled();
    });

    it("does not re-enable an explicitly disabled unused Codex plugin from a stale journal line", async () => {
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: "Plugin \"codex\" requires capability consent\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockReadFile.mockImplementation(async (file) => {
        if (String(file).endsWith("BUILD_ID")) return "rebuilt-build-id\n";
        if (String(file).endsWith("/openclaw.json")) {
          return JSON.stringify({
            agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
            plugins: { entries: { codex: { enabled: false } } },
          });
        }
        throw new Error("ENOENT");
      });
      mockGatewayUp.mockImplementation(async () =>
        mockExecFile.mock.calls.some(([cmd, args]) =>
          cmd === "/usr/bin/sudo"
            && (args as string[]).join(" ").includes("systemctl restart clawbox-gateway.service"),
        ),
      );
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) =>
        call.includes("plugins install @openclaw/codex@2026.8.1 --force --accept-capabilities"),
      )).toBe(false);
    });

    it("records explicit consent but does not restart when current pre-start fails", async () => {
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: "Plugin \"codex\" requires capability consent\n",
          stderr: "",
        },
        "/bin/bash": new Error("pre-start failed"),
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      const priorRoot = process.env.CLAWBOX_ROOT;
      process.env.CLAWBOX_ROOT = process.cwd();
      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");
      if (priorRoot === undefined) delete process.env.CLAWBOX_ROOT;
      else process.env.CLAWBOX_ROOT = priorRoot;

      updater.resetUpdateState();
      expect(await updater.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("failed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      const preStartIndex = calls.findIndex((call) => call.includes("scripts/gateway-pre-start.sh"));
      // The LOCAL consent verb, not the pinned reinstall: after a pre-start
      // that just died, minutes of npm buy nothing on an update that is about
      // to report that failure.
      const consentIndex = calls.findIndex((call) =>
        call.includes("plugins enable codex --accept-capabilities"),
      );
      expect(calls.some((call) => call.includes("plugins install @openclaw/codex"))).toBe(false);
      const finalUnmaskIndex = calls
        .map((call, index) => call.includes("systemctl --runtime unmask clawbox-gateway.service") ? index : -1)
        .filter((index) => index >= 0)
        .at(-1) ?? -1;
      expect(consentIndex).toBeGreaterThan(preStartIndex);
      expect(finalUnmaskIndex).toBeGreaterThan(consentIndex);
      expect(calls.some((call) => call.includes("systemctl restart clawbox-gateway.service"))).toBe(false);
    });

    it("quarantines known legacy gateway blockers and completes when the gateway recovers", async () => {
      setupExecFileMock({
        "clawbox-run-root-step.sh post_update": { stdout: "", stderr: "" },
        "/usr/bin/journalctl -u clawbox-gateway.service": {
          stdout: "conflicting plugin install metadata\nopenclaw-agent.sqlite belongs to agent piper; requested agent carl_pir\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
        "/bin/bash": { stdout: "moved legacy files\n", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      // The gateway only "recovers" once the legacy-state quarantine has run.
      // Tie the probe to that side-effect instead of a fixed false/false/true
      // call sequence: waitForGateway polls in a loop (deadline/interval are 1ms
      // in these tests), so the old sequence could be fully consumed by the very
      // first poll — reporting recovery BEFORE quarantine ran and leaving no
      // /bin/bash call to assert on. That made this test flaky (~1 in 3).
      mockGatewayUp.mockImplementation(async () =>
        mockExecFile.mock.calls.some(([cmd]) => cmd === "/bin/bash"),
      );
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      const result = await updater.checkContinuation();
      expect(result).toBe(true);

      await vi.waitFor(() => {
        expect(updater.getUpdateState().phase).toBe("completed");
      });
      const bashCall = mockExecFile.mock.calls.find(([cmd]) => cmd === "/bin/bash");
      expect(bashCall?.[1]).toEqual(expect.arrayContaining(["-lc", expect.stringContaining("installs.json")]));
      expect(String((bashCall?.[1] as string[] | undefined)?.[1])).toContain("carl_pir.sqlite");
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ update_completed: true }),
      );
    });

    it("stops the update sequence when bootstrap_updater fails", async () => {
      setupExecFileMock({
        "clawbox-run-root-step.sh bootstrap_updater": new Error("systemctl failed"),
        "show clawbox-root-update@bootstrap_updater.service": { stdout: "failed\n", stderr: "" },
        "/usr/bin/journalctl": {
          stdout: "fatal: invalid branch name in .update-branch\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(undefined);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockRebuiltBox();
      updater = await import("@/lib/updater");

      updater.resetUpdateState();
      updater.startUpdate();
      await vi.waitFor(() => {
        const state = updater.getUpdateState();
        const bootstrapStep = state.steps.find((step) => step.id === "bootstrap_updater");
        expect(bootstrapStep?.status).toBe("failed");
        expect(state.phase).toBe("failed");
      });

      const state = updater.getUpdateState();
      const aptStep = state.steps.find((step) => step.id === "apt_update");
      expect(aptStep?.status).toBe("pending");
      expect(state.error).toBe("fatal: invalid branch name in .update-branch");
    });
  });

  describe("startOpenclawUpdate", () => {
    it("keeps the gateway masked throughout the root package replacement", async () => {
      updater.resetUpdateState();

      expect(updater.startOpenclawUpdate().started).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      const installIndex = calls.findIndex((call) =>
        call.includes("/usr/bin/sudo -n /usr/local/libexec/clawbox/clawbox-run-root-step.sh openclaw_install"),
      );
      const firstMaskIndex = calls.findIndex((call) =>
        call.includes("systemctl --runtime mask clawbox-gateway.service"),
      );
      const firstStopIndex = calls.findIndex((call) =>
        call.includes("systemctl stop clawbox-gateway.service"),
      );
      const firstUnmaskIndex = calls.findIndex((call) =>
        call.includes("systemctl --runtime unmask clawbox-gateway.service"),
      );

      expect(firstMaskIndex).toBeLessThan(firstStopIndex);
      expect(firstStopIndex).toBeLessThan(installIndex);
      expect(installIndex).toBeLessThan(firstUnmaskIndex);
      expect(calls.slice(firstMaskIndex, firstUnmaskIndex + 1).some((call) =>
        call.includes("systemctl restart clawbox-gateway.service"),
      )).toBe(false);
    });
  });

  describe("checkContinuation", () => {
    it("returns false when already running", async () => {
      updater.resetUpdateState();
      updater.startUpdate();

      const result = await updater.checkContinuation();
      expect(result).toBe(false);
    });

    it("returns false when no continuation needed", async () => {
      updater.resetUpdateState();
      mockGet.mockResolvedValue(undefined);

      const result = await updater.checkContinuation();
      expect(result).toBe(false);
    });

    it("returns true and starts continuation when flag is set", async () => {
      updater.resetUpdateState();
      mockGet.mockResolvedValue(true);

      const result = await updater.checkContinuation();

      expect(result).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ update_needs_continuation: undefined }),
      );
    });

    it("treats the restart it asked for as expected, not as an interruption", async () => {
      // The continuation flag IS the proof that the web server was replaced on
      // purpose. Anything a reader stamped while that restart was under way
      // describes this update's own normal path, so it goes with the flag.
      updater.resetUpdateState();
      mockGet.mockResolvedValue(true);

      await updater.checkContinuation();

      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({
          update_needs_continuation: undefined,
          update_interrupted_at: undefined,
        }),
      );
    });

    it("resumes once when a boot check and a status poll overlap, and tells both", async () => {
      // The boot hook and the status route can both ask within the same
      // tick. The flag read is an await, so without a claim taken BEFORE it
      // both callers read the flag as set and both launch the second half of
      // the update — post_update twice, two gateway restarts. The second
      // caller joins the first's read: a poll that lands here must answer
      // "running", not "idle", so it gets the same true.
      updater.resetUpdateState();
      const flagRead = deferred();
      mockGet.mockImplementation(async (key: string) =>
        key === "update_needs_continuation" ? flagRead.promise.then(() => true) : undefined,
      );

      const fromBoot = updater.checkContinuation();
      const fromPoll = updater.checkContinuation();
      flagRead.resolve();

      expect(await Promise.all([fromBoot, fromPoll])).toEqual([true, true]);
      expect(
        mockSetMany.mock.calls.filter(([entries]) => "update_needs_continuation" in entries),
      ).toHaveLength(1);
      expect(mockGet.mock.calls.filter(([key]) => key === "update_needs_continuation")).toHaveLength(1);
    });

    it("refuses a full or scoped update while the continuation is being read", async () => {
      // Between the claim and `running = true` the check is reading persisted
      // state. A POST /update/run in that window used to see `running` false
      // and launch a full update under the second half about to resume.
      updater.resetUpdateState();
      const flagRead = deferred();
      mockGet.mockImplementation(async (key: string) =>
        key === "update_needs_continuation" ? flagRead.promise.then(() => true) : undefined,
      );

      const continuation = updater.checkContinuation();
      expect(updater.startUpdate()).toEqual({ started: false, error: "Update already in progress" });
      expect(updater.startOpenclawUpdate()).toEqual({ started: false, error: "Update already in progress" });

      flagRead.resolve();
      expect(await continuation).toBe(true);
    });

    it("reports a failed update instead of resuming when the rebuild unit failed", async () => {
      // The continuation flag only proves the rebuild unit STARTED. If the
      // server came back without the unit succeeding (georgi: a config-set
      // conflict killed it before the build), resuming would stamp "Update
      // complete" on a box still running its old build.
      setupExecFileMock({
        "show clawbox-root-update@rebuild_reboot.service -p Result": { stdout: "failed\n", stderr: "" },
        "/usr/bin/journalctl": {
          stdout: "ConfigMutationConflictError: config changed since last load\n",
          stderr: "",
        },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      updater.resetUpdateState();
      mockGet.mockResolvedValue(true);

      const result = await updater.checkContinuation();

      expect(result).toBe(false);
      // Flag still cleared — the failure must not replay on every poll.
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ update_needs_continuation: undefined }),
      );
      const state = updater.getUpdateState();
      expect(state.phase).toBe("failed");
      expect(state.error).toBe("ConfigMutationConflictError: config changed since last load");
      // The UI step's id is "restart"; "rebuild_reboot" is the root UNIT name.
      const rebuildStep = state.steps.find((step) => step.id === "restart");
      expect(rebuildStep?.status).toBe("failed");
    });

    it("reports a failed update when no new build was produced", async () => {
      // Power-cycle scenario: the rebuild unit failed, the box was rebooted
      // before the watcher noticed (so the unit's systemd Result reset), and
      // the stale flag survived. The recorded BUILD_ID still matching the
      // on-disk one is the proof no rebuild happened.
      updater.resetUpdateState();
      mockGet.mockResolvedValue("build-aaa");
      mockReadFile.mockResolvedValue("build-aaa\n");

      const result = await updater.checkContinuation();

      expect(result).toBe(false);
      const state = updater.getUpdateState();
      expect(state.phase).toBe("failed");
      expect(state.error).toContain("without producing a new build");
    });

    it("reports a failed update when the rebuild left no build at all", async () => {
      // The hole the BUILD_ID comparison left open. `do_rebuild` deleted
      // `.next` before building, so an OOM-killed build (measured on the dev
      // box 2026-09-04, three times in one night) left NO BUILD_ID — and an
      // ABSENT id compares UNEQUAL to the one recorded before the rebuild, so
      // "the build changed" read as "the build happened". The update then
      // resumed and stamped itself complete over a box with no dashboard at
      // all. Nothing is the one answer that can never be evidence of a build.
      updater.resetUpdateState();
      mockGet.mockResolvedValue("build-aaa");
      mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      const result = await updater.checkContinuation();

      expect(result).toBe(false);
      const state = updater.getUpdateState();
      expect(state.phase).toBe("failed");
      expect(state.error).toContain("no build");
    });

    it("reports a failed update when the SERVING tree lost its build", async () => {
      // The half a `resolveBuildDir` fallback would miss. A failed rebuild can
      // leave `.next/standalone/server.js` in place — that is what the service
      // loads — while the standalone BUILD_ID beside it is gone and a stale
      // `.next/BUILD_ID` is still there. Reading the fallback tree would answer
      // about a directory nobody serves, and the update would resume.
      updater.resetUpdateState();
      mockGet.mockResolvedValue("build-aaa");
      mockExists.mockImplementation((file: unknown) => String(file).endsWith("standalone/server.js"));
      mockReadFile.mockImplementation(async (file) => {
        // Only the NON-serving tree still has one.
        if (String(file).endsWith("standalone/.next/BUILD_ID")) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        if (String(file).endsWith("BUILD_ID")) return "build-bbb\n";
        throw new Error("ENOENT");
      });

      expect(await updater.checkContinuation()).toBe(false);
      expect(updater.getUpdateState().phase).toBe("failed");
    });

    it("reads the nested standalone layout's real build, not the path it links from", async () => {
      // `postbuild` SEARCHES for the standalone entry (Next nests the tree when
      // outputFileTracingRoot resolves above the project), copies the assets and
      // the stamp beside the real one, and symlinks `.next/standalone/server.js`
      // at it. On such a box `.next/standalone/.next/BUILD_ID` does not exist —
      // so reading the literal path answers "" and turns a rebuild that WORKED
      // into "the device restarted with no build at all".
      updater.resetUpdateState();
      mockGet.mockResolvedValue("build-aaa");
      mockExists.mockImplementation((file: unknown) => String(file).endsWith("standalone/server.js"));
      mockRealpath.mockImplementation((async (p: unknown) =>
        String(p).replace("/standalone/server.js", "/standalone/nested/app/server.js")) as never);
      mockReadFile.mockImplementation(async (file) => {
        if (String(file).endsWith("standalone/nested/app/.next/BUILD_ID")) return "build-bbb\n";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      // A new build id, read from the tree the service really loads: the
      // continuation is allowed to run.
      expect(await updater.checkContinuation()).toBe(true);
      expect(updater.getUpdateState().phase).not.toBe("failed");
    });

    it("reports a failed update when a box that had no build still has none", async () => {
      // Same hole from the other side: a box with nothing to record wrote the
      // "no-previous-build" sentinel, and after a failed rebuild the empty
      // BUILD_ID differs from the sentinel too.
      updater.resetUpdateState();
      mockGet.mockResolvedValue("no-previous-build");
      mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      expect(await updater.checkContinuation()).toBe(false);
      expect(updater.getUpdateState().phase).toBe("failed");
    });
  });

  describe("updateInFlight", () => {
    // What the boot hooks that touch the OpenClaw store ask before starting:
    // an update is in flight while it runs AND while its second half is still
    // waiting to be resumed after the reboot.
    it("is false on a box with nothing to update", async () => {
      updater.resetUpdateState();
      mockGet.mockResolvedValue(undefined);
      expect(await updater.updateInFlight()).toBe(false);
    });

    it("is true while an update runs", async () => {
      updater.resetUpdateState();
      updater.startUpdate();
      expect(await updater.updateInFlight()).toBe(true);
    });

    it("is true when an update starts while the flag is being read", async () => {
      // Owner clicks Update in the same instant the 45 s warm asks. The
      // ownership check before the flag read is stale by the time the read
      // resolves; without a re-check the warm would run under the update.
      updater.resetUpdateState();
      const flagRead = deferred();
      mockGet.mockImplementation(async (key: string) =>
        key === "update_needs_continuation" ? flagRead.promise.then(() => undefined) : undefined,
      );

      const asked = updater.updateInFlight();
      expect(updater.startUpdate()).toEqual({ started: true });
      flagRead.resolve();

      expect(await asked).toBe(true);
    });

    it("is true while the post-reboot half is still waiting to be resumed", async () => {
      updater.resetUpdateState();
      mockGet.mockImplementation(async (key: string) =>
        key === "update_needs_continuation" ? "build-before-reboot" : undefined,
      );
      expect(await updater.updateInFlight()).toBe(true);
    });
  });

  describe("getTargetVersion", () => {
    it("passes an environment-provided project path to git as inert argv, never shell text", async () => {
      const originalRoot = process.env.CLAWBOX_ROOT;
      const taintedLookingRoot = "/tmp/claw box;touch /tmp/codeql-pwned";
      try {
        process.env.CLAWBOX_ROOT = taintedLookingRoot;
        setupExecMock({
          "ls-remote": { stdout: "abc123\trefs/tags/v2.0.0\n", stderr: "" },
        });
        vi.resetModules();
        const freshUpdater = await import("@/lib/updater");

        expect(await freshUpdater.getTargetVersion()).toBe("v2.0.0");
        const gitCall = mockExecFile.mock.calls.find(([, args]) =>
          Array.isArray(args) && args.includes("ls-remote"),
        );
        expect(gitCall?.[0]).toBe("git");
        expect(gitCall?.[1]).toEqual([
          "-c",
          `safe.directory=${taintedLookingRoot}`,
          "-C",
          taintedLookingRoot,
          "ls-remote",
          "--tags",
          "--refs",
          "origin",
        ]);
        expect(mockExec.mock.calls.some(([command]) => String(command).includes(taintedLookingRoot))).toBe(false);
      } finally {
        if (originalRoot === undefined) delete process.env.CLAWBOX_ROOT;
        else process.env.CLAWBOX_ROOT = originalRoot;
        vi.resetModules();
      }
    });

    it("returns latest semver tag", async () => {
      setupExecMock({
        "ls-remote": {
          stdout: "abc123\trefs/tags/v1.0.0\ndef456\trefs/tags/v2.0.0\nghi789\trefs/tags/v1.5.0\n",
          stderr: "",
        },
      });

      // Reset module to clear cache
      vi.resetModules();
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const freshUpdater = await import("@/lib/updater");

      const version = await freshUpdater.getTargetVersion();
      expect(version).toBe("v2.0.0");
    });

    it("returns latest semver tag even when the current HEAD is not its ancestor", async () => {
      setupExecMock({
        "ls-remote": {
          stdout: "abc123\trefs/tags/v1.0.0\ndef456\trefs/tags/v1.1.0\n",
          stderr: "",
        },
        "merge-base --is-ancestor": new Error("not an ancestor"),
      });

      vi.resetModules();
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const freshUpdater = await import("@/lib/updater");

      const version = await freshUpdater.getTargetVersion();
      expect(version).toBe("v1.1.0");
    });

    it("returns null when no semver tags", async () => {
      setupExecMock({
        "ls-remote": { stdout: "abc123\trefs/tags/release-candidate\n", stderr: "" },
      });

      vi.resetModules();
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const freshUpdater = await import("@/lib/updater");

      const version = await freshUpdater.getTargetVersion();
      expect(version).toBe(null);
    });

    it("returns null on error", async () => {
      setupExecMock({
        "ls-remote": new Error("Network error"),
      });

      vi.resetModules();
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const freshUpdater = await import("@/lib/updater");

      const version = await freshUpdater.getTargetVersion();
      expect(version).toBe(null);
    });
  });

  describe("getVersionInfo", () => {
    it("returns version info", async () => {
      setupExecMock({
        "ls-remote": { stdout: "abc123\trefs/tags/v2.0.0\n", stderr: "" },
        "npm view": { stdout: "1.5.0\n", stderr: "" },
      });
      setupExecFileMock({
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const freshUpdater = await import("@/lib/updater");

      const info = await freshUpdater.getVersionInfo();

      expect(info.clawbox).toBeDefined();
      expect(info.openclaw).toBeDefined();
    });

    it("handles errors gracefully", async () => {
      setupExecMock({
        "ls-remote": new Error("Git error"),
        "npm view": new Error("NPM error"),
      });
      setupExecFileMock({
        openclaw: new Error("Not installed"),
      });

      vi.resetModules();
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const freshUpdater = await import("@/lib/updater");

      const info = await freshUpdater.getVersionInfo();

      expect(info.clawbox.target).toBe(null);
      expect(info.openclaw.current).toBe(null);
    });

    it("surfaces a pinned branch update when origin has a newer commit", async () => {
      setupExecMock({
        "ls-remote": { stdout: "abc123\trefs/tags/v2.0.0\n", stderr: "" },
        "rev-parse HEAD": { stdout: "1111111111111111111111111111111111111111\n", stderr: "" },
        "rev-parse origin/fix/qa-update": { stdout: "2222222222222222222222222222222222222222\n", stderr: "" },
        "fetch --quiet origin fix/qa-update": { stdout: "", stderr: "" },
      });
      setupExecFileMock({
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockReadFile.mockImplementation(async (file) => {
        const path = String(file);
        if (path.endsWith(".update-branch")) return "fix/qa-update\n";
        if (path.endsWith("package.json")) return JSON.stringify({ version: "1.0.0" });
        throw new Error("ENOENT");
      });
      const freshUpdater = await import("@/lib/updater");

      const info = await freshUpdater.getVersionInfo();

      expect(info.clawbox.updateAvailable).toBe(true);
      expect(info.clawbox.target).toBe("fix/qa-update@2222222");
    });
  });

  /**
   * An update on a Hermes box used to end red on `gateway_verify`: that step
   * waits for the OpenClaw gateway on port 18789, which this SKU deliberately
   * masks and closes. It could only ever throw, and because it is `failFast`
   * the run stopped there — so `update_completed` was never persisted and the
   * device kept presenting a finished update as unfinished.
   *
   * The same run also contradicted itself: post_update's smoke test FAILS the
   * install if anything is listening on 18789, and the very next step demanded
   * that something was.
   */
  describe("edition-aware step list", () => {
    /** Same shape as loadHarness() in harness-edition.test.ts. */
    async function loadUpdater(edition?: string) {
      vi.resetModules();
      if (edition === undefined) delete process.env.CLAWBOX_EDITION;
      else process.env.CLAWBOX_EDITION = edition;
      const fresh = await import("@/lib/updater");
      fresh.resetUpdateState();
      return fresh;
    }

    const stepIdsFor = async (edition?: string): Promise<string[]> =>
      (await loadUpdater(edition)).getUpdateState().steps.map((s) => s.id);

    it("drops the OpenClaw and gateway steps on hermes, and provisions the edition", async () => {
      // The exact list, so this fails loudly on any drift: openclaw_install,
      // openclaw_patch, gateway_setup and gateway_verify are all absent, and
      // hermes_edition lands AFTER post_update — step_systemd_services has to
      // refresh the unit files before the provisioning step restarts them.
      const ids = await stepIdsFor("hermes");

      expect(ids).toEqual([
        "bootstrap_updater",
        "apt_update",
        "nvidia_jetpack",
        "performance_mode",
        "chromium_install",
        "vnc_install",
        "restart",
        "post_update",
        "hermes_edition",
        // Every edition builds a .next, so every edition verifies that the
        // build it rebooted onto is the code it just synced.
        "verify_build_identity",
      ]);
    });

    it("runs a Hermes continuation without touching gateway maintenance", async () => {
      mockGet.mockResolvedValue(true);
      const fresh = await loadUpdater("hermes");
      mockExecFile.mockClear();

      expect(await fresh.checkContinuation()).toBe(true);
      await vi.waitFor(() => expect(fresh.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      expect(calls.some((call) =>
        call.includes("systemctl --runtime mask clawbox-gateway.service")
          || call.includes("systemctl --runtime unmask clawbox-gateway.service")
          || call.includes("systemctl stop clawbox-gateway.service")
          || call.includes("scripts/gateway-pre-start.sh"),
      )).toBe(false);
    });

    it("leaves the openclaw edition unchanged apart from having no hermes step", async () => {
      const ids = await stepIdsFor("openclaw");

      expect(ids).toEqual([
        "bootstrap_updater",
        "apt_update",
        "nvidia_jetpack",
        "performance_mode",
        "chromium_install",
        "vnc_install",
        "openclaw_install",
        "openclaw_patch",
        "gateway_setup",
        "restart",
        "post_update",
        "gateway_verify",
        "verify_build_identity",
      ]);
      expect(ids).not.toContain("hermes_edition");
    });

    it("runs everything on dual — it has both harnesses", async () => {
      const ids = await stepIdsFor("dual");

      for (const id of [
        "openclaw_install",
        "openclaw_patch",
        "gateway_setup",
        "gateway_verify",
        "hermes_edition",
      ]) {
        expect(ids, `${id} applies on dual`).toContain(id);
      }
    });

    it("defaults to the openclaw list when no edition is recorded", async () => {
      const ids = await stepIdsFor();

      expect(ids).toContain("gateway_verify");
      expect(ids).not.toContain("hermes_edition");
    });

    it("refuses the OpenClaw-only update on hermes instead of failing on the gateway", async () => {
      const fresh = await loadUpdater("hermes");

      const result = fresh.startOpenclawUpdate();

      expect(result.started).toBe(false);
      expect(result.error).toMatch(/does not ship OpenClaw/i);
      // Nothing should have been kicked off.
      expect(fresh.getUpdateState().phase).toBe("idle");
    });

    it("still allows the OpenClaw-only update on dual", async () => {
      const fresh = await loadUpdater("dual");

      expect(fresh.startOpenclawUpdate().started).toBe(true);
      fresh.resetUpdateState();
    });

    it("completes a hermes update and records it as completed", async () => {
      // The gateway is closed on this SKU — the old list could not get here.
      mockGatewayUp.mockResolvedValue(false);
      const fresh = await loadUpdater("hermes");

      // Resume past `restart` so the test doesn't have to drive the rebuild
      // hand-off, which never returns by design.
      mockGet.mockResolvedValue("previous-build-id");
      setupExecFileMock({
        // Specific keys first — the mock returns on the first key that matches,
        // and a bare "systemctl" would shadow this one.
        "show clawbox-root-update@rebuild_reboot.service": { stdout: "success\n", stderr: "" },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
      });
      mockReadFile.mockImplementation(async (file) => {
        if (String(file).endsWith("BUILD_ID")) return "new-build-id";
        throw new Error("ENOENT");
      });

      expect(await fresh.checkContinuation()).toBe(true);
      await vi.waitFor(() => {
        expect(fresh.getUpdateState().phase).toBe("completed");
      });

      const state = fresh.getUpdateState();
      expect(state.steps.every((s) => s.status === "completed")).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ update_completed: true }),
      );
    });
  });
});

/**
 * The About screen used to report an OpenClaw version on every SKU. On the
 * Hermes edition there IS no OpenClaw — the harness is not installed — so the
 * row could only read "not installed": a line about software the device was
 * never meant to have, and nothing at all about the agent it actually runs.
 *
 * getVersionInfo() therefore reports the harness the device really has, and
 * must do it without ever spawning a hermes binary on an openclaw box.
 */
describe("getVersionInfo harness reporting", () => {
  const HERMES_BANNER =
    "Hermes Agent v0.20.5 (2026.8.19) — upstream 261a4efb — local 10914727\n" +
    "Install directory: /home/clawbox/.hermes/hermes-agent";

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockGet.mockResolvedValue(undefined);
    setupExecMock({ "ls-remote": { stdout: "abc123\trefs/tags/v1.0.0\n", stderr: "" } });
    setupExecFileMock({ openclaw: { stdout: "1.0.0", stderr: "" } });
    mockRunHermesCli.mockResolvedValue({ code: 0, stdout: HERMES_BANNER, stderr: "" });
  });

  afterEach(() => {
    delete process.env.CLAWBOX_EDITION;
  });

  async function versionsFor(edition: string) {
    vi.resetModules();
    process.env.CLAWBOX_EDITION = edition;
    const fresh = await import("@/lib/updater");
    return fresh.getVersionInfo();
  }

  it("reports the Hermes agent version on the hermes edition", async () => {
    const info = await versionsFor("hermes");

    expect(info.edition).toBe("hermes");
    expect(info.hermes?.current).toBe("v0.20.5");
    // TASK-613: and it asks for the banner WITHOUT the agent's passive update
    // check. `--version` is the only hermes call that runs one, and on a
    // six-hourly cache miss that check does a `git fetch` plus a GitHub
    // compare inside the 10 s this probe allows for the whole call — after
    // which the About screen reports no Hermes version at all.
    expect(mockRunHermesCli).toHaveBeenCalledWith(
      ["--version"],
      expect.objectContaining({ silenceUpdateCheck: true }),
    );
  });

  it("never spawns hermes on the openclaw edition, and reports no hermes field", async () => {
    const info = await versionsFor("openclaw");

    expect(info.edition).toBe("openclaw");
    expect(info.hermes).toBeUndefined();
    expect(mockRunHermesCli).not.toHaveBeenCalled();
    // OpenClaw itself is unchanged — this SKU's About row still has a version.
    expect(info.openclaw.current).toBe("1.0.0");
  });

  it("reports both harnesses on dual", async () => {
    const info = await versionsFor("dual");

    expect(info.edition).toBe("dual");
    expect(info.openclaw.current).toBe("1.0.0");
    expect(info.hermes?.current).toBe("v0.20.5");
  });

  it("reports a null hermes version rather than failing when the CLI is missing", async () => {
    mockRunHermesCli.mockRejectedValue(new Error("Hermes is not installed on this device"));

    const info = await versionsFor("hermes");

    // The field is still present (the SKU has a Hermes) but has no version,
    // and the ClawBox half of the payload is unaffected.
    expect(info.hermes).toEqual({ current: null, target: null, updateAvailable: false });
    expect(info.clawbox.current).toBeTruthy();
  });

  it("reports a null hermes version when the CLI exits non-zero", async () => {
    mockRunHermesCli.mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });

    const info = await versionsFor("hermes");

    expect(info.hermes?.current).toBeNull();
  });

  it("offers no Hermes update — ClawBox does not pin the agent", async () => {
    const info = await versionsFor("hermes");

    expect(info.hermes?.target).toBeNull();
    expect(info.hermes?.updateAvailable).toBe(false);
  });

  it("probes hermes once per cache window, not once per caller", async () => {
    vi.resetModules();
    process.env.CLAWBOX_EDITION = "hermes";
    const fresh = await import("@/lib/updater");

    await fresh.getVersionInfo();
    await fresh.getVersionInfo();
    await fresh.getVersionInfo();

    expect(mockRunHermesCli).toHaveBeenCalledTimes(1);
  });
});
