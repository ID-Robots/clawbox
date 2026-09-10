import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const source = readFileSync("install.sh", "utf8");
function fn(name: string) {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`Missing ${name}`);
  return source.slice(start + 1, source.indexOf("\n}", start) + 2);
}
// Execute the real installer step, not a mirrored caller. Doctor deliberately
// can fail or succeed; all side effects use isolated fixtures.
function run(scenario: string, needsInstall = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "migration-stop-"));
  const core = path.join(dir, "openclaw");
  const v1 = scenario.startsWith("v1-");
  writeFileSync(core, `#!/bin/sh\necho 'OpenClaw ${v1 ? (needsInstall ? "2026.7.0" : "2026.7.1") : needsInstall ? "2026.7.1" : "2026.8.1"}'\n`, { mode: 0o755 });
  try {
  const result = spawnSync("bash", ["-c", `
set -euo pipefail
event() { echo "$1" >> "${dir}/events"; }
CLAWBOX_USER=test
SRC_DIR=/nonexistent
OPENCLAW_BIN="${core}"
OPENCLAW_PIN_VERSION=${v1 ? "2026.7.1" : "2026.8.1"}
OPENCLAW_VERSION=2026.8.1
NPM_PREFIX=/nonexistent
CLAWBOX_HOME=/nonexistent
id() { echo 1000; }
is_hermes_edition() { return 1; }
ensure_clawbox_bashrc_path() { :; }
ensure_openclaw_node_engine() { :; }
openclaw_version_is_v2() { [[ "$1" == 2026.8.* ]]; }
mkdir() { echo CORE_REPLACEMENT; case "$SCENARIO" in v1-replacement|v2-replacement) return 0 ;; *) return 99 ;; esac; }
chown() { :; }
systemctl() { ctl system "$@"; }
as_clawbox() {
  case "$*" in
    *'systemctl --user'*) shift 5; ctl user "$@" ;;
    *'doctor --fix'*) echo DOCTOR_CALLED; case "$SCENARIO" in v2-replacement|v2-current|setup-*) return 0 ;; *) return 42 ;; esac ;;
    *'npm install'*) echo NPM_CALLED; return 0 ;;
    *'plugins list'*) event PLUGINS_LIST; printf '%s' '{"plugins":[{"id":"fixture-plugin","origin":"global"}]}'; return 0 ;;
    *'plugins install'*) event PLUGIN_REFRESH; return 0 ;;
    *) echo UNEXPECTED_COMMAND >&2; return 99 ;;
  esac
}
ctl() {
  local scope="$1"; shift
  echo "CTL $scope $*" >&2
  if [ "$1" = start ]; then event START; echo GATEWAY_RESTARTED; return 0; fi
  if [[ "$*" == *user@1000.service* ]]; then
    case "$SCENARIO" in
      manager-absent) echo inactive ;;
      manager-query-failure) return 1 ;;
      manager-activating) echo activating ;;
      *) echo active ;;
    esac
    return 0
  fi
  if [[ "$*" == *LoadState* ]]; then
    case "$SCENARIO:$scope" in
      absent:*|user-absent:user) printf 'LoadState=not-found\nActiveState=inactive\n'; return 4 ;;
      inspect-failure:system|user-bus-failure:user) return 1 ;;
      masked:*) printf 'LoadState=masked\nActiveState=inactive\n' ;;
      *) printf 'LoadState=loaded\nActiveState=active\n' ;;
    esac
  elif [ "$1" = stop ]; then
    case "$SCENARIO:$scope" in system-stop-failure:system|user-stop-failure:user) return 1 ;; esac
  else
    case "$SCENARIO:$scope" in
      still-active:system|user-still-active:user) echo active ;;
      verify-failure:system) return 1 ;;
      *) echo inactive ;;
    esac
  fi
  return 0
}
${fn("stop_openclaw_unit_for_migration")}
${fn("stop_openclaw_gateways_for_migration")}
${fn("openclaw_migration_complete")}
${fn("step_openclaw_install")}
step_openclaw_patch() { event PATCH; [ "$SCENARIO" != setup-patch-failure ]; }
step_openclaw_config() { event CONFIG; [ "$SCENARIO" != setup-config-failure ]; }
step_openclaw_tts() { event TTS; [ "$SCENARIO" != setup-tts-failure ]; }
${fn("step_openclaw_setup")}
if [[ "$SCENARIO" == setup-* ]]; then
  step_openclaw_setup
else
  step_openclaw_install
fi
`, "test"], { encoding: "utf8", env: { ...process.env, SCENARIO: scenario } });
  return { ...result, events: existsSync(path.join(dir, "events")) ? readFileSync(path.join(dir, "events"), "utf8").trim().split("\n") : [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
describe("OpenClaw stopped-writer prerequisite", () => {
  for (const scenario of ["system-stop-failure", "user-stop-failure", "inspect-failure", "user-bus-failure", "manager-query-failure", "manager-activating", "still-active", "user-still-active", "verify-failure"]) {
    it(`refuses doctor on ${scenario}`, () => {
      const r = run(scenario);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stdout).not.toContain("DOCTOR_CALLED");
      expect(r.stdout).not.toContain("CORE_REPLACEMENT");
    });
  }
  for (const scenario of ["success", "absent", "user-absent", "manager-absent", "masked"]) {
    it(`reaches doctor safely on ${scenario}`, () => {
      const r = run(scenario);
      expect(r.stdout, r.stderr).toContain("DOCTOR_CALLED");
      expect(r.status).toBe(1); // The sentinel doctor's failure propagates.
      if (scenario === "absent") expect(r.stderr).not.toContain(" stop ");
      if (scenario === "manager-absent") expect(r.stderr).not.toContain("CTL user");
    });
  }
  for (const scenario of ["system-stop-failure", "user-stop-failure"]) {
    it(`also refuses core replacement on ${scenario}`, () => {
      const r = run(scenario, true);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stdout).not.toContain("CORE_REPLACEMENT");
      expect(r.stdout).not.toContain("DOCTOR_CALLED");
    });
  }
  for (const scenario of ["v1-replacement", "v1-current", "v2-replacement", "v2-current"]) {
    it(`restores the gateway after successful ${scenario}`, () => {
      const r = run(scenario, scenario.endsWith("replacement"));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("GATEWAY_RESTARTED");
      expect(r.events).toEqual(["PLUGINS_LIST", "PLUGIN_REFRESH", "START"]);
      if (scenario.startsWith("v1-")) expect(r.stdout).not.toContain("DOCTOR_CALLED");
      else expect(r.stdout).toContain("DOCTOR_CALLED");
      if (scenario.endsWith("replacement")) expect(r.stdout).toContain("NPM_CALLED");
      else expect(r.stdout).not.toContain("NPM_CALLED");
    });
  }

  it("defers composite setup restart until plugin, patch, config and voice work finish", () => {
    const r = run("setup-success");
    expect(r.status, r.stderr).toBe(0);
    expect(r.events).toEqual(["PLUGINS_LIST", "PLUGIN_REFRESH", "PATCH", "CONFIG", "TTS", "START"]);
  });
  for (const scenario of ["setup-patch-failure", "setup-config-failure", "setup-tts-failure"]) {
    it(`does not restart after ${scenario}`, () => {
      const r = run(scenario);
      expect(r.status, r.stderr).toBe(1);
      expect(r.events).not.toContain("START");
    });
  }

});
