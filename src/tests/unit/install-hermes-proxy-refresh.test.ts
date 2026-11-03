import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * An update reaches the Hermes dashboard's auth proxy (TASK-2131).
 *
 * The proxy (scripts/hermes-dashboard-proxy.js) is ClawBox's own node process,
 * run straight from the checkout, and nothing in an update restarted it: on a
 * board updated to the session-guard fix it was still the process started
 * before the update, serving the old script. step_post_update now asks a
 * RUNNING proxy to restart once the unit files are in place, and never starts
 * one an edition does not run.
 *
 * These run the SHIPPED function body out of install.sh against a stub
 * systemctl, so an edit to install.sh is what the assertions see.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const INSTALL_SH = readFileSync(path.join(process.cwd(), "install.sh"), "utf-8");
const UNIT = "clawbox-hermes-dashboard-proxy.service";

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(name + "() {");
  if (start < 0) throw new Error(name + " not found in install.sh");
  const end = INSTALL_SH.indexOf("\n}", start);
  return INSTALL_SH.slice(start, end + 2);
}

function run(opts: { active: boolean; restartFails?: boolean }) {
  const script = [
    "set -euo pipefail",
    "calls=()",
    "systemctl() {",
    '  calls+=("$*")',
    '  case "$1" in',
    `    is-active) ${opts.active ? "return 0" : "return 3"} ;;`,
    `    try-restart) ${opts.restartFails ? "return 1" : "return 0"} ;;`,
    "  esac",
    "}",
    shellFunction("step_hermes_dashboard_proxy_refresh"),
    "rc=0; step_hermes_dashboard_proxy_refresh || rc=$?",
    'echo "rc=$rc"',
    'printf "CALL %s\\n" "${calls[@]}"',
  ].join("\n");
  const res = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 20_000 });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    calls: res.stdout.split("\n").filter((l) => l.startsWith("CALL ")).map((l) => l.slice(5)),
  };
}

describe("step_hermes_dashboard_proxy_refresh", () => {
  it("restarts a running proxy so it serves the updated script", () => {
    const res = run({ active: true });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("rc=0");
    expect(res.calls).toEqual([`is-active --quiet ${UNIT}`, `try-restart ${UNIT}`]);
  });

  it("never starts a proxy that is not running — an edition without one stays without one", () => {
    const res = run({ active: false });
    expect(res.stdout).toContain("rc=0");
    expect(res.calls).toEqual([`is-active --quiet ${UNIT}`]);
  });

  it("warns and reports a failed fixup when systemd refuses the restart", () => {
    const res = run({ active: true, restartFails: true });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("rc=1");
    expect(res.stderr).toContain("WARN");
  });
});

describe("step_post_update", () => {
  it("refreshes the proxy right after it reinstalls the unit files", () => {
    const body = shellFunction("step_post_update");
    const units = body.indexOf("optional_step systemd_services step_systemd_services");
    const refresh = body.indexOf("optional_step hermes_dashboard_proxy_refresh step_hermes_dashboard_proxy_refresh");
    expect(units).toBeGreaterThan(0);
    expect(refresh).toBeGreaterThan(units);
  });
});
