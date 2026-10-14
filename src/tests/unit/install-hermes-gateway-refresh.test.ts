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
 * 43 restarts, Telegram dead. Hermes' own `gateway install` re-renders the unit
 * and its own `gateway restart` drains and restarts the gateway. These tests
 * drive the REAL step_hermes_install against a fake HOME, a stub `hermes` that
 * re-renders the unit for whichever agent is on disk, and a stub systemd, and
 * look at what was asked and what was proven.
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
const INSTALL_CALL = "gateway install --no-start-now --no-start-on-login";

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
  /** The user unit on disk before the step; null for a box that never installed one. */
  unit?: string | null;
  /** What `gateway install` renders for an agent OFF the pin; default: the unit on disk. */
  rendersOffPin?: string;
  /** What it renders for the pinned agent. */
  renders?: string;
  /** What `systemctl --user is-active` says before the step: `activating` is the crash loop. */
  gwState?: "active" | "activating" | "inactive" | "failed";
  /** What it says once Hermes has restarted it. */
  gwAfter?: "active" | "activating";
  installRc?: number;
  restartRc?: number;
  /** Whether the reachability precheck for the upstream installer answers. */
  reachable?: boolean;
  /** false: the box's edition does not run Hermes (`unselected` carries the agent on disk). */
  runsHermes?: boolean;
  /** A system-scope unit's ExecStart program, when the box has one. */
  systemUnitStarts?: string;
}

function run(s: Scenario) {
  const {
    head,
    unit = staleUnit(),
    renders = currentUnit(),
    gwState = "active",
    gwAfter = "active",
    installRc = 0,
    restartRc = 0,
    reachable = true,
    runsHermes = true,
    systemUnitStarts,
  } = s;
  const rendersOffPin = s.rendersOffPin ?? unit ?? "";
  const agent = path.join(tmp, ".hermes", "hermes-agent");
  const shim = path.join(tmp, ".local", "bin", "hermes");
  const fakePy = path.join(tmp, "fake-py");
  writeExec(fakePy, ["#!/bin/sh", "echo 'Hermes 9.9.9'"]);
  // The CLI: answers the step's probes, renders the unit for the agent that is
  // on disk into ~/.config/systemd/user (from HOME), and restarts.
  writeExec(shim, [
    "#!/bin/sh",
    'case "$1" in',
    "  --help) exit 0 ;;",
    "  --version) echo 'Hermes 9.9.9'; exit 0 ;;",
    "  gateway)",
    '    [ -t 0 ] && stdin=tty || stdin=closed',
    '    printf "%s|HOME=%s|XDG=%s|stdin=%s\\n" "$*" "${HOME:-}" "${XDG_RUNTIME_DIR:-}" "$stdin" >> "$GW_LOG"',
    '    case "$2" in',
    "      install)",
    '        [ "$GW_INSTALL_RC" = 0 ] || { echo "✗ could not write the unit" >&2; exit "$GW_INSTALL_RC"; }',
    '        mkdir -p "$HOME/.config/systemd/user"',
    '        if [ "$(cat "$AGENT_DIR/.fake-head")" = "$PIN" ]; then r="$GW_RENDERS"; else r="$GW_RENDERS_OFF_PIN"; fi',
    '        printf "%s" "$r" > "$HOME/.config/systemd/user/hermes-gateway.service"',
    "        exit 0 ;;",
    "      restart)",
    '        [ "$GW_RESTART_RC" = 0 ] || { echo "✗ Gateway service restart failed." >&2; exit "$GW_RESTART_RC"; }',
    '        touch "$SYSD/restarted"; exit 0 ;;',
    "    esac ;;",
    "esac",
    "exit 0",
  ]);
  fs.mkdirSync(path.join(agent, "venv", "bin"), { recursive: true });
  fs.copyFileSync(fakePy, path.join(agent, "venv", "bin", "python"));
  fs.chmodSync(path.join(agent, "venv", "bin", "python"), 0o755);
  fs.writeFileSync(path.join(agent, ".fake-head"), head);
  if (unit !== null) {
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    fs.writeFileSync(unitFile(), unit);
  }
  const systemUnit = path.join(tmp, "etc-system", UNIT);
  if (systemUnitStarts !== undefined) {
    fs.mkdirSync(path.dirname(systemUnit), { recursive: true });
    fs.writeFileSync(systemUnit, `[Service]${NL}User=clawbox${NL}ExecStart=${systemUnitStarts} -m hermes_cli.main gateway run${NL}`);
  }

  const bin = path.join(tmp, "bin");
  // The reachability precheck, then the installer: lays down an agent on the pin.
  writeExec(path.join(bin, "curl"), [
    "#!/bin/sh",
    'case " $* " in *" -o /dev/null "*) exit "$PRECHECK_RC" ;; esac',
    'mkdir -p "$AGENT_DIR/venv/bin"',
    'cp "$FAKE_PY" "$AGENT_DIR/venv/bin/python"',
    'printf %s "$PIN" > "$AGENT_DIR/.fake-head"',
    'echo ":"',
  ]);
  writeExec(path.join(bin, "git"), ["#!/bin/sh", '[ -f "$2/.fake-head" ] || exit 128', 'cat "$2/.fake-head"']);
  // systemd. The dashboard units are not installed in these scenarios; the
  // gateway's USER unit answers from the scenario, and once Hermes has
  // restarted it, from the outcome. Every call is logged.
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
    "esac",
    "exit 0",
  ]);
  fs.mkdirSync(path.join(tmp, "sysd"), { recursive: true });

  const script = [
    "set -euo pipefail",
    'CLAWBOX_HOME="$1"',
    'CLAWBOX_USER="$(id -un)"',
    `HERMES_GATEWAY_SYSTEM_UNIT="${systemUnit}"`,
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
        PRECHECK_RC: reachable ? "0" : "7",
        GW_LOG: path.join(tmp, "gw-log"),
        GW_INSTALL_RC: String(installRc),
        GW_RESTART_RC: String(restartRc),
        GW_RENDERS: renders,
        GW_RENDERS_OFF_PIN: rendersOffPin,
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
  const gatewayCalls = lines(path.join(tmp, "gw-log"));
  const userCalls = lines(path.join(tmp, "systemctl-log")).filter((l) => l.startsWith("--user "));
  return {
    code,
    out,
    gatewayCalls,
    installs: gatewayCalls.filter((l) => l.startsWith("gateway install ")),
    restarts: gatewayCalls.filter((l) => l.startsWith("gateway restart")),
    userCalls,
    unitNow: fs.existsSync(unitFile()) ? fs.readFileSync(unitFile(), "utf8") : null,
  };
}

const uid = () => String(process.getuid?.() ?? "");

describe.skipIf(!hasBash)("the Hermes gateway follows the agent an update installs", () => {
  it("re-renders the unit through Hermes after an upgrade and has Hermes restart the gateway onto it", () => {
    const r = run({ head: OTHER_COMMIT });

    expect(r.code, r.out).toBe(0);
    // Hermes' own re-render, as the clawbox user, the definition only — whether
    // the gateway runs and starts at boot stay what they were — with no
    // terminal for a prompt to hide on. Asked of the agent found (nothing to
    // repair) and of the one installed.
    const call = `${INSTALL_CALL}|HOME=${tmp}|XDG=/run/user/${uid()}|stdin=closed`;
    expect(r.installs, `the gateway unit was never re-rendered after the upgrade:\n${r.out}`).toEqual([call, call]);
    expect(r.unitNow).toBe(currentUnit());
    // Hermes' own drain-restart, once; never a raw systemctl bounce or a
    // `start`, which is a no-op for a gateway on the deleted tree.
    expect(r.restarts, `the gateway was left on the deleted agent:\n${r.out}`).toEqual([
      `gateway restart|HOME=${tmp}|XDG=/run/user/${uid()}|stdin=closed`,
    ]);
    expect(r.userCalls.some((l) => /^--user (restart|start|try-restart) /.test(l))).toBe(false);
    for (const c of r.userCalls) expect(c).toContain(`XDG=/run/user/${uid()}`);
    // Proven running, not assumed from Hermes' exit code.
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
    expect(r.installs, `a crash-looping gateway was left on the stale unit:\n${r.out}`).toHaveLength(1);
    expect(r.unitNow).toBe(currentUnit());
    expect(r.restarts).toHaveLength(1);
    expect(r.out).toMatch(/Restarted hermes-gateway\.service on the current agent \(main pid 0 -> 5555/);
  });

  it("heals the unit of an off-pin agent the step leaves in place when the installer is unreachable", () => {
    const r = run({ head: OTHER_COMMIT, reachable: false, gwState: "activating", rendersOffPin: currentUnit() });

    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/cannot reach the Hermes installer/);
    expect(r.unitNow, `the stale unit survived an update that could not upgrade:\n${r.out}`).toBe(currentUnit());
    expect(r.restarts).toHaveLength(1);
  });

  it("does not bounce a healthy gateway on an update that changed nothing under it", () => {
    // Every update reaches the early return. Hermes answers whether its unit
    // is current; a unit it leaves byte-identical over an agent that did not
    // move is a gateway with nothing to pick up.
    const r = run({ head: PIN, unit: currentUnit() });

    expect(r.code, r.out).toBe(0);
    expect(r.installs).toHaveLength(1);
    expect(r.restarts, `a healthy gateway was restarted for nothing:\n${r.out}`).toEqual([]);
  });

  it("re-renders a stopped gateway's unit but never starts it", () => {
    const r = run({ head: OTHER_COMMIT, gwState: "inactive" });

    expect(r.code, r.out).toBe(0);
    expect(r.unitNow).toBe(currentUnit());
    expect(r.restarts, `a stopped gateway was started by an update:\n${r.out}`).toEqual([]);
    expect(r.userCalls.some((l) => /^--user (restart|start) /.test(l))).toBe(false);
    expect(r.out).toMatch(/hermes-gateway\.service re-rendered for the current agent; it was inactive and is left that way/);
  });

  it("says so, without failing the step, when Hermes answers 0 over a gateway that did not stay up", () => {
    const r = run({ head: OTHER_COMMIT, gwAfter: "activating" });

    expect(r.code, r.out).toBe(0);
    expect(r.restarts).toHaveLength(1);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[hermes-gateway-not-restarted\]: hermes-gateway\.service did not stay up after the restart \(systemd says activating, main pid 0\)/m);
    expect(r.out).not.toMatch(/Restarted hermes-gateway\.service on the current agent/);
  });

  it("says so when Hermes refuses the restart", () => {
    const r = run({ head: OTHER_COMMIT, restartRc: 1 });

    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[hermes-gateway-not-restarted\]: hermes-gateway\.service could not be restarted \(✗ Gateway service restart failed\.\)/m);
  });

  it("leaves the gateway alone when Hermes could not re-render its unit", () => {
    // Restarting onto a unit that still names a deleted interpreter would turn
    // a gateway running on the old tree into a crash loop.
    const r = run({ head: OTHER_COMMIT, installRc: 1 });

    expect(r.code, r.out).toBe(0);
    expect(r.restarts, `the gateway was restarted onto a unit Hermes could not rewrite:\n${r.out}`).toEqual([]);
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

  it("reports a system-wide unit whose program the install no longer has, and runs no Hermes for it", () => {
    // `sudo hermes gateway install --system` was the only installer from
    // 2026-08-11 to 2026-09-07. Rendering that unit would mean running the
    // clawbox-owned shim as root, so it is only read.
    const gone = `${tmp}/.hermes/hermes-agent/venv/bin/python-gone`;
    const r = run({ head: OTHER_COMMIT, unit: null, systemUnitStarts: gone });

    expect(r.code, r.out).toBe(0);
    expect(r.gatewayCalls).toEqual([]);
    expect(r.out).toContain(
      `CLAWBOX-WARN[hermes-gateway-not-restarted]: the system-wide hermes-gateway.service starts ${gone}, which the Hermes install no longer has`,
    );
  });

  it("says nothing about a system-wide unit whose program is still there", () => {
    const r = run({ head: OTHER_COMMIT, unit: null, systemUnitStarts: path.join(tmp, "fake-py") });

    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/CLAWBOX-WARN\[hermes-gateway/);
  });
});
