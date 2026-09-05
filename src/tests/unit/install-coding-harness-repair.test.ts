import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `install.sh --step coding_harness` is not just another step. It is the exact
 * command `checkReadiness()` puts in front of the owner when the Coding app
 * refuses ("Run: sudo bash install.sh --step coding_harness"), and the same
 * command scripts/claude-ds prints when it cannot find Claude Code. It is THE
 * documented repair, and two things were wrong with it.
 *
 *  1. It exited 0 whatever happened. `ensure_claude_code || true` plus a WARN
 *     that only went to stdout meant a box with no network — or one in a region
 *     Anthropic's installer refuses — ran the repair, was told nothing had gone
 *     wrong, and went back to an app refusing in exactly the same words. A
 *     repair that cannot repair has to say so in its exit status.
 *
 *  2. It left the AGENT unable to see the harness it had just installed. The
 *     coding_agent_* tools are registered only if the ClawBox MCP server's
 *     one-time startup probe of /setup-api/coding-agent/status says the harness
 *     is ready (mcp/lib/context.ts + mcp/tools/coding-agent.ts), and that
 *     server is a long-lived stdio child of the agent. The web server covers
 *     the two paths that flip readiness from its side
 *     (src/lib/coding-agent-mcp-refresh.ts, on the enable route and the ClawBox
 *     AI connect path); a full install and step_post_update both happen to
 *     restart the agent shortly afterwards. The standalone repair — the one the
 *     owner is actually told to run — did neither.
 *
 * These run the SHIPPED function bodies out of install.sh against stubs, so an
 * edit to install.sh is what the assertions see.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

/** One shell function, verbatim, closing brace included; "" when there is none. */
function findShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(name + "() {");
  if (start < 0) return "";
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(name + " has no closing brace");
  return INSTALL_SH.slice(start, end + 2);
}

function shellFunction(name: string): string {
  const body = findShellFunction(name);
  if (!body) throw new Error(name + " not found in install.sh");
  return body;
}

/**
 * The agent-refresh helper, or nothing.
 *
 * Deliberately tolerant, and only for this one: on the code these tests were
 * written against there IS no such function, and its absence is the bug. A hard
 * failure here would make every case below fail with "not found in install.sh",
 * which proves nothing about what the old step DID — finish quietly, exit 0,
 * and leave the agent blind. Missing means the script simply never calls it,
 * which is exactly what it used to do.
 */
function agentRefreshHelper(): string {
  return findShellFunction("refresh_agent_coding_tools");
}

let sandbox: string;
let home: string;
let systemctlLog: string;

interface Scenario {
  /** Units `systemctl is-active --quiet` answers yes for. */
  activeUnits?: string[];
  /** Units whose refresh fails. */
  failingRestarts?: string[];
  /**
   * Units that are active at the `is-active` probe and STOPPED by the time the
   * refresh runs. `restart` would start them again; `try-restart` must not.
   */
  stopsBetween?: string[];
  /** Is Claude Code on the clawbox login PATH before the step runs? */
  claudeInstalled?: boolean;
  /** Does the CLI install performed by the step succeed? */
  claudeInstallSucceeds?: boolean;
  /** Is the claude-ds wrapper already there before the step runs? */
  wrapperInstalled?: boolean;
  /** Does the wrapper copy performed by the step succeed? */
  wrapperInstallSucceeds?: boolean;
}

interface StepRun {
  status: number | null;
  stdout: string;
  stderr: string;
  systemctl: string[];
}

const SHELL_TIMEOUT_MS = 30_000;

function runStep(scenario: Scenario = {}): StepRun {
  const {
    activeUnits = [],
    failingRestarts = [],
    stopsBetween = [],
    claudeInstalled = false,
    claudeInstallSucceeds = true,
    wrapperInstalled = false,
    wrapperInstallSucceeds = true,
  } = scenario;

  const makeWrapper = 'printf "#!/bin/sh\\n" > "$WRAPPER"; chmod +x "$WRAPPER"';

  const lines = [
    "set -euo pipefail",
    "",
    "CLAWBOX_HOME=" + JSON.stringify(home),
    "CLAWBOX_USER=clawbox",
    'WRAPPER="$CLAWBOX_HOME/.local/bin/claude-ds"',
    'CLAUDE_MARKER="$CLAWBOX_HOME/.claude-installed"',
    'SYSTEMCTL_LOG=' + JSON.stringify(systemctlLog),
    "",
    'mkdir -p "$CLAWBOX_HOME/.local/bin"',
    claudeInstalled ? 'touch "$CLAUDE_MARKER"' : 'rm -f "$CLAUDE_MARKER"',
    wrapperInstalled ? makeWrapper : 'rm -f "$WRAPPER"',
    "",
    "is_test_mode() { return 1; }",
    "ensure_clawbox_bashrc_path() { :; }",
    "",
    "# Stands in for the real download. Its success is deliberately NOT the",
    "# verdict: the step probes the box afterwards, which is the only thing that",
    '# can tell a working harness from an installer that printed "installed" and',
    "# did nothing.",
    "ensure_claude_code() {",
    claudeInstallSucceeds
      ? '  touch "$CLAUDE_MARKER"; return 0'
      : '  echo "  WARN: installer unavailable"; return 1',
    "}",
    "",
    "install_claude_ds_wrapper() {",
    wrapperInstallSucceeds
      ? "  " + makeWrapper + "; return 0"
      : '  echo "  WARN: source missing"; return 1',
    "}",
    "",
    "# The login-shell probe: answers from the marker the fake installer writes.",
    'as_clawbox_login() { [ -f "$CLAUDE_MARKER" ]; }',
    "",
    'ACTIVE_UNITS="' + activeUnits.join(" ") + '"',
    'FAILING_RESTARTS="' + failingRestarts.join(" ") + '"',
    'STOPS_BETWEEN="' + stopsBetween.join(" ") + '"',
    "",
    "systemctl() {",
    '  printf "%s\\n" "systemctl $*" >> "$SYSTEMCTL_LOG"',
    '  case "$1" in',
    "    is-active)",
    '      for u in $ACTIVE_UNITS; do [ "$u" = "$3" ] && return 0; done',
    "      return 3",
    "      ;;",
    "    restart)",
    "      # A real `restart` STARTS an inactive unit. The fake says so, which is",
    "      # what lets the invariant be tested rather than assumed.",
    '      for u in $STOPS_BETWEEN; do [ "$u" = "$2" ] && { printf "%s\\n" "STARTED-A-STOPPED-UNIT $2" >> "$SYSTEMCTL_LOG"; return 0; }; done',
    '      for u in $FAILING_RESTARTS; do [ "$u" = "$2" ] && return 1; done',
    "      return 0",
    "      ;;",
    "    try-restart)",
    "      # ...and a real `try-restart` does nothing, successfully, for a unit",
    "      # that is no longer running.",
    '      for u in $STOPS_BETWEEN; do [ "$u" = "$2" ] && return 0; done',
    '      for u in $FAILING_RESTARTS; do [ "$u" = "$2" ] && return 1; done',
    "      return 0",
    "      ;;",
    "  esac",
    "  return 0",
    "}",
    "",
    agentRefreshHelper(),
    "",
    shellFunction("step_coding_harness"),
    "",
    "step_coding_harness",
    "",
  ];

  const scriptPath = path.join(sandbox, "run.sh");
  writeFileSync(scriptPath, lines.join("\n"), "utf-8");
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", cwd: REPO });
  const log = existsSync(systemctlLog)
    ? readFileSync(systemctlLog, "utf-8").split("\n").filter(Boolean)
    : [];
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    systemctl: log,
  };
}

/**
 * Every refresh the step asked systemd for.
 *
 * `try-restart`, not `restart`: the probe and the action are two commands, and
 * `restart` would START a unit that stopped in between — the one thing this
 * function must never do.
 */
const refreshes = (run: StepRun) => run.systemctl.filter((l) => l.startsWith("systemctl try-restart"));

/** A unit systemd was told to bring UP. Must always be empty. */
const starts = (run: StepRun) =>
  run.systemctl.filter((l) => l.startsWith("systemctl restart") || l.startsWith("STARTED-A-STOPPED-UNIT"));

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "clawbox-harness-repair-"));
  home = path.join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  systemctlLog = path.join(sandbox, "systemctl.log");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("the documented repair reports whether it repaired anything", () => {
  it("FAILS when Claude Code is still missing afterwards", () => {
    const run = runStep({ claudeInstallSucceeds: false });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/did NOT repair the coding harness/);
    // And it names something the owner can act on, rather than repeating the
    // instruction that just failed.
    expect(run.stderr).toMatch(/internet access|region/i);
  }, SHELL_TIMEOUT_MS);

  it("FAILS when the wrapper is missing afterwards, even with the CLI present", () => {
    const run = runStep({ wrapperInstallSucceeds: false });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/wrapper is NOT/);
  }, SHELL_TIMEOUT_MS);

  it("succeeds when the harness is genuinely usable afterwards", () => {
    const run = runStep({ activeUnits: ["clawbox-gateway.service"] });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Coding harness ready/);
  }, SHELL_TIMEOUT_MS);
});

describe("the agent is told the harness exists now", () => {
  it("restarts the running agent when the harness has just become available", () => {
    // Without this the owner runs the documented repair, the Coding app starts
    // working, and the agent goes on answering that it has no way to run code
    // — until something unrelated respawns its MCP server.
    const run = runStep({ activeUnits: ["clawbox-gateway.service"] });
    expect(run.status).toBe(0);
    expect(run.systemctl).toContain("systemctl try-restart clawbox-gateway.service");
  }, SHELL_TIMEOUT_MS);

  it("restarts the Hermes dashboard when that is the agent that is running", () => {
    const run = runStep({ activeUnits: ["clawbox-hermes-dashboard.service"] });
    expect(run.systemctl).toContain("systemctl try-restart clawbox-hermes-dashboard.service");
  }, SHELL_TIMEOUT_MS);

  it("does NOT restart anything when the harness was already there", () => {
    // Every install and every in-app update runs this step. A reload respawns
    // every MCP child and invalidates the model's prompt cache, so it is only
    // worth paying for on the transition — the same rule the web-server-side
    // refresh applies.
    const run = runStep({
      claudeInstalled: true,
      wrapperInstalled: true,
      activeUnits: ["clawbox-gateway.service"],
    });
    expect(run.status).toBe(0);
    expect(refreshes(run)).toEqual([]);
  }, SHELL_TIMEOUT_MS);

  it("does NOT start an agent that is stopped or masked", () => {
    // The Hermes SKU masks clawbox-gateway. Starting it here would resurrect
    // the unit the edition lock exists to keep down, and a stopped agent
    // re-probes when it next starts anyway.
    const run = runStep({ activeUnits: [] });
    expect(run.status).toBe(0);
    expect(refreshes(run)).toEqual([]);
    expect(run.stdout).toMatch(/No agent running/);
  }, SHELL_TIMEOUT_MS);

  it("never STARTS a unit that stopped between the probe and the refresh", () => {
    // The probe and the action are two commands. `systemctl restart` on a unit
    // that went down in the gap would bring it back up — resurrecting exactly
    // the agent the owner, or the Hermes edition lock, put down. `try-restart`
    // acts only on a unit that is still running and exits 0 when there is
    // nothing to do, so the invariant does not depend on the gap being small.
    const run = runStep({
      activeUnits: ["clawbox-gateway.service"],
      stopsBetween: ["clawbox-gateway.service"],
    });
    expect(run.status).toBe(0);
    expect(starts(run)).toEqual([]);
    expect(refreshes(run)).toContain("systemctl try-restart clawbox-gateway.service");
    // And it claims only what it knows. `try-restart` exits 0 both when it
    // restarted the unit and when it found nothing to do, so "Restarted ..."
    // would be this PR's own bug in miniature.
    expect(run.stdout).toMatch(/Asked clawbox-gateway\.service to restart/);
    expect(run.stdout).not.toMatch(/Restarted clawbox-gateway\.service/);
  }, SHELL_TIMEOUT_MS);

  it("counts a PARTIAL refresh as a refusal on a dual box", () => {
    // Both harnesses run on the dual edition. One agent refreshed and one not
    // is one harness still blind, and reporting that as a clean refresh is the
    // exact shape this change exists to remove.
    const run = runStep({
      activeUnits: ["clawbox-gateway.service", "clawbox-hermes-dashboard.service"],
      failingRestarts: ["clawbox-hermes-dashboard.service"],
    });
    expect(run.status).toBe(0);
    expect(refreshes(run)).toHaveLength(2);
    expect(run.stderr).toMatch(/could not restart clawbox-hermes-dashboard\.service/);
    expect(run.stderr).toMatch(/after its next restart/);
  }, SHELL_TIMEOUT_MS);

  it("says so when the restart was refused, without failing the repair", () => {
    // The harness IS repaired and the Coding app works; calling that a failed
    // repair would be the opposite lie. It must not be silent either.
    const run = runStep({
      activeUnits: ["clawbox-gateway.service"],
      failingRestarts: ["clawbox-gateway.service"],
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/could not restart clawbox-gateway\.service/);
    expect(run.stderr).toMatch(/after its next restart/);
  }, SHELL_TIMEOUT_MS);
});

describe("a step that can now fail must not abort the install", () => {
  // The sibling-call-site rule, as a test. Making step_coding_harness report a
  // real verdict is only safe if EVERY caller expects one: install.sh runs
  // under `set -euo pipefail`, and the harness is optional — a box with no
  // Claude Code boots, serves its dashboard and runs its agent. An unguarded
  // call would turn a region-blocked download into an aborted install, which is
  // the same defect pointed the other way.
  //
  // Backslash line-continuations are folded first, so a guard on the next line
  // still counts as a guard.
  const FLAT = INSTALL_SH.replace(/\\r?\n\s*/g, " ");

  const callSites = FLAT.split("\n")
    .map((text, i) => ({ line: i + 1, text }))
    .filter(
      ({ text }) =>
        /(^|\s)step_coding_harness(\s|$)/.test(text)
        && !text.trim().startsWith("#")
        && !text.includes("() {"),
    );

  it("finds every call site (the check is not vacuously passing)", () => {
    // The full install and step_post_update. If a third appears, it is held to
    // the same rule by the case below.
    expect(callSites.length).toBeGreaterThanOrEqual(2);
  });

  it.each(callSites.map((c) => [c.line, c.text] as const))(
    "install.sh:%s guards the call",
    (_line, text) => {
      expect(text).toMatch(/\|\|\s*echo/);
    },
  );
});
