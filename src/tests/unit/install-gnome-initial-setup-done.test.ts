import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * GNOME's first-run assistant stayed resident on every box.
 *
 * `gnome-initial-setup --existing-user` is started by the GNOME session for any
 * user without `~/.config/gnome-initial-setup-done`, and nothing on a ClawBox
 * wrote that file — so it sat at 120-170 MB RSS on an 8 GB board from session
 * start, on every lab board measured, for an assistant ClawBox's own setup
 * wizard replaces. The file is the switch GNOME itself reads.
 *
 * What is pinned here: the step writes the marker, with the content the
 * assistant writes itself, as the device user; it ends the copy the running
 * session already started (the update runs this after its own reboot); a
 * second run touches nothing; and it is wired into BOTH the full install and
 * `step_post_update`, so a box already in the field is fixed by its next
 * in-app update.
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

let sandbox: string;
let home: string;
let calls: string;
let marker: string;

/**
 * Run the real `step_gnome_initial_setup_done` against the sandbox HOME.
 * `as_clawbox` is `sudo -u clawbox` on a box; here it runs the command as the
 * test's own user, and logs that it was asked, so the test can tell a write
 * that went through the user from one root would have made itself. `pkill` is
 * ALWAYS a stub: the real one would end a first-run assistant on the machine
 * running the tests. `pkillRc` is what it answers (1: nothing matched).
 */
function runStep({ asClawbox = 'echo "as_clawbox $*" >> "$CALLS"; "$@"', pkillRc = 1 } = {}) {
  const script = [
    "set -euo pipefail",
    `CLAWBOX_HOME=${JSON.stringify(home)}`,
    'CLAWBOX_USER="$(id -un)"',
    `CALLS=${JSON.stringify(calls)}`,
    `as_clawbox() { ${asClawbox}; }`,
    `pkill() { echo "pkill $*" >> "$CALLS"; return ${pkillRc}; }`,
    extractShellFunction("step_gnome_initial_setup_done"),
    "step_gnome_initial_setup_done",
  ].join("\n");
  const runner = path.join(sandbox, "run.sh");
  fs.writeFileSync(runner, script, "utf-8");
  return spawnSync("bash", [runner], { encoding: "utf-8", cwd: REPO });
}

function loggedCalls(prefix: "as_clawbox" | "pkill"): string[] {
  if (!fs.existsSync(calls)) return [];
  return fs.readFileSync(calls, "utf-8").split("\n").filter((line) => line.startsWith(`${prefix} `));
}
const asClawboxCalls = () => loggedCalls("as_clawbox");
const pkillCalls = () => loggedCalls("pkill");

d("step_gnome_initial_setup_done marks GNOME's first-run assistant as done", () => {
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-gnome-initial-setup-"));
    home = path.join(sandbox, "home");
    fs.mkdirSync(home);
    calls = path.join(sandbox, "as-clawbox.log");
    marker = path.join(home, ".config", "gnome-initial-setup-done");
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("writes ~/.config/gnome-initial-setup-done with \"yes\", as the device user", () => {
    const result = runStep();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(marker, "utf-8")).toBe("yes");
    expect(fs.lstatSync(marker).isFile()).toBe(true);
    if (typeof process.getuid === "function") {
      expect(fs.statSync(marker).uid).toBe(process.getuid());
    }
    // Through `as_clawbox`, never root writing into the user's own tree.
    expect(asClawboxCalls()).toHaveLength(1);
    expect(asClawboxCalls()[0]).toContain(marker);
    // A ~/.config the step had to create is private, the way GLib makes it.
    expect(fs.statSync(path.dirname(marker)).mode & 0o777).toBe(0o700);
    expect(result.stdout).toContain("GNOME initial setup marked done");
  });

  it("ends the assistant the running session already started, and only the device user's", () => {
    // The in-app update runs post_update after its own reboot: by then the
    // session has started the assistant, and the marker only stops the NEXT one.
    const result = runStep({ pkillRc: 0 });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(pkillCalls()).toHaveLength(1);
    const user = spawnSync("id", ["-un"], { encoding: "utf-8" }).stdout.trim();
    expect(pkillCalls()[0]).toBe(`pkill -TERM -u ${user} -f gnome-initial-setup --existing-user`);
    expect(result.stdout).toContain("Ended the first-run assistant");
  });

  it("is quiet about the assistant when none was running", () => {
    const result = runStep({ pkillRc: 1 });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Ended the first-run assistant");
  });

  it("is a no-op on the second run", () => {
    expect(runStep().status).toBe(0);
    const past = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(marker, past, past);
    const callsAfterFirst = fs.readFileSync(calls, "utf-8");

    const second = runStep();

    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(fs.readFileSync(marker, "utf-8")).toBe("yes");
    expect(fs.statSync(marker).mtimeMs).toBe(past.getTime());
    // Neither a write through the user nor a signal to anything.
    expect(fs.readFileSync(calls, "utf-8")).toBe(callsAfterFirst);
    expect(second.stdout).toContain("already marked done");
  });

  it("leaves a marker that is already there alone, whatever it says", () => {
    fs.mkdirSync(path.dirname(marker), { mode: 0o755 });
    fs.writeFileSync(marker, "owner finished it\n");

    const result = runStep();

    expect(result.status).toBe(0);
    expect(fs.readFileSync(marker, "utf-8")).toBe("owner finished it\n");
    expect(fs.statSync(path.dirname(marker)).mode & 0o777).toBe(0o755);
    expect(asClawboxCalls()).toHaveLength(0);
    expect(pkillCalls()).toHaveLength(0);
  });

  it("answers non-zero, and says so, when the marker cannot be written", () => {
    const result = runStep({ asClawbox: "return 1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not write");
    expect(fs.existsSync(marker)).toBe(false);
    expect(pkillCalls()).toHaveLength(0);
  });

  it("runs on the full install and on every in-app update", () => {
    const postUpdate = extractShellFunction("step_post_update");
    expect(postUpdate).toContain("optional_step gnome_initial_setup_done step_gnome_initial_setup_done");

    const fullInstall = INSTALL_SH.slice(INSTALL_SH.indexOf("# ── Full Install Mode"));
    expect(fullInstall).toMatch(/^step_gnome_initial_setup_done \|\| /m);
  });
});
