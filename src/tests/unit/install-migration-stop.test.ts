import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
vi.setConfig({ testTimeout: 30000 });
const source = readFileSync("install.sh", "utf8");
function fn(name: string) {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`Missing ${name}`);
  return source.slice(start + 1, source.indexOf("\n}", start) + 2);
}
// Execute the real installer step, not a mirrored caller. Doctor deliberately
// exits nonzero after emitting its marker so no downstream plugin work runs.
function run(scenario: string, needsInstall = false) {
  return spawnSync("bash", ["-c", `
set -euo pipefail
CLAWBOX_USER=test
SRC_DIR=/nonexistent
OPENCLAW_BIN=/bin/true
OPENCLAW_PIN_VERSION=2026.8.1
OPENCLAW_VERSION=2026.8.1
NPM_PREFIX=/nonexistent
CLAWBOX_HOME=/nonexistent
id() { echo 1000; }
is_hermes_edition() { return 1; }
ensure_clawbox_bashrc_path() { :; }
ensure_openclaw_node_engine() { :; }
openclaw_version_is_v2() { return 0; }
# The executable version probe yields an exact match unless replacement is tested.
/bin/true() { echo 'OpenClaw ${needsInstall ? "2026.7.1" : "2026.8.1"}'; }
mkdir() { echo CORE_REPLACEMENT; return 99; }
systemctl() { ctl system "$@"; }
as_clawbox() {
  case "$*" in
    *'systemctl --user'*) shift 5; ctl user "$@" ;;
    *'doctor --fix'*) echo DOCTOR_CALLED; return 42 ;;
    *) echo UNEXPECTED_COMMAND >&2; return 99 ;;
  esac
}
ctl() {
  local scope="$1"; shift
  echo "CTL $scope $*" >&2
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
step_openclaw_install
`, "test"], { encoding: "utf8", env: { ...process.env, SCENARIO: scenario } });
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
});
