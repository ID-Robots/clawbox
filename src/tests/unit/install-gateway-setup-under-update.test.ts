import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A real bash per case: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The in-app update's own "Configuring gateway service" step restarted a
 * gateway that was already running. Every appliance update stops that gateway
 * again before its last step (the build pause on a box under 12 GB,
 * post_update's quiesce on every box) and gateway_verify starts it on the
 * updated core, patches, unit and pre-start, so the restart was a whole
 * gateway start thrown away a minute later: 35-65 s of chat down and about
 * 126 CPU-seconds per update on an 8 GB board.
 *
 * Inside that step only (the updater dispatching `--step gateway_setup` while
 * it holds the box) a gateway systemd calls `active` or `reloading` is left as
 * it is. Every other state, and every other way into step_gateway_setup
 * (post_update's own call, a harness swap or edition choice, a hand-run step,
 * a full install), restarts exactly as before. This drives the shipped
 * functions under bash to hold that.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

/** The function `name` cut out of install.sh, or "" when it is not there. */
function shellFunctionIfPresent(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) return "";
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return `${INSTALL_SH.slice(start + 1, end)}\n}`;
}

/** The function `name`, failing the test (not crashing the file) when it is missing. */
function shellFunction(name: string): string {
  const fn = shellFunctionIfPresent(name);
  expect(fn, `${name} is defined in install.sh`).not.toBe("");
  return fn;
}

const UNIT = "clawbox-gateway.service";
const RESTART = `systemctl restart ${UNIT}`;
const RESET_FAILED = `systemctl reset-failed ${UNIT}`;
const LEAVING = "Leaving the running clawbox-gateway.service as it is";

type Box = { dir: string; calls: () => string[]; cleanup: () => void };

/**
 * A temp box: data/config.json (the update lock) as given, and the answers
 * `systemctl is-active` gives, one per ask (the last repeats; "" is a query
 * that answered nothing).
 */
function makeBox(opts: { lock?: unknown; states: string[] }): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-gateway-setup-"));
  mkdirSync(path.join(dir, "data"), { recursive: true });
  writeFileSync(path.join(dir, "calls"), "");
  writeFileSync(path.join(dir, "asks"), "");
  writeFileSync(path.join(dir, "states"), opts.states.map((s) => `${s}\n`).join(""));
  if (opts.lock !== undefined) {
    writeFileSync(
      path.join(dir, "data", "config.json"),
      typeof opts.lock === "string" ? opts.lock : JSON.stringify(opts.lock),
    );
  }
  return {
    dir,
    calls: () => readFileSync(path.join(dir, "calls"), "utf-8").split("\n").filter(Boolean),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * The shell every case runs in: errexit on, the box's PROJECT_DIR, and
 * `systemctl` and `sudo` as recording FUNCTIONS (they reach into `$(...)` too,
 * so nothing here can touch the machine's own systemd).
 */
function prelude(box: Box, dispatched: string | undefined): string[] {
  const q = (p: string) => JSON.stringify(path.join(box.dir, p));
  return [
    "set -euo pipefail",
    dispatched === undefined ? "unset CLAWBOX_DISPATCHED_STEP" : `CLAWBOX_DISPATCHED_STEP=${JSON.stringify(dispatched)}`,
    `PROJECT_DIR=${JSON.stringify(box.dir)}`,
    "systemctl() {",
    `  printf 'systemctl %s\\n' "$*" >> ${q("calls")}`,
    '  if [ "${1:-}" = is-active ]; then',
    "    local n s",
    `    n=$(wc -l < ${q("asks")})`,
    `    echo x >> ${q("asks")}`,
    `    s=$(sed -n "$((n + 1))p" ${q("states")})`,
    `    [ -n "$s" ] || [ "$(wc -l < ${q("states")})" -gt "$n" ] || s=$(tail -n 1 ${q("states")})`,
    '    [ -n "$s" ] || return 1',
    '    echo "$s"',
    '    case "$s" in active|reloading) return 0 ;; *) return 3 ;; esac',
    "  fi",
    "  return 0",
    "}",
    `sudo() { printf 'sudo %s\\n' "$*" >> ${q("calls")}; }`,
  ];
}

function run(program: string[]) {
  return spawnSync("bash", ["-c", program.join("\n")], { encoding: "utf-8", timeout: 20_000 });
}

const LOCKED = { update_in_progress: true, update_lock_holder: { pid: 1 } };

describe("gateway_setup_restart_wanted", () => {
  function ask(box: Box, dispatched: string | undefined) {
    const program = [
      ...prelude(box, dispatched),
      shellFunction("update_owns_the_box"),
      shellFunction("gateway_setup_restart_wanted"),
      'word="$(gateway_setup_restart_wanted)"',
      'printf "WORD=%s\\n" "$word"',
    ];
    const r = run(program);
    expect(r.status, r.stderr).toBe(0);
    const word = /^WORD=(.*)$/m.exec(r.stdout)?.[1];
    return { word, asks: box.calls().filter((c) => c.startsWith("systemctl is-active")) };
  }

  it.each<[string, string[], number]>([
    ["active", ["active"], 1],
    ["reloading", ["reloading"], 1],
    ["an empty answer, then active", ["", "active"], 2],
  ])("leaves a running gateway inside the update's own step: %s", (_name, states, asked) => {
    const box = makeBox({ lock: LOCKED, states });
    try {
      const { word, asks } = ask(box, "gateway_setup");
      expect(word).toBe("leave");
      expect(asks).toEqual(Array(asked).fill(`systemctl is-active ${UNIT}`));
    } finally {
      box.cleanup();
    }
  });

  it.each<[string, string[]]>([
    // A start in progress, and a unit waiting in auto-restart after a crash:
    // systemd says `activating` for both, so both keep reset-failed + restart.
    ["activating", ["activating"]],
    ["inactive (openclaw_install's full path left it stopped)", ["inactive"]],
    ["failed", ["failed"]],
    ["deactivating", ["deactivating"]],
    ["no answer, asked twice", ["", ""]],
  ])("restarts inside the update's own step when the gateway is %s", (_name, states) => {
    const box = makeBox({ lock: LOCKED, states });
    try {
      const { word, asks } = ask(box, "gateway_setup");
      expect(word).toBe("restart");
      expect(asks.length).toBe(states[0] === "" ? 2 : 1);
    } finally {
      box.cleanup();
    }
  });

  it.each<[string, string | undefined, unknown]>([
    ["no update in flight", "gateway_setup", { update_in_progress: false }],
    ["no store", "gateway_setup", undefined],
    ["a store it cannot read", "gateway_setup", "not json"],
    ["post_update's own call, with the lock held", "post_update", LOCKED],
    ["not dispatched (a full install), with the lock held", undefined, LOCKED],
  ])("restarts, without asking systemd, on %s", (_name, dispatched, lock) => {
    const box = makeBox({ lock, states: ["active"] });
    try {
      const { word, asks } = ask(box, dispatched);
      expect(word).toBe("restart");
      expect(asks).toEqual([]);
    } finally {
      box.cleanup();
    }
  });
});

describe("step_gateway_setup inside an in-app update", () => {
  // The whole step, with every unit path moved into the box the way
  // install-home-writes-as-account.test.ts does. No user-level unit exists, so
  // the mask block is skipped.
  function gatewaySetup(box: Box, dispatched: string | undefined) {
    const etc = path.join(box.dir, "etc-systemd");
    const src = path.join(box.dir, "src");
    mkdirSync(path.join(src, "config"), { recursive: true });
    mkdirSync(etc, { recursive: true });
    writeFileSync(path.join(src, "config", "clawbox-gateway.service"), "[Service]\n");
    const step = shellFunction("step_gateway_setup");
    expect(step.split("/etc/systemd/system").length - 1, "step_gateway_setup's unit paths").toBe(3);
    const program = [
      ...prelude(box, dispatched),
      `SRC_DIR=${JSON.stringify(src)}`,
      `CLAWBOX_HOME=${JSON.stringify(path.join(box.dir, "home"))}`,
      'CLAWBOX_USER="$(id -un)"',
      "is_hermes_edition() { return 1; }",
      "is_unselected_edition() { return 1; }",
      shellFunction("update_owns_the_box"),
      // Optional so that unmodified beta runs the step and fails on what it
      // DOES (the restart), not on a missing name.
      shellFunctionIfPresent("gateway_setup_restart_wanted"),
      step.split("/etc/systemd/system").join(etc),
      "step_gateway_setup",
      'echo "RC=0"',
    ];
    const r = run(program);
    return { ...r, calls: box.calls() };
  }

  it("leaves an active gateway running: no reset-failed, no restart, one line, RC=0", () => {
    const box = makeBox({ lock: LOCKED, states: ["active"] });
    try {
      const r = gatewaySetup(box, "gateway_setup");
      expect(r.stdout, r.stderr).toContain("RC=0");
      // The unit is still copied, reloaded and enabled; asked once; never
      // reset-failed or restarted.
      expect(r.calls).toEqual([
        "systemctl daemon-reload",
        `systemctl enable ${UNIT}`,
        `systemctl is-active ${UNIT}`,
      ]);
      expect(r.stdout).toContain(LEAVING);
    } finally {
      box.cleanup();
    }
  });

  it.each<[string, string | undefined, unknown, string]>([
    ["the lock held but the gateway inactive", "gateway_setup", LOCKED, "inactive"],
    ["an active gateway but no update in flight", "gateway_setup", { update_in_progress: false }, "active"],
    ["post_update's own call, lock held and gateway active", "post_update", LOCKED, "active"],
    ["a full install (not dispatched), lock held and gateway active", undefined, LOCKED, "active"],
  ])("restarts as before with %s", (_name, dispatched, lock, state) => {
    const box = makeBox({ lock, states: [state] });
    try {
      const r = gatewaySetup(box, dispatched);
      expect(r.stdout, r.stderr).toContain("RC=0");
      expect(r.stdout).not.toContain(LEAVING);
      const reset = r.calls.indexOf(RESET_FAILED);
      expect(reset).toBeGreaterThan(-1);
      expect(r.calls.indexOf(RESTART)).toBeGreaterThan(reset);
    } finally {
      box.cleanup();
    }
  });

  it("asks after enabling the unit and returns before reset-failed and the restart", () => {
    const step = shellFunction("step_gateway_setup");
    const enable = step.indexOf(`systemctl enable ${UNIT}`);
    const asked = step.indexOf("gateway_setup_restart_wanted");
    const reset = step.indexOf(`systemctl reset-failed ${UNIT} 2>/dev/null || true`);
    const restart = step.indexOf(`\n  ${RESTART}\n`);
    expect(enable).toBeGreaterThan(-1);
    expect(asked).toBeGreaterThan(enable);
    expect(reset).toBeGreaterThan(asked);
    expect(restart).toBeGreaterThan(reset);
    const leaveArm = step.slice(asked, reset);
    expect(leaveArm).toContain(LEAVING);
    expect(leaveArm).toMatch(/\n\s+return 0\n/);
  });
});
