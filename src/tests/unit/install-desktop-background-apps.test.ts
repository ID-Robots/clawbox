import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accountOnlyHome, CAN_LOCK_HOME, handOverOrder, shellFunctionIfPresent, unlockTree,
} from "../helpers/account-only-home";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Ubuntu's background apps stayed resident in the GNOME session of every
 * Jetson box: gnome-software's service, update-notifier (which launches
 * update-manager and runs apt-check), NVIDIA's nvpmodel_indicator and the
 * tracker file miner, about 110 MB of PSS and 300 MB of swap on an 8 GB board.
 *
 * What is pinned here: step_desktop_background_apps writes, as the device
 * user, a per-user copy of each of those system autostart entries with
 * `Hidden=true` (the same basename, which is what makes it shadow the system
 * one) and masks the miner's user unit with a link to /dev/null; root writes
 * nothing in the home, and hands back a root-owned directory on the way
 * through `hand_over_home_path` before the first write; an entry or unit the
 * image does not ship, an owner's own file and a link are left alone with one
 * line; a second run writes nothing; and the step is wired into the full
 * install and step_post_update, never into the x64 installer.
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
const STEP = "step_desktop_background_apps";
const MARKER =
  "# ClawBox: hidden by install.sh (step_desktop_background_apps). To bring it back for good, "
  + "remove this line and the Hidden=true line; a deleted file is written again by the next update";
// What a first line must start with for the step to treat the file as its own:
// the undo wording after it may change in a later release.
const PREFIX = "# ClawBox: hidden by install.sh (step_desktop_background_apps)";
const ENTRIES = ["gnome-software-service", "update-notifier", "nvpmodel_indicator", "tracker-miner-fs-3"];
const UNIT = "tracker-miner-fs-3.service";
const SYSTEM_AUTOSTART = "/etc/xdg/autostart";
const SYSTEM_USER_UNITS = "/usr/lib/systemd/user";

// Linux only, as install.sh is (GNU stat, mktemp and mv); and not as root,
// whose writes the read-only home of account-only-home.ts cannot stop.
const CAN_RUN =
  process.platform === "linux"
  && CAN_LOCK_HOME
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start + 1, end)}\n}`;
}

// Vendor entries in the shapes the step must handle: a `Hidden=false` of the
// vendor's own (and one written with spaces, which GKeyFile reads as the same
// key, the last one winning), a comment block above the header (L4T's
// nvpmodel_indicator.desktop opens with one), and a second group after
// [Desktop Entry] that a key appended at the end would land in.
const VENDOR: Record<string, string> = {
  "gnome-software-service": [
    "[Desktop Entry]",
    "Type=Application",
    "Name=GNOME Software",
    "Exec=/usr/bin/gnome-software --gapplication-service",
    "OnlyShowIn=GNOME;Unity;",
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n"),
  "update-notifier": [
    "[Desktop Entry]",
    "Name=Update Notifier",
    "Exec=update-notifier",
    "Terminal=false",
    "Type=Application",
    "Hidden=false",
    "OnlyShowIn=GNOME;XFCE;Unity;",
    "X-GNOME-Autostart-Delay=60",
    "",
  ].join("\n"),
  nvpmodel_indicator: [
    "# Vendor comment block, first line",
    "# Vendor comment block, second line",
    "",
    "[Desktop Entry]",
    "Type=Application",
    "Exec=/usr/share/nvpmodel_indicator/nvpmodel_indicator.py",
    "Hidden = false",
    "Name=nvpmodel_indicator",
    "",
  ].join("\n"),
  "tracker-miner-fs-3": [
    "[Desktop Entry]",
    "Name=Tracker File System Miner",
    "Exec=/usr/libexec/tracker-miner-fs-3",
    "Terminal=false",
    "Type=Application",
    "X-GNOME-Autostart-enabled=true",
    "X-GNOME-HiddenUnderSystemd=true",
    "NoDisplay=true",
    "",
    "[Desktop Action x]",
    "Name=Another action",
    "Exec=/usr/libexec/tracker-miner-fs-3 --x",
    "",
  ].join("\n"),
};

/** What the override of `vendor` must be: the marker, then every vendor line but its Hidden= ones, Hidden=true after the header. */
function override(vendor: string): string {
  const out = [MARKER];
  let placed = false;
  for (const line of vendor.replace(/\n$/, "").split("\n")) {
    if (/^\s*Hidden\s*=/.test(line)) continue;
    out.push(line);
    if (!placed && line === "[Desktop Entry]") {
      out.push("Hidden=true");
      placed = true;
    }
  }
  return `${out.join("\n")}\n`;
}

let sandbox: string;
let home: string;
let aux: string;
let xdg: string;
let units: string;
let chownLog: string;

const autostartDir = () => path.join(home, ".config", "autostart");
const entryFile = (name: string) => path.join(autostartDir(), `${name}.desktop`);
const unitDir = () => path.join(home, ".config", "systemd", "user");
const maskFile = () => path.join(unitDir(), UNIT);

/** The system side of the box, outside the home: its autostart entries and the miner's unit. */
function systemFixtures(names: string[] = ENTRIES, unit = true) {
  for (const name of names) fs.writeFileSync(path.join(xdg, `${name}.desktop`), VENDOR[name]);
  if (unit) fs.writeFileSync(path.join(units, UNIT), "[Unit]\nDescription=Tracker file system data miner\n");
}

/**
 * Run the real step against the sandbox home, locked so only `as_clawbox` can
 * write there. The two system directories are moved into the sandbox in the
 * function text, and the cut is checked to have moved each of them.
 * `user` names a device user other than the test's own: to the step and the
 * hand-over helper, everything the test made in the home then belongs to
 * another account. `chown` is then a stub that records the entry and the
 * directory it ran in (the real one could not hand anything to that name).
 */
function runStep({ user = "", asClawbox = "" }: { user?: string; asClawbox?: string } = {}) {
  const fn = extractShellFunction(STEP);
  expect(fn.split(SYSTEM_AUTOSTART).length - 1, `${STEP}'s system autostart directory, named once`).toBe(1);
  expect(fn.split(SYSTEM_USER_UNITS).length - 1, `${STEP}'s system user-unit directory, named once`).toBe(1);
  const account = accountOnlyHome(home, aux);
  const script = [
    "set -euo pipefail",
    `CLAWBOX_HOME=${JSON.stringify(home)}`,
    user ? `CLAWBOX_USER=${JSON.stringify(user)}` : 'CLAWBOX_USER="$(id -un)"',
    account.shell,
    user ? `chown() { printf '%s %s\\n' "$(pwd -P)" "$*" >> ${JSON.stringify(chownLog)}; }` : "",
    asClawbox ? `as_clawbox() { ${asClawbox}; }` : "",
    shellFunctionIfPresent(INSTALL_SH, "hand_over_home_path"),
    account.recordHandOvers,
    fn.split(SYSTEM_AUTOSTART).join(xdg).split(SYSTEM_USER_UNITS).join(units),
    "__ao_lock",
    `rc=0; ${STEP} || rc=$?`,
    "__ao_unlock",
    'exit "$rc"',
  ].join("\n");
  const runner = path.join(aux, "run.sh");
  fs.writeFileSync(runner, script, "utf-8");
  const r = spawnSync("bash", [runner], { encoding: "utf-8", cwd: aux });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    rootInHome: account.rootInHome(),
    asClawbox: account.asClawbox(),
    sequence: account.sequence(),
    chowns: fs.existsSync(chownLog) ? fs.readFileSync(chownLog, "utf-8").split("\n").filter(Boolean) : [],
  };
}

type Run = ReturnType<typeof runStep>;

/** What every run must show: no file command by root in the home, and both hand-overs before the first write. */
function expectWrittenAsTheAccount(r: Run) {
  expect(r.rootInHome, "no chmod, chown, mkdir, ln, mv or write by root in the home").toEqual([]);
  for (const dir of [autostartDir(), unitDir()]) {
    const { handOver, firstWrite } = handOverOrder(r.sequence, `hand_over_home_path ${dir}`);
    expect(handOver, r.sequence.join(" | ")).toBeGreaterThanOrEqual(0);
    if (firstWrite >= 0) expect(handOver).toBeLessThan(firstWrite);
  }
}

const hiddenLines = (text: string) => text.split("\n").filter((l) => /^\s*Hidden\s*=/.test(l));

d("step_desktop_background_apps hides Ubuntu's background apps from the desktop session", () => {
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-desktop-background-apps-"));
    // None of these names has the home's path as a prefix: the recorder of
    // root's commands matches the home by substring.
    home = path.join(sandbox, "home");
    aux = path.join(sandbox, "aux");
    xdg = path.join(sandbox, "xdg-autostart");
    units = path.join(sandbox, "user-units");
    chownLog = path.join(aux, "chown.log");
    for (const dir of [home, aux, xdg, units]) fs.mkdirSync(dir);
  });

  afterEach(() => {
    unlockTree(sandbox);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("writes a hidden copy of each system entry and masks the miner, all as the device user", () => {
    systemFixtures();

    const r = runStep();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectWrittenAsTheAccount(r);
    for (const name of ENTRIES) {
      const text = fs.readFileSync(entryFile(name), "utf-8");
      const lines = text.split("\n");
      expect(lines[0]).toBe(MARKER);
      expect(hiddenLines(text), name).toEqual(["Hidden=true"]);
      expect(lines[lines.indexOf("[Desktop Entry]") + 1], name).toBe("Hidden=true");
      // Every other vendor line, in its place.
      expect(text, name).toBe(override(VENDOR[name]));
      expect(fs.lstatSync(entryFile(name)).isFile()).toBe(true);
      expect(fs.statSync(entryFile(name)).mode & 0o777).toBe(0o644);
      expect(r.stdout).toContain(`${name}: hidden`);
    }
    // The marker goes above the vendor's own comment block, Hidden=true right
    // after the header.
    expect(fs.readFileSync(entryFile("nvpmodel_indicator"), "utf-8")).toBe([
      MARKER,
      "# Vendor comment block, first line",
      "# Vendor comment block, second line",
      "",
      "[Desktop Entry]",
      "Hidden=true",
      "Type=Application",
      "Exec=/usr/share/nvpmodel_indicator/nvpmodel_indicator.py",
      "Name=nvpmodel_indicator",
      "",
    ].join("\n"));
    // Not appended at the end, where [Desktop Action x] would own it.
    const tracker = fs.readFileSync(entryFile("tracker-miner-fs-3"), "utf-8");
    expect(tracker.indexOf("Hidden=true")).toBeLessThan(tracker.indexOf("[Desktop Action x]"));
    expect(fs.lstatSync(maskFile()).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(maskFile())).toBe("/dev/null");
    expect(r.stdout).toContain(`${UNIT}: masked`);
    // Every write went through the device user, each path an argument.
    expect(r.asClawbox.filter((c) => c.startsWith("sh -c "))).toHaveLength(ENTRIES.length + 1);
    for (const name of ENTRIES) expect(r.asClawbox.some((c) => c.includes(entryFile(name)))).toBe(true);
    expect(r.asClawbox.some((c) => c.includes(maskFile()))).toBe(true);
    // No temp left behind.
    expect(fs.readdirSync(autostartDir()).sort()).toEqual(ENTRIES.map((n) => `${n}.desktop`).sort());
    expect(fs.readdirSync(unitDir())).toEqual([UNIT]);
  });

  it("hides only the entries this image ships, and masks nothing without the unit", () => {
    systemFixtures(["gnome-software-service", "nvpmodel_indicator"], false);

    const r = runStep();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectWrittenAsTheAccount(r);
    expect(fs.readdirSync(autostartDir()).sort()).toEqual(
      ["gnome-software-service.desktop", "nvpmodel_indicator.desktop"],
    );
    expect(fs.existsSync(path.join(home, ".config", "systemd"))).toBe(false);
    for (const name of ["update-notifier", "tracker-miner-fs-3"]) {
      const said = r.stdout.split("\n").filter((l) => l.includes(`${name}: no system autostart entry on this image, nothing to hide`));
      expect(said, name).toHaveLength(1);
    }
    expect(r.stdout).toContain(`${UNIT}: no such user unit on this image, nothing to mask`);
  });

  it("leaves the owner's own entry and unit byte-for-byte", () => {
    systemFixtures();
    const own = "[Desktop Entry]\nType=Application\nExec=update-notifier\nX-GNOME-Autostart-enabled=false\n";
    const ownUnit = "[Unit]\nDescription=the owner's own miner\n";
    fs.mkdirSync(autostartDir(), { recursive: true });
    fs.writeFileSync(entryFile("update-notifier"), own);
    fs.mkdirSync(unitDir(), { recursive: true });
    fs.writeFileSync(maskFile(), ownUnit);
    const past = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(entryFile("update-notifier"), past, past);
    fs.utimesSync(maskFile(), past, past);

    const r = runStep();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectWrittenAsTheAccount(r);
    expect(fs.readFileSync(entryFile("update-notifier"), "utf-8")).toBe(own);
    expect(fs.statSync(entryFile("update-notifier")).mtimeMs).toBe(past.getTime());
    expect(fs.readFileSync(maskFile(), "utf-8")).toBe(ownUnit);
    expect(fs.lstatSync(maskFile()).isSymbolicLink()).toBe(false);
    expect(fs.statSync(maskFile()).mtimeMs).toBe(past.getTime());
    expect(r.stdout).toMatch(/update-notifier: .*owner's own.*left as it is/);
    expect(r.stdout).toMatch(new RegExp(`${UNIT.replace(/\./g, "\\.")}: .*owner's own.*left as it is`));
    // The other entries are still hidden.
    expect(fs.readFileSync(entryFile("gnome-software-service"), "utf-8")).toBe(override(VENDOR["gnome-software-service"]));
  });

  it("follows no link at a destination", () => {
    systemFixtures();
    const target = path.join(sandbox, "linked-target.desktop");
    const unitTarget = path.join(sandbox, "linked-target.service");
    fs.writeFileSync(target, "not to be written\n");
    fs.writeFileSync(unitTarget, "[Unit]\n");
    fs.mkdirSync(autostartDir(), { recursive: true });
    fs.symlinkSync(target, entryFile("gnome-software-service"));
    fs.mkdirSync(unitDir(), { recursive: true });
    fs.symlinkSync(unitTarget, maskFile());

    const r = runStep();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectWrittenAsTheAccount(r);
    expect(fs.readlinkSync(entryFile("gnome-software-service"))).toBe(target);
    expect(fs.readFileSync(target, "utf-8")).toBe("not to be written\n");
    expect(fs.readlinkSync(maskFile())).toBe(unitTarget);
    expect(fs.readFileSync(unitTarget, "utf-8")).toBe("[Unit]\n");
    expect(r.stdout).toMatch(/gnome-software-service: .*link.*left as it is/);
    // The others are still hidden.
    expect(fs.readFileSync(entryFile("update-notifier"), "utf-8")).toBe(override(VENDOR["update-notifier"]));
  });

  it("hands a root-owned ~/.config and ~/.config/autostart back through hand_over_home_path before the first write", () => {
    // What an older install can leave: a root-owned ~/.config and autostart.
    // With another account named as the device user, everything the test made
    // looks root's to the step.
    systemFixtures();
    fs.mkdirSync(autostartDir(), { recursive: true });

    const r = runStep({ user: "clawbox-device" });

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectWrittenAsTheAccount(r);
    const real = fs.realpathSync(home);
    expect(r.chowns).toContain(`${real} -h -- clawbox-device:clawbox-device .config`);
    expect(r.chowns).toContain(`${real}/.config -h -- clawbox-device:clawbox-device autostart`);
    // One entry at a time, never recursive, never through a link.
    for (const c of r.chowns) expect(c).toMatch(/ -h -- clawbox-device:clawbox-device [^/ ]+$/);
    for (const name of ENTRIES) expect(fs.readFileSync(entryFile(name), "utf-8")).toBe(override(VENDOR[name]));
  });

  it("writes nothing through a ~/.config that is a link, and hands nothing below it over", () => {
    // A link the account planted at ~/.config (here to a sandbox "etc"): root
    // following it would change the owner of what it points at, and a write
    // below it would land there.
    systemFixtures();
    const etc = path.join(sandbox, "etc");
    fs.mkdirSync(path.join(etc, "systemd", "user"), { recursive: true });
    fs.mkdirSync(path.join(etc, "autostart"));
    fs.symlinkSync(etc, path.join(home, ".config"));
    const listing = () => spawnSync("find", [etc, "-printf", "%p %y %U %T@\\n"], { encoding: "utf-8" }).stdout;
    const before = listing();

    const r = runStep({ user: "clawbox-device" });

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectWrittenAsTheAccount(r);
    expect(r.chowns, "nothing changes owner").toEqual([]);
    expect(listing(), "nothing is written below the link").toBe(before);
    expect(fs.readlinkSync(path.join(home, ".config"))).toBe(etc);
    expect(r.stdout).toMatch(/~\/\.config\/autostart .*link.*left as it is/);
    expect(r.stdout).toMatch(/~\/\.config\/systemd\/user .*link.*left as it is/);
  });

  it("rewrites its own copy when the vendor entry changed", () => {
    systemFixtures();
    expect(runStep().status).toBe(0);
    const changed = VENDOR["update-notifier"].replace("X-GNOME-Autostart-Delay=60", "X-GNOME-Autostart-Delay=30");
    fs.writeFileSync(path.join(xdg, "update-notifier.desktop"), changed);

    const r = runStep();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectWrittenAsTheAccount(r);
    expect(fs.readFileSync(entryFile("update-notifier"), "utf-8")).toBe(override(changed));
    expect(r.stdout).toContain("update-notifier: hidden");
  });

  it("knows its own copy by the first line's prefix, and rewrites one with other wording after it", () => {
    // A copy an earlier release wrote, whose undo sentence read differently.
    systemFixtures();
    const older = override(VENDOR["update-notifier"]).replace(MARKER, `${PREFIX}. Older wording of how to undo it`);
    fs.mkdirSync(autostartDir(), { recursive: true });
    fs.writeFileSync(entryFile("update-notifier"), older);

    const r = runStep();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectWrittenAsTheAccount(r);
    expect(fs.readFileSync(entryFile("update-notifier"), "utf-8")).toBe(override(VENDOR["update-notifier"]));
    expect(r.stdout).toContain("update-notifier: hidden");
    expect(r.stdout).not.toContain("owner's own");
  });

  it("leaves a file whose first line does not start with the prefix byte-for-byte", () => {
    systemFixtures();
    // The prefix later in the line, and a first line that stops short of it.
    const own: Record<string, string> = {
      "update-notifier": override(VENDOR["update-notifier"]).replace(MARKER, `# my own copy, was: ${PREFIX}`),
      nvpmodel_indicator: override(VENDOR.nvpmodel_indicator).replace(MARKER, "# ClawBox: hidden by install.sh"),
    };
    fs.mkdirSync(autostartDir(), { recursive: true });
    const past = new Date("2026-01-01T00:00:00Z");
    for (const [name, text] of Object.entries(own)) {
      fs.writeFileSync(entryFile(name), text);
      fs.utimesSync(entryFile(name), past, past);
    }

    const r = runStep();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectWrittenAsTheAccount(r);
    for (const [name, text] of Object.entries(own)) {
      expect(fs.readFileSync(entryFile(name), "utf-8"), name).toBe(text);
      expect(fs.statSync(entryFile(name)).mtimeMs, name).toBe(past.getTime());
      expect(r.stdout).toContain(`${name}: ~/.config/autostart/${name}.desktop is the owner's own, left as it is`);
    }
  });

  it("writes nothing on a second run, and says each is already done", () => {
    systemFixtures();
    expect(runStep().status).toBe(0);
    const past = new Date("2026-01-01T00:00:00Z");
    for (const name of ENTRIES) fs.utimesSync(entryFile(name), past, past);
    fs.utimesSync(autostartDir(), past, past);
    fs.utimesSync(unitDir(), past, past);
    const look = () => [
      ...ENTRIES.map((n) => fs.lstatSync(entryFile(n))),
      fs.lstatSync(maskFile()),
      fs.lstatSync(autostartDir()),
      fs.lstatSync(unitDir()),
    ].map((s) => `${s.ino} ${s.mtimeMs}`);
    const before = look();

    const r = runStep();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectWrittenAsTheAccount(r);
    // No file rewritten, and no temp made and removed beside them.
    expect(look()).toEqual(before);
    for (const name of ENTRIES) expect(r.stdout).toContain(`${name}: already hidden`);
    expect(r.stdout).toContain(`${UNIT}: already masked`);
  });

  it("answers non-zero, naming each file, when the device user's write fails", () => {
    systemFixtures();

    const r = runStep({ asClawbox: "return 1" });

    expect(r.status).toBe(1);
    expect(r.rootInHome).toEqual([]);
    for (const name of ENTRIES) expect(r.stderr).toContain(`Warning: could not write ${entryFile(name)}`);
    expect(r.stderr).toContain(`Warning: could not write ${maskFile()}`);
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });
});

describe("step_desktop_background_apps's marker", () => {
  it("starts with the prefix the step knows its own copy by", () => {
    const fn = extractShellFunction(STEP);
    const literal = (name: string) => fn.match(new RegExp(`^ {2}local ${name}='([^']*)'$`, "m"))?.[1];
    expect(literal("marker")).toBe(MARKER);
    expect(literal("marker_prefix")).toBe(PREFIX);
    expect(MARKER.startsWith(`${PREFIX}.`)).toBe(true);
  });
});

describe("step_desktop_background_apps is wired into the Jetson installer only", () => {
  it("runs on the full install and on every in-app update, after the gnome first-run step", () => {
    const postUpdate = extractShellFunction("step_post_update");
    const gnome = "optional_step gnome_initial_setup_done step_gnome_initial_setup_done";
    const ours = "optional_step desktop_background_apps step_desktop_background_apps";
    expect(postUpdate).toContain(`\n  ${ours}\n`);
    // Right after the gnome line: nothing but comments between them.
    const between = postUpdate.slice(postUpdate.indexOf(gnome) + gnome.length, postUpdate.indexOf(ours));
    expect(postUpdate.indexOf(gnome)).toBeGreaterThan(0);
    expect(between.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))).toEqual([]);

    const fullInstall = INSTALL_SH.slice(INSTALL_SH.indexOf("# ── Full Install Mode"));
    const gnomeCall = fullInstall.search(/^step_gnome_initial_setup_done \|\| /m);
    const call = fullInstall.search(
      /^step_desktop_background_apps \|\| echo " {2}Warning: desktop_background_apps step failed \(non-fatal\)"$/m,
    );
    expect(gnomeCall).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(gnomeCall);
    expect(call).toBeLessThan(fullInstall.search(/^step_desktop_theme$/m));
  });

  it("is not in the x64 installer or its migration scripts", () => {
    expect(fs.readFileSync(path.join(REPO, "install-x64.sh"), "utf-8")).not.toContain("desktop_background_apps");
    const found = spawnSync("grep", ["-rl", "desktop_background_apps", path.join(REPO, "scripts", "x64-migration")], {
      encoding: "utf-8",
    });
    expect(found.stdout).toBe("");
  });
});
