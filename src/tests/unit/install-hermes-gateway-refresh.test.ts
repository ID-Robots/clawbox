import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Every Hermes box's messaging gateway died after an update (2026-10-14).
 *
 * `hermes gateway install` writes ~/.config/systemd/user/hermes-gateway.service
 * with an ExecStart INSIDE the agent install. The update moved Hermes to
 * v0.21.7, which has no `venv/` at all, and nothing re-rendered the unit: the
 * gateway kept running on deleted files (the update looked healthy), and the
 * next restart failed for good —
 *
 *   status=203/EXEC … ~/.hermes/hermes-agent/venv/bin/python: No such file or directory
 *
 * 43 restarts, Telegram dead. `hermes gateway install --force` — Hermes' own
 * re-render — is what healed the box. These tests drive the REAL
 * step_hermes_install against a fake HOME, a stub `hermes` that re-renders the
 * unit the way the real one does, and a stub systemd, and look at what was
 * asked and what was proven.
 */

// Starts a real bash: vitest's 5 s test default is not enough on a loaded CI
// runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const INSTALL_SH_PATH = path.join(REPO, "install.sh");
const INSTALL_SH = fs.readFileSync(INSTALL_SH_PATH, "utf-8");
const NL = String.fromCharCode(10);
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

const PIN = (INSTALL_SH.split(NL).find((l) => l.startsWith("HERMES_PIN_COMMIT="))?.match(/[0-9a-f]{40}/) ?? [""])[0];
const OTHER_COMMIT = "0".repeat(39) + "1";
const UNIT = "hermes-gateway.service";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-gw-refresh-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const unitFile = () => path.join(tmp, ".config", "systemd", "user", UNIT);
/** The unit every box updated before v0.21.7 is carrying. */
const staleUnit = () =>
  `[Service]${NL}ExecStart=${tmp}/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run${NL}`;
/** What Hermes' generator writes for the v0.21.7 layout. */
const currentUnit = () =>
  `[Service]${NL}ExecStart=${tmp}/.hermes/hermes-agent/.hermes/bin/hermes gateway run${NL}`;

function writeExec(file: string, lines: string[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join(NL) + NL, { mode: 0o755 });
}

interface Scenario {
  /** HEAD of the agent on disk: the pin (no upgrade) or not (the step upgrades it). */
  head: string;
  /** The unit on disk before the step; null for a box that never installed a gateway. */
  unit?: string | null;
  /** What `systemctl --user is-active` says before the step: `activating` is the crash loop. */
  gwState?: "active" | "activating" | "inactive" | "failed";
  /** What it says once restarted. */
  gwAfter?: "active" | "activating";
  /** What `hermes gateway install` writes, and how it exits. */
  renders?: string;
  installRc?: number;
  /** false: the box's edition does not run Hermes (`unselected` carries the agent on disk). */
  runsHermes?: boolean;
}

function run(s: Scenario) {
  const {
    head,
    unit = staleUnit(),
    gwState = "active",
    gwAfter = "active",
    renders = currentUnit(),
    installRc = 0,
    runsHermes = true,
  } = s;
  const agent = path.join(tmp, ".hermes", "hermes-agent");
  const shim = path.join(tmp, ".local", "bin", "hermes");
  const fakePy = path.join(tmp, "fake-py");
  writeExec(fakePy, ["#!/bin/sh", "echo 'Hermes 9.9.9'"]);
  // The CLI: answers the step's probes, and re-renders the unit the way the
  // real `gateway install` does — into ~/.config/systemd/user, from HOME.
  const shimTemplate = path.join(tmp, "shim-template");
  writeExec(shimTemplate, [
    "#!/bin/sh",
    'case "$1" in',
    "  --help) exit 0 ;;",
    "  --version) echo 'Hermes 9.9.9'; exit 0 ;;",
    "  gateway)",
    '    printf "%s|HOME=%s|XDG=%s\\n" "$*" "${HOME:-}" "${XDG_RUNTIME_DIR:-}" >> "$GW_LOG"',
    '    [ "$GW_INSTALL_RC" = 0 ] || { echo "✗ could not write the unit" >&2; exit "$GW_INSTALL_RC"; }',
    '    mkdir -p "$HOME/.config/systemd/user"',
    '    printf "%s" "$GW_RENDERS" > "$HOME/.config/systemd/user/hermes-gateway.service"',
    "    exit 0 ;;",
    "esac",
    "exit 0",
  ]);
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.copyFileSync(shimTemplate, shim);
  fs.chmodSync(shim, 0o755);
  fs.mkdirSync(path.join(agent, "venv", "bin"), { recursive: true });
  fs.copyFileSync(fakePy, path.join(agent, "venv", "bin", "python"));
  fs.chmodSync(path.join(agent, "venv", "bin", "python"), 0o755);
  fs.writeFileSync(path.join(agent, ".fake-head"), head);
  if (unit !== null) {
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    fs.writeFileSync(unitFile(), unit);
  }

  const bin = path.join(tmp, "bin");
  // The reachability precheck, then the installer: lays down an agent on the pin.
  writeExec(path.join(bin, "curl"), [
    "#!/bin/sh",
    'case " $* " in *" -o /dev/null "*) exit 0 ;; esac',
    'mkdir -p "$AGENT_DIR/venv/bin"',
    'cp "$FAKE_PY" "$AGENT_DIR/venv/bin/python"',
    'printf %s "$PIN" > "$AGENT_DIR/.fake-head"',
    'echo ":"',
  ]);
  writeExec(path.join(bin, "git"), ["#!/bin/sh", '[ -f "$2/.fake-head" ] || exit 128', 'cat "$2/.fake-head"']);
  // systemd. The dashboard units are not installed in these scenarios; the
  // gateway's USER unit answers from the scenario, and after `restart` from
  // its outcome. Every call is logged.
  writeExec(path.join(bin, "systemctl"), [
    "#!/bin/sh",
    'printf "%s|XDG=%s\\n" "$*" "${XDG_RUNTIME_DIR:-}" >> "$SYSTEMCTL_LOG"',
    '[ "$1" = "--user" ] || { [ "$1" = is-active ] && echo inactive; exit 3; }',
    "shift",
    'if [ -f "$SYSD/restarted" ]; then live="$GW_AFTER"; pid=5555; else live="$GW_STATE"; pid=4444; fi',
    '[ "$live" = active ] || pid=0',
    'case "$1" in',
    '  is-active) echo "$live"; [ "$live" = active ] && exit 0; exit 3 ;;',
    '  show) echo "$pid"; exit 0 ;;',
    '  restart) touch "$SYSD/restarted"; exit 0 ;;',
    "esac",
    "exit 0",
  ]);
  fs.mkdirSync(path.join(tmp, "sysd"), { recursive: true });

  const script = [
    "set -euo pipefail",
    'CLAWBOX_HOME="$1"',
    'CLAWBOX_USER="$(id -un)"',
    `has_hermes_harness() { return ${runsHermes ? 0 : 1}; }`,
    "installs_hermes_harness() { return 0; }",
    'runuser() { shift 2; if [ "$1" = "--" ]; then shift; fi; "$@"; }',
    'export PATH="$1/bin:$PATH"',
    // Sliced by name, like install-hermes-install-guard.test.ts: a rename
    // fails loudly here rather than turning a call into a silent 127.
    "for f in unit_is_coming_up hermes_dashboard_restart_warn hermes_dashboard_restart_after_install \\",
    "    hermes_venv_python hermes_gateway_refresh_after_install step_hermes_install; do",
    "  sed -n \"/^$f() {/,/^}/p\" \"$2\" >> \"$1/fn.sh\"",
    "done",
    '. "$1/fn.sh"',
    "step_hermes_install 2>&1",
  ].join(NL);

  let code = 0;
  let out: string;
  try {
    out = execFileSync("bash", ["-c", script, "bash", tmp, INSTALL_SH_PATH], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENT_DIR: agent,
        FAKE_PY: fakePy,
        PIN,
        HERMES_PIN_COMMIT: PIN,
        GW_LOG: path.join(tmp, "gw-log"),
        GW_INSTALL_RC: String(installRc),
        GW_RENDERS: renders,
        GW_STATE: gwState,
        GW_AFTER: gwAfter,
        SYSD: path.join(tmp, "sysd"),
        SYSTEMCTL_LOG: path.join(tmp, "systemctl-log"),
        CLAWBOX_ENGINE_SETTLE_S: "1",
        HERMES_DASHBOARD_RESTART_WAIT_S: "1",
      },
    });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    code = err.status ?? 1;
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(NL).filter(Boolean) : []);
  const userCalls = lines(path.join(tmp, "systemctl-log")).filter((l) => l.startsWith("--user "));
  return {
    code,
    out,
    gatewayCalls: lines(path.join(tmp, "gw-log")),
    userCalls,
    restarted: userCalls.some((l) => l.startsWith(`--user restart ${UNIT}`)),
    unitNow: fs.existsSync(unitFile()) ? fs.readFileSync(unitFile(), "utf8") : null,
  };
}

const uid = () => String(process.getuid?.() ?? "");

describe.skipIf(!hasBash)("the Hermes gateway follows the agent an update installs", () => {
  it("re-renders the unit through Hermes after an upgrade and restarts the gateway onto it", () => {
    const r = run({ head: OTHER_COMMIT });

    expect(r.code, r.out).toBe(0);
    // Hermes' own re-render, as the clawbox user, definition only: whether the
    // gateway runs and whether it starts at boot stay what they were.
    expect(r.gatewayCalls, `the gateway unit was never re-rendered after the upgrade:\n${r.out}`).toEqual([
      `gateway install --force --no-start-now --no-start-on-login|HOME=${tmp}|XDG=/run/user/${uid()}`,
    ]);
    expect(r.unitNow).toBe(currentUnit());
    // RESTART, never start: start is a no-op for a gateway still running on
    // the deleted tree, which is how the first update looked healthy.
    expect(r.restarted, `the gateway was left on the deleted agent:\n${r.out}`).toBe(true);
    expect(r.userCalls.some((l) => l.startsWith(`--user start ${UNIT}`))).toBe(false);
    for (const call of r.userCalls) expect(call).toContain(`XDG=/run/user/${uid()}`);
    // Proven running, not assumed from an exit code.
    expect(r.out).toMatch(/Restarted hermes-gateway\.service on the current agent \(main pid 4444 -> 5555, still up 1s later\)/);
    expect(r.out).not.toMatch(/CLAWBOX-WARN\[hermes-gateway/);
  });

  it("heals a box already on the pin whose unit still points at the old interpreter", () => {
    // The population in the field today: the agent is ON the pin, so the step
    // takes its early return — and the gateway is crash-looping (`activating`,
    // no main pid) on a venv that no longer exists.
    const r = run({ head: PIN, gwState: "activating" });

    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/already installed at the pinned commit/);
    expect(r.gatewayCalls, `a crash-looping gateway was left on the stale unit:\n${r.out}`).toHaveLength(1);
    expect(r.unitNow).toBe(currentUnit());
    expect(r.restarted).toBe(true);
    expect(r.out).toMatch(/Restarted hermes-gateway\.service on the current agent \(main pid 0 -> 5555/);
  });

  it("does not bounce a healthy gateway on an update that changed nothing under it", () => {
    // Every update reaches the early return. Hermes answers whether its unit
    // is current; a unit that comes back byte-identical over an agent that did
    // not move is a gateway with nothing to pick up.
    const r = run({ head: PIN, unit: currentUnit(), renders: currentUnit() });

    expect(r.code, r.out).toBe(0);
    expect(r.gatewayCalls).toHaveLength(1);
    expect(r.restarted, `a healthy gateway was restarted for nothing:\n${r.out}`).toBe(false);
  });

  it("re-renders a stopped gateway's unit but never starts it", () => {
    const r = run({ head: OTHER_COMMIT, gwState: "inactive" });

    expect(r.code, r.out).toBe(0);
    expect(r.unitNow).toBe(currentUnit());
    expect(r.restarted, `a stopped gateway was started by an update:\n${r.out}`).toBe(false);
    expect(r.userCalls.some((l) => l.startsWith(`--user start ${UNIT}`))).toBe(false);
    expect(r.out).toMatch(/hermes-gateway\.service re-rendered for the current agent; it was inactive and is left that way/);
  });

  it("says so, without failing the step, when the gateway does not stay up", () => {
    // The agent install worked; a gateway that will not come back is the
    // owner's to hear about on the update's own status, not a failed fixup.
    const r = run({ head: OTHER_COMMIT, gwAfter: "activating" });

    expect(r.code, r.out).toBe(0);
    expect(r.restarted).toBe(true);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[hermes-gateway-not-restarted\]: hermes-gateway\.service did not stay up after the restart \(systemd says activating, main pid 0\)/m);
    expect(r.out).not.toMatch(/Restarted hermes-gateway\.service on the current agent/);
  });

  it("leaves the gateway alone when Hermes could not re-render its unit", () => {
    // Restarting onto a unit that still names a deleted interpreter would
    // turn a gateway running on the old tree into a crash loop.
    const r = run({ head: OTHER_COMMIT, installRc: 1 });

    expect(r.code, r.out).toBe(0);
    expect(r.restarted, `the gateway was restarted onto a unit Hermes could not rewrite:\n${r.out}`).toBe(false);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[hermes-gateway-not-restarted\]: hermes-gateway\.service could not be re-rendered for the current agent \(✗ could not write the unit\)/m);
  });

  it("touches nothing on a box with no gateway unit", () => {
    const r = run({ head: OTHER_COMMIT, unit: null });

    expect(r.code, r.out).toBe(0);
    expect(r.gatewayCalls, `a gateway was installed on a box that never had one:\n${r.out}`).toEqual([]);
    expect(r.userCalls).toEqual([]);
  });

  it("never touches the gateway on an edition that does not run Hermes", () => {
    // `unselected` carries the agent on disk; its gateway unit is a foreign
    // edition's, which step_edition_foreign_teardown keeps down.
    const r = run({ head: OTHER_COMMIT, runsHermes: false });

    expect(r.code, r.out).toBe(0);
    expect(r.gatewayCalls).toEqual([]);
    expect(r.userCalls).toEqual([]);
  });
});
