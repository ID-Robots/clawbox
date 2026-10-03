import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";
import { failureReason } from "@/lib/root-step-follow";
import { SELF_UPDATING_ROOT_STEPS, UI_ROOT_STEPS, WEB_ROOT_STEPS } from "@/lib/root-steps";

// Real bash per case; see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const SPAWN_TIMEOUT_MS = 20_000;

/**
 * The root half of the setup wizard's "Choose your assistant" (TASK-1149):
 * `install.sh --step edition_select`, which turns a unified-image box (lock
 * `unselected`, both harnesses on disk) into a plain single-edition box.
 *
 * `data/edition-select.env` is clawbox-writable and read by ROOT, so the same
 * value gate as the harness swap guards it; the step's own rule is that it
 * acts only on an `unselected` box (or finishes, for the same agent, an
 * activation its own pending marker says was cut short). Driven under bash
 * with a sandbox PROJECT_DIR and a stub install.sh standing in for the
 * sub-step re-exec, the way install-harness-swap.test.ts drives the swap.
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
const DISPATCHER = fs.readFileSync(path.join(REPO, "config/clawbox-root-step.sh"), "utf-8");
const LAUNCHER = fs.readFileSync(path.join(REPO, "config/clawbox-run-root-step.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

function shellList(source: string, name: string): string[] {
  const m = new RegExp(`^${name}="([^"]*)"`, "m").exec(source);
  if (!m) throw new Error(`${name} not found`);
  return m[1].split(/\s+/).filter(Boolean);
}

function bashArray(name: string): string[] {
  const start = INSTALL_SH.indexOf(`${name}=(`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n)", start);
  return INSTALL_SH.slice(start + `${name}=(`.length, end)
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .flatMap((l) => l.split(/\s+/))
    .filter(Boolean);
}

/** Everything the step calls, in the order install.sh defines it. */
const SELECT_FUNCTIONS = [
  "read_configured_harness_swap",
  "harness_swap_label",
  "harness_swap_say_failed",
  "harness_swap_last_line",
  "harness_swap_hermes_runnable",
  "harness_swap_openclaw_runnable",
  "harness_swap_print_probe",
  "wait_for_gateway_port",
  "edition_select_substep",
  "edition_select_runnable",
  "edition_select_pending_target",
  "edition_select_mark_pending",
  "edition_select_prove",
  "edition_select_provision_hermes",
  "edition_select_provision_openclaw",
  "edition_select_remove_other",
  "edition_select_restart_web",
  "step_edition_select",
];

/**
 * The re-exec target: records each `--step` and the edition environment it
 * was handed, repairs a harness on its install step, writes the lock on
 * edition_lock, and fails the steps named in STUB_FAIL_STEPS.
 */
const STUB_INSTALL_SH = [
  "#!/usr/bin/env bash",
  "set -u",
  '[ "${1:-}" = "--step" ] || { echo "stub: expected --step, got: $*" >&2; exit 64; }',
  'step="${2:-}"',
  "printf 'step=%s edition=%s allow=%s bootstrapped=%s reason=%s\\n' \\",
  '  "$step" "${CLAWBOX_EDITION:-}" "${CLAWBOX_ALLOW_EDITION_CHANGE:-}" \\',
  '  "${CLAWBOX_INSTALL_BOOTSTRAPPED:-}" "${CLAWBOX_EDITION_CHANGE_REASON:-}" >> "$STUB_CALLS"',
  "for f in ${STUB_FAIL_STEPS:-}; do",
  '  if [ "$f" = "$step" ]; then echo "stub: $step failed" >&2; exit 1; fi',
  "done",
  'case "$step" in',
  "  hermes_install)",
  '    mkdir -p "$STUB_HOME/.local/bin" "$STUB_HOME/.hermes/hermes-agent/venv/bin"',
  "    printf '#!/bin/sh\\nexit 0\\n' > \"$STUB_HOME/.local/bin/hermes\"; chmod +x \"$STUB_HOME/.local/bin/hermes\"",
  "    printf '#!/bin/sh\\nexit 0\\n' > \"$STUB_HOME/.hermes/hermes-agent/venv/bin/python\"; chmod +x \"$STUB_HOME/.hermes/hermes-agent/venv/bin/python\" ;;",
  "  openclaw_install)",
  '    mkdir -p "$(dirname "$STUB_OPENCLAW_BIN")"',
  "    printf '#!/bin/sh\\nexit 0\\n' > \"$STUB_OPENCLAW_BIN\"; chmod +x \"$STUB_OPENCLAW_BIN\" ;;",
  "  edition_lock)",
  "    printf 'CLAWBOX_EDITION=%s\\n' \"${CLAWBOX_EDITION:-}\" > \"$STUB_LOCK\" ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

let tmp: string;
let projectDir: string;
let srcDir: string;
let home: string;
let requestFile: string;
let pendingFile: string;
let callsFile: string;
let lockFile: string;
let systemctlCalls: string;
let systemdRunCalls: string;
let npmPrefix: string;
let openclawBin: string;
let openclawPkg: string;
let hermesShim: string;
let hermesVenv: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-edition-select-"));
  projectDir = path.join(tmp, "clawbox");
  fs.mkdirSync(path.join(projectDir, "data"), { recursive: true });
  requestFile = path.join(projectDir, "data", "edition-select.env");
  pendingFile = path.join(tmp, "etc-clawbox", "edition-select.pending");
  srcDir = path.join(tmp, "src");
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, "install.sh"), STUB_INSTALL_SH, { mode: 0o755 });
  home = path.join(tmp, "home");
  fs.mkdirSync(home);
  callsFile = path.join(tmp, "substeps");
  fs.writeFileSync(callsFile, "");
  lockFile = path.join(tmp, "edition.env");
  systemctlCalls = path.join(tmp, "systemctl-calls");
  fs.writeFileSync(systemctlCalls, "");
  systemdRunCalls = path.join(tmp, "systemd-run-calls");
  fs.writeFileSync(systemdRunCalls, "");
  npmPrefix = path.join(home, ".npm-global");
  openclawBin = path.join(npmPrefix, "bin", "openclaw");
  openclawPkg = path.join(npmPrefix, "lib", "node_modules", "openclaw");
  hermesShim = path.join(home, ".local", "bin", "hermes");
  hermesVenv = path.join(home, ".hermes", "hermes-agent", "venv", "bin", "python");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

function writeExecutable(file: string, body = "#!/bin/sh\nexit 0\n"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

/** The unified image: both agents installed and runnable. */
function layDownBoth(): void {
  writeExecutable(openclawBin);
  fs.mkdirSync(openclawPkg, { recursive: true });
  fs.writeFileSync(path.join(openclawPkg, "package.json"), "{}");
  writeExecutable(hermesShim);
  writeExecutable(hermesVenv);
  fs.writeFileSync(path.join(home, ".hermes", "config.yaml"), "model: x\n");
}

/** The file the route writes, byte for byte. */
function writeRequest(target: string, at: number = nowSeconds()): void {
  fs.writeFileSync(requestFile, `TARGET_EDITION=${target}\nREQUESTED_AT=${at}\n`);
}

function writePending(target: string): void {
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(pendingFile, `TARGET_EDITION=${target}\n`);
}

interface StepRun {
  status: number;
  out: string;
  substeps: string[];
  calls: string[];
  lock: string | null;
  requestLeft: boolean;
  pending: string | null;
  phases: string[];
  systemctl: string[];
  systemdRun: string[];
}

function runStep(
  recorded: string,
  extra: Record<string, string> = {},
  { systemdRunFails = false }: { systemdRunFails?: boolean } = {},
): StepRun {
  const script = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(projectDir)}`,
    `SRC_DIR=${JSON.stringify(srcDir)}`,
    `CLAWBOX_HOME=${JSON.stringify(home)}`,
    "CLAWBOX_USER=clawbox",
    `NPM_PREFIX=${JSON.stringify(npmPrefix)}`,
    `OPENCLAW_BIN=${JSON.stringify(openclawBin)}`,
    `CLAWBOX_RECORDED_EDITION=${JSON.stringify(recorded)}`,
    `EDITION_SELECT_PENDING_FILE=${JSON.stringify(pendingFile)}`,
    "EDITION_SELECT_RESTART_DELAY_S=10",
    "GATEWAY_READY_SPENT=0",
    'runuser() { shift 2; [ "${1:-}" = "--" ] && shift; "$@"; }',
    "systemctl() {",
    `  printf '%s\\n' "$*" >> ${JSON.stringify(systemctlCalls)}`,
    '  if [ "${1:-}" = "is-enabled" ]; then printf \'%s\\n\' "${STUB_UNIT_ENABLED:-enabled}"; fi',
    "  return 0",
    "}",
    // Always a stub: the host's real systemd-run must never be reached.
    `systemd-run() { printf '%s\\n' "$*" >> ${JSON.stringify(systemdRunCalls)}; return ${systemdRunFails ? 1 : 0}; }`,
    'gateway_port_listening() { [ "${STUB_GATEWAY_LISTENING:-1}" = 1 ]; }',
    'gateway_unit_running_or_starting() { [ "${STUB_GATEWAY_TRYING:-1}" = 1 ]; }',
    "sleep() { :; }",
    ...SELECT_FUNCTIONS.map(extractShellFunction),
    "step_edition_select",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "",
      STUB_CALLS: callsFile,
      STUB_LOCK: lockFile,
      STUB_HOME: home,
      STUB_OPENCLAW_BIN: openclawBin,
      ...extra,
    }),
    timeout: SPAWN_TIMEOUT_MS,
  });
  const calls = fs.readFileSync(callsFile, "utf-8").split("\n").filter(Boolean);
  return {
    status: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    calls,
    substeps: calls.map((c) => /^step=(\S+)/.exec(c)?.[1] ?? ""),
    lock: fs.existsSync(lockFile) ? (/CLAWBOX_EDITION=(\S+)/.exec(fs.readFileSync(lockFile, "utf-8"))?.[1] ?? "") : null,
    requestLeft: fs.existsSync(requestFile),
    pending: fs.existsSync(pendingFile) ? fs.readFileSync(pendingFile, "utf-8").trim() : null,
    phases: (r.stdout ?? "").split("\n").filter((l) => l.startsWith("[edition-select] phase=")).map((l) => l.slice("[edition-select] phase=".length)),
    systemctl: fs.readFileSync(systemctlCalls, "utf-8").split("\n").filter(Boolean),
    systemdRun: fs.readFileSync(systemdRunCalls, "utf-8").split("\n").filter(Boolean),
  };
}

/** The sentence the wizard shows under "Details": the route's own pick. */
function wizardSentence(r: StepRun): string {
  const line = failureReason(r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  if (!line) throw new Error(`no failure line in:\n${r.out}`);
  return line;
}

d("step_edition_select on a unified-image box", () => {
  it("sets the box up as Hermes: probe, lock, provision, remove OpenClaw, restart", () => {
    layDownBoth();
    writeRequest("hermes");
    const r = runStep("unselected");

    expect(r.status, r.out).toBe(0);
    expect(r.phases).toEqual(["check", "lock", "provision", "cleanup", "done"]);
    // Runnable already: no install step, so no network is needed.
    expect(r.substeps).toEqual(["edition_lock", "hermes_edition"]);
    for (const call of r.calls) {
      expect(call).toContain("edition=hermes allow=1 bootstrapped=1");
      expect(call).toMatch(/reason=the owner chose Hermes in the setup wizard \(install\.sh --step edition_select\)/);
    }
    expect(r.lock).toBe("hermes");
    // The other agent's PROGRAM is gone; its config dir is not touched.
    expect(fs.existsSync(openclawBin)).toBe(false);
    expect(fs.existsSync(openclawPkg)).toBe(false);
    expect(fs.existsSync(hermesShim)).toBe(true);
    // Finished: no marker, no request, and the web server restart scheduled.
    expect(r.pending).toBeNull();
    expect(r.requestLeft).toBe(false);
    expect(r.systemdRun).toHaveLength(1);
    expect(r.systemdRun[0]).toMatch(/--on-active=10 .*restart clawbox-setup\.service$/);
  });

  it("sets the box up as OpenClaw: gateway installed and listening, Hermes removed", () => {
    layDownBoth();
    writeRequest("openclaw");
    const r = runStep("unselected");

    expect(r.status, r.out).toBe(0);
    expect(r.phases).toEqual(["check", "lock", "provision", "cleanup", "done"]);
    // The factory patched the core it installed: no openclaw_patch unless repaired.
    expect(r.substeps).toEqual(["edition_lock", "gateway_setup"]);
    expect(r.out).toContain("OpenClaw gateway is listening");
    expect(r.lock).toBe("openclaw");
    expect(fs.existsSync(path.join(home, ".hermes"))).toBe(false);
    expect(fs.existsSync(hermesShim)).toBe(false);
    expect(fs.existsSync(openclawBin)).toBe(true);
    expect(r.pending).toBeNull();
    expect(r.requestLeft).toBe(false);
  });

  it("repairs an agent that does not run with its own install step, once, then goes on", () => {
    layDownBoth();
    fs.rmSync(hermesVenv);
    writeRequest("hermes");
    const r = runStep("unselected");

    expect(r.status, r.out).toBe(0);
    expect(r.substeps).toEqual(["hermes_install", "edition_lock", "hermes_edition"]);
    expect(r.out).toContain("its Python environment is missing");
  });

  it("patches a core it had to reinstall on the OpenClaw way", () => {
    layDownBoth();
    fs.rmSync(openclawBin);
    writeRequest("openclaw");
    const r = runStep("unselected");

    expect(r.status, r.out).toBe(0);
    expect(r.substeps).toEqual(["openclaw_install", "edition_lock", "gateway_setup", "openclaw_patch"]);
  });

  it("changes NOTHING when the chosen agent cannot be made to run", () => {
    layDownBoth();
    fs.rmSync(hermesVenv);
    writeRequest("hermes");
    const r = runStep("unselected", { STUB_FAIL_STEPS: "hermes_install" });

    expect(r.status).not.toBe(0);
    expect(r.phases).toEqual(["check"]);
    expect(r.substeps).toEqual(["hermes_install"]);
    expect(r.lock).toBeNull();
    expect(r.pending).toBeNull();
    // Both agents still there: the owner can pick either again.
    expect(fs.existsSync(openclawBin)).toBe(true);
    expect(fs.existsSync(hermesShim)).toBe(true);
    const sentence = wizardSentence(r);
    expect(sentence).toMatch(/^Error: the check phase failed — Hermes could not be repaired/);
    expect(sentence).toMatch(/nothing was changed/);
    expect(sentence).not.toMatch(/\/home\/|sudo|--step|journalctl|systemctl/);
    expect(r.systemdRun).toEqual([]);
  });

  it("leaves the pending marker when provisioning fails after the lock flipped", () => {
    layDownBoth();
    writeRequest("hermes");
    const r = runStep("unselected", { STUB_FAIL_STEPS: "hermes_edition" });

    expect(r.status).not.toBe(0);
    expect(r.phases).toEqual(["check", "lock", "provision"]);
    expect(r.lock).toBe("hermes");
    expect(r.pending).toBe("TARGET_EDITION=hermes");
    // Nothing removed before the chosen agent is up.
    expect(fs.existsSync(openclawBin)).toBe(true);
    expect(wizardSentence(r)).toMatch(/^Error: the provision phase failed — /);
    // The repair line is for an operator and is never the one shown.
    for (const line of r.out.split("\n").filter((l) => l.trim().startsWith("Repair:"))) {
      expect(line).not.toMatch(/error/i);
    }
  });

  it("finishes a cut-short activation for the SAME agent — idempotent on retry", () => {
    layDownBoth();
    writePending("hermes");
    writeRequest("hermes");
    const r = runStep("hermes");

    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Finishing the Hermes setup an earlier run started");
    expect(r.substeps).toEqual(["edition_lock", "hermes_edition"]);
    expect(r.pending).toBeNull();
    expect(fs.existsSync(openclawBin)).toBe(false);
  });

  it("answers 'nothing to do' on a box that already finished, and drops the request", () => {
    writeRequest("hermes");
    const r = runStep("hermes");

    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Already set up with Hermes");
    expect(r.substeps).toEqual([]);
    expect(r.requestLeft).toBe(false);
    expect(r.systemdRun).toEqual([]);
  });

  it("falls back to an immediate restart when systemd-run cannot schedule one", () => {
    layDownBoth();
    writeRequest("openclaw");
    const r = runStep("unselected", {}, { systemdRunFails: true });
    expect(r.status, r.out).toBe(0);
    expect(r.systemctl).toContain("--no-block restart clawbox-setup.service");
  });

  it.skipIf(IS_ROOT)("does not fail the step when the other agent cannot be removed", () => {
    layDownBoth();
    writeRequest("hermes");
    const binDir = path.dirname(openclawBin);
    fs.chmodSync(binDir, 0o555);
    try {
      const r = runStep("unselected");
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/Warning: could not remove .*openclaw — it stays on disk, unused/);
      expect(r.out).toContain("this box runs Hermes only");
      expect(r.phases).toEqual(["check", "lock", "provision", "cleanup", "done"]);
      expect(r.pending).toBeNull();
    } finally {
      fs.chmodSync(binDir, 0o755);
    }
  });
});

d("step_edition_select is never a free swap", () => {
  it.each([
    ["openclaw", "hermes"],
    ["hermes", "openclaw"],
    ["dual", "hermes"],
    ["dual", "openclaw"],
  ])("refuses a box locked to %s asking for %s", (recorded, target) => {
    layDownBoth();
    writeRequest(target);
    const r = runStep(recorded);

    expect(r.status).not.toBe(0);
    expect(r.substeps).toEqual([]);
    expect(r.phases).toEqual([]);
    expect(r.lock).toBeNull();
    expect(fs.existsSync(openclawBin)).toBe(true);
    expect(fs.existsSync(hermesShim)).toBe(true);
    expect(r.out).toMatch(/cannot be chosen again here — changing it is Settings → Harness/);
  });

  it("refuses the OTHER agent while a cut-short activation is pending", () => {
    layDownBoth();
    writePending("hermes");
    writeRequest("openclaw");
    const r = runStep("hermes");
    expect(r.status).not.toBe(0);
    expect(r.substeps).toEqual([]);
  });

  it("refuses a box that records no edition at all", () => {
    writeRequest("hermes");
    const r = runStep("");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/records no edition/);
  });

  it("is a clean no-op with no request on disk", () => {
    const r = runStep("unselected");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("No assistant choice requested");
    expect(r.substeps).toEqual([]);
  });

  it("refuses a stale request (the swap's own hour)", () => {
    layDownBoth();
    writeRequest("hermes", nowSeconds() - 2 * 3600);
    const r = runStep("unselected");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/request is stale/);
    expect(r.substeps).toEqual([]);
  });

  it.each(["dual", "unselected", "Hermes", "hermes; reboot"])("refuses TARGET_EDITION=%s", (target) => {
    layDownBoth();
    writeRequest(target);
    const r = runStep("unselected");
    expect(r.status).not.toBe(0);
    expect(r.substeps).toEqual([]);
  });

  it("refuses a request that is not the plain file the route writes", () => {
    layDownBoth();
    const real = path.join(tmp, "elsewhere.env");
    fs.writeFileSync(real, `TARGET_EDITION=hermes\nREQUESTED_AT=${nowSeconds()}\n`);
    fs.symlinkSync(real, requestFile);
    const r = runStep("unselected");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/is not the plain file the setup wizard writes/);
    expect(r.substeps).toEqual([]);
  });

  it("ignores a planted symlink as the pending marker", () => {
    layDownBoth();
    const real = path.join(tmp, "fake-pending");
    fs.writeFileSync(real, "TARGET_EDITION=hermes\n");
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.symlinkSync(real, pendingFile);
    writeRequest("hermes");
    const r = runStep("hermes");
    // Not "pending": the box is simply already Hermes.
    expect(r.out).toContain("Already set up with Hermes");
    expect(r.substeps).toEqual([]);
  });
});

d("the harness swap refuses a box that has not chosen yet", () => {
  it("leaves an unselected box to the wizard", () => {
    fs.writeFileSync(
      path.join(projectDir, "data", "harness-swap.env"),
      `TARGET_EDITION=hermes\nREQUESTED_AT=${nowSeconds()}\n`,
    );
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(projectDir)}`,
      'CLAWBOX_RECORDED_EDITION="unselected"',
      extractShellFunction("read_configured_harness_swap"),
      extractShellFunction("harness_swap_label"),
      extractShellFunction("step_harness_swap"),
      "step_harness_swap",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: testEnv({ PATH: process.env.PATH ?? "" }), timeout: SPAWN_TIMEOUT_MS });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/has not chosen its assistant yet — that is the setup wizard's step/);
  });
});

describe("edition_select's place on the root-step lists", () => {
  it("is dispatchable, allowed root-side and startable by the web server", () => {
    expect(bashArray("DISPATCH_STEPS")).toContain("edition_select");
    expect(shellList(DISPATCHER, "ALLOWED_STEPS")).toContain("edition_select");
    expect(shellList(LAUNCHER, "WEB_ROOT_STEPS")).toContain("edition_select");
    expect(WEB_ROOT_STEPS).toContain("edition_select");
  });

  it("is neither a UI/MCP-reachable step nor one that may pull new code", () => {
    expect(UI_ROOT_STEPS).not.toContain("edition_select");
    expect(SELF_UPDATING_ROOT_STEPS).not.toContain("edition_select");
    expect(shellList(DISPATCHER, "SELF_UPDATING_STEPS")).not.toContain("edition_select");
  });
});
