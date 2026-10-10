import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

/**
 * A root step the launcher could not even be asked to start must say what is
 * wrong and what to do (TASK-1316).
 *
 * On a box whose web build and root side disagree — an update cut short
 * between installing one half and the other — the owner used to read
 * `Command failed: /usr/bin/sudo -n … sudo: a password is required` (or,
 * from a build older than the launcher, polkit's "Interactive authentication
 * required") on the failed update card. Nothing in it names the repair.
 */

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, default: { ...actual, execFile: mockExecFile }, execFile: mockExecFile };
});

import {
  ROOT_STEP_LAUNCHER,
  RootStepUnavailableError,
  rootStepRepairCommand,
  startRootStep,
} from "@/lib/root-step-runner";

/** Fail the next execFile the way child_process does: an Error carrying stderr. */
function failWith(stderr: string, extra: Record<string, unknown> = {}): void {
  mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    const err = Object.assign(
      new Error(`Command failed: /usr/bin/sudo -n ${ROOT_STEP_LAUNCHER} bootstrap_updater\n${stderr}`),
      { code: 1, stderr, stdout: "", ...extra },
    );
    cb(err);
  });
}

function succeed(): void {
  mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    cb(null, { stdout: "", stderr: "" });
  });
}

const REPAIR = "sudo bash /home/clawbox/clawbox/install.sh --step systemd_services";

const X64_HOST_FILES = ["/etc/clawbox/x64-integration.env", "/etc/clawbox/x64.env"];

/**
 * Answer the files the repair command depends on, whatever this runner is —
 * `present` names which of them exist (`true`: the integration package's).
 */
function x64Install(present: boolean | string[]): void {
  const real = fs.existsSync;
  const existing = present === true ? [X64_HOST_FILES[0]] : present === false ? [] : present;
  vi.spyOn(fs, "existsSync").mockImplementation((p) =>
    X64_HOST_FILES.includes(String(p)) ? existing.includes(String(p)) : real(p));
}

beforeEach(() => {
  mockExecFile.mockReset();
  vi.restoreAllMocks();
  delete process.env.CLAWBOX_ROOT;
  // An appliance unless a case says otherwise — the runner may itself be an
  // x64 desktop install, which is exactly what this file must not depend on.
  x64Install(false);
});

describe("startRootStep", () => {
  it("asks the launcher through sudo -n, and nothing else", async () => {
    succeed();
    await startRootStep("bootstrap_updater", { noBlock: true });
    expect(mockExecFile.mock.calls[0][0]).toBe("/usr/bin/sudo");
    expect(mockExecFile.mock.calls[0][1]).toEqual(["-n", ROOT_STEP_LAUNCHER, "--no-block", "bootstrap_updater"]);
  });

  it.each([
    ["the sudoers grant is missing", "sudo: a password is required\n", /not allowed to start root steps/],
    ["the launcher is missing", `sudo: ${ROOT_STEP_LAUNCHER}: command not found\n`, /root-step launcher .* is not installed/],
    ["the launcher is older than the build", "clawbox-run-root-step: step not permitted from the web server: harness_swap\n", /older than this build/],
    ["polkit refused the old path", "Failed to start clawbox-root-update@bootstrap_updater.service: Interactive authentication required.\n", /no longer allows/],
  ])("says what is wrong and names the one repair command when %s", async (_what, stderr, reason) => {
    failWith(stderr);
    const err = await startRootStep("bootstrap_updater").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RootStepUnavailableError);
    const e = err as RootStepUnavailableError;
    expect(e.message).toMatch(reason);
    expect(e.message).toContain('"bootstrap_updater"');
    expect(e.message).toContain(REPAIR);
    expect(e.message).not.toContain("Command failed");
    expect(e.repairCommand).toBe(REPAIR);
    // The original error's shape survives for callers that read it.
    expect(e.code).toBe(1);
    expect(e.stderr).toBe(stderr);
    expect(e.rootStepUnavailable).toBe(true);
  });

  it("leaves a step's OWN failure alone — the updater explains that from the unit's journal", async () => {
    failWith("Job for clawbox-root-update@post_update.service failed because the control process exited with error code.\n");
    const err = await startRootStep("post_update").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RootStepUnavailableError);
    expect((err as Error).message).toContain("Command failed");
  });

  it("leaves a timeout alone, so the updater can still call it a budget overrun", async () => {
    failWith("sudo: a password is required\n", { killed: true, signal: "SIGTERM" });
    const err = await startRootStep("post_update").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RootStepUnavailableError);
    expect((err as { killed?: boolean }).killed).toBe(true);
  });

  it("does not mistake a step that printed 'No such file' for a missing launcher", async () => {
    failWith("Job failed. See 'journalctl -xe': No such file or directory\n");
    const err = await startRootStep("post_update").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RootStepUnavailableError);
  });
});

describe("rootStepRepairCommand", () => {
  it("names install.sh's systemd_services step on the appliance, under the box's own checkout", () => {
    expect(rootStepRepairCommand()).toBe(REPAIR);
    process.env.CLAWBOX_ROOT = "/srv/clawbox";
    expect(rootStepRepairCommand()).toBe("sudo bash /srv/clawbox/install.sh --step systemd_services");
  });

  it("names the x64 installer's own step on a desktop install", () => {
    x64Install(true);
    expect(rootStepRepairCommand("/home/me/clawbox")).toBe("sudo bash /home/me/clawbox/install-x64.sh --step root_step_contract"); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
  });

  it("names it on a PC install-x64.sh set up without the integration package, too", () => {
    // That installer writes /etc/clawbox/x64.env and never the integration
    // file, so checking only the latter sent its owner to the APPLIANCE's
    // install.sh, whose systemd_services step lays Jetson units down.
    x64Install(["/etc/clawbox/x64.env"]);
    expect(rootStepRepairCommand("/home/me/clawbox")).toBe("sudo bash /home/me/clawbox/install-x64.sh --step root_step_contract"); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
  });
});
