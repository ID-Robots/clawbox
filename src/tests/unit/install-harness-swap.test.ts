import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";
import { failureReason } from "@/lib/root-step-follow";
import { SELF_UPDATING_ROOT_STEPS, UI_ROOT_STEPS, WEB_ROOT_STEPS } from "@/lib/root-steps";

// Starts a real bash per case: vitest's 5 s test and 10 s hook defaults are not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The privileged half of the harness swap (Settings → Harness, 2026-09-07).
 *
 * `data/harness-swap.env` is written by the web server as `clawbox` and read
 * back by `step_harness_swap` running as ROOT — attacker-influenced input on
 * the root side of the boundary, the same shape as `data/timezone.env`. The
 * reader's gates are therefore the boundary, and the step's ORDER is the
 * safety story: the harness being swapped to is installed and proved to run
 * before the edition lock flips, so a failed install leaves the box what it
 * was. Both are driven here under bash with a sandbox PROJECT_DIR and a stub
 * `install.sh` standing in for the re-exec target, which records every
 * sub-step and the environment it was asked to run under.
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
const DISPATCHER = fs.readFileSync(path.join(REPO, "config/clawbox-root-step.sh"), "utf-8");
const LAUNCHER = fs.readFileSync(path.join(REPO, "config/clawbox-run-root-step.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

/** A whitespace-separated shell list assigned as NAME="…". */
function shellList(source: string, name: string): string[] {
  const m = new RegExp(`^${name}="([^"]*)"`, "m").exec(source);
  if (!m) throw new Error(`${name} not found`);
  return m[1].split(/\s+/).filter(Boolean);
}

/** Contents of a bash array literal `NAME=( … )`, comments dropped. */
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

/** Source text between two literal markers, `end` exclusive. */
function slice(startMarker: string, endMarker: string): string {
  const start = INSTALL_SH.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const end = INSTALL_SH.indexOf(endMarker, start);
  if (end < 0) throw new Error(`marker not found: ${endMarker}`);
  return INSTALL_SH.slice(start, end);
}

/**
 * The whole swap, in the order install.sh defines it — and the box's own
 * gateway wait, which the openclaw direction calls rather than carrying a
 * loop of its own.
 */
const SWAP_FUNCTIONS = [
  "read_configured_harness_swap",
  "harness_swap_substep",
  "harness_swap_label",
  "harness_swap_say_failed",
  "harness_swap_last_line",
  "harness_swap_hermes_runnable",
  "harness_swap_openclaw_runnable",
  "harness_swap_print_probe",
  "harness_swap_to_hermes",
  "harness_swap_to_openclaw",
  "wait_for_gateway_port",
  "step_harness_swap",
];

/**
 * The re-exec target. Records `--step <name>` and the edition environment it
 * was handed, then plays the part the STUB_* flags say: lays Hermes or
 * OpenClaw down (runnable, or deliberately not), writes the lock the way
 * step_edition_lock would, and fails the steps named in STUB_FAIL_STEPS. A
 * launcher that does not run says why on stderr, the way a real one does.
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
  'shim="$STUB_HOME/.local/bin/hermes"',
  'venv="$STUB_HOME/.hermes/hermes-agent/venv/bin/python"',
  'case "$step" in',
  "  hermes_install)",
  '    mkdir -p "$(dirname "$shim")" "$(dirname "$venv")"',
  '    case "${STUB_HERMES_INSTALL:-runnable}" in',
  "      runnable)",
  "        printf '#!/bin/sh\\nexit 0\\n' > \"$shim\"; chmod +x \"$shim\"",
  "        printf '#!/bin/sh\\nexit 0\\n' > \"$venv\"; chmod +x \"$venv\" ;;",
  "      no_venv)",
  "        printf '#!/bin/sh\\nexit 0\\n' > \"$shim\"; chmod +x \"$shim\" ;;",
  "      broken_shim)",
  "        printf '#!/bin/sh\\necho \"Traceback (most recent call last):\" >&2\\necho \"ModuleNotFoundError: No module named hermes_cli\" >&2\\nexit 1\\n' > \"$shim\"; chmod +x \"$shim\"",
  "        printf '#!/bin/sh\\nexit 0\\n' > \"$venv\"; chmod +x \"$venv\" ;;",
  "      nothing) ;;",
  "    esac ;;",
  "  openclaw_install)",
  '    mkdir -p "$(dirname "$STUB_OPENCLAW_BIN")"',
  '    case "${STUB_OPENCLAW_INSTALL:-runnable}" in',
  "      runnable) printf '#!/bin/sh\\nexit 0\\n' > \"$STUB_OPENCLAW_BIN\"; chmod +x \"$STUB_OPENCLAW_BIN\" ;;",
  "      broken) printf '#!/bin/sh\\necho \"env: node: No such file or directory\" >&2\\nexit 127\\n' > \"$STUB_OPENCLAW_BIN\"; chmod +x \"$STUB_OPENCLAW_BIN\" ;;",
  "      nothing) ;;",
  "    esac ;;",
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
let callsFile: string;
let lockFile: string;
let systemctlCalls: string;
let sleepCalls: string;
let openclawBin: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-swap-"));
  projectDir = path.join(tmp, "clawbox");
  fs.mkdirSync(path.join(projectDir, "data"), { recursive: true });
  requestFile = path.join(projectDir, "data", "harness-swap.env");
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
  sleepCalls = path.join(tmp, "sleep-calls");
  fs.writeFileSync(sleepCalls, "");
  openclawBin = path.join(home, ".npm-global", "bin", "openclaw");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The file the route writes, byte for byte. */
function writeRequest(target: string, at: number = nowSeconds()): void {
  fs.writeFileSync(requestFile, `TARGET_EDITION=${target}\nREQUESTED_AT=${at}\n`);
}

/** Environment for a spawned driver: never process.env, so nothing leaks in. */
function driverEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return testEnv({
    PATH: process.env.PATH ?? "",
    STUB_CALLS: callsFile,
    STUB_LOCK: lockFile,
    STUB_HOME: home,
    STUB_OPENCLAW_BIN: openclawBin,
    SYSTEMCTL_CALLS: systemctlCalls,
    SLEEP_CALLS: sleepCalls,
    ...extra,
  });
}

/**
 * What `read_configured_harness_swap` makes of the file on disk: 0 with the
 * target, 1 "no request", 2 "not an edition this box can be swapped to",
 * 3 "not the plain file the route writes", 4 "stale".
 */
function readConfigured(contents: string | null): { code: number; value: string } {
  if (contents !== null) fs.writeFileSync(requestFile, contents);
  const script = [
    "set -uo pipefail",
    `PROJECT_DIR=${JSON.stringify(projectDir)}`,
    extractShellFunction("read_configured_harness_swap"),
    "out=$(read_configured_harness_swap); rc=$?",
    'printf "[%s] rc=%s" "$out" "$rc"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: driverEnv() });
  const out = (r.stdout ?? "").trim();
  return { code: Number(/rc=(\d+)/.exec(out)?.[1] ?? -1), value: out.replace(/ rc=\d+$/, "") };
}

interface StepRun {
  status: number;
  out: string;
  /** Every sub-step the stub was asked for, in order. */
  substeps: string[];
  /** The stub's record of each call, `step=… edition=… allow=… bootstrapped=… reason=…`. */
  calls: string[];
  /** The edition the stub's edition_lock wrote, or null when it never ran. */
  lock: string | null;
  requestLeft: boolean;
  /** Every `[harness-swap] phase=…` line, in order. */
  phases: string[];
  systemctl: string[];
  /** Every `sleep` the step asked for, as `sleep <seconds>`. */
  sleeps: string[];
}

/**
 * Drive step_harness_swap as a root step would run it — `set -euo pipefail`,
 * the step called bare — over the sandbox. `runuser` runs the command as this
 * user; systemctl, the gateway probes and sleep are stubs that answer what the
 * STUB_* flags say and record what they were asked.
 */
function runStep(recorded: string, extra: Record<string, string> = {}): StepRun {
  const script = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(projectDir)}`,
    `SRC_DIR=${JSON.stringify(srcDir)}`,
    `CLAWBOX_HOME=${JSON.stringify(home)}`,
    "CLAWBOX_USER=clawbox",
    `OPENCLAW_BIN=${JSON.stringify(openclawBin)}`,
    `CLAWBOX_RECORDED_EDITION=${JSON.stringify(recorded)}`,
    // install.sh initialises this at parse time; wait_for_gateway_port reads
    // it under `set -u`, and a fresh dispatch of the step starts it at 0.
    "GATEWAY_READY_SPENT=0",
    // `runuser -u clawbox -- env HOME=… cmd…` → run cmd… as this user.
    'runuser() { shift 2; [ "${1:-}" = "--" ] && shift; "$@"; }',
    "systemctl() {",
    `  printf '%s\\n' "$*" >> ${JSON.stringify(systemctlCalls)}`,
    '  if [ "${1:-}" = "is-enabled" ]; then printf \'%s\\n\' "${STUB_UNIT_ENABLED:-enabled}"; fi',
    // NRestarts climbs by one per question when STUB_RESTART_COUNTER names a
    // file — a gateway restarting under the wait. Otherwise systemctl says
    // nothing, and the wait skips its restart check.
    '  if [ "${1:-}" = "show" ] && [ -n "${STUB_RESTART_COUNTER:-}" ]; then case " $* " in *" NRestarts "*) echo "$(( $(wc -l < "$STUB_RESTART_COUNTER") ))"; echo x >> "$STUB_RESTART_COUNTER" ;; esac; fi',
    "  return 0",
    "}",
    'gateway_port_listening() { [ "${STUB_GATEWAY_LISTENING:-1}" = 1 ]; }',
    'gateway_unit_running_or_starting() { [ "${STUB_GATEWAY_TRYING:-1}" = 1 ]; }',
    `sleep() { printf 'sleep %s\\n' "$*" >> ${JSON.stringify(sleepCalls)}; }`,
    ...SWAP_FUNCTIONS.map(extractShellFunction),
    "step_harness_swap",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: driverEnv(extra) });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const calls = fs.readFileSync(callsFile, "utf-8").split("\n").filter(Boolean);
  return {
    status: r.status ?? -1,
    out,
    calls,
    substeps: calls.map((c) => /^step=(\S+)/.exec(c)?.[1] ?? ""),
    lock: fs.existsSync(lockFile) ? (/CLAWBOX_EDITION=(\S+)/.exec(fs.readFileSync(lockFile, "utf-8"))?.[1] ?? "") : null,
    requestLeft: fs.existsSync(requestFile),
    phases: (r.stdout ?? "").split("\n").filter((l) => l.startsWith("[harness-swap] phase=")),
    systemctl: fs.readFileSync(systemctlCalls, "utf-8").split("\n").filter(Boolean),
    sleeps: fs.readFileSync(sleepCalls, "utf-8").split("\n").filter(Boolean),
  };
}

/** The run as the route's journal tail sees it: trimmed, non-empty lines. */
function journal(r: StepRun): string[] {
  return r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * The sentence the owner's modal shows — the SAME pick the route makes
 * (`failureReason`: the last journal line that says "error"), so this file
 * and the route cannot disagree about which line that is.
 */
function modalSentence(r: StepRun): string {
  const line = failureReason(journal(r));
  if (!line) throw new Error(`no failure line in:\n${r.out}`);
  return line;
}

function repairLines(r: StepRun): string[] {
  return journal(r).filter((l) => l.startsWith("Repair:"));
}

/**
 * What the owner may be shown: which phase failed, the harness by the name
 * the Settings page uses, and NO path, account name or command — those are
 * an operator's and belong on the Repair line, which must never be the one
 * `failureReason` picks (so it must not say "error").
 */
function expectOwnerSentence(r: StepRun, phase: "install" | "lock" | "provision"): string {
  const line = modalSentence(r);
  expect(line).toMatch(new RegExp(`^Error: the ${phase} phase failed — `));
  expect(line).toMatch(/the (Hermes|OpenClaw) edition/);
  expect(line).not.toMatch(/\/home\/|sudo|--step|journalctl|systemctl|\bclawbox\b/);
  for (const repair of repairLines(r)) expect(repair).not.toMatch(/error/i);
  return line;
}

d("read_configured_harness_swap", () => {
  it("reads a fresh request for either single edition", () => {
    expect(readConfigured(`TARGET_EDITION=hermes\nREQUESTED_AT=${nowSeconds()}\n`))
      .toEqual({ code: 0, value: "[hermes]" });
    expect(readConfigured(`TARGET_EDITION=openclaw\nREQUESTED_AT=${nowSeconds()}\n`))
      .toEqual({ code: 0, value: "[openclaw]" });
  });

  it("answers 'no request' — not a refusal — when the box was never asked", () => {
    expect(readConfigured(null)).toEqual({ code: 1, value: "[]" });
  });

  it("takes exactly openclaw or hermes as the target, case-sensitive", () => {
    // The value becomes CLAWBOX_EDITION for a ROOT re-exec of install.sh, and
    // `dual` is a SKU with its own runtime switcher, never a swap target.
    for (const bad of ["dual", "Hermes", "HERMES", "hermes ", "", "openclaw;hermes", "../hermes"]) {
      const r = readConfigured(`TARGET_EDITION=${bad}\nREQUESTED_AT=${nowSeconds()}\n`);
      expect(r.code, JSON.stringify(bad)).toBe(2);
      expect(r.value, JSON.stringify(bad)).toBe("[]");
    }
    // A file with no target at all is not "no request": it is a file this
    // route did not write, and a step that exits 0 over it would be lying.
    expect(readConfigured("REQUESTED_AT=1\n").code).toBe(2);
  });

  it("never executes what it reads", () => {
    const marker = path.join(tmp, "pwned");
    expect(readConfigured(`TARGET_EDITION=$(touch ${marker})\nREQUESTED_AT=${nowSeconds()}\n`).value).toBe("[]");
    expect(readConfigured(`TARGET_EDITION=hermes\nREQUESTED_AT=$(touch ${marker})\n`).code).toBe(4);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses a request that is stale, from the future, or undated", () => {
    // A request is an intent with a time on it, not a standing order: one
    // that outlived a crashed web server must not swap the box on some later,
    // unrelated start of the step.
    const now = nowSeconds();
    for (const [name, contents] of [
      ["an hour and a bit old", `TARGET_EDITION=hermes\nREQUESTED_AT=${now - 3700}\n`],
      ["ten minutes in the future", `TARGET_EDITION=hermes\nREQUESTED_AT=${now + 600}\n`],
      ["undated", "TARGET_EDITION=hermes\n"],
      ["not a number", "TARGET_EDITION=hermes\nREQUESTED_AT=yesterday\n"],
      ["negative", "TARGET_EDITION=hermes\nREQUESTED_AT=-5\n"],
      ["absurdly long", `TARGET_EDITION=hermes\nREQUESTED_AT=${"9".repeat(30)}\n`],
    ] as const) {
      const r = readConfigured(contents);
      expect(r.code, name).toBe(4);
      expect(r.value, name).toBe("[]");
    }
    // Inside the window on both sides: fifty minutes old, four minutes ahead.
    expect(readConfigured(`TARGET_EDITION=hermes\nREQUESTED_AT=${now - 3000}\n`).code).toBe(0);
    expect(readConfigured(`TARGET_EDITION=hermes\nREQUESTED_AT=${now + 240}\n`).code).toBe(0);
  });

  it("REJECTS anything that is not the plain file the route writes", () => {
    // data/ is clawbox-writable and this reader runs as ROOT. `[ -f ]` follows
    // a symlink and is false for a directory and a FIFO, so every one of these
    // would otherwise read as "no request" — the one outcome the step exits 0
    // on. A FIFO would also park the grep for ever.
    const target = path.join(tmp, "elsewhere.env");
    fs.writeFileSync(target, `TARGET_EDITION=hermes\nREQUESTED_AT=${nowSeconds()}\n`);
    const shapes: [string, () => void][] = [
      ["symlink to a real file", () => fs.symlinkSync(target, requestFile)],
      ["dangling symlink", () => fs.symlinkSync(path.join(tmp, "never.env"), requestFile)],
      ["directory", () => fs.mkdirSync(requestFile)],
      ["FIFO", () => spawnSync("mkfifo", [requestFile])],
    ];
    for (const [name, plant] of shapes) {
      fs.rmSync(requestFile, { recursive: true, force: true });
      plant();
      const r = readConfigured(null);
      expect(r.code, name).toBe(3);
      expect(r.value, name).toBe("[]");
    }
  });

  it("reads the same file the route writes", () => {
    expect(extractShellFunction("read_configured_harness_swap")).toContain("data/harness-swap.env");
  });
});

d("step_harness_swap — refusals before anything is touched", () => {
  it("is a no-op, not a failure, with no request on disk", () => {
    const r = runStep("openclaw");
    expect(r.status).toBe(0);
    expect(r.substeps).toEqual([]);
    expect(r.out).toContain("No harness swap requested");
    expect(r.phases).toEqual([]);
  });

  it("refuses a dual box — it switches at runtime and has nothing to swap", () => {
    writeRequest("hermes");
    const r = runStep("dual");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/dual box switches harness at runtime/);
    expect(r.substeps).toEqual([]);
    expect(r.lock).toBeNull();
  });

  it("refuses a box with no edition lock at all", () => {
    writeRequest("hermes");
    const r = runStep("");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/no edition lock/);
    expect(r.substeps).toEqual([]);
  });

  it("removes the request and does nothing when the box already is the target", () => {
    writeRequest("openclaw");
    const r = runStep("openclaw");
    expect(r.status).toBe(0);
    expect(r.out).toContain("Already the OpenClaw edition");
    expect(r.substeps).toEqual([]);
    expect(r.requestLeft).toBe(false);
  });

  it("FAILS — never exits 0 — on a stale, planted or malformed request, and leaves it for the route", () => {
    const cases: [string, () => void, RegExp][] = [
      ["stale", () => writeRequest("hermes", nowSeconds() - 7200), /stale/],
      ["planted", () => { fs.mkdirSync(requestFile); }, /not the plain file|was refused/],
      ["not an edition", () => fs.writeFileSync(requestFile, `TARGET_EDITION=dual\nREQUESTED_AT=${nowSeconds()}\n`), /does not name an edition/],
    ];
    for (const [name, plant, said] of cases) {
      fs.rmSync(requestFile, { recursive: true, force: true });
      fs.writeFileSync(callsFile, "");
      plant();
      const r = runStep("openclaw");
      expect(r.status, name).not.toBe(0);
      expect(r.out, name).toMatch(said);
      expect(r.substeps, name).toEqual([]);
      expect(r.requestLeft, name).toBe(true);
    }
  });
});

d("step_harness_swap — openclaw → hermes", () => {
  it("installs, proves, locks, provisions, and announces every phase exactly once", () => {
    writeRequest("hermes");
    const r = runStep("openclaw");

    expect(r.status, r.out).toBe(0);
    expect(r.substeps).toEqual(["hermes_install", "edition_lock", "hermes_edition"]);
    expect(r.phases).toEqual([
      "[harness-swap] phase=request",
      "[harness-swap] phase=install",
      "[harness-swap] phase=lock",
      "[harness-swap] phase=provision",
      "[harness-swap] phase=done",
    ]);
    expect(r.lock).toBe("hermes");
    expect(r.requestLeft).toBe(false);
    // Both dashboard units were asked for their state, by name.
    expect(r.systemctl).toContain("is-enabled clawbox-hermes-dashboard.service");
    expect(r.systemctl).toContain("is-enabled clawbox-hermes-dashboard-proxy.service");
    // The harness by the name the Settings page uses: these lines are drawn in
    // the same modal as the route's own "Hermes"/"OpenClaw" sentences.
    expect(r.out).toContain("Swapping this box from the OpenClaw edition to Hermes");
    expect(r.out).toContain("This box is now the Hermes edition");
  });

  it("re-execs every sub-step AS THE TARGET, pinned, with the change allowed and the reason named", () => {
    // The edition globals — the predicates, the service lists,
    // FOREIGN_EDITION_UNITS — are computed at parse time, so only a fresh
    // parse as the target can tear the RIGHT harness down; the pin keeps a
    // swap from fetching or resetting the tree; the reason is what turns the
    // top-level "finish by hand" paragraph into one honest journal line.
    writeRequest("hermes");
    const r = runStep("openclaw");
    expect(r.calls.length).toBe(3);
    for (const call of r.calls) {
      expect(call).toContain(" edition=hermes ");
      expect(call).toContain(" allow=1 ");
      expect(call).toContain(" bootstrapped=1 ");
      expect(call).toMatch(/ reason=harness swap in progress \(install\.sh --step harness_swap\)$/);
    }
  });

  it("re-execs the copy of install.sh root is already running, never the tree", () => {
    // $SRC_DIR is the root-owned mirror on a dispatched step; $PROJECT_DIR is
    // the clawbox-writable checkout. docs/root-exec-mirror.md.
    const fn = extractShellFunction("harness_swap_substep");
    expect(fn).toContain('bash "$SRC_DIR/install.sh" --step "$name"');
    expect(fn).not.toContain("$PROJECT_DIR/install.sh");
  });

  it("leaves the lock UNTOUCHED when the install step itself fails", () => {
    writeRequest("hermes");
    const r = runStep("openclaw", { STUB_FAIL_STEPS: "hermes_install" });

    expect(r.status).not.toBe(0);
    expect(r.substeps).toEqual(["hermes_install"]);
    expect(r.lock).toBeNull();
    const line = expectOwnerSentence(r, "install");
    expect(line).toMatch(/still the OpenClaw edition and nothing was changed/);
    expect(r.requestLeft).toBe(true);
    expect(r.phases).toEqual(["[harness-swap] phase=request", "[harness-swap] phase=install"]);
  });

  it("leaves the lock UNTOUCHED when the install 'succeeded' but Hermes does not run — and says why", () => {
    // THE RULE. step_hermes_install is non-fatal by design (a box with no
    // network must not lose the agent it has), so its exit 0 proves nothing:
    // the proof is the swap's own, and an unrunnable Hermes has to stop the
    // swap with the box still a working OpenClaw box. Three ways to not run:
    // nothing laid down, the shim without its interpreter, a shim that fails
    // — and each puts ITS reason on the sentence, the launcher's own last
    // stderr line for the third, because a probe that discarded stderr left
    // the owner a red modal with no reason on it.
    const reasons: Record<string, RegExp> = {
      nothing: /its launcher is missing/,
      no_venv: /its Python environment is missing/,
      broken_shim: /its launcher does not start: ModuleNotFoundError: No module named hermes_cli/,
    };
    for (const shape of Object.keys(reasons)) {
      fs.rmSync(home, { recursive: true, force: true });
      fs.mkdirSync(home);
      fs.rmSync(lockFile, { force: true });
      fs.writeFileSync(callsFile, "");
      writeRequest("hermes");

      const r = runStep("openclaw", { STUB_HERMES_INSTALL: shape });

      expect(r.status, shape).not.toBe(0);
      expect(r.substeps, shape).toEqual(["hermes_install"]);
      expect(r.lock, `${shape}: the lock flipped over a Hermes that does not run`).toBeNull();
      const line = expectOwnerSentence(r, "install");
      expect(line, shape).toMatch(/Hermes does not run on this box after its install step/);
      expect(line, shape).toMatch(reasons[shape]);
      expect(line, shape).toMatch(/still the OpenClaw edition and nothing was changed/);
      expect(r.requestLeft, shape).toBe(true);
    }
    // The whole of what the launcher said is in the journal too, ahead of the
    // sentence so that a line of its own is never the one the modal picks.
    const r = runStep("openclaw", { STUB_HERMES_INSTALL: "broken_shim" });
    expect(r.out).toContain("| Traceback (most recent call last):");
    expect(r.out.indexOf("| Traceback")).toBeLessThan(r.out.indexOf("Error: the install phase failed"));
  });

  it("names the lock phase when the lock step fails, and repairs the lock BEFORE the provisioning", () => {
    // step_edition_lock can only fail at the lock or drop-in write itself, so
    // the lock may still say openclaw — and run that way, `--step
    // hermes_edition` exits clean having provisioned nothing. The repair has
    // to re-bake the lock as the target first.
    writeRequest("hermes");
    const r = runStep("openclaw", { STUB_FAIL_STEPS: "edition_lock" });

    expect(r.status).not.toBe(0);
    expect(r.substeps).toEqual(["hermes_install", "edition_lock"]);
    const line = expectOwnerSentence(r, "lock");
    expect(line).toMatch(/may now be the Hermes edition/);
    const [repair] = repairLines(r);
    expect(repair).toBeDefined();
    expect(repair.indexOf("--step edition_lock")).toBeGreaterThan(-1);
    expect(repair.indexOf("--step edition_lock")).toBeLessThan(repair.indexOf("--step hermes_edition"));
    expect(repair).toContain("CLAWBOX_EDITION=hermes CLAWBOX_ALLOW_EDITION_CHANGE=1");
    expect(r.phases).not.toContain("[harness-swap] phase=provision");
    expect(r.requestLeft).toBe(true);
  });

  it("says plainly which phase failed after the lock flipped, and what the box now is — with the repair on its own line", () => {
    writeRequest("hermes");
    const r = runStep("openclaw", { STUB_FAIL_STEPS: "hermes_edition" });

    expect(r.status).not.toBe(0);
    expect(r.substeps).toEqual(["hermes_install", "edition_lock", "hermes_edition"]);
    expect(r.lock).toBe("hermes");
    const line = expectOwnerSentence(r, "provision");
    expect(line).toMatch(/Hermes provisioning step did not finish/);
    expect(line).toMatch(/now the Hermes edition without a working dashboard/);
    // The operator's half — path, sudo, step — is in the journal on the
    // Repair line, which failureReason never picks.
    expect(repairLines(r)).toEqual([`Repair: sudo bash ${projectDir}/install.sh --step hermes_edition`]);
    expect(r.phases).not.toContain("[harness-swap] phase=done");
    // The request stays: it is how a failed swap remains tellable from a
    // finished one, and its deletion is the route's.
    expect(r.requestLeft).toBe(true);
  });

  it("does not report done over a dashboard that provisioning left disabled", () => {
    writeRequest("hermes");
    const r = runStep("openclaw", { STUB_UNIT_ENABLED: "disabled" });

    expect(r.status).not.toBe(0);
    const line = expectOwnerSentence(r, "provision");
    expect(line).toMatch(/the Hermes dashboard is not enabled after provisioning/);
    expect(line).toMatch(/now the Hermes edition with its dashboard not enabled/);
    expect(repairLines(r)).toEqual(["Repair: sudo systemctl enable --now clawbox-hermes-dashboard.service"]);
    expect(r.phases).not.toContain("[harness-swap] phase=done");
    expect(r.requestLeft).toBe(true);
  });
});

d("step_harness_swap — hermes → openclaw", () => {
  it("installs, proves, locks, sets the gateway up, patches, and waits for the listener", () => {
    writeRequest("openclaw");
    const r = runStep("hermes");

    expect(r.status, r.out).toBe(0);
    expect(r.substeps).toEqual(["openclaw_install", "edition_lock", "gateway_setup", "openclaw_patch"]);
    for (const call of r.calls) {
      expect(call).toContain(" edition=openclaw ");
      expect(call).toContain(" allow=1 ");
      expect(call).toContain(" bootstrapped=1 ");
    }
    expect(r.phases).toEqual([
      "[harness-swap] phase=request",
      "[harness-swap] phase=install",
      "[harness-swap] phase=lock",
      "[harness-swap] phase=provision",
      "[harness-swap] phase=done",
    ]);
    expect(r.lock).toBe("openclaw");
    expect(r.requestLeft).toBe(false);
    expect(r.out).toContain("This box is now the OpenClaw edition");
  });

  it("never runs openclaw_config — the owner's openclaw.json is not the swap's to re-seed", () => {
    writeRequest("openclaw");
    const r = runStep("hermes");
    expect(r.substeps).not.toContain("openclaw_config");
    expect(extractShellFunction("harness_swap_to_openclaw")).not.toContain("openclaw_config ");
  });

  it("leaves the lock UNTOUCHED when OpenClaw does not run after its install step — and says why", () => {
    const reasons: Record<string, RegExp> = {
      nothing: /its command is missing/,
      broken: /its command does not answer --version: env: node: No such file or directory/,
    };
    for (const shape of Object.keys(reasons)) {
      fs.rmSync(lockFile, { force: true });
      fs.rmSync(openclawBin, { force: true });
      fs.writeFileSync(callsFile, "");
      writeRequest("openclaw");

      const r = runStep("hermes", { STUB_OPENCLAW_INSTALL: shape });

      expect(r.status, shape).not.toBe(0);
      expect(r.substeps, shape).toEqual(["openclaw_install"]);
      expect(r.lock, shape).toBeNull();
      const line = expectOwnerSentence(r, "install");
      expect(line, shape).toMatch(/OpenClaw does not run on this box after its install step/);
      expect(line, shape).toMatch(reasons[shape]);
      expect(line, shape).toMatch(/still the Hermes edition and nothing was changed/);
    }
  });

  it("repairs a failed lock step by re-baking the lock as openclaw BEFORE gateway_setup", () => {
    // Run as the recorded (hermes) edition, `--step gateway_setup` copies the
    // unit into the mask at /dev/null — the case step_edition_gateway_state's
    // own comment warns about.
    writeRequest("openclaw");
    const r = runStep("hermes", { STUB_FAIL_STEPS: "edition_lock" });

    expect(r.status).not.toBe(0);
    const line = expectOwnerSentence(r, "lock");
    expect(line).toMatch(/may now be the OpenClaw edition/);
    const [repair] = repairLines(r);
    expect(repair).toContain("CLAWBOX_EDITION=openclaw CLAWBOX_ALLOW_EDITION_CHANGE=1");
    expect(repair.indexOf("--step edition_lock")).toBeGreaterThan(-1);
    expect(repair.indexOf("--step edition_lock")).toBeLessThan(repair.indexOf("--step gateway_setup"));
    expect(r.requestLeft).toBe(true);
  });

  it("waits for the listener with the box's OWN budget — 180 s in 3 s polls — and fails the swap when it never comes", () => {
    // The listener arrives long after systemd says the unit started: 14 s
    // after `Started` behind an ExecStartPre measured at 31, 86 and 120 s
    // (install.sh, 2026-09-06), during which the unit is `activating`. A
    // private 60 s loop reported the slower half of the box's own starts as a
    // failed swap — lock flipped, carry-over skipped — over a gateway that
    // listened a minute later, so the wait is wait_for_gateway_port's. A
    // gateway that never listens is still a failed swap, said as such.
    writeRequest("openclaw");
    const r = runStep("hermes", { STUB_GATEWAY_LISTENING: "0" });

    expect(r.status).not.toBe(0);
    expect(r.sleeps).toHaveLength(60);
    expect(new Set(r.sleeps)).toEqual(new Set(["sleep 3"]));
    const line = expectOwnerSentence(r, "provision");
    expect(line).toMatch(/gateway did not start listening on port 18789/);
    expect(line).toMatch(/longer than 180 s/);
    expect(line).toMatch(/now the OpenClaw edition with its gateway down/);
    expect(repairLines(r)).toEqual(["Repair: journalctl -u clawbox-gateway.service"]);
    expect(r.phases).not.toContain("[harness-swap] phase=done");
    expect(r.requestLeft).toBe(true);

    // The budget is the shared one, so the operator's override reaches it.
    fs.writeFileSync(sleepCalls, "");
    fs.writeFileSync(callsFile, "");
    writeRequest("openclaw");
    const short = runStep("hermes", { STUB_GATEWAY_LISTENING: "0", CLAWBOX_GATEWAY_READY_BUDGET_S: "9" });
    expect(short.sleeps).toHaveLength(3);
    expect(modalSentence(short)).toMatch(/longer than 9 s/);
  });

  it("gives up at once on a gateway that RESTARTS while it waits — looping is not starting", () => {
    // Under Restart=always a crash loop spends its time `activating`, which a
    // state check alone reads as "still starting" and burns the whole budget
    // over. The private loop had no restart check; the box's wait does.
    const counter = path.join(tmp, "restarts");
    fs.writeFileSync(counter, "");
    writeRequest("openclaw");
    const r = runStep("hermes", { STUB_GATEWAY_LISTENING: "0", STUB_RESTART_COUNTER: counter });

    expect(r.status).not.toBe(0);
    expect(r.sleeps).toEqual(["sleep 3"]);
    expect(r.out).toMatch(/looping, not starting/);
    expect(expectOwnerSentence(r, "provision")).toMatch(/gateway did not start listening/);
  });

  it("stops waiting the moment the gateway unit stops trying", () => {
    writeRequest("openclaw");
    const r = runStep("hermes", { STUB_GATEWAY_LISTENING: "0", STUB_GATEWAY_TRYING: "0" });
    expect(r.status).not.toBe(0);
    expect(r.sleeps).toEqual([]);
  });

  it("has no gateway wait of its own", () => {
    expect(extractShellFunction("harness_swap_to_openclaw")).toContain("wait_for_gateway_port");
    expect(INSTALL_SH).not.toContain("harness_swap_gateway_answers");
  });
});

d("the top-level edition block, re-entered by the swap", () => {
  // The child install.sh the swap re-execs meets the recorded≠requested
  // refusal with CLAWBOX_ALLOW_EDITION_CHANGE=1. That path prints a paragraph
  // written for an operator — "finish the transition by hand", "no usable
  // model" — which is untrue during a swap and lands in the one journal the
  // owner is watching. Driven like install-edition-switch-refusal.test.ts:
  // the shipped text with its two absolute paths rewritten into the sandbox.
  const BLOCK = slice('CLAWBOX_EDITION_FILE="/etc/clawbox/edition.env"', "# The Hermes SKU: Hermes is the ONLY harness");

  function runBlock(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
    const lockPath = path.join(tmp, "edition.env");
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=hermes\n");
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(projectDir)}`,
      'SRC_DIR="$PROJECT_DIR"',
      BLOCK.replace('"/etc/clawbox/edition.env"', JSON.stringify(lockPath)).replace(
        '"/etc/systemd/system/clawbox-setup.service.d/edition.conf"',
        JSON.stringify(path.join(tmp, "edition.conf")),
      ),
      'printf "RESOLVED=%s\\n" "$CLAWBOX_EDITION"',
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV, ...env },
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("says one honest line when the swap is the caller", () => {
    const r = runBlock({
      CLAWBOX_EDITION: "openclaw",
      CLAWBOX_ALLOW_EDITION_CHANGE: "1",
      CLAWBOX_EDITION_CHANGE_REASON: "harness swap in progress (install.sh --step harness_swap)",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RESOLVED=openclaw");
    expect(r.stderr).toContain("[edition] installing 'openclaw' over 'hermes'");
    expect(r.stderr).toContain("harness swap in progress");
    expect(r.stderr).not.toContain("finish the transition by hand");
    expect(r.stderr).not.toContain("no usable model");
  });

  it("keeps the operator's paragraph for an operator", () => {
    const r = runBlock({ CLAWBOX_EDITION: "openclaw", CLAWBOX_ALLOW_EDITION_CHANGE: "1" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("WARNING");
    expect(r.stderr).toContain("finish the transition by hand");
  });

  it("is still a hard refusal without the allow flag, reason or no reason", () => {
    const r = runBlock({
      CLAWBOX_EDITION: "openclaw",
      CLAWBOX_EDITION_CHANGE_REASON: "harness swap in progress (install.sh --step harness_swap)",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already installed as the 'hermes' edition");
  });
});

describe("harness_swap on the allow-lists", () => {
  it("is dispatchable by install.sh and permitted by the root dispatcher", () => {
    expect(bashArray("DISPATCH_STEPS")).toContain("harness_swap");
    expect(shellList(DISPATCHER, "ALLOWED_STEPS")).toContain("harness_swap");
    expect(INSTALL_SH).toContain("\nstep_harness_swap() {");
  });

  it("is startable by the web server, in both copies of that list", () => {
    expect(shellList(LAUNCHER, "WEB_ROOT_STEPS")).toContain("harness_swap");
    expect(WEB_ROOT_STEPS).toContain("harness_swap");
  });

  it("is NOT a UI step — install/run-step is reachable by the agent's bearer", () => {
    expect(UI_ROOT_STEPS).not.toContain("harness_swap");
  });

  it("is NOT self-updating — a swap must not fetch or reset the tree", () => {
    expect(SELF_UPDATING_ROOT_STEPS).not.toContain("harness_swap");
    expect(shellList(DISPATCHER, "SELF_UPDATING_STEPS")).not.toContain("harness_swap");
  });
});
