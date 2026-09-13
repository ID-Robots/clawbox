import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// This file spawns a real bash to run the shipped step, so it takes both
// ceilings the timeout-hygiene rule asks of a suite that starts a process.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * WHO STOPS THE GATEWAY FOR A MIGRATION, and what the core is told about it.
 *
 * The 2026.9.3 pin brought a maintenance gate with it:
 * `assertDoctorMaintenanceInspection` refuses `doctor --fix` unless the core can
 * account for the gateway's own service — owned by it, absent, or provably
 * offline. On a ClawBox the gateway is the SYSTEM unit `clawbox-gateway.service`,
 * which the core neither installed nor can claim, so it is none of the three and
 * doctor exits 1 with "Gateway service ownership or shutdown could not be
 * verified" — on a box whose gateway `stop_openclaw_gateways_for_migration` had
 * just stopped for it.
 *
 * Measured on two Orin boards (2026-09-13), gateway already stopped:
 *
 *   doctor --fix --non-interactive                                  -> rc 1, refused
 *   OPENCLAW_SERVICE_REPAIR_POLICY=external  doctor --fix …         -> rc 0, "Doctor complete."
 *
 * and the same step exited 0 under 2026.8.1, which is what makes it the pin's
 * regression rather than a standing defect. Left unfixed it is not cosmetic:
 * `step_openclaw_install` returns 1 on every unit's first update, and the plugin
 * refresh that follows the doctor call never runs, so the plugins stay on the
 * old core.
 *
 * The variable is the core's own knob (`resolveServiceRepairPolicy`): repair the
 * STATE, leave the SERVICE to its supervisor. That is already the division of
 * labour here, which is why this suite asserts the pairing rather than the
 * variable alone — the stop must still happen, and must still happen first.
 */

const REPO = path.join(__dirname, "..", "..", "..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const PRE_START = readFileSync(path.join(REPO, "scripts", "gateway-pre-start.sh"), "utf-8");

const HAS_BASH = spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const HAS_PYTHON3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** A shell function lifted out of install.sh, so the test cannot drift from it. */
function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

/**
 * A top-level assignment lifted by name, an absent one becoming an empty
 * definition rather than an error — so this suite RUNS against a tree that
 * predates the variable and fails on what that tree DID, which is how its red
 * was demonstrated before the fix went in.
 */
function assignment(name: string): string {
  const m = new RegExp(`^${name}=.*$`, "m").exec(INSTALL_SH);
  return m ? m[0] : `${name}=""`;
}

type Box = { dir: string; state: string; openclawBin: string; calls: () => string[] };

function makeBox(): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-doctor-policy-"));
  const state = path.join(dir, "state");
  const npmPrefix = path.join(dir, "npm-global");
  mkdirSync(state, { recursive: true });
  mkdirSync(path.join(npmPrefix, "bin"), { recursive: true });
  writeFileSync(path.join(state, "calls"), "");

  // The stub logs the POLICY IT WAS HANDED beside the argv, because that pairing
  // is the whole claim: not that install.sh mentions the variable somewhere, but
  // that the doctor process itself runs with it.
  const openclawBin = path.join(npmPrefix, "bin", "openclaw");
  writeFileSync(openclawBin, `#!/usr/bin/env bash
ST=${JSON.stringify(state)}
printf 'openclaw %s policy=%s\\n' "$*" "\${OPENCLAW_SERVICE_REPAIR_POLICY:-unset}" >> "$ST/calls"
case "$1" in
  --version) printf 'OpenClaw 2026.9.3 (stub)\\n' ;;
  plugins) printf '{"plugins":[]}\\n' ;;
  doctor) printf 'Doctor complete.\\n' ;;
esac
exit 0
`);
  chmodSync(openclawBin, 0o755);
  return {
    dir,
    state,
    openclawBin,
    calls: () => readFileSync(path.join(state, "calls"), "utf-8").split("\n").filter(Boolean),
  };
}

/** Everything install.sh's own file provides, and nothing the test invents. */
const SHIPPED = [
  assignment("OPENCLAW_VERSION"),
  assignment("OPENCLAW_SERVICE_REPAIR_POLICY"),
  shellFunction("openclaw_version_is_v2"),
  shellFunction("openclaw_is_v2"),
  shellFunction("openclaw_migration_complete"),
];

const AMBIENT = [
  "wait_for_apt() { :; }",
  "ensure_clawbox_bashrc_path() { :; }",
  "ensure_openclaw_node_engine() { :; }",
  "is_hermes_edition() { return 1; }",
  "chown() { :; }",
  'systemctl() { printf "systemctl %s\\n" "$*" >> "$ST/calls"; }',
  // `as_clawbox -H cmd …` runs cmd as the service user; here it just runs it,
  // which is also what lets `env VAR=… cmd` through unchanged — the shape the
  // call sites now use, because `sudo -u` resets the environment.
  'as_clawbox() { while [ "${1:-}" = "-H" ]; do shift; done; "$@"; }',
  'stop_openclaw_gateways_for_migration() { printf "stop-gateways-for-migration\\n" >> "$ST/calls"; }',
];

function runStep(box: Box): SpawnSyncReturns<string> {
  const program = [
    "set -uo pipefail",
    `ST=${JSON.stringify(box.state)}`,
    `SRC_DIR=${JSON.stringify(REPO)}`,
    `CLAWBOX_HOME=${JSON.stringify(box.dir)}`,
    `CLAWBOX_USER=${JSON.stringify(process.env.USER ?? "clawbox")}`,
    `NPM_PREFIX=${JSON.stringify(path.join(box.dir, "npm-global"))}`,
    `OPENCLAW_BIN=${JSON.stringify(box.openclawBin)}`,
    ...SHIPPED,
    ...AMBIENT,
    shellFunction("step_openclaw_install"),
    "step_openclaw_install",
  ].join("\n");
  return spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    timeout: 20_000,
    // Deliberately NOT inherited from this process: the claim is that install.sh
    // sets the policy, so the environment the step starts in must not carry one.
    env: { ...process.env, OPENCLAW_SERVICE_REPAIR_POLICY: "" },
  });
}

describe("what install.sh tells the core about who owns the gateway service", () => {
  it("has the bash and python3 the shipped step itself uses", () => {
    expect(HAS_BASH).toBe(true);
    expect(HAS_PYTHON3).toBe(true);
  });

  it("runs the migration doctor with the external service-repair policy", () => {
    const box = makeBox();

    const r = runStep(box);
    const calls = box.calls();
    const doctor = calls.find((c) => c.startsWith("openclaw doctor --fix"));

    expect(r.status, r.stderr).toBe(0);
    expect(doctor, `doctor never ran:\n${calls.join("\n")}`).toBeDefined();
    expect(doctor).toContain("policy=external");
  });

  it("still stops the gateway itself, and still before doctor", () => {
    // The policy tells the core not to touch the SERVICE. It does not excuse
    // ClawBox from stopping it: the sessions-to-SQLite move must not race a
    // gateway writing the very files being migrated. Both halves, or neither
    // is safe.
    const box = makeBox();

    runStep(box);
    const calls = box.calls();
    const stop = calls.findIndex((c) => c.includes("stop-gateways-for-migration"));
    const doctor = calls.findIndex((c) => c.startsWith("openclaw doctor --fix"));

    expect(stop, `the gateway was never stopped:\n${calls.join("\n")}`).toBeGreaterThanOrEqual(0);
    expect(doctor).toBeGreaterThan(stop);
  });

  it("declares the policy as `external` and never as the wider supervisor mode", () => {
    // `OPENCLAW_SUPERVISOR_MODE=external` would also block gateway service
    // mutations and the core's own self-update. This needs neither, and a box
    // that could no longer be told to restart its gateway is a worse outcome
    // than the bug.
    expect(assignment("OPENCLAW_SERVICE_REPAIR_POLICY")).toBe('OPENCLAW_SERVICE_REPAIR_POLICY="external"');
    // Named in prose is fine and is how the choice is explained; SET is not.
    const setsSupervisorMode = /^\s*(export\s+)?OPENCLAW_SUPERVISOR_MODE=/m;
    expect(setsSupervisorMode.test(INSTALL_SH)).toBe(false);
    expect(setsSupervisorMode.test(PRE_START)).toBe(false);
  });

  it("carries the policy to every doctor --fix install.sh runs, not just the migration one", () => {
    // The two recovery call sites run doctor over a gateway that is down. Under
    // the gate they would refuse just as the migration one did — silently, since
    // both are `|| true` — leaving a box in legacy state with a repair that
    // reported nothing.
    const sites = INSTALL_SH.split("\n")
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /\$OPENCLAW_BIN"? doctor --fix/.test(line));

    expect(sites.length, "install.sh runs doctor --fix nowhere").toBeGreaterThanOrEqual(3);
    for (const { line, i } of sites) {
      // The variable travels on the `env` that precedes the binary, which may be
      // a continuation line above it.
      const window = INSTALL_SH.split("\n").slice(Math.max(0, i - 4), i + 1).join("\n");
      expect(window, `doctor --fix without the service-repair policy at install.sh:${i + 1}\n${line}`)
        .toContain("OPENCLAW_SERVICE_REPAIR_POLICY");
    }
  });

  it("exports the policy in the gateway's own ExecStartPre", () => {
    // gateway-pre-start.sh runs its own `doctor --fix` to migrate a config the
    // core refuses — the repair a box needs most, on the one path where a
    // refusal means the gateway never starts at all. It runs as the clawbox
    // user with no sudo in between, so one export covers every openclaw it runs.
    expect(PRE_START).toContain('export OPENCLAW_SERVICE_REPAIR_POLICY="external"');
    const exported = PRE_START.indexOf('export OPENCLAW_SERVICE_REPAIR_POLICY=');
    const firstDoctor = PRE_START.indexOf('doctor --fix --non-interactive');
    expect(exported).toBeGreaterThanOrEqual(0);
    expect(firstDoctor).toBeGreaterThan(exported);
  });
});
