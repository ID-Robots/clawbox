import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

/**
 * TASK-2490: install.sh installs the gateway liveness watchdog wherever the
 * OpenClaw gateway runs, refreshes it on every in-app update, and takes it off
 * a Hermes box. Driven against install.sh's own text — the unit registry and
 * the two functions, lifted out and run with the system paths moved into a
 * temp dir and systemctl stubbed.
 */

// Real bash per case; see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
const UNITS = ["clawbox-gateway-watchdog.service", "clawbox-gateway-watchdog.timer"];

function slice(startMarker: string, endMarker: string): string {
  const start = INSTALL_SH.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const end = INSTALL_SH.indexOf(endMarker, start);
  if (end < 0) throw new Error(`marker not found: ${endMarker}`);
  return INSTALL_SH.slice(start, end);
}

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  const body = INSTALL_SH.slice(start + 1, end + 2);
  const opens = (body.match(/\{/g) ?? []).length;
  const closes = (body.match(/\}/g) ?? []).length;
  if (opens !== closes) throw new Error(`${name} was extracted truncated (${opens} { vs ${closes} })`);
  return body;
}

const EDITION_BLOCK = slice(
  'CLAWBOX_EDITION_FILE="/etc/clawbox/edition.env"',
  "# CLAWBOX_TEST_MODE=1 skips hardware-only steps",
);
const REGISTRY_BLOCK = slice("EXPECTED_ACTIVE_SERVICES=(", "# Read one KEY=VALUE out of a file this script does NOT trust.");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-install-gw-watchdog-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function registry(edition: string): Record<string, string[]> {
  const script = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(path.join(tmp, "project"))}`,
    'SRC_DIR="$PROJECT_DIR"',
    EDITION_BLOCK.replace('"/etc/clawbox/edition.env"', JSON.stringify(path.join(tmp, "edition.env"))).replace(
      '"/etc/systemd/system/clawbox-setup.service.d/edition.conf"',
      JSON.stringify(path.join(tmp, "edition.conf")),
    ),
    REGISTRY_BLOCK,
    'printf "ACTIVE=%s\\n" "${EXPECTED_ACTIVE_SERVICES[*]}"',
    'printf "INSTALLED=%s\\n" "${EXPECTED_INSTALLED_SERVICES[*]}"',
    'printf "SCOPED=%s\\n" "${EDITION_SCOPED_UNITS[*]}"',
    'printf "FOREIGN=%s\\n" "${FOREIGN_EDITION_UNITS[*]:-}"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", CLAWBOX_EDITION: edition }),
    timeout: 20_000,
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  const out: Record<string, string[]> = {};
  for (const line of r.stdout.split("\n")) {
    const m = /^([A-Z]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].split(" ").filter(Boolean);
  }
  return out;
}

describe("the watchdog's place in the unit registry", () => {
  it.each(["openclaw", "dual"])("%s installs the service and expects the timer up", (edition) => {
    const r = registry(edition);
    expect(r.ACTIVE).toContain("clawbox-gateway-watchdog.timer");
    expect(r.INSTALLED).toContain("clawbox-gateway-watchdog.service");
    expect(r.FOREIGN).not.toContain("clawbox-gateway-watchdog.timer");
  });

  it.each(["hermes", "unselected"])("%s neither installs nor expects it", (edition) => {
    const r = registry(edition);
    for (const unit of UNITS) {
      expect(r.ACTIVE).not.toContain(unit);
      expect(r.INSTALLED).not.toContain(unit);
    }
  });

  it("Hermes lists the timer as a unit to keep down", () => {
    expect(registry("hermes").FOREIGN).toContain("clawbox-gateway-watchdog.timer");
  });

  it("both units are edition-scoped, so the drift guard accepts them on every edition", () => {
    const r = registry("hermes");
    for (const unit of UNITS) expect(r.SCOPED).toContain(unit);
    for (const unit of UNITS) expect(fs.existsSync(path.join(REPO, "config", unit))).toBe(true);
  });
});

describe("the watchdog's units", () => {
  const service = fs.readFileSync(path.join(REPO, "config", "clawbox-gateway-watchdog.service"), "utf-8");
  const timer = fs.readFileSync(path.join(REPO, "config", "clawbox-gateway-watchdog.timer"), "utf-8");

  it("runs the root-owned libexec copy, never anything clawbox can write", () => {
    expect(service).toMatch(/^ExecStart=\/usr\/local\/libexec\/clawbox\/gateway-watchdog\.sh$/m);
    expect(service).not.toMatch(/^(Exec\w*|EnvironmentFile)=.*\/home\/clawbox/m);
    expect(service).toMatch(/^Type=oneshot$/m);
  });

  it("fires once a minute, enabled through timers.target", () => {
    expect(timer).toMatch(/^OnUnitActiveSec=60s$/m);
    expect(timer).toMatch(/^Unit=clawbox-gateway-watchdog\.service$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
  });
});

/**
 * install_gateway_watchdog / remove_gateway_watchdog / step_edition_gateway_state,
 * with /etc/systemd/system, the libexec dir and /run/clawbox moved into tmp.
 */
function runFunctions(call: string, opts: { edition?: string; failCopy?: string } = {}) {
  const project = path.join(tmp, "project");
  const unitDir = path.join(tmp, "etc-systemd");
  const libexec = path.join(tmp, "libexec");
  const run = path.join(tmp, "run-clawbox");
  for (const d of [path.join(project, "scripts"), path.join(project, "config"), unitDir, run]) fs.mkdirSync(d, { recursive: true });
  for (const f of ["gateway-watchdog.sh", "gateway-unit-guard.sh"]) {
    fs.copyFileSync(path.join(REPO, "scripts", f), path.join(project, "scripts", f));
  }
  for (const u of UNITS) fs.copyFileSync(path.join(REPO, "config", u), path.join(project, "config", u));

  const redirect = (body: string) =>
    body.replaceAll("/etc/systemd/system", unitDir).replaceAll("/run/clawbox", run);
  const fns = [
    slice("GATEWAY_WATCHDOG_UNITS=(", "\n").trim(),
    redirect(shellFunction("install_gateway_watchdog")),
    redirect(shellFunction("remove_gateway_watchdog")),
    redirect(shellFunction("step_edition_gateway_state")),
  ].join("\n");
  for (const body of [fns]) {
    if (body.includes("/etc/systemd") || body.includes("/run/clawbox/")) throw new Error("a real system path survived the redirection");
  }
  const log = path.join(tmp, "systemctl.log");
  const script = [
    "set -euo pipefail",
    `SRC_DIR=${JSON.stringify(project)}`,
    `ROOT_LIBEXEC_DIR=${JSON.stringify(libexec)}`,
    `systemctl() { echo "$*" >> ${JSON.stringify(log)}; return 0; }`,
    // install(1) without the ownership: -d makes the directory, otherwise copy.
    'install() { local d=0 a=(); while [ $# -gt 0 ]; do case "$1" in -d) d=1; shift ;; -o|-g|-m) shift 2 ;; *) a+=("$1"); shift ;; esac; done; if [ "$d" = 1 ]; then mkdir -p "${a[@]}"; else cp "${a[0]}" "${a[1]}"; fi; }',
    opts.failCopy
      ? `install_root_file() { case "$2" in *${opts.failCopy}) return 1 ;; esac; cp "$1" "$2.new" && mv -f "$2.new" "$2"; }`
      : 'install_root_file() { cp "$1" "$2.new" && mv -f "$2.new" "$2"; }',
    `is_hermes_edition() { [ ${JSON.stringify(opts.edition ?? "openclaw")} = hermes ]; }`,
    fns,
    call,
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: testEnv({ PATH: process.env.PATH ?? "" }), timeout: 20_000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, unitDir, libexec, run };
}

describe("install_gateway_watchdog / remove_gateway_watchdog", () => {
  it("installs the script beside its guard, both units, and starts the timer — idempotently", () => {
    for (let i = 0; i < 2; i++) {
      const r = runFunctions("install_gateway_watchdog");
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/Gateway liveness watchdog installed/);
      expect(fs.existsSync(path.join(r.libexec, "gateway-watchdog.sh"))).toBe(true);
      expect(fs.existsSync(path.join(r.libexec, "gateway-unit-guard.sh"))).toBe(true);
      for (const u of UNITS) {
        expect(fs.readFileSync(path.join(r.unitDir, u), "utf-8")).toBe(fs.readFileSync(path.join(REPO, "config", u), "utf-8"));
      }
      expect(r.calls).toMatch(/daemon-reload/);
      expect(r.calls).toMatch(/enable --now clawbox-gateway-watchdog\.timer/);
    }
  });

  it("does not install units that point at a script that did not land", () => {
    const r = runFunctions("install_gateway_watchdog || echo RC=$?", { failCopy: "gateway-watchdog.sh" });
    expect(r.out).toMatch(/could not install the gateway watchdog's root-owned script/);
    expect(r.out).toMatch(/RC=1/);
    for (const u of UNITS) expect(fs.existsSync(path.join(r.unitDir, u))).toBe(false);
    expect(r.calls).not.toMatch(/enable/);
  });

  it("removes the units and the script, keeps the guard the network waiter still sources", () => {
    runFunctions("install_gateway_watchdog");
    fs.writeFileSync(path.join(tmp, "run-clawbox", "gateway-watchdog.state"), "inv 1 2 3 0\n");
    fs.rmSync(path.join(tmp, "systemctl.log"));
    const r = runFunctions("remove_gateway_watchdog");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/Gateway liveness watchdog removed/);
    expect(r.calls).toMatch(/disable --now clawbox-gateway-watchdog\.timer/);
    for (const u of UNITS) expect(fs.existsSync(path.join(r.unitDir, u))).toBe(false);
    expect(fs.existsSync(path.join(r.libexec, "gateway-watchdog.sh"))).toBe(false);
    expect(fs.existsSync(path.join(r.libexec, "gateway-unit-guard.sh"))).toBe(true);
    expect(fs.existsSync(path.join(r.run, "gateway-watchdog.state"))).toBe(false);
  });

  it("is silent and touches nothing when there is nothing to remove", () => {
    const r = runFunctions("remove_gateway_watchdog");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toBe("");
    expect(r.calls).toBe("");
  });

  it("the Hermes branch of step_edition_gateway_state takes the watchdog with the gateway", () => {
    runFunctions("install_gateway_watchdog");
    const r = runFunctions("step_edition_gateway_state", { edition: "hermes" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\[hermes edition\] clawbox-gateway\.service stopped, disabled and masked/);
    expect(r.out).toMatch(/Gateway liveness watchdog removed/);
    for (const u of UNITS) expect(fs.existsSync(path.join(r.unitDir, u))).toBe(false);
  });

  it("the OpenClaw branch leaves it alone", () => {
    runFunctions("install_gateway_watchdog");
    const r = runFunctions("step_edition_gateway_state", { edition: "openclaw" });
    expect(r.status, r.out).toBe(0);
    for (const u of UNITS) expect(fs.existsSync(path.join(r.unitDir, u))).toBe(true);
  });
});

describe("the call sites", () => {
  it("every in-app update (step_systemd_services) installs it on OpenClaw editions and removes it elsewhere", () => {
    const body = shellFunction("step_systemd_services");
    expect(body).toMatch(/if has_openclaw_harness; then\n\s+install_gateway_watchdog \|\|[^\n]*\n\s+else\n\s+remove_gateway_watchdog \|\|/);
    // After install_root_libexec, which publishes the guard and the script first.
    expect(body.indexOf("install_root_libexec")).toBeLessThan(body.indexOf("install_gateway_watchdog"));
  });

  it("the edition choice and the swap to OpenClaw (step_gateway_setup) install it beside the gateway", () => {
    const body = shellFunction("step_gateway_setup");
    expect(body.indexOf("systemctl enable clawbox-gateway.service")).toBeLessThan(body.indexOf("install_gateway_watchdog"));
    // After the Hermes / unselected early returns.
    expect(body.indexOf("is_unselected_edition")).toBeLessThan(body.indexOf("install_gateway_watchdog"));
  });

  it("install_root_libexec publishes the shared guard before either consumer, and neither without it", () => {
    const body = shellFunction("install_root_libexec");
    const guard = body.indexOf('install_root_file "$SRC_DIR/scripts/gateway-unit-guard.sh"');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf("gateway-watchdog.sh) [ \"$gateway_guard_ready\" -eq 1 ] || continue"));
    expect(body).toMatch(/gateway-restart-when-online\.sh\|gateway-watchdog\.sh\) \[ "\$gateway_guard_ready" -eq 1 \] \|\| continue/);
  });
});
