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

vi.mock("@/lib/port-probe", () => ({
  isPortOpen: vi.fn(),
}));

// The Hermes version probe goes through the shared CLI wrapper, so the wrapper
// is the seam: nothing in these tests may spawn a real `hermes`.
const { mockRunHermesCli } = vi.hoisted(() => ({ mockRunHermesCli: vi.fn() }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: mockRunHermesCli }));

import { get, set, setMany } from "@/lib/config-store";
import { isPortOpen } from "@/lib/port-probe";

const mockGet = vi.mocked(get);
const mockSet = vi.mocked(set);
const mockSetMany = vi.mocked(setMany);
const mockExec = vi.mocked(childProcess.exec);
const mockExecFile = vi.mocked(childProcess.execFile);
const mockReadFile = vi.mocked(fs.readFile);
const mockIsPortOpen = vi.mocked(isPortOpen);
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
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockIsPortOpen.mockResolvedValue(true);

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

    it("fails when an overrun post_update later settles with a systemd error result", async () => {
      const timeoutErr = Object.assign(new Error("Command failed"), { killed: true });
      setupExecFileMock({
        "start clawbox-root-update@post_update.service": timeoutErr,
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
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
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
      expect(mockSetMany).not.toHaveBeenCalled();
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
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      mockIsPortOpen.mockResolvedValue(false);
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
        "start clawbox-root-update@post_update.service": { stdout: "", stderr: "" },
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
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      // Health is impossible until BOTH explicit consent and the later system
      // restart occurred. Merely invoking pre-start must never make this green.
      mockIsPortOpen.mockImplementation(async () => {
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
        call.includes("systemctl start clawbox-root-update@post_update.service"),
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
      expect(preStartOptions?.env?.OPENCLAW_HOME)
        .toBe("/tmp/clawbox-updater-openclaw-home");
    });

    it("continues to doctor and restart when the targeted Codex repair fails", async () => {
      setupExecFileMock({
        "plugins install @openclaw/codex@2026.8.1 --force --accept-capabilities": new Error(
          "Codex repair timed out",
        ),
        "start clawbox-root-update@post_update.service": { stdout: "", stderr: "" },
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
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      mockIsPortOpen.mockImplementation(async () =>
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
        "[Updater] Codex capability repair did not complete:",
        "Codex repair timed out",
      );
      expect(calls.some((call) => call.includes("openclaw doctor --fix --yes --non-interactive")))
        .toBe(true);
      expect(calls.some((call) => call.includes("systemctl restart clawbox-gateway.service")))
        .toBe(true);
      warnSpy.mockRestore();
    });

    it("retries a failed maintenance unmask and surfaces the cleanup failure", async () => {
      setupExecFileMock({
        "systemctl --runtime unmask clawbox-gateway.service": new Error("unmask failed"),
        "start clawbox-root-update@post_update.service": { stdout: "", stderr: "" },
        ping: { stdout: "", stderr: "" },
        systemctl: { stdout: "", stderr: "" },
        openclaw: { stdout: "1.0.0", stderr: "" },
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      vi.resetModules();
      mockGet.mockResolvedValue(true);
      mockSet.mockResolvedValue();
      mockSetMany.mockResolvedValue();
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
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

    it("does not re-enable an explicitly disabled unused Codex plugin from a stale journal line", async () => {
      setupExecFileMock({
        "start clawbox-root-update@post_update.service": { stdout: "", stderr: "" },
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
        if (String(file).endsWith("/openclaw.json")) {
          return JSON.stringify({
            agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
            plugins: { entries: { codex: { enabled: false } } },
          });
        }
        throw new Error("ENOENT");
      });
      mockIsPortOpen.mockImplementation(async () =>
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
        "start clawbox-root-update@post_update.service": { stdout: "", stderr: "" },
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
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
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
      const consentIndex = calls.findIndex((call) =>
        call.includes("plugins install @openclaw/codex@2026.8.1 --force --accept-capabilities"),
      );
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
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      // The gateway only "recovers" once the legacy-state quarantine has run.
      // Tie the probe to that side-effect instead of a fixed false/false/true
      // call sequence: waitForGateway polls in a loop (deadline/interval are 1ms
      // in these tests), so the old sequence could be fully consumed by the very
      // first poll — reporting recovery BEFORE quarantine ran and leaving no
      // /bin/bash call to assert on. That made this test flaky (~1 in 3).
      mockIsPortOpen.mockImplementation(async () =>
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

  describe("startOpenclawUpdate", () => {
    it("keeps the gateway masked throughout the root package replacement", async () => {
      updater.resetUpdateState();

      expect(updater.startOpenclawUpdate().started).toBe(true);
      await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("completed"));

      const calls = mockExecFile.mock.calls.map(([cmd, args]) =>
        `${cmd} ${(args as string[]).join(" ")}`,
      );
      const installIndex = calls.findIndex((call) =>
        call.includes("systemctl start clawbox-root-update@openclaw_install.service"),
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
      mockIsPortOpen.mockResolvedValue(false);
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
    expect(mockRunHermesCli).toHaveBeenCalledWith(["--version"], expect.anything());
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
