import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TASK-539 — the one command the allow-list grants for starting a root step.
 *
 * Removing the unscoped polkit `manage-units` grant means the updater, the UI's
 * install buttons and the wizard's hand-offs all have to come back through
 * sudo. Enumerating ~25 `clawbox-root-update@<step>.service` instances twice
 * over would be 50 lines of string matching, and the wildcard that would
 * compress them is what TASK-445 removed. So the grant names this launcher with
 * no argument spec, and the launcher decides which unit it will start.
 *
 * That makes it the outer bound on the web server's root surface, so what it
 * refuses is the whole point. These tests run the real shipped script with
 * /usr/bin/systemctl redirected to a recorder.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const LAUNCHER_SRC = path.join(REPO, "config", "clawbox-run-root-step.sh");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

let tmp: string;
let launcher: string;
let seen: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-launcher-"));
  seen = path.join(tmp, "systemctl-calls");
  const stub = path.join(tmp, "systemctl");
  fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" >> "${seen}"\n`, { mode: 0o755 });
  launcher = path.join(tmp, "clawbox-run-root-step.sh");
  fs.writeFileSync(
    launcher,
    fs.readFileSync(LAUNCHER_SRC, "utf-8").replace(/\/usr\/bin\/systemctl/g, stub),
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (...args: string[]) => spawnSync("bash", [launcher, ...args], { encoding: "utf-8" });
const calls = () => (fs.existsSync(seen) ? fs.readFileSync(seen, "utf-8").trim().split("\n") : []);

d("clawbox-run-root-step.sh", () => {
  it("starts the unit for a step the web server is allowed to run", () => {
    expect(run("chpasswd").status).toBe(0);
    expect(calls()).toEqual([
      "reset-failed clawbox-root-update@chpasswd.service",
      "start clawbox-root-update@chpasswd.service",
    ]);
  });

  it("passes --no-block through", () => {
    expect(run("--no-block", "llamacpp_install").status).toBe(0);
    expect(calls()).toContain("start --no-block clawbox-root-update@llamacpp_install.service");
  });

  it("clears a previous failure itself, so no caller needs its own grant", () => {
    // clawbox-root-update@.service does not set StartLimitIntervalSec=0, so a
    // step that failed a few times is unstartable until something resets it.
    run("set_hostname");
    expect(calls()[0]).toBe("reset-failed clawbox-root-update@set_hostname.service");
  });

  it("REFUSES a step outside the web-startable list", () => {
    // git_pull, build and rebuild are the updater's own self-updating family:
    // reachable from install.sh, never from the web server.
    for (const step of ["git_pull", "build", "rebuild", "recover", "polkit_rules"]) {
      const r = run(step);
      expect(r.status, `${step} was permitted`).toBe(64);
      expect(r.stderr).toMatch(/not permitted from the web server/);
    }
    expect(calls()).toEqual([]);
  });

  it("REFUSES a step name that is not a plain identifier", () => {
    for (const step of ["../../etc/shadow", "chpasswd.service", "chpasswd ssh", "CHPASSWD", ""]) {
      const r = run(step);
      expect(r.status, `${JSON.stringify(step)} was permitted`).toBe(64);
    }
    expect(calls()).toEqual([]);
  });

  it("REFUSES more than one step, so a second unit cannot ride along", () => {
    // The shape TASK-445's wildcard removal was about: `systemctl start` takes a
    // LIST of units, and this is the only thing standing in front of it now.
    expect(run("chpasswd", "ssh").status).toBe(64);
    expect(run("--no-block", "chpasswd", "ssh").status).toBe(64);
    expect(calls()).toEqual([]);
  });

  it("takes a STEP, never a unit name", () => {
    const r = run("clawbox-root-update@chpasswd.service");
    expect(r.status).toBe(64);
    expect(calls()).toEqual([]);
  });
});
