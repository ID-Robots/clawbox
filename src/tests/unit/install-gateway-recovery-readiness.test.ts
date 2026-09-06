import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `step_gateway_legacy_state_recovery` read a still-STARTING gateway as a
 * broken one.
 *
 * `gateway_port_listening()` is a single `ss` with no wait, and the step asked
 * it in the same second systemd reported the unit started. Measured on the
 * OpenClaw box 2026-09-06:
 *
 *   07:53:43  systemd: Started ClawBox OpenClaw Gateway.
 *   07:53:43  root-step: Gateway is not listening on 18789; running OpenClaw doctor recovery
 *   07:53:53  root-step: - Failed migrating legacy shared auth store: the Gateway or another
 *                          SQLite maintenance command owns this state directory.
 *   07:53:57  openclaw: [gateway] http server listening (18 plugins; 7.2s)
 *   07:54:09  systemd: Stopping ClawBox OpenClaw Gateway...      <- the recovery's restart
 *
 * The listener is seconds behind `Started`, and the ExecStartPre ahead of it
 * measured 31 s, 86 s and 120 s across that boot's three restarts. So the probe
 * cannot tell "broken" from "starting" — probe-once — and the `openclaw doctor`
 * it runs then FAILS because the gateway is alive, which the step read as one
 * more reason to restart: a false failure, and one unnecessary cold start on
 * every update.
 *
 * Driven against a stubbed `ss`, `systemctl` and `openclaw`, because the two
 * properties that matter — "waits for a listener that is on its way" and "never
 * restarts over a gateway doctor just proved alive" — cannot be read out of a
 * regex.
 */

// Starts a real bash process: vitest's 5 s default is not enough on a loaded
// runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO = process.cwd();
const INSTALL_SH_PATH = path.join(REPO, "install.sh");
const INSTALL_SH = fs.readFileSync(INSTALL_SH_PATH, "utf-8");
const NL = String.fromCharCode(10);

function hasShellFunction(name: string): boolean {
  return INSTALL_SH.includes(`${name}() {`);
}

describe("the gateway recovery waits for a listener instead of asking once", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-recovery-"));
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });

    // `ss` starts answering "listening" after LISTEN_AFTER probes, which is how
    // a gateway whose ExecStartPre is still running behaves.
    fs.writeFileSync(
      path.join(tmp, "bin", "ss"),
      [
        "#!/bin/sh",
        'n=$(cat "$PROBES" 2>/dev/null || echo 0)',
        "n=$((n + 1))",
        'printf %s "$n" > "$PROBES"',
        'if [ "$n" -gt "${LISTEN_AFTER:-0}" ]; then',
        '  printf "LISTEN 0 4096 0.0.0.0:18789 0.0.0.0:*\\n"',
        "fi",
        "exit 0",
        "",
      ].join(NL),
      { mode: 0o755 },
    );

    fs.writeFileSync(
      path.join(tmp, "bin", "systemctl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
        'case " $* " in',
        // `systemctl show … -p ActiveState --value`
        '  *" ActiveState "*) printf "%s\\n" "${UNIT_STATE:-activating}" ; exit 0 ;;',
        "esac",
        "exit 0",
        "",
      ].join(NL),
      { mode: 0o755 },
    );

    // The real recovery calls the CLI through as_clawbox; the harness stubs
    // as_clawbox to exec directly, so this stands in for `openclaw`.
    fs.writeFileSync(
      path.join(tmp, "bin", "openclaw"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "openclaw $*" >> "$SYSTEMCTL_LOG"',
        'if [ -n "$DOCTOR_OWNED" ]; then',
        '  printf -- "- Failed migrating legacy shared auth store: the Gateway or another SQLite maintenance command owns this state directory.\\n"',
        "  exit 1",
        "fi",
        'printf "doctor: nothing to do\\n"',
        "exit 0",
        "",
      ].join(NL),
      { mode: 0o755 },
    );

    fs.writeFileSync(path.join(tmp, "bin", "sleep"), `#!/bin/sh${NL}exit 0${NL}`, { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, "bin", "journalctl"), `#!/bin/sh${NL}exit 0${NL}`, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run({
    listenAfter = 0,
    unitState = "activating",
    doctorOwned = "",
  }: { listenAfter?: number; unitState?: string; doctorOwned?: string } = {}) {
    const log = path.join(tmp, "systemctl.log");
    const probes = path.join(tmp, "probes");
    fs.writeFileSync(log, "");
    fs.writeFileSync(probes, "0");
    const script = [
      // install.sh's own options; a laxer harness would certify a script the
      // shipped one is not.
      "set -euo pipefail",
      `export PATH="${tmp}/bin:$PATH"`,
      'OPENCLAW_BIN="openclaw"',
      // Every helper the step reaches that is not what is under test.
      "is_hermes_edition() { return 1; }",
      'as_clawbox() { "$@"; }',
      ...[
        "gateway_port_listening",
        "gateway_unit_running_or_starting",
        "wait_for_gateway_port",
        "step_gateway_legacy_state_recovery",
      ].map((f) => `sed -n '/^${f}() {/,/^}/p' "$1" >> "${tmp}/fns.sh"`),
      `. "${tmp}/fns.sh"`,
      "step_gateway_legacy_state_recovery 2>&1",
      'echo "RC=$?"',
    ].join(NL);
    let out: string;
    let code = 0;
    try {
      out = execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          SYSTEMCTL_LOG: log,
          PROBES: probes,
          LISTEN_AFTER: String(listenAfter),
          UNIT_STATE: unitState,
          DOCTOR_OWNED: doctorOwned,
          // Keep the budget short: the stubbed `sleep` returns at once, so this
          // only bounds the loop's iteration count.
          CLAWBOX_GATEWAY_READY_BUDGET_S: "30",
        },
      });
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    return { code, out, calls: fs.readFileSync(log, "utf8").split(NL).filter(Boolean) };
  }

  it("has the budgeted probe at all", () => {
    expect(hasShellFunction("wait_for_gateway_port")).toBe(true);
  });

  it("waits for a gateway whose listener has not arrived yet, and runs no recovery", () => {
    // Four probes' worth of ExecStartPre. Before the budget existed, the first
    // `ss` decided the box was broken and the recovery ran.
    const r = run({ listenAfter: 4 });

    expect(r.out).toMatch(/skipping legacy state recovery/);
    expect(r.calls.some((c) => c.includes("restart clawbox-gateway"))).toBe(false);
    expect(r.calls.some((c) => c.startsWith("openclaw doctor"))).toBe(false);
  });

  it("still runs the recovery for a gateway that is not coming up", () => {
    // The case the step exists for must not be made to wait, and must not be
    // skipped: the unit is not trying at all.
    const r = run({ listenAfter: 999, unitState: "failed" });

    expect(r.out).toMatch(/running OpenClaw doctor recovery/);
    expect(r.calls.some((c) => c.startsWith("openclaw doctor"))).toBe(true);
    expect(r.calls.some((c) => c.includes("restart clawbox-gateway"))).toBe(true);
  });

  it("does not restart over a gateway that doctor just proved alive", () => {
    // `doctor` losing the state directory TO THE GATEWAY is positive evidence
    // that the gateway is running. Restarting on the strength of it is a cold
    // start bought with proof of health — the false-failure class.
    const r = run({ listenAfter: 999, unitState: "active", doctorOwned: "1" });

    expect(r.calls.some((c) => c.startsWith("openclaw doctor"))).toBe(true);
    expect(r.calls.some((c) => c.includes("restart clawbox-gateway"))).toBe(false);
    expect(r.out).toMatch(/the gateway is alive, not in legacy state/);
  });

  it("says so instead of claiming a recovery, when a live gateway never listens", () => {
    // Not restarting must not become "everything is fine": the operator gets
    // the honest sentence and the step still does not fail the update.
    const r = run({ listenAfter: 999, unitState: "active", doctorOwned: "1" });

    expect(r.out).toMatch(/is not listening on 18789; not restarting over a live gateway/);
    expect(r.out).toMatch(/RC=0/);
  });

  it("leaves the single-shot probe alone for the question that wants one", () => {
    // step_validate_services' Hermes probe asserts that NOTHING is listening on
    // the OpenClaw port. Waiting there would turn "nothing is listening" into a
    // three-minute pause on every validated Hermes install, and a budgeted
    // answer is not the question it asks.
    const validate = INSTALL_SH.slice(INSTALL_SH.indexOf("step_validate_services() {"));
    expect(validate).toContain("if gateway_port_listening; then");
    expect(validate).not.toContain("wait_for_gateway_port");
  });

  it("is inert on the Hermes SKU, where a silent port is the correct state", () => {
    const step = INSTALL_SH.slice(
      INSTALL_SH.indexOf("step_gateway_legacy_state_recovery() {"),
      INSTALL_SH.indexOf(`${NL}}`, INSTALL_SH.indexOf("step_gateway_legacy_state_recovery() {")),
    );
    const guard = step.indexOf("is_hermes_edition");
    const firstWait = step.indexOf("wait_for_gateway_port");
    expect(guard).toBeGreaterThan(-1);
    expect(firstWait).toBeGreaterThan(guard);
  });
});
