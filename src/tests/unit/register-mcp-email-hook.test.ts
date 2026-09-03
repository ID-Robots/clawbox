import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

// The boot reconcile that puts ClawBox's outbound `EMAIL:`-directive hook into
// the Hermes agent, and then checks that it actually loaded.
//
// It lives in register-mcp.sh — not in the ClawBox-AI link path where the image
// backend is installed — for two reasons the card spelled out: every Hermes box
// needs this one, linked or not; and a factory reset wipes ~/.hermes bar
// `hermes-agent` and `bin`, so only something that runs on every web-server
// boot can put it back.
//
// The three failure shapes this pins are the three this codebase keeps
// producing:
//
//   probe-once    — installed once and never checked again. The doctor call
//                   runs on EVERY boot, like the browser-toolset disable.
//   false success — `hermes plugins list` says "enabled" for a plugin that
//                   raises on import: its status is read back out of the config
//                   it was just written into (plugins_cmd.py:1931). The guard
//                   is `plugins doctor`, which really imports it.
//   false failure — none of this may ever stop the web server or the MCP
//                   registration; a broken hook is a warning, not an abort.

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "register-mcp.sh");
const PLUGIN = "clawbox_email_directives";

function have(bin: string, args: string[]): boolean {
  return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}

const CAN_RUN =
  process.platform !== "win32"
  && have("bash", ["-c", "true"])
  && have("python3", ["-c", "import yaml"]);

const d = CAN_RUN ? describe : describe.skip;

let home: string;
let configPath: string;
let pluginsDir: string;
let editionFile: string;
let hermesBin: string;
/** What the fake `hermes plugins doctor` prints; the reconcile reads it back. */
let doctorOutput: string;

/**
 * A `hermes` that records its calls and answers `plugins doctor` with whatever
 * the test staged — which is the only way to exercise the readback without a
 * Python runtime pretending to be the agent.
 */
function writeHermesStub() {
  fs.writeFileSync(
    hermesBin,
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$HERMES_CALLS"',
      'if [ "$1" = "plugins" ] && [ "$2" = "doctor" ]; then',
      '  cat "$HERMES_DOCTOR_OUT"',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
  );
  fs.chmodSync(hermesBin, 0o755);
}

function run(extra: Record<string, string> = {}, root = REPO) {
  fs.writeFileSync(path.join(home, "doctor-out"), doctorOutput);
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAWBOX_ROOT: root,
      HERMES_CONFIG: configPath,
      HERMES_BIN: hermesBin,
      BUN_BIN: path.join(home, "fake-bun"),
      CLAWBOX_EDITION_FILE: editionFile,
      HERMES_CALLS: path.join(home, "calls.log"),
      HERMES_DOCTOR_OUT: path.join(home, "doctor-out"),
      ...extra,
    }),
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readConfig(): Record<string, unknown> {
  const out = execFileSync(
    "python3",
    ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))", configPath],
    { encoding: "utf-8" },
  );
  return JSON.parse(out);
}

function enabledPlugins(): unknown {
  const plugins = readConfig().plugins as Record<string, unknown> | undefined;
  return plugins?.enabled;
}

function installedFiles(): string[] {
  const dir = path.join(pluginsDir, PLUGIN);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hook-home-"));
  configPath = path.join(home, ".hermes", "config.yaml");
  pluginsDir = path.join(home, ".hermes", "plugins");
  editionFile = path.join(home, "edition.env");
  hermesBin = path.join(home, "fake-hermes");
  doctorOutput = "  OK: registration passed\n  registrations: 0 tool(s), 1 hook(s)\n";

  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(editionFile, "CLAWBOX_EDITION=hermes\n");
  fs.writeFileSync(path.join(home, "fake-bun"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(home, "fake-bun"), 0o755);
  writeHermesStub();
  fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

d("register-mcp.sh — the outbound EMAIL: directive hook", () => {
  it("installs the shipped plugin and enables it by name", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(installedFiles()).toEqual(["__init__.py", "email_directives.py", "plugin.yaml"]);
    expect(enabledPlugins()).toEqual([PLUGIN]);
  });

  it("copies the real plugin, not a placeholder", () => {
    run();
    const shipped = fs.readFileSync(path.join(REPO, "scripts/hermes-plugins", PLUGIN, "__init__.py"), "utf-8");
    const installed = fs.readFileSync(path.join(pluginsDir, PLUGIN, "__init__.py"), "utf-8");
    expect(installed).toBe(shipped);
    expect(installed).toContain("transform_llm_output");
  });

  it("MERGES into plugins.enabled — the ClawAI image backend must survive", () => {
    // The same list gates image generation. Writing ours over it would take the
    // customer's picture-drawing away as a side effect of a directive strip.
    fs.writeFileSync(configPath, "plugins:\n  enabled:\n    - clawai\n");
    run();
    expect(enabledPlugins()).toEqual(["clawai", PLUGIN]);
  });

  it("reads back the JSON-string list form `hermes config set` writes", () => {
    fs.writeFileSync(configPath, `plugins:\n  enabled: '["clawai"]'\n`);
    run();
    expect(enabledPlugins()).toEqual(["clawai", PLUGIN]);
  });

  it("changes nothing on a second run", () => {
    run();
    const before = fs.readFileSync(configPath, "utf-8");
    const r = run();
    expect(r.stdout).toContain("already current");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("refuses to enable a plugin whose files are not there", () => {
    // "enabled in config, nothing on disk" is the false success. A checkout
    // without the plugin must leave the list alone rather than name a plugin
    // Hermes will never find.
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-bare-root-"));
    try {
      fs.mkdirSync(path.join(bareRoot, "mcp"), { recursive: true });
      fs.writeFileSync(path.join(bareRoot, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
      const r = run({}, bareRoot);
      expect(r.status).toBe(0);
      expect(enabledPlugins()).toBeUndefined();
      expect(installedFiles()).toEqual([]);
      // And it still registered the MCP server — a missing plugin must not cost
      // the box its device tools.
      expect((readConfig().mcp_servers as Record<string, unknown>).clawbox).toBeTruthy();
    } finally {
      fs.rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  it("removes a stale __pycache__ left by an older version of the plugin", () => {
    const cache = path.join(pluginsDir, PLUGIN, "__pycache__");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "email_directives.cpython-311.pyc"), "stale");
    run();
    expect(fs.existsSync(cache)).toBe(false);
  });

  it("verifies the plugin LOADED on every boot, not once at install", () => {
    run();
    const calls = fs.readFileSync(path.join(home, "calls.log"), "utf-8");
    expect(calls).toContain(`plugins doctor ${PLUGIN}`);

    // Second boot, nothing to write — the check still runs.
    fs.writeFileSync(path.join(home, "calls.log"), "");
    run();
    expect(fs.readFileSync(path.join(home, "calls.log"), "utf-8")).toContain(`plugins doctor ${PLUGIN}`);
  });

  it("says so when the plugin registered no hook", () => {
    // The state nothing else on the box reports: the module imported, so
    // `plugins list` says "enabled", but the hook is not there and every
    // channel reply still carries the directive.
    doctorOutput = "  OK: registration passed\n  registrations: 0 tool(s), 0 hook(s)\n";
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARNING.*did not register its hook/);
    expect(r.stdout).toContain("0 hook(s)");
  });

  it("says so when the doctor cannot load the plugin at all, and carries the reason", () => {
    doctorOutput = "Plugin registration failed: No __init__.py in /home/x/.hermes/plugins/clawbox_email_directives\n";
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARNING.*did not register its hook/);
    expect(r.stdout).toContain("No __init__.py");
  });

  it("does not fail the boot when the doctor itself is broken", () => {
    // A hermes too old for `plugins doctor`, or one that is wedged. The box
    // still gets its MCP registration and its plugin; only the proof is
    // missing, and the log says which.
    fs.writeFileSync(hermesBin, "#!/usr/bin/env bash\nexit 1\n");
    fs.chmodSync(hermesBin, 0o755);
    const r = run();
    expect(r.status).toBe(0);
    expect(enabledPlugins()).toEqual([PLUGIN]);
    expect(r.stdout).toMatch(/WARNING.*did not register its hook/);
  });

  it("does nothing at all on an OpenClaw box", () => {
    // gateway-pre-start.sh owns that edition; this script exits before it
    // touches anything.
    fs.writeFileSync(editionFile, "CLAWBOX_EDITION=openclaw\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(installedFiles()).toEqual([]);
    expect(enabledPlugins()).toBeUndefined();
  });
});
