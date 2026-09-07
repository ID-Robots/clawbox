import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Starts a real bash per case — vitest's 5 s default is not enough on a loaded
// CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const SPAWN_TIMEOUT_MS = 20_000;

/**
 * `step_edition_foreign_teardown` and the clawbox user's USER-scope
 * hermes-gateway unit (2026-09-07).
 *
 * A swap to Hermes installs the message gateway as the clawbox user's own
 * systemd unit — `hermes gateway install`, no root — because the system
 * install needs a sudo that is refused on purpose. The teardown's loop over
 * FOREIGN_EDITION_UNITS speaks to the SYSTEM manager and cannot see that unit,
 * and left running it long-polls the same Telegram bot OpenClaw takes over:
 * both pollers terminate each other's getUpdates for ever. So on a box whose
 * edition has no Hermes harness the step also asks the user's manager, through
 * the clawbox user's session bus, and disables that unit — the same idiom
 * `pause_engine_user_unit` uses for the voice engines.
 */
const INSTALL_SH = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf-8");

function extractShellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}

const bashAvailable = process.platform !== "win32" && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = bashAvailable ? describe : describe.skip;

let tmp: string;
let calls: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-teardown-"));
  calls = path.join(tmp, "calls");
  fs.writeFileSync(calls, "");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  calls: string[];
}

/**
 * Runs the step with `systemctl`, `sudo` and `id` stubbed. The system-scope
 * `systemctl` answers `inactive`/`disabled` for everything (the loop has
 * nothing to do), so what lands in `calls` is the user-scope half alone.
 * `USER_UNIT_PRESENT` decides whether `systemctl --user cat` finds the unit.
 */
function run(edition: string, env: Record<string, string> = {}): Run {
  const script = [
    "set -u",
    `CLAWBOX_EDITION=${JSON.stringify(edition)}`,
    "CLAWBOX_USER=clawbox",
    // The predicate the step branches on, as install.sh defines it.
    extractShellFn(INSTALL_SH, "has_hermes_harness"),
    // Foreign units per edition, as install.sh's parse-time block builds them.
    "FOREIGN_EDITION_UNITS=()",
    "if ! has_hermes_harness; then FOREIGN_EDITION_UNITS+=(clawbox-hermes-dashboard.service clawbox-hermes-dashboard-proxy.service hermes-gateway.service); fi",
    'if [ "$CLAWBOX_EDITION" = hermes ]; then FOREIGN_EDITION_UNITS+=(clawbox-gateway.service); fi',
    "id() { echo 1000; }",
    "systemctl() {",
    `  printf 'systemctl %s\\n' "$*" >> ${JSON.stringify(calls)}`,
    '  case "$*" in',
    "    *is-active*) echo inactive; return 3 ;;",
    "    *is-enabled*) echo disabled; return 1 ;;",
    "  esac",
    "  return 0",
    "}",
    // `sudo -u clawbox XDG_RUNTIME_DIR=… systemctl --user …`: record the
    // user-scope call and answer it from USER_UNIT_PRESENT / USER_UNIT_STATE.
    "sudo() {",
    '  local rt=""',
    '  while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; XDG_RUNTIME_DIR=*) rt="$1"; shift ;; *) break ;; esac; done',
    `  printf 'sudo %s :: %s\\n' "$rt" "$*" >> ${JSON.stringify(calls)}`,
    '  case "$*" in',
    '    "systemctl --user cat"*) [ "${USER_UNIT_PRESENT:-0}" = 1 ] ;;',
    '    "systemctl --user is-active"*) echo "${USER_UNIT_STATE:-active}"; [ "${USER_UNIT_STATE:-active}" = active ] ;;',
    '    "systemctl --user disable"*) [ "${USER_UNIT_DISABLE_FAILS:-0}" != 1 ] ;;',
    "    *) return 0 ;;",
    "  esac",
    "}",
    extractShellFn(INSTALL_SH, "step_edition_foreign_teardown"),
    "step_edition_foreign_teardown",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV, USER_UNIT_PRESENT: "1", ...env },
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    calls: fs.readFileSync(calls, "utf-8").split("\n").filter(Boolean),
  };
}

d("step_edition_foreign_teardown and the user-scope hermes gateway", () => {
  it("disables the clawbox user's hermes-gateway unit through the user's bus on an OpenClaw box", () => {
    const r = run("openclaw");
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("sudo"))).toEqual([
      "sudo XDG_RUNTIME_DIR=/run/user/1000 :: systemctl --user cat hermes-gateway.service",
      "sudo XDG_RUNTIME_DIR=/run/user/1000 :: systemctl --user is-active hermes-gateway.service",
      "sudo XDG_RUNTIME_DIR=/run/user/1000 :: systemctl --user disable --now hermes-gateway.service",
    ]);
    // Reported with the system units, in the same list, naming what it was.
    expect(r.stdout).toMatch(/hermes-gateway\.service \(the clawbox user's unit; was active=active\)/);
    expect(r.stdout).toMatch(/Brought down units belonging to another edition/);
  });

  it("looks and does nothing when the user has no such unit", () => {
    const r = run("openclaw", { USER_UNIT_PRESENT: "0" });
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("sudo"))).toEqual([
      "sudo XDG_RUNTIME_DIR=/run/user/1000 :: systemctl --user cat hermes-gateway.service",
    ]);
    expect(r.stdout).not.toMatch(/Brought down/);
  });

  it("never asks the user's manager on a Hermes or dual box — that gateway belongs there", () => {
    for (const edition of ["hermes", "dual"]) {
      const r = run(edition);
      expect(r.status, edition).toBe(0);
      expect(r.calls.filter((c) => c.startsWith("sudo")), edition).toEqual([]);
    }
  });

  it("leaves the unit alone under CLAWBOX_KEEP_FOREIGN_UNITS=1", () => {
    const r = run("openclaw", { CLAWBOX_KEEP_FOREIGN_UNITS: "1" });
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("sudo"))).toEqual([]);
  });

  it("never reports a unit the user's manager would not disable as brought down — it names the command instead", () => {
    // CodeRabbit on #781: a `|| true` here reported the second poller as gone
    // while it went on polling the bot beside the OpenClaw gateway.
    const r = run("openclaw", { USER_UNIT_DISABLE_FAILS: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/hermes-gateway\.service \(the clawbox user's unit/);
    expect(r.stdout).not.toMatch(/Brought down/);
    expect(r.stderr).toMatch(/could not disable the clawbox user's hermes-gateway\.service \(was active=active\)/);
    expect(r.stderr).toMatch(/sudo -u clawbox XDG_RUNTIME_DIR=\/run\/user\/1000 systemctl --user disable --now hermes-gateway\.service/);
  });

  it("reports a unit that was already stopped as such and still disables it", () => {
    const r = run("openclaw", { USER_UNIT_STATE: "inactive" });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("sudo XDG_RUNTIME_DIR=/run/user/1000 :: systemctl --user disable --now hermes-gateway.service");
    expect(r.stdout).toMatch(/was active=inactive/);
  });
});
