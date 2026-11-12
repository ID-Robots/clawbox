import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountOnlyHome, handOverOrder, shellFunctionIfPresent, unlockTree } from "../helpers/account-only-home";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * install.sh runs as root, and the clawbox user owns its home. Root writing,
 * renaming, linking or removing there acts through any link that user planted
 * (~/.config/systemd/user -> /etc/systemd/system, ~/.codex -> /etc), so the
 * installer does that file work AS the user (`as_clawbox`), after handing back
 * any root-owned directory an earlier root run left on the way.
 *
 * These are the sites no other suite runs: the mask of the user-level gateway
 * unit (step_gateway_setup), ~/.codex (step_systemd_services), the full
 * install's ~/Desktop clean-up, and the hand-over helper itself. Each block is
 * cut out of the shipped install.sh and run against a home only `as_clawbox`
 * can write to (src/tests/helpers/account-only-home.ts).
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

// Linux only, as install.sh is (GNU stat and find); and not as root, whose
// writes the read-only home cannot stop.
const CAN_RUN =
  process.platform === "linux"
  && typeof process.getuid === "function" && process.getuid() !== 0
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

/** install.sh from the first line containing `from` up to (not including) the first after it containing `to`. */
function sliceLines(source: string, from: string, to: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.includes(from));
  if (start < 0) throw new Error(`${from} not found in install.sh`);
  const end = lines.findIndex((l, i) => i > start && l.includes(to));
  if (end < 0) throw new Error(`${to} not found after ${from} in install.sh`);
  return lines.slice(start, end).join("\n");
}

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return `${INSTALL_SH.slice(start + 1, end)}\n}`;
}

let sandbox: string;
let home: string;
let aux: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-home-as-account-"));
  home = path.join(sandbox, "home");
  aux = path.join(sandbox, "aux");
  fs.mkdirSync(home);
  fs.mkdirSync(aux);
});

afterEach(() => {
  unlockTree(sandbox);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Run `body` (shell) against the locked sandbox home, as root's install.sh would. */
function runAsInstaller(body: string, prelude = "") {
  const account = accountOnlyHome(home, aux);
  const script = [
    "set -euo pipefail",
    `CLAWBOX_HOME=${JSON.stringify(home)}`,
    'CLAWBOX_USER="$(id -un)"',
    `CALLS=${JSON.stringify(path.join(aux, "calls.log"))}`,
    account.shell,
    prelude,
    shellFunctionIfPresent(INSTALL_SH, "hand_over_home_path"),
    account.recordHandOvers,
    "__ao_lock",
    body,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(aux, "run.sh"), script, "utf-8");
  const result = spawnSync("bash", [path.join(aux, "run.sh")], { encoding: "utf-8", cwd: aux });
  const callsFile = path.join(aux, "calls.log");
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    rootInHome: account.rootInHome(),
    asClawbox: account.asClawbox(),
    sequence: account.sequence(),
    calls: fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf-8").split("\n").filter(Boolean) : [],
  };
}

d("the user-level gateway unit is masked by the clawbox user", () => {
  // step_gateway_setup's block, from its first line to the `fi` that closes it.
  const block = (() => {
    const start = INSTALL_SH.indexOf('  local USER_SYSTEMD_DIR="$CLAWBOX_HOME/.config/systemd/user"');
    if (start < 0) throw new Error("the user-unit mask block is not in install.sh");
    const end = INSTALL_SH.indexOf("\n  fi\n", start);
    return INSTALL_SH.slice(start, end + "\n  fi".length);
  })();
  // `sudo -u … systemctl --user stop` is the stop of a running user gateway:
  // recorded, never run, so the test cannot stop a unit on the machine.
  const prelude = 'sudo() { printf \'sudo %s\\n\' "$*" >> "$CALLS"; }';
  const unitDir = () => path.join(home, ".config", "systemd", "user");
  const unit = () => path.join(unitDir(), "openclaw-gateway.service");
  const mask = () => runAsInstaller(`mask_user_gateway() {\n${block}\n}\nmask_user_gateway`, prelude);

  it("replaces a user unit file with a link to /dev/null, after stopping it", () => {
    fs.mkdirSync(unitDir(), { recursive: true });
    fs.writeFileSync(unit(), "[Service]\nExecStart=/usr/bin/openclaw gateway\n");

    const r = mask();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.rootInHome, "no rm, ln, mkdir or chown by root in the home").toEqual([]);
    expect(fs.lstatSync(unit()).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(unit())).toBe("/dev/null");
    expect(r.stdout).toContain("Masking conflicting user-level openclaw-gateway.service");
    // The stop still comes first, so the port is freed by this run.
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/systemctl --user stop openclaw-gateway\.service$/);
    expect(r.asClawbox.some((c) => c.startsWith("ln -s"))).toBe(true);
    // Its directory, and each one above it, are handed over before the first write.
    const { handOver, firstWrite } = handOverOrder(r.sequence, `hand_over_home_path ${unitDir()}`);
    expect(handOver, r.sequence.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(handOver).toBeLessThan(firstWrite);
    expect(r.sequence[firstWrite]).toBe(`rm -f -- ${unit()}`);
  });

  it("is a no-op on a unit that is already masked", () => {
    fs.mkdirSync(unitDir(), { recursive: true });
    fs.symlinkSync("/dev/null", unit());

    const r = mask();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("already masked");
    expect(r.asClawbox).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(fs.readlinkSync(unit())).toBe("/dev/null");
  });

  it("masks again on the next run when the link was replaced by a unit file", () => {
    fs.mkdirSync(unitDir(), { recursive: true });
    fs.writeFileSync(unit(), "[Service]\n");
    expect(mask().status).toBe(0);
    fs.unlinkSync(unit());
    fs.writeFileSync(unit(), "[Service]\n");

    const r = mask();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(fs.readlinkSync(unit())).toBe("/dev/null");
    expect(r.rootInHome).toEqual([]);
  });

  it("creates nothing when there is no user unit", () => {
    const r = mask();

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
    expect(r.asClawbox).toEqual([]);
  });
});

d("a mask the clawbox user cannot write is reported, and the gateway step still finishes", () => {
  // The whole step: the updater dispatches it on its own under errexit (and
  // stops the update when it fails), and step_post_update runs it as a fixup
  // with errexit off. The account's rm or ln can fail where root's could not;
  // either way the system gateway is still configured and restarted, and the
  // failed mask is said on the line the updater turns into a warning.
  const unitDir = () => path.join(home, ".config", "systemd", "user");
  const unit = () => path.join(unitDir(), "openclaw-gateway.service");
  const MARKER = /^CLAWBOX-WARN\[user-gateway-not-masked\]: /m;

  function gatewaySetup(call: string) {
    const fn = shellFunction("step_gateway_setup");
    const etc = path.join(sandbox, "etc-systemd");
    expect(fn.split("/etc/systemd/system").length - 1, "step_gateway_setup's unit paths").toBe(3);
    const src = path.join(sandbox, "src");
    fs.mkdirSync(path.join(src, "config"), { recursive: true });
    fs.mkdirSync(etc, { recursive: true });
    fs.writeFileSync(path.join(src, "config", "clawbox-gateway.service"), "[Service]\n");
    const prelude = [
      `SRC_DIR=${JSON.stringify(src)}`,
      `PROJECT_DIR=${JSON.stringify(path.join(home, "clawbox"))}`,
      "is_hermes_edition() { return 1; }",
      "is_unselected_edition() { return 1; }",
      'sudo() { printf \'sudo %s\\n\' "$*" >> "$CALLS"; }',
      'systemctl() { printf \'systemctl %s\\n\' "$*" >> "$CALLS"; }',
      fn.split("/etc/systemd/system").join(etc),
    ].join("\n");
    return runAsInstaller(call, prelude);
  }

  beforeEach(() => {
    fs.mkdirSync(unitDir(), { recursive: true });
    fs.writeFileSync(unit(), "[Service]\nExecStart=/usr/bin/openclaw gateway\n");
    // The account cannot change the directory the unit is in.
    fs.chmodSync(unitDir(), 0o555);
  });

  it.each([
    ["dispatched on its own, under errexit", 'step_gateway_setup; echo "RC=0"'],
    ["run as a fixup, errexit off", 'if step_gateway_setup; then echo "RC=0"; else echo "RC=$?"; fi'],
  ])("%s", (_name, call) => {
    const r = gatewaySetup(call);

    expect(r.stdout, r.stderr).toContain("RC=0");
    expect(r.stdout).toMatch(MARKER);
    expect(r.stderr).toContain("Warning: could not mask the user-level openclaw-gateway.service");
    expect(r.calls).toContain("systemctl restart clawbox-gateway.service");
    expect(fs.lstatSync(unit()).isSymbolicLink()).toBe(false);
    expect(r.rootInHome).toEqual([]);
  });

  it("says nothing of the kind when the mask lands", () => {
    fs.chmodSync(unitDir(), 0o755);

    const r = gatewaySetup('step_gateway_setup; echo "RC=0"');

    expect(r.stdout, r.stderr).toContain("RC=0");
    expect(r.stdout).not.toMatch(MARKER);
    expect(fs.readlinkSync(unit())).toBe("/dev/null");
    expect(r.calls).toContain("systemctl restart clawbox-gateway.service");
  });
});

d("~/.codex is made private by the clawbox user", () => {
  // step_systemd_services' lines, from the comment that explains them to the
  // timer start that follows.
  const block = sliceLines(
    shellFunction("step_systemd_services"),
    "# The sync unit runs under ProtectSystem=strict",
    "systemctl enable --now clawbox-codex-auth-sync.timer",
  );
  const codex = () => path.join(home, ".codex");

  it("is cut from install.sh with nothing but the ~/.codex lines in it", () => {
    const commands = block.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(c).toContain('"$CLAWBOX_HOME/.codex"');
  });

  it("creates a missing ~/.codex with mode 0700", () => {
    const r = runAsInstaller(block);

    expect(r.rootInHome, "no install, mkdir or chmod by root in the home").toEqual([]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(fs.statSync(codex()).isDirectory()).toBe(true);
    expect(fs.statSync(codex()).mode & 0o777).toBe(0o700);
    const { handOver, firstWrite } = handOverOrder(r.sequence, `hand_over_home_path ${codex()}`);
    expect(handOver, r.sequence.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(handOver).toBeLessThan(firstWrite);
  });

  it("sets an existing ~/.codex back to 0700 and keeps what is in it", () => {
    fs.mkdirSync(codex(), { mode: 0o755 });
    fs.chmodSync(codex(), 0o755);
    fs.writeFileSync(path.join(codex(), "auth.json"), "{}\n");

    const r = runAsInstaller(block);

    expect(r.rootInHome).toEqual([]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(fs.statSync(codex()).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(codex(), "auth.json"), "utf-8")).toBe("{}\n");
  });
});

d("the full install's ~/Desktop clean-up runs as the clawbox user", () => {
  const block = sliceLines(INSTALL_SH, "# Clean up default NVIDIA desktop shortcuts", "# Bake the edition lock");
  const desktop = () => path.join(home, "Desktop");

  it("removes the .desktop shortcuts, a linked one included, and nothing else", () => {
    fs.mkdirSync(desktop());
    fs.writeFileSync(path.join(desktop(), "nvidia-a.desktop"), "[Desktop Entry]\n");
    fs.writeFileSync(path.join(desktop(), "nvidia-b.desktop"), "[Desktop Entry]\n");
    const target = path.join(aux, "shared.desktop");
    fs.writeFileSync(target, "[Desktop Entry]\n");
    fs.symlinkSync(target, path.join(desktop(), "linked.desktop"));
    fs.writeFileSync(path.join(desktop(), "notes.txt"), "keep\n");

    const r = runAsInstaller(block);

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.rootInHome, "no rm by root in the home").toEqual([]);
    expect(fs.readdirSync(desktop())).toEqual(["notes.txt"]);
    // The link went, never what it pointed at.
    expect(fs.existsSync(target)).toBe(true);
    const { handOver, firstWrite } = handOverOrder(r.sequence, `hand_over_home_path ${desktop()}`);
    expect(handOver, r.sequence.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(handOver).toBeLessThan(firstWrite);
  });

  it("is quiet when there is no ~/Desktop", () => {
    const r = runAsInstaller(block);

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toBe("");
    expect(fs.existsSync(desktop())).toBe(false);
  });
});

d("hand_over_home_path gives root-owned leftovers back one entry at a time", () => {
  // The tests cannot make a root-owned directory, so the device user is named
  // as an account other than the test's own: to the helper, everything the
  // test made then belongs to someone else. `chown` is a stub that records the
  // entry and the directory it was run in.
  function handOver(target: string, chownBody = "", flags = "") {
    const script = [
      "set -euo pipefail",
      `CLAWBOX_HOME=${JSON.stringify(home)}`,
      "CLAWBOX_USER=clawbox-device",
      `CALLS=${JSON.stringify(path.join(aux, "chown.log"))}`,
      `chown() { printf '%s %s\\n' "$(pwd -P)" "$*" >> "$CALLS"; ${chownBody} }`,
      shellFunctionIfPresent(INSTALL_SH, "hand_over_home_path"),
      `hand_over_home_path ${flags} ${JSON.stringify(target)}`,
      'echo "rc=$?"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", cwd: aux });
    const log = path.join(aux, "chown.log");
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      chowns: fs.existsSync(log) ? fs.readFileSync(log, "utf-8").split("\n").filter(Boolean) : [],
    };
  }

  it("exists in install.sh", () => {
    expect(shellFunctionIfPresent(INSTALL_SH, "hand_over_home_path")).not.toBe("");
  });

  it("hands over each directory on the way, from the home down, with chown -h and no -R", () => {
    fs.mkdirSync(path.join(home, ".config", "systemd", "user"), { recursive: true });

    const r = handOver(path.join(home, ".config", "systemd", "user"));

    expect(r.status, r.stderr).toBe(0);
    const real = fs.realpathSync(home);
    expect(r.chowns).toEqual([
      `${real} -h -- clawbox-device:clawbox-device .config`,
      `${real}/.config -h -- clawbox-device:clawbox-device systemd`,
      `${real}/.config/systemd -h -- clawbox-device:clawbox-device user`,
    ]);
  });

  it("hands over a file at the end of the path, and stops where the path stops existing", () => {
    fs.writeFileSync(path.join(home, ".bashrc"), "");
    expect(handOver(path.join(home, ".bashrc")).chowns).toHaveLength(1);

    fs.rmSync(path.join(aux, "chown.log"));
    fs.mkdirSync(path.join(home, ".cache"));
    const r = handOver(path.join(home, ".cache", "node-gyp"));
    expect(r.chowns).toHaveLength(1);
    expect(r.chowns[0]).toMatch(/ \.cache$/);
  });

  it("never goes through a link, at any depth", () => {
    // A link root followed would hand the user whatever it points at.
    const outside = path.join(aux, "etc");
    fs.mkdirSync(path.join(outside, "systemd"), { recursive: true });
    fs.symlinkSync(outside, path.join(home, ".config"));
    expect(handOver(path.join(home, ".config", "systemd")).chowns).toEqual([]);

    fs.rmSync(path.join(home, ".config"));
    fs.mkdirSync(path.join(home, ".config"));
    fs.symlinkSync(path.join(outside, "systemd"), path.join(home, ".config", "systemd"));
    const r = handOver(path.join(home, ".config", "systemd", "user"));
    expect(r.chowns).toHaveLength(1);
    expect(r.chowns[0]).toMatch(/ \.config$/);
  });

  it("stops when a directory is swapped for a link between its look and its entry", () => {
    // The race the walk exists for: the user owns the home, so it can replace
    // ~/.config with a link to /etc just after root examined it. Simulated
    // inside the chown of ~/.config; the walk must not go on in the link's
    // target.
    const outside = path.join(aux, "etc");
    fs.mkdirSync(path.join(outside, "systemd"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "systemd"), { recursive: true });
    const swap = [
      `if [ "\${@: -1}" = .config ]; then`,
      `  command mv ${JSON.stringify(path.join(home, ".config"))} ${JSON.stringify(path.join(aux, "was-config"))};`,
      `  command ln -s ${JSON.stringify(outside)} ${JSON.stringify(path.join(home, ".config"))};`,
      "fi;",
    ].join(" ");

    const r = handOver(path.join(home, ".config", "systemd"), swap);

    expect(r.status, r.stderr).toBe(0);
    expect(r.chowns).toHaveLength(1);
    expect(r.chowns[0]).toMatch(/ \.config$/);
  });

  it("with -R, hands over the last directory with everything below it, from the directory it is in", () => {
    fs.mkdirSync(path.join(home, ".cache", "node-gyp", "24.22.2"), { recursive: true });

    const r = handOver(path.join(home, ".cache", "node-gyp"), "", "-R");

    expect(r.status, r.stderr).toBe(0);
    const real = fs.realpathSync(home);
    expect(r.chowns).toEqual([
      `${real} -h -- clawbox-device:clawbox-device .cache`,
      `${real}/.cache -R -- clawbox-device:clawbox-device node-gyp`,
    ]);
  });

  it("with -R, goes through no link, the last entry included", () => {
    const outside = path.join(aux, "elsewhere");
    fs.mkdirSync(path.join(outside, "node-gyp"), { recursive: true });
    fs.symlinkSync(outside, path.join(home, ".cache"));
    expect(handOver(path.join(home, ".cache", "node-gyp"), "", "-R").chowns).toEqual([]);

    fs.rmSync(path.join(home, ".cache"));
    fs.mkdirSync(path.join(home, ".cache"));
    fs.symlinkSync(path.join(outside, "node-gyp"), path.join(home, ".cache", "node-gyp"));
    const r = handOver(path.join(home, ".cache", "node-gyp"), "", "-R");
    expect(r.chowns).toHaveLength(1);
    expect(r.chowns[0]).toMatch(/ -h -- \S+ \.cache$/);
  });

  it("hands over a file only while it has one name, so nothing outside the home changes hands", () => {
    // A second hard link is the same file under another name: handing over the
    // name in the home would hand over the file wherever else it is linked.
    // Where a directory is expected (~/.codex) the old `install -d` failed on
    // a file and chowned nothing.
    const outside = path.join(aux, "elsewhere");
    fs.writeFileSync(outside, "");
    fs.linkSync(outside, path.join(home, ".codex"));
    fs.linkSync(outside, path.join(home, ".bashrc"));

    expect(handOver(path.join(home, ".codex")).chowns).toEqual([]);
    expect(handOver(path.join(home, ".bashrc")).chowns).toEqual([]);
    expect(handOver(path.join(home, ".codex", "x")).chowns).toEqual([]);

    // The same file with one name left is handed over as before.
    fs.rmSync(outside);
    fs.rmSync(path.join(home, ".codex"));
    expect(handOver(path.join(home, ".bashrc")).chowns).toHaveLength(1);
  });

  it("leaves what is already the user's alone, and ignores a path outside the home", () => {
    fs.mkdirSync(path.join(home, ".config"));
    const script = [
      `CLAWBOX_HOME=${JSON.stringify(home)}`,
      'CLAWBOX_USER="$(id -un)"',
      'chown() { echo "chown $*"; }',
      shellFunctionIfPresent(INSTALL_SH, "hand_over_home_path"),
      `hand_over_home_path ${JSON.stringify(path.join(home, ".config", "autostart"))}`,
      `hand_over_home_path ${JSON.stringify(path.join(aux, "x"))}`,
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("answers 0 whatever it finds, so a caller under errexit carries on", () => {
    // A chown that fails, a dangling link: neither may end the step.
    fs.mkdirSync(path.join(home, ".codex"));
    expect(handOver(path.join(home, ".codex"), "return 1;").stdout).toContain("rc=0");
    fs.symlinkSync("/nonexistent", path.join(home, ".dangling"));
    expect(handOver(path.join(home, ".dangling", "x")).stdout).toContain("rc=0");
    // The recursive hand-over too: errexit is on in its subshell, as in the
    // installer, and chown -R fails when an entry goes away under it.
    expect(handOver(path.join(home, ".codex"), 'case " $* " in *" -R "*) return 1 ;; esac;', "-R").stdout)
      .toContain("rc=0");
  });
});
