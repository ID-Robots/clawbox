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
 * assistant writes itself, as the device user; a root-owned `~/.config` left
 * by an older install is handed back to that user first, and nothing else is;
 * it ends the copy the running session already started (the update runs this
 * after its own reboot), also when the marker was already there; a second run
 * writes nothing; and it is wired into BOTH the full install and
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
 * `chown` is a stub too, since the tests do not run as root. It logs the call
 * and makes the directory writable, the way handing it to the user would.
 * `user` names a device user other than the test's own, so a `~/.config` the
 * test made looks to the step like one another account owns.
 */
function runStep({
  asClawbox = 'echo "as_clawbox $*" >> "$CALLS"; "$@"',
  pkillRc = 1,
  user = "",
} = {}) {
  const script = [
    "set -euo pipefail",
    `CLAWBOX_HOME=${JSON.stringify(home)}`,
    user ? `CLAWBOX_USER=${JSON.stringify(user)}` : 'CLAWBOX_USER="$(id -un)"',
    `CALLS=${JSON.stringify(calls)}`,
    `as_clawbox() { ${asClawbox}; }`,
    `pkill() { echo "pkill $*" >> "$CALLS"; return ${pkillRc}; }`,
    'chown() { echo "chown $*" >> "$CALLS"; chmod u+w "${@: -1}"; }',
    extractShellFunction("step_gnome_initial_setup_done"),
    "step_gnome_initial_setup_done",
  ].join("\n");
  const runner = path.join(sandbox, "run.sh");
  fs.writeFileSync(runner, script, "utf-8");
  return spawnSync("bash", [runner], { encoding: "utf-8", cwd: REPO });
}

function loggedCalls(prefix: "as_clawbox" | "pkill" | "chown"): string[] {
  if (!fs.existsSync(calls)) return [];
  return fs.readFileSync(calls, "utf-8").split("\n").filter((line) => line.startsWith(`${prefix} `));
}
const asClawboxCalls = () => loggedCalls("as_clawbox");
const pkillCalls = () => loggedCalls("pkill");
const chownCalls = () => loggedCalls("chown");

d("step_gnome_initial_setup_done marks GNOME's first-run assistant as done", () => {
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-gnome-initial-setup-"));
    home = path.join(sandbox, "home");
    fs.mkdirSync(home);
    calls = path.join(sandbox, "as-clawbox.log");
    marker = path.join(home, ".config", "gnome-initial-setup-done");
  });

  afterEach(() => {
    // The read-only ~/.config of the root-owned case would otherwise stop the
    // cleanup when the step failed to hand it back.
    try {
      fs.chmodSync(path.join(home, ".config"), 0o700);
    } catch {
      // No ~/.config in this test.
    }
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
    expect(chownCalls()).toHaveLength(0);
    expect(result.stdout).toContain("GNOME initial setup marked done");
  });

  it("hands a root-owned ~/.config back to the device user before writing, and only ~/.config itself", () => {
    // What a box installed before this step can have: step_desktop_theme's root
    // `mkdir -p ~/.config/autostart` made ~/.config and chowned only autostart.
    // `mkdir -p` as the user does not repair it, so the user write failed.
    // Here ~/.config is the test user's, which is not the device user named:
    // to the step, that is a ~/.config another account owns.
    const configDir = path.dirname(marker);
    fs.mkdirSync(path.join(configDir, "autostart"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "autostart", "clawbox-desktop-theme.desktop"), "");
    fs.chmodSync(configDir, 0o555);

    const result = runStep({ user: "clawbox-device" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(marker, "utf-8")).toBe("yes");
    // Not recursive, and never through a symlink.
    expect(chownCalls()).toEqual([`chown -h clawbox-device:clawbox-device ${configDir}`]);
    const log = fs.readFileSync(calls, "utf-8").split("\n");
    expect(log.findIndex((line) => line.startsWith("chown "))).toBeLessThan(
      log.findIndex((line) => line.startsWith("as_clawbox ")),
    );
  });

  it("leaves a ~/.config that is already the device user's as it is", () => {
    fs.mkdirSync(path.dirname(marker), { mode: 0o755 });

    const result = runStep();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(marker, "utf-8")).toBe("yes");
    expect(chownCalls()).toHaveLength(0);
  });

  it("never hands over a ~/.config that is a symlink", () => {
    // Root following one the user planted would chown whatever it points at.
    const elsewhere = path.join(sandbox, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.dirname(marker));

    const result = runStep({ user: "clawbox-device" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(chownCalls()).toHaveLength(0);
  });

  it("ends the assistant the running session already started, and only the device user's", () => {
    // The in-app update runs post_update after its own reboot: by then the
    // session has started the assistant, and the marker only stops the NEXT one.
    const result = runStep({ pkillRc: 0 });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(pkillCalls()).toHaveLength(1);
    const user = spawnSync("id", ["-un"], { encoding: "utf-8" }).stdout.trim();
    expect(pkillCalls()[0]).toMatch(new RegExp(`^pkill -TERM -u ${user} -f \\S`));
    expect(result.stdout).toContain("Ended the first-run assistant");
  });

  it("matches the assistant's own command line, never one that only mentions it", () => {
    // Unanchored, `pkill -f` also signalled any clawbox process whose command
    // line CONTAINS the text — an agent run whose prompt quotes it, a shell
    // running a script that looks for it. Checked with grep -E: pkill's
    // pattern is a POSIX extended regex searched in the command line.
    const pattern = /pkill -TERM -u "\$CLAWBOX_USER" -f '([^']+)'/.exec(
      extractShellFunction("step_gnome_initial_setup_done"),
    )?.[1];
    expect(pattern).toBeDefined();
    const matches = (cmdline: string) =>
      spawnSync("grep", ["-Eq", "--", pattern as string], { input: `${cmdline}\n` }).status === 0;

    expect(matches("/usr/libexec/gnome-initial-setup --existing-user")).toBe(true);
    expect(matches("gnome-initial-setup --existing-user")).toBe(true);
    expect(matches("/usr/libexec/gnome-initial-setup --existing-user --force")).toBe(true);
    expect(matches("claude -p fix the gnome-initial-setup --existing-user leak")).toBe(false);
    expect(matches("bash -c pgrep -f 'gnome-initial-setup --existing-user'")).toBe(false);
    expect(matches("/usr/libexec/gnome-initial-setup-copy-worker")).toBe(false);
    expect(matches("/usr/libexec/gnome-initial-setup")).toBe(false);
  });

  it("is quiet about the assistant when none was running", () => {
    const result = runStep({ pkillRc: 1 });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Ended the first-run assistant");
  });

  it("writes nothing on the second run, and only looks for a running assistant", () => {
    expect(runStep().status).toBe(0);
    const past = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(marker, past, past);
    const callsAfterFirst = fs.readFileSync(calls, "utf-8");

    const second = runStep();

    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(fs.readFileSync(marker, "utf-8")).toBe("yes");
    expect(fs.statSync(marker).mtimeMs).toBe(past.getTime());
    // No write through the user and no chown: the one new call is the
    // process check, which found nothing and stays quiet.
    const newCalls = fs.readFileSync(calls, "utf-8").slice(callsAfterFirst.length).split("\n").filter(Boolean);
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]).toMatch(/^pkill -TERM /);
    expect(second.stdout).toContain("already marked done");
    expect(second.stdout).not.toContain("Ended the first-run assistant");
  });

  it("leaves a marker that is already there alone, whatever it says", () => {
    fs.mkdirSync(path.dirname(marker), { mode: 0o755 });
    fs.writeFileSync(marker, "owner finished it\n");

    const result = runStep();

    expect(result.status).toBe(0);
    expect(fs.readFileSync(marker, "utf-8")).toBe("owner finished it\n");
    expect(fs.statSync(path.dirname(marker)).mode & 0o777).toBe(0o755);
    expect(asClawboxCalls()).toHaveLength(0);
    expect(chownCalls()).toHaveLength(0);
  });

  it("still ends a running assistant when the marker is already there", () => {
    // A marker written mid-session — by an earlier run whose pkill looked just
    // before the session started the assistant, or by hand — stops only the
    // NEXT session's copy. The one already running must not survive the run.
    fs.mkdirSync(path.dirname(marker), { mode: 0o700 });
    fs.writeFileSync(marker, "yes");

    const result = runStep({ pkillRc: 0 });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(marker, "utf-8")).toBe("yes");
    expect(asClawboxCalls()).toHaveLength(0);
    expect(pkillCalls()).toHaveLength(1);
    expect(result.stdout).toContain("already marked done");
    expect(result.stdout).toContain("Ended the first-run assistant");
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
    const call = fullInstall.search(/^step_gnome_initial_setup_done \|\| /m);
    expect(call).toBeGreaterThan(0);
    // Before the theme step, whose root `mkdir -p ~/.config/autostart` would
    // leave a missing ~/.config root-owned and the marker unwritable as clawbox.
    expect(call).toBeLessThan(fullInstall.search(/^step_desktop_theme$/m));
  });
});
