import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CODING_HARNESS_COMMAND, CODING_HARNESS_WRAPPER_PATH } from "@/lib/coding-harness";

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
    const line = fn.split("\n").find((l) => l.includes("step_coding_harness"));
    expect(line).toMatch(/\|\|\s*echo/);
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
    expect(fn).toContain(`$PROJECT_DIR/scripts/${CODING_HARNESS_COMMAND}`);
    expect(fn).toContain(`$CLAWBOX_HOME/${CODING_HARNESS_WRAPPER_PATH}`);
  });

  it("lands on a PATH the in-UI terminal actually has", () => {
    // The terminal spawns a LOGIN shell, whose PATH comes from ~/.profile and
    // ~/.bashrc — both of which put ~/.local/bin on it.
    expect(CODING_HARNESS_WRAPPER_PATH.startsWith(".local/bin/")).toBe(true);
    expect(extractShellFunction("ensure_clawbox_bashrc_path")).toContain("$HOME/.local/bin");
    expect(extractShellFunction("step_coding_harness")).toContain("ensure_clawbox_bashrc_path");
  });

  it("is owned by the clawbox user and executable", () => {
    expect(fn).toMatch(/install -o "\$CLAWBOX_USER" -g "\$CLAWBOX_USER" -m 755/);
  });

  it("copies rather than symlinks, so a half-checked-out repo cannot break the harness", () => {
    expect(fn).not.toContain("ln -s");
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
