import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The owner's switch for Hermes' built-in `computer_use` toolset, shipped
 * DORMANT: the Settings control and its route exist only while
 * CLAWBOX_COMPUTER_USE_SETTING=1, and a device store without the key behaves
 * exactly as before the switch existed — register-mcp.sh issues no
 * computer_use call at all, so a Hermes box keeps the toolset it ships with.
 * Only a stored boolean is a decision, and register-mcp.sh applies it on every
 * boot through Hermes' own `hermes tools enable|disable computer_use`.
 */

// Imported per test rather than at the top, so the script half of this file
// still runs (and says what it says) on a tree without the module.
const load = () => import("@/lib/computer-use-switch");

describe("computer-use-switch — the flag", () => {
  it("is off by default", async () => {
    const { computerUseSettingEnabled } = await load();
    expect(computerUseSettingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is on only for exactly 1", async () => {
    const { computerUseSettingEnabled } = await load();
    const flag = (v: string) => ({ CLAWBOX_COMPUTER_USE_SETTING: v }) as unknown as NodeJS.ProcessEnv;
    expect(computerUseSettingEnabled(flag("1"))).toBe(true);
    expect(computerUseSettingEnabled(flag(" 1 "))).toBe(true);
    for (const v of ["", "0", "true", "yes", "on", "2"]) {
      expect(computerUseSettingEnabled(flag(v)), v).toBe(false);
    }
  });
});

describe("computer-use-switch — the stored key", () => {
  it("reads a boolean as on/off", async () => {
    const { readComputerUseSwitch } = await load();
    expect(readComputerUseSwitch({ clawbox_computer_use: false })).toBe("off");
    expect(readComputerUseSwitch({ clawbox_computer_use: true })).toBe("on");
  });

  it("reads anything else as unmanaged — today's behaviour", async () => {
    const { readComputerUseSwitch } = await load();
    expect(readComputerUseSwitch({})).toBe("unmanaged");
    expect(readComputerUseSwitch(null)).toBe("unmanaged");
    expect(readComputerUseSwitch([false])).toBe("unmanaged");
    for (const v of ["false", "true", 0, 1, null, {}]) {
      expect(readComputerUseSwitch({ clawbox_computer_use: v }), JSON.stringify(v)).toBe("unmanaged");
    }
  });

  it("drops computer_use from a -t list only when the switch is off", async () => {
    const { withoutComputerUse } = await load();
    const list = ["web", "computer_use", "file"];
    expect(withoutComputerUse(list, "off")).toEqual(["web", "file"]);
    expect(withoutComputerUse(list, "on")).toEqual(list);
    expect(withoutComputerUse(list, "unmanaged")).toEqual(list);
  });
});

// ── register-mcp.sh §4: the boot-time apply ────────────────────────────────
const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "register-mcp.sh");
const SCRIPT_SRC = fs.readFileSync(SCRIPT, "utf-8");

function have(bin: string, args: string[]): boolean {
  return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}

const CAN_RUN =
  process.platform !== "win32"
  && have("bash", ["-c", "true"])
  && have("python3", ["-c", "import yaml"]);

const d = CAN_RUN ? describe : describe.skip;

let home: string;
let root: string;
let callsLog: string;

/** A `hermes` that records every argv, and refuses `tools <verb> computer_use` on request. */
function writeHermesStub(refuseComputerUse = false) {
  const bin = path.join(home, "fake-hermes");
  fs.writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$HERMES_CALLS"',
      ...(refuseComputerUse ? ['[ "$1" = tools ] && [ "$3" = computer_use ] && exit 3'] : []),
      "exit 0",
    ].join("\n"),
  );
  fs.chmodSync(bin, 0o755);
}

function run(store: Record<string, unknown> | null): { status: number; stdout: string; calls: string } {
  if (store) fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(store));
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAWBOX_ROOT: root,
      HERMES_CONFIG: path.join(home, ".hermes", "config.yaml"),
      HERMES_BIN: path.join(home, "fake-hermes"),
      BUN_BIN: path.join(home, "fake-bun"),
      CLAWBOX_EDITION_FILE: path.join(home, "edition.env"),
      HERMES_CALLS: callsLog,
    }),
  });
  const calls = fs.existsSync(callsLog) ? fs.readFileSync(callsLog, "utf-8") : "";
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? ""), calls };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-cu-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-cu-root-"));
  callsLog = path.join(home, "calls.log");
  fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(path.join(home, ".hermes", "config.yaml"), "model:\n  default: deepseek-v4-pro\n");
  fs.writeFileSync(path.join(home, "edition.env"), "CLAWBOX_EDITION=hermes\n");
  fs.writeFileSync(path.join(home, "fake-bun"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(home, "fake-bun"), 0o755);
  writeHermesStub();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

d("register-mcp.sh — the computer_use switch", () => {
  it("switched off: disables the toolset through Hermes' own CLI", () => {
    const r = run({ clawbox_computer_use: false });
    expect(r.status, r.stdout).toBe(0);
    expect(r.calls).toContain("tools disable computer_use");
    expect(r.calls).not.toContain("tools enable computer_use");
    expect(r.stdout).toContain("computer_use toolset off (Settings switch)");
  });

  it("switched on: enables it", () => {
    const r = run({ clawbox_computer_use: true });
    expect(r.status, r.stdout).toBe(0);
    expect(r.calls).toContain("tools enable computer_use");
    expect(r.calls).not.toContain("tools disable computer_use");
    expect(r.stdout).toContain("computer_use toolset on (Settings switch)");
  });

  it("key absent: no computer_use call at all — today's behaviour", () => {
    const r = run({ clawbox_mcp_enabled: true });
    expect(r.status, r.stdout).toBe(0);
    // The browser step still ran, so the stub was reached and the log is real.
    expect(r.calls).toContain("tools disable browser");
    expect(r.calls).not.toMatch(/computer_use/);
  });

  it("no device store, or a non-boolean key: no call either", () => {
    expect(run(null).calls).not.toMatch(/computer_use/);
    fs.rmSync(callsLog, { force: true });
    expect(run({ clawbox_computer_use: "false" }).calls).not.toMatch(/computer_use/);
    fs.writeFileSync(path.join(root, "data", "config.json"), "{not json");
    fs.rmSync(callsLog, { force: true });
    expect(run(null).calls).not.toMatch(/computer_use/);
  });

  it("a refusal is logged with its exit status and never fails the boot", () => {
    writeHermesStub(true);
    const r = run({ clawbox_computer_use: false });
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("could not switch the computer_use toolset off (exit 3)");
    expect(r.stdout).not.toContain("computer_use toolset off (Settings switch)");
  });

  it("runs inside the config lock, after the browser step and before the opt-out read-back", () => {
    const lock = SCRIPT_SRC.search(/^acquire_config_lock[ \t]*$/m);
    const browser = SCRIPT_SRC.search(/^.*"\$HERMES_BIN" tools disable browser/m);
    const enable = SCRIPT_SRC.search(/^.*"\$HERMES_BIN" tools enable computer_use/m);
    const disable = SCRIPT_SRC.search(/^.*"\$HERMES_BIN" tools disable computer_use/m);
    const optoutSeed = SCRIPT_SRC.search(/^CLAWBOX_OPTOUT_STATE=/m);
    for (const [name, at] of Object.entries({ lock, browser, enable, disable, optoutSeed })) {
      expect(at, `register-mcp.sh: marker ${name} not found`).toBeGreaterThan(-1);
    }
    expect(lock).toBeLessThan(browser);
    for (const cu of [enable, disable]) {
      expect(browser).toBeLessThan(cu);
      expect(cu).toBeLessThan(optoutSeed);
    }
    // Both verbs are LITERAL, so the harness-contract scan checks each against
    // the pinned Hermes CLI, and both are bounded with a SIGKILL grace.
    for (const verb of ["enable", "disable"]) {
      expect(SCRIPT_SRC).toContain(`timeout -k 5 "$HERMES_CLI_TIMEOUT" "$HERMES_BIN" tools ${verb} computer_use >/dev/null 2>&1`);
    }
  });
});
