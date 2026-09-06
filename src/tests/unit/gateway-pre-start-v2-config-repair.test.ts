import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";
import { sliceScript } from "@/tests/helpers/gateway-pre-start";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// TASK-737. A customer box was dark for 25 hours after the 2026.7.1 → 2026.8.1
// core upgrade: OpenClaw 2026.8 does not migrate a 2026.7 config on load, it
// REFUSES it (`Unrecognized keys`, gateway exit 78), and the migrations it
// names are performed only by `openclaw doctor --fix`. Nothing on the boot path
// ran doctor for that reason.
//
// And the repair had a blocker of its own, measured against 2026.8.1 on
// 2026-09-06: with an EMPTY legacy `exec-approvals.json` in the state
// directory, `doctor --fix --yes --non-interactive` exits 1 having migrated
// NOTHING and asks the operator to run the command that just ran. Move that one
// empty file aside and the same command exits 0 and migrates everything. The
// stub below models exactly that, so these cases fail if either half regresses.
//
// The three failure shapes pinned:
//   false success — a boot that "started the gateway" on a config the core will
//                   not load. The config has to be provably ACCEPTED by the
//                   core afterwards, not merely doctored at.
//   false failure — an approvals file with content is the owner's data; it is
//                   never moved, and its presence is reported rather than
//                   silently repaired.
//   probe-once    — the stamp records the core version whose config was
//                   accepted, and is written ONLY on success, so a failed
//                   repair is retried on the next boot rather than remembered
//                   as done.

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

/** The shipped block, run verbatim — a drift in the script fails here. */
function block(): string {
  return sliceScript(
    "# ── First boot on a NEW OpenClaw core: make the config loadable again ",
    "# Resolve configured mDNS hostname",
  );
}

let dir: string;
let root: string;
let binDir: string;
let stateDir: string;
let configPath: string;
let stampPath: string;

/**
 * An `openclaw` that behaves like 2026.8.1 on a 2026.7 config.
 *
 * `config validate` refuses until the migration has run; `doctor --fix`
 * performs it — unless a legacy exec-approvals.json is still present, in which
 * case it exits 1 having done nothing, which is the measured behaviour this
 * whole block exists to get past.
 */
function stubOpenclaw() {
  const p = path.join(binDir, "openclaw");
  writeFileSync(
    p,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OC_CALLS"
if [ "$1" = "config" ] && [ "$2" = "validate" ]; then
  if [ -f "$OC_STATE/migrated" ]; then
    echo "Config valid: $OPENCLAW_CONFIG"
    exit 0
  fi
  echo "OpenClaw config is invalid: $OPENCLAW_CONFIG"
  echo "  × openclaw.json:4 — agents.defaults: Unrecognized keys: \\"memorySearch\\", \\"imageGenerationModel\\""
  echo "  × openclaw.json:11 — messages: Unrecognized key: \\"tts\\""
  exit 1
fi
if [ "$1" = "doctor" ]; then
  if [ -f "$OC_STATE/exec-approvals.json" ]; then
    echo "Legacy exec approvals exist at $OC_STATE/exec-approvals.json. Run \\\`openclaw doctor --fix\\\` before using exec approvals."
    exit 1
  fi
  touch "$OC_STATE/migrated"
  exit 0
fi
exit 0
`,
  );
  chmodSync(p, 0o755);
}

function run(version = "2026.8.1") {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_BIN=${JSON.stringify(path.join(binDir, "openclaw"))}`,
    "CLAWBOX_OPENCLAW_V2=1",
    `CLAWBOX_OPENCLAW_EFFECTIVE=${JSON.stringify(version)}`,
    block(),
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({
      PATH: `${binDir}:/usr/bin:/bin`,
      OPENCLAW_CONFIG: configPath,
      OC_CALLS: path.join(dir, "calls.log"),
      OC_STATE: stateDir,
    }),
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function calls(): string[] {
  const p = path.join(dir, "calls.log");
  return existsSync(p) ? readFileSync(p, "utf-8").split("\n").filter(Boolean) : [];
}

function approvalsFiles(): string[] {
  return spawnSync("bash", ["-c", `ls ${JSON.stringify(stateDir)}`], { encoding: "utf-8" })
    .stdout.split("\n")
    .filter((n) => n.startsWith("exec-approvals"));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-v2-config-repair-"));
  root = path.join(dir, "clawbox");
  binDir = path.join(dir, "bin");
  stateDir = path.join(dir, "openclaw");
  mkdirSync(path.join(root, "data"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  configPath = path.join(stateDir, "openclaw.json");
  stampPath = path.join(root, "data", "openclaw-config-validated");
  writeFileSync(configPath, JSON.stringify({ agents: { defaults: { memorySearch: {} } } }, null, 2));
  stubOpenclaw();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

d("gateway pre-start: making a bumped core's config loadable", () => {
  it("moves an EMPTY legacy exec-approvals.json aside so the core's own migration can run", () => {
    writeFileSync(
      path.join(stateDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, socket: {}, defaults: {}, agents: {} }),
    );

    const r = run();

    expect(r.status).toBe(0);
    // The empty file is gone from its blocking name and kept under another.
    expect(existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
    expect(approvalsFiles().some((n) => n.startsWith("exec-approvals.json.legacy-"))).toBe(true);
    // …and with it out of the way the core migrated and now ACCEPTS the config.
    expect(calls().some((c) => c.startsWith("doctor --fix"))).toBe(true);
    expect(existsSync(path.join(stateDir, "migrated"))).toBe(true);
    expect(readFileSync(stampPath, "utf-8").trim()).toBe("2026.8.1");
  });

  it("never moves an approvals file that holds approvals, and says why", () => {
    writeFileSync(
      path.join(stateDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, socket: {}, defaults: { "rm -rf": "deny" }, agents: {} }),
    );

    const r = run();

    expect(existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(true);
    expect(approvalsFiles()).toEqual(["exec-approvals.json"]);
    expect(r.stderr).toContain("holds approvals");
    // The repair still fails — that is the honest outcome — and it is REPORTED
    // with the keys the core named, not swallowed.
    expect(r.stderr).toContain("the core still refuses this config");
    expect(r.stderr).toContain('agents.defaults: Unrecognized keys: "memorySearch", "imageGenerationModel"');
    // A failed repair is NOT remembered as done.
    expect(existsSync(stampPath)).toBe(false);
  });

  it("runs the core's own migration when the core refuses the config, and re-asks the core", () => {
    const r = run();

    expect(r.status).toBe(0);
    const seen = calls();
    expect(seen[0]).toBe("config validate");
    expect(seen.some((c) => c.startsWith("doctor --fix"))).toBe(true);
    // Asked AGAIN afterwards: doctor exiting 0 is not evidence that the core
    // will load the file, and taking it as such is the false success that left
    // a box dark for a day.
    expect(seen.filter((c) => c === "config validate")).toHaveLength(2);
    expect(seen.indexOf("doctor --fix --non-interactive")).toBeGreaterThan(0);
    expect(readFileSync(stampPath, "utf-8").trim()).toBe("2026.8.1");
    // A backup of the pre-migration file is kept next to it.
    expect(
      spawnSync("bash", ["-c", `ls ${JSON.stringify(stateDir)}`], { encoding: "utf-8" })
        .stdout.split("\n")
        .some((n) => n.startsWith("openclaw.json.pre-v2-migration-")),
    ).toBe(true);
  });

  it("costs a steady box nothing: the stamp already names the installed core", () => {
    mkdirSync(path.dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, "2026.8.1\n");

    const r = run();

    expect(r.status).toBe(0);
    expect(calls()).toEqual([]);
  });

  it("re-asks after a core bump even though the previous core was accepted", () => {
    mkdirSync(path.dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, "2026.7.1\n");

    run("2026.8.1");

    expect(calls()[0]).toBe("config validate");
    expect(readFileSync(stampPath, "utf-8").trim()).toBe("2026.8.1");
  });
});
