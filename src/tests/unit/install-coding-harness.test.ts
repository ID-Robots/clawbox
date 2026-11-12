import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODING_HARNESS_COMMAND, CODING_HARNESS_WRAPPER_PATH } from "@/lib/coding-harness";
import { accountOnlyHome, CAN_LOCK_HOME, shellFunctionIfPresent, unlockTree } from "../helpers/account-only-home";

// The wrapper's install starts a real bash: vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * How the coding harness actually reaches a device.
 *
 * The bug this file exists to prevent already happened once, in the other
 * direction: install.sh has had the native Claude Code installer since before
 * TASK-378 was written, and no shipped box has `claude` on it — because
 * step_post_update never called the step that runs it. Fresh-install-only
 * delivery is the default failure mode of this installer, not an edge case, so
 * the delivery path is pinned here rather than assumed.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const WRAPPER = readFileSync(path.join(REPO, "scripts", "claude-ds"), "utf-8");

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end);
}

function bashArray(name: string): string[] {
  const start = INSTALL_SH.indexOf(`${name}=(`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n)", start);
  return INSTALL_SH.slice(start + `${name}=(`.length, end)
    .split("\n")
    .flatMap((l) => l.replace(/#.*$/, "").trim().split(/\s+/))
    .filter(Boolean);
}

describe("delivery to devices already in the field", () => {
  it("post_update installs the harness, so an in-app update is enough", () => {
    // Without this line the feature only ever exists on boxes flashed after it
    // merged, which is how `claude` came to be missing everywhere.
    expect(extractShellFunction("step_post_update")).toContain("step_coding_harness");
  });

  it("a fresh install ships it too", () => {
    // The main flow calls the harness step directly. It cannot ride inside
    // step_ai_tools_install, which early-returns in test mode — the very
    // environment e2e-install proves the delivery path in.
    const flow = INSTALL_SH.slice(INSTALL_SH.indexOf("# ── Full Install Mode"));
    expect(flow).toContain("step_coding_harness");
    expect(extractShellFunction("step_ai_tools_install")).toContain("ensure_claude_code");
  });

  it("exactly one place installs the wrapper, so the two paths cannot drift", () => {
    const callers = INSTALL_SH.split("\n").filter(
      (l) => l.includes("install_claude_ds_wrapper") && !l.trim().startsWith("#") && !l.includes("() {"),
    );
    expect(callers).toHaveLength(1);
  });

  it("is dispatchable on its own, so a box can repair the harness without a reinstall", () => {
    // The wrapper's own error message tells the owner to run exactly this.
    expect(bashArray("DISPATCH_STEPS")).toContain("coding_harness");
    expect(WRAPPER).toContain("--step coding_harness");
  });

  it("post_update cannot be aborted by the harness step", () => {
    // Every optional step in post_update is guarded; an unguarded one would
    // stop the update at whatever comes after it.
    const fn = extractShellFunction("step_post_update");
    // `optional_step` is the guard in post_update now: it cannot fail the step and it records the name, so a skipped repair reaches the update's own status rather than only the journal.
    const line = fn.split("\n").find((l) => l.includes("step_coding_harness"));
    expect(line).toMatch(/^\s*optional_step \S+ step_coding_harness\b/);
  });
});

describe("Claude Code is installed the way Anthropic supports", () => {
  const fn = extractShellFunction("ensure_claude_code");

  it("uses the native installer, not an npm global", () => {
    expect(fn).toContain("https://claude.ai/install.sh");
    expect(fn).not.toContain("npm i -g");
  });

  it("runs it AS the clawbox user — the installer refuses to run as root", () => {
    expect(fn).toContain('sudo -u "$CLAWBOX_USER" bash "$installer"');
  });

  it("still refuses to pipe a region-block page into bash", () => {
    // Anthropic geo-blocks some regions with an HTML body and HTTP 200, and
    // piping that into bash once aborted an entire reinstall.
    expect(fn).toContain("unavailable in region");
    expect(fn).toContain("<!doctype");
  });

  it("hands the downloaded installer to the user that will execute it, after the download", () => {
    // Two real failures, both seen on .65 on 2026-08-22, one after the other.
    //
    // Without the chown: mktemp makes the file root:root 0600 and the installer
    // runs AS the clawbox user, so every run answered
    // "bash: /tmp/tmp.XXXX: Permission denied" then "installer ran but failed".
    //
    // With the chown moved before the curl: these devices run
    // fs.protected_regular=2, under which even root may not write a file it
    // does not own in sticky world-writable /tmp — curl exits 23, "Failure
    // writing output to destination", and the step reports a region block that
    // never happened.
    //
    // So the ordering is the fix, and both halves of it are pinned.
    const chown = 'chown "$CLAWBOX_USER" "$installer"';
    const curl = "curl -fsSL https://claude.ai/install.sh";
    const run = 'sudo -u "$CLAWBOX_USER" bash "$installer"';
    expect(fn).toContain(chown);
    expect(fn.indexOf(curl)).toBeLessThan(fn.indexOf(chown));
    expect(fn.indexOf(chown)).toBeLessThan(fn.indexOf(run));
  });

  it("treats a failed chown as a failed install rather than running anyway", () => {
    // A chown that silently fails would put us straight back in the
    // Permission-denied case with "Claude Code installed" printed over it.
    const guard = fn.slice(fn.indexOf("curl -fsSL"), fn.indexOf('sudo -u "$CLAWBOX_USER" bash "$installer"'));
    expect(guard).toMatch(/&&\s*chown "\$CLAWBOX_USER" "\$installer"; then/);
  });

  it("short-circuits when Claude Code is already there, so updates stay cheap", () => {
    expect(fn).toContain("already installed");
  });

  it("asks a LOGIN shell whether the CLI exists", () => {
    // `sudo -u clawbox bash -c` reads neither ~/.profile nor ~/.bashrc, so
    // ~/.local/bin — where the native installer puts `claude` — is not on its
    // PATH. Observed on .65 on 2026-08-22: Claude Code 2.1.239 was installed
    // and working, and this probe still said it was missing, so the fast path
    // never fired and every update re-downloaded the CLI. It is the same false
    // negative the task warns about for ssh.
    for (const probe of ["ensure_claude_code", "step_coding_harness"]) {
      const body = extractShellFunction(probe);
      expect(body, probe).toContain('as_clawbox_login "command -v claude"');
      expect(body, probe).not.toMatch(/sudo -u "\$CLAWBOX_USER" bash -c 'command -v claude'/);
    }
  });
});

describe("the wrapper lands where the desktop expects it", () => {
  const fn = extractShellFunction("install_claude_ds_wrapper");

  it("installs the repo's own script to the path the icon's command resolves to", () => {
    expect(fn).toContain(`$SRC_DIR/scripts/${CODING_HARNESS_COMMAND}`);
    expect(fn).toContain(`$CLAWBOX_HOME/${CODING_HARNESS_WRAPPER_PATH}`);
  });

  it("lands on a PATH the in-UI terminal actually has", () => {
    // The terminal spawns a LOGIN shell, whose PATH comes from ~/.profile and
    // ~/.bashrc — both of which put ~/.local/bin on it.
    expect(CODING_HARNESS_WRAPPER_PATH.startsWith(".local/bin/")).toBe(true);
    expect(extractShellFunction("ensure_clawbox_bashrc_path")).toContain("$HOME/.local/bin");
    expect(extractShellFunction("step_coding_harness")).toContain("ensure_clawbox_bashrc_path");
  });

  it("copies rather than symlinks, so a half-checked-out repo cannot break the harness", () => {
    expect(fn).not.toContain("ln -s");
  });
});

// Linux only (GNU stat and find), and not as root, whose writes the read-only
// home of src/tests/helpers/account-only-home.ts cannot stop.
const CAN_RUN_WRAPPER = CAN_LOCK_HOME && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;

(CAN_RUN_WRAPPER ? describe : describe.skip)("the wrapper is written by the clawbox user", () => {
  // ~/.local/bin is the clawbox user's: root's `install` there followed a link
  // planted on the way, and `install -d` applied its owner and mode to a linked
  // directory's target. Run against a home only `as_clawbox` can write to.
  let sandbox: string;
  let home: string;
  let aux: string;
  let src: string;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "clawbox-claude-ds-"));
    home = path.join(sandbox, "home");
    aux = path.join(sandbox, "aux");
    src = path.join(sandbox, "src");
    for (const dir of [home, aux, path.join(src, "scripts")]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(src, "scripts", CODING_HARNESS_COMMAND), WRAPPER, "utf-8");
  });

  afterEach(() => {
    unlockTree(sandbox);
    rmSync(sandbox, { recursive: true, force: true });
  });

  const dest = () => path.join(home, CODING_HARNESS_WRAPPER_PATH);

  function install() {
    const account = accountOnlyHome(home, aux);
    const script = [
      "set -euo pipefail",
      `CLAWBOX_HOME=${JSON.stringify(home)}`,
      'CLAWBOX_USER="$(id -un)"',
      `SRC_DIR=${JSON.stringify(src)}`,
      account.shell,
      shellFunctionIfPresent(INSTALL_SH, "hand_over_home_path"),
      `${extractShellFunction("install_claude_ds_wrapper")}\n}`,
      "__ao_lock",
      // As step_coding_harness calls it: errexit off inside, the status read.
      'if install_claude_ds_wrapper; then echo "RC=0"; else echo "RC=$?"; fi',
    ].join("\n");
    writeFileSync(path.join(aux, "run.sh"), script, "utf-8");
    const r = spawnSync("bash", [path.join(aux, "run.sh")], { encoding: "utf-8", cwd: aux });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", rootInHome: account.rootInHome() };
  }

  it("lands with the repo's bytes and mode 0755, and root writes nothing in the home", () => {
    const r = install();

    expect(r.rootInHome, "no install, mkdir or chown by root in the home").toEqual([]);
    expect(r.stdout, r.stderr).toContain("RC=0");
    expect(r.stdout).toContain(`claude-ds installed at ${dest()}`);
    expect(readFileSync(dest(), "utf-8")).toBe(WRAPPER);
    expect(statSync(dest()).mode & 0o777).toBe(0o755);
    // The temp went with the rename.
    expect(readdirSync(path.dirname(dest()))).toEqual([CODING_HARNESS_COMMAND]);
  });

  it("replaces a link at the target instead of writing through it", () => {
    // An older box can have ~/.local/bin/claude-ds pointing back into the
    // checkout; writing through it would rewrite the checkout's own file.
    const target = path.join(sandbox, "checkout-claude-ds");
    writeFileSync(target, "#!/bin/sh\necho old\n", "utf-8");
    mkdirSync(path.dirname(dest()), { recursive: true });
    symlinkSync(target, dest());

    const r = install();

    expect(r.stdout, r.stderr).toContain("RC=0");
    expect(lstatSync(dest()).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest(), "utf-8")).toBe(WRAPPER);
    expect(readFileSync(target, "utf-8")).toBe("#!/bin/sh\necho old\n");
  });

  it("refreshes a wrapper that is already there, still 0755", () => {
    mkdirSync(path.dirname(dest()), { recursive: true });
    writeFileSync(dest(), "stale\n", "utf-8");
    chmodSync(dest(), 0o700);

    const r = install();

    expect(r.stdout, r.stderr).toContain("RC=0");
    expect(readFileSync(dest(), "utf-8")).toBe(WRAPPER);
    expect(statSync(dest()).mode & 0o777).toBe(0o755);
    expect(r.rootInHome).toEqual([]);
  });

  it("says so, and answers non-zero, when the wrapper could not be written", () => {
    // A failure the old `install` lines printed "installed" over: errexit is
    // off inside the function, as step_coding_harness calls it with `|| true`.
    mkdirSync(path.join(home, ".local"));
    writeFileSync(path.join(home, ".local", "bin"), "not a directory\n", "utf-8");

    const r = install();

    expect(r.stdout).toContain("RC=1");
    expect(r.stdout).toContain("WARN: could not install claude-ds");
    expect(r.stdout).not.toContain("claude-ds installed at");
    expect(existsSync(dest())).toBe(false);
  });
});

describe("the step says whether the harness can actually run", () => {
  it("reports a missing CLI instead of leaving the owner in a repair loop", () => {
    // The wrapper's failure tells the owner to run this step. If the step then
    // finishes quietly on a box where the CLI install failed, the two point at
    // each other forever with no diagnosis anywhere.
    const fn = extractShellFunction("step_coding_harness");
    expect(fn).toContain("command -v claude");
    expect(fn).toMatch(/Coding harness ready/);
    // Each half names only its own component. The message used to open
    // "claude-ds is installed but Claude Code is NOT", which is a claim about
    // the OTHER half — and a lie on the box where both are missing, which is
    // also the box most likely to be reading it. See
    // install-coding-harness-repair.test.ts for the behaviour.
    expect(fn).toMatch(/WARN: Claude Code is NOT installed/);
    expect(fn).toMatch(/WARN: the claude-ds wrapper is NOT/);
    expect(fn).not.toMatch(/claude-ds is installed but Claude Code is NOT/);
  });
});

describe("the harness never becomes a global reroute", () => {
  it("install.sh writes no ANTHROPIC variable into any shell rc", () => {
    // OpenClaw drives claude-cli through the same `claude` binary: a global
    // ANTHROPIC_BASE_URL would send every OpenClaw Claude call to DeepSeek
    // with no error anywhere.
    expect(extractShellFunction("ensure_clawbox_bashrc_path")).not.toContain("ANTHROPIC");
    expect(INSTALL_SH).not.toMatch(/export ANTHROPIC_BASE_URL/);
  });

  it("the wrapper exports them into its own process only", () => {
    expect(WRAPPER).toContain("export ANTHROPIC_BASE_URL=");
    expect(WRAPPER).toContain("exec claude");
    expect(WRAPPER).not.toMatch(/>>\s*\S*\.(bashrc|profile|zshrc)/);
  });
});
