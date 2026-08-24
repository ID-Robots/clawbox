import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import * as childProcess from "child_process";

/**
 * The settings model behind the two TASK-455 toggles (src/lib/system-profile.ts).
 *
 * The scripts themselves are covered by system-profile-scripts.test.ts, which
 * runs them for real. Here the child process is mocked, because what is under
 * test is the CONTRACT between the route and the script: which argv is sent,
 * which JSON object is believed, what happens when the script is missing, lies,
 * or fails — and whether config.json is written when it shouldn't be.
 */

vi.mock("child_process", () => ({ execFile: vi.fn() }));

const store = new Map<string, unknown>();
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
}));

const mockExecFile = vi.mocked(childProcess.execFile);

/** Queue of (cmd, argv) -> stdout, matched on the joined command line. */
let responses: { match: string; stdout?: string; error?: Error }[] = [];
const calls: { cmd: string; argv: string[] }[] = [];

function installExecFileMock() {
  mockExecFile.mockImplementation(((
    cmd: string,
    argv: string[],
    _opts: object,
    cb?: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push({ cmd, argv });
    const line = `${cmd} ${argv.join(" ")}`;
    const hit = responses.find((r) => line.includes(r.match));
    if (cb) {
      if (hit?.error) cb(hit.error, { stdout: "", stderr: "" });
      else cb(null, { stdout: hit?.stdout ?? "", stderr: "" });
    }
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

const DESKTOP_JSON = JSON.stringify({
  supported: true, enabled: true, active: true, rebootRequired: false,
  defaultTarget: "graphical.target", displayManager: "gdm3:alias",
});
const POWER_JSON = JSON.stringify({
  supported: true, mode: "balanced", nvpmodelId: 1, nvpmodelName: "25W",
  clocksPinned: false, balancedId: 1, performanceId: 2,
});

let libexec: string;
let sp: typeof import("@/lib/system-profile");

beforeAll(async () => {
  libexec = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-libexec-"));
  for (const name of ["clawbox-desktop-mode.sh", "clawbox-power-mode.sh"]) {
    fs.writeFileSync(path.join(libexec, name), "#!/bin/sh\n", { mode: 0o755 });
  }
  process.env.CLAWBOX_LIBEXEC_DIR = libexec;
  vi.resetModules();
  sp = await import("@/lib/system-profile");
});

afterAll(() => {
  delete process.env.CLAWBOX_LIBEXEC_DIR;
  fs.rmSync(libexec, { recursive: true, force: true });
});

beforeEach(() => {
  store.clear();
  responses = [];
  calls.length = 0;
  installExecFileMock();
});

describe("isPowerMode", () => {
  it("accepts only the two profiles the script implements", () => {
    expect(sp.isPowerMode("balanced")).toBe(true);
    expect(sp.isPowerMode("performance")).toBe(true);
    for (const bad of ["MAXN", "", null, undefined, 2, {}, ["balanced"]]) {
      expect(sp.isPowerMode(bad), String(bad)).toBe(false);
    }
  });
});

describe("readDesktopMode", () => {
  it("runs --check without sudo and returns the script's state", async () => {
    responses = [{ match: "--check", stdout: DESKTOP_JSON }];
    const status = await sp.readDesktopMode();
    expect(status.enabled).toBe(true);
    expect(status.defaultTarget).toBe("graphical.target");
    expect(calls[0].cmd).toBe(path.join(libexec, "clawbox-desktop-mode.sh"));
    expect(calls[0].argv).toEqual(["--check"]);
    // The status route must never need a privilege the sudoers file grants.
    expect(calls.some((c) => c.cmd === "sudo")).toBe(false);
  });

  it("takes the LAST JSON object, so the mutating modes parse too", async () => {
    responses = [{
      match: "--check",
      stdout: `default target set to multi-user.target\ndisable gdm3.service\n${DESKTOP_JSON}\n`,
    }];
    expect((await sp.readDesktopMode()).supported).toBe(true);
  });

  it("reports unsupported — defaulting to ON — when the script fails", async () => {
    responses = [{ match: "--check", error: new Error("systemctl: not found") }];
    const status = await sp.readDesktopMode();
    expect(status.supported).toBe(false);
    // The desktop is a shipped, default-ON feature: an unreadable box must not
    // render the switch as "off", which would read as "the owner turned it off".
    expect(status.enabled).toBe(true);
  });

  it("falls back to the owner's persisted intent when the script is unreadable", async () => {
    store.set(sp.DESKTOP_CONFIG_KEY, false);
    responses = [{ match: "--check", error: new Error("boom") }];
    expect((await sp.readDesktopMode()).enabled).toBe(false);
  });

  it("survives a script that prints garbage instead of JSON", async () => {
    responses = [{ match: "--check", stdout: "Segmentation fault\n" }];
    expect((await sp.readDesktopMode()).supported).toBe(false);
  });
});

describe("readPowerMode", () => {
  it("returns the profile and the live nvpmodel state", async () => {
    responses = [{ match: "--check", stdout: POWER_JSON }];
    const status = await sp.readPowerMode();
    expect(status).toMatchObject({
      supported: true, mode: "balanced", nvpmodelId: 1,
      nvpmodelName: "25W", clocksPinned: false,
    });
  });

  it("defaults to balanced, never to the pinned profile", async () => {
    responses = [{ match: "--check", error: new Error("no nvpmodel") }];
    const status = await sp.readPowerMode();
    expect(status.supported).toBe(false);
    expect(status.mode).toBe("balanced");
    expect(status.clocksPinned).toBe(false);
  });

  it("ignores a mode the script should never emit", async () => {
    responses = [{ match: "--check", stdout: JSON.stringify({ supported: true, mode: "MAXN_SUPER" }) }];
    expect((await sp.readPowerMode()).mode).toBe("balanced");
  });
});

describe("setDesktopMode", () => {
  it("invokes the root-owned script through sudo with the matching flag", async () => {
    responses = [{ match: "clawbox-desktop-mode.sh", stdout: DESKTOP_JSON }];
    await sp.setDesktopMode(false);
    const mutation = calls.find((c) => c.argv.includes("--disable"))!;
    expect(mutation.cmd).toBe("sudo");
    // The path has to be the libexec copy verbatim: sudoers matches the
    // argument list exactly, so the repo copy would fail closed on a password
    // prompt nobody can answer.
    expect(mutation.argv).toEqual([path.join(libexec, "clawbox-desktop-mode.sh"), "--disable"]);
  });

  it("persists the owner's intent once the script has succeeded", async () => {
    responses = [{ match: "clawbox-desktop-mode.sh", stdout: DESKTOP_JSON }];
    await sp.setDesktopMode(false);
    expect(store.get(sp.DESKTOP_CONFIG_KEY)).toBe(false);
  });

  it("does NOT persist when the script fails", async () => {
    responses = [{ match: "clawbox-desktop-mode.sh", error: new Error("sudo: a password is required") }];
    await expect(sp.setDesktopMode(false)).rejects.toThrow("password is required");
    expect(store.has(sp.DESKTOP_CONFIG_KEY)).toBe(false);
  });

  it("throws ProfileUnavailableError when the root-owned copy is missing", async () => {
    process.env.CLAWBOX_LIBEXEC_DIR = path.join(libexec, "nope");
    vi.resetModules();
    const fresh = await import("@/lib/system-profile");
    await expect(fresh.setDesktopMode(true)).rejects.toBeInstanceOf(fresh.ProfileUnavailableError);
    process.env.CLAWBOX_LIBEXEC_DIR = libexec;
    vi.resetModules();
  });
});

describe("setPowerMode", () => {
  it("maps the profile onto the script's flag", async () => {
    responses = [{ match: "clawbox-power-mode.sh", stdout: POWER_JSON }];
    await sp.setPowerMode("performance");
    expect(calls.find((c) => c.cmd === "sudo")!.argv)
      .toEqual([path.join(libexec, "clawbox-power-mode.sh"), "--performance"]);

    calls.length = 0;
    await sp.setPowerMode("balanced");
    expect(calls.find((c) => c.cmd === "sudo")!.argv)
      .toEqual([path.join(libexec, "clawbox-power-mode.sh"), "--balanced"]);
  });

  it("persists the profile after the script succeeds", async () => {
    responses = [{ match: "clawbox-power-mode.sh", stdout: POWER_JSON }];
    await sp.setPowerMode("performance");
    expect(store.get(sp.POWER_CONFIG_KEY)).toBe("performance");
  });
});

describe("resolveScript", () => {
  it("prefers the root-owned copy", () => {
    expect(sp.resolveScript("clawbox-power-mode.sh"))
      .toBe(path.join(libexec, "clawbox-power-mode.sh"));
  });

  it("refuses the repo copy for mutations", () => {
    expect(sp.resolveScript("does-not-exist.sh")).toBeNull();
  });

  it("allows the repo copy for the unprivileged --check path only", () => {
    // Without this, the Settings panel would be blank on a dev machine.
    const found = sp.resolveScript("clawbox-power-mode.sh", { allowRepoFallback: true });
    expect(found).not.toBeNull();
  });
});
