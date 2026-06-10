import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import * as fs from "fs/promises";

vi.mock("child_process", () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(),
  setMany: vi.fn(),
}));

import { get, set, setMany } from "@/lib/config-store";

const mockGet = vi.mocked(get);
const mockSet = vi.mocked(set);
const mockSetMany = vi.mocked(setMany);
const mockExec = vi.mocked(childProcess.exec);
const mockExecFile = vi.mocked(childProcess.execFile);
const mockReadFile = vi.mocked(fs.readFile);

function setupExecMock(results: Record<string, { stdout: string; stderr: string } | Error> = {}) {
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
    for (const k of Object.keys(results)) {
      if (key.includes(k) || k.includes(cmd)) {
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
    return returnObj as unknown as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("updater", () => {
  let updater: typeof import("@/lib/updater");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGet.mockResolvedValue(undefined);
    mockSet.mockResolvedValue();
    mockSetMany.mockResolvedValue();
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

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
        "start clawbox-root-update@apt_update.service": new Error("systemctl failed"),
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
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
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

    it("reports a budget overrun instead of the journal when a root step times out", async () => {
      // execFile kills the blocking `systemctl start` when OUR timeout
      // expires (err.killed) — the unit itself usually keeps running. The
      // journal's last line at that moment is just whatever fixup finished
      // most recently and must NOT be presented as the failure.
      const timeoutErr = Object.assign(new Error("Command failed"), { killed: true });
      setupExecFileMock({
        "start clawbox-root-update@apt_update.service": timeoutErr,
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
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
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
        "start clawbox-root-update@post_update.service": timeoutErr,
        "show clawbox-root-update@post_update.service": { stdout: "success\n", stderr: "" },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });

      vi.resetModules();
      mockGet.mockResolvedValue(undefined);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
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
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ update_completed: true }),
      );
    });

    it("stops the update sequence when bootstrap_updater fails", async () => {
      setupExecFileMock({
        "start clawbox-root-update@bootstrap_updater.service": new Error("systemctl failed"),
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
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
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
      expect(mockSet).toHaveBeenCalledWith("update_needs_continuation", undefined);
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
      expect(mockSet).toHaveBeenCalledWith("update_needs_continuation", undefined);
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
  });

  describe("getTargetVersion", () => {
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
  });
});
