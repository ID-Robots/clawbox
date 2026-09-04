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

  it("removes a partial copy rather than leaving Hermes to import it", () => {
    // `cp -f` truncates each target before it writes it, so a write that dies
    // part-way leaves a mixture of new, truncated and stale files — while
    // `plugins.enabled` still names the plugin from the boot before, because
    // the enable step only gates the write of a NEW entry, not the removal of
    // one already there. Hermes would then import a half-written module. One
    // state — no plugin, no strip, and a line that says so — beats that.
    // Provoked the way the OpenClaw twin's test does it: make one of the three
    // targets a directory, which `cp -f` cannot overwrite.
    run();
    expect(enabledPlugins()).toEqual([PLUGIN]);
    const third = path.join(pluginsDir, PLUGIN, "email_directives.py");
    fs.rmSync(third);
    fs.mkdirSync(third);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARNING: could not install/);
    expect(r.stdout).toContain("has been removed rather than left for Hermes to import");
    expect(installedFiles()).toEqual([]);
    // And the config still names it — which is exactly why the files must go.
    expect(enabledPlugins()).toEqual([PLUGIN]);
  });

  it.skipIf(process.getuid?.() === 0)("says so when it could NOT remove the partial copy", () => {
    // The other half of the same line, and the reason it is a line and not a
    // claim: `cp` truncates through the modes of files that already exist,
    // while `rm` needs the directory bit — so a destination the box cannot
    // write leaves a package missing a file, with `plugins.enabled` still
    // naming it. Reporting that as a completed cleanup would be a false
    // success in the step written to remove one.
    run();
    const dst = path.join(pluginsDir, PLUGIN);
    fs.rmSync(path.join(dst, "plugin.yaml")); // so `cp` must CREATE, and fails
    fs.chmodSync(dst, 0o555);
    try {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("could not remove what is there");
      expect(r.stdout).not.toContain("has been removed rather than left");
      expect(fs.existsSync(dst)).toBe(true);
    } finally {
      fs.chmodSync(dst, 0o755);
    }
  });

  it.skipIf(process.getuid?.() === 0)("leaves the installed plugin ALONE when it is the SOURCES that cannot be read", () => {
    // The other side of the same branch. `cp` opens its source first and never
    // touches the destination when that open fails, so a source-side problem —
    // a checkout still being written by the updater, a permission slip — leaves
    // the last good plugin exactly where it is. Removing it there would turn
    // "the box keeps stripping with what it already had" into "no plugin, and a
    // config that names one".
    run();
    expect(installedFiles()).toEqual(["__init__.py", "email_directives.py", "plugin.yaml"]);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-unreadable-src-"));
    try {
      fs.mkdirSync(path.join(bare, "mcp"), { recursive: true });
      fs.writeFileSync(path.join(bare, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
      const src = path.join(bare, "scripts", "hermes-plugins", PLUGIN);
      fs.mkdirSync(src, { recursive: true });
      for (const f of ["__init__.py", "plugin.yaml", "email_directives.py"]) {
        fs.writeFileSync(path.join(src, f), "x");
        fs.chmodSync(path.join(src, f), 0o000);
      }
      const r = run({}, bare);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/WARNING: could not read/);
      expect(r.stdout).toContain("leaving whatever is already installed in place");
      expect(installedFiles()).toEqual(["__init__.py", "email_directives.py", "plugin.yaml"]);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
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

  it("calls a doctor that could not run UNKNOWN, not a defect", () => {
    // A hermes too old for `plugins doctor`, or one that is wedged. The box
    // still gets its MCP registration and its plugin. Saying "directives will
    // still reach channels" here would be a false failure on a box where the
    // hook is registered and working — and one the operator sees every boot is
    // one they stop reading.
    fs.writeFileSync(hermesBin, "#!/usr/bin/env bash\nexit 1\n");
    fs.chmodSync(hermesBin, 0o755);
    const r = run();
    expect(r.status).toBe(0);
    expect(enabledPlugins()).toEqual([PLUGIN]);
    expect(r.stdout).toMatch(/NOTE: could not verify/);
    expect(r.stdout).not.toMatch(/WARNING/);
  });

  it("BOTH hermes calls are really bounded — a hung CLI cannot hold the boot", () => {
    // `production-server.js` launches this script, so an unbounded CLI call is
    // a helper (and its child) left running for as long as the box is up, and
    // both calls sit inside the config-lock critical section. Proven by turning
    // the ceiling down and hanging the CLI, rather than by matching a command
    // line: a `timeout` that never fires would leave this test waiting on the
    // stub's own sleep and then reading a SUCCESS from it.
    fs.writeFileSync(
      hermesBin,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$HERMES_CALLS"',
        "sleep 30",
        "exit 0",
      ].join("\n"),
    );
    fs.chmodSync(hermesBin, 0o755);
    const started = Date.now();
    const r = run({ HERMES_CLI_TIMEOUT: "1" });
    expect(r.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    // The doctor: killed, so its verdict is the UNKNOWN one and never the
    // "did not register its hook" defect.
    expect(r.stdout).toMatch(/NOTE: .*answered 124/);
    expect(r.stdout).not.toMatch(/did not register its hook/);
    // The sibling call site: `hermes tools disable browser`, which without a
    // bound would have slept and then reported SUCCESS.
    expect(r.stdout).toContain("could not disable the built-in browser toolset");
    // And the box still got its device tools and its plugin.
    expect(enabledPlugins()).toEqual([PLUGIN]);
    expect((readConfig().mcp_servers as Record<string, unknown>).clawbox).toBeTruthy();
  });
  it("a CLI that IGNORES SIGTERM is still bounded AND still reads as UNKNOWN", () => {
    // The case `-k 5` exists for, and the one a plain `sleep 30` stub never
    // reaches: a `hermes` that ignores SIGTERM survives the ceiling, so
    // `timeout` SIGKILLs it 5s later — and because SIGKILL cannot be ignored,
    // `timeout` kills ITSELF along with the process group and the caller reads
    // 128+9 = **137**, never 124. A classifier that knows only 124 therefore
    // sends exactly this input into the text `case`, where the banner the
    // doctor already printed IS the "ran and refused" branch — the hard
    // WARNING, about a hook that is very probably registered and working, on
    // every boot. 137 is not only `-k`: an OOM-killed `plugins doctor` (it
    // imports the whole agent) answers 137 with no `timeout` involved, and
    // tells us just as little about the hook.
    fs.writeFileSync(
      hermesBin,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$HERMES_CALLS"',
        // SIG_IGN survives execve, so the `sleep` inherits the ignore and
        // rides out the SIGTERM the way a wedged CLI does.
        "trap '' TERM",
        'if [ "$1" = "plugins" ] && [ "$2" = "doctor" ]; then',
        `  echo "Plugin Doctor: ${PLUGIN}"`,
        "fi",
        "exec sleep 30",
      ].join("\n"),
    );
    fs.chmodSync(hermesBin, 0o755);
    const started = Date.now();
    const r = run({ HERMES_CLI_TIMEOUT: "1" });
    const elapsed = Date.now() - started;
    expect(r.status).toBe(0);
    // 1s ceiling + 5s grace, twice, and nothing waiting on the stub's sleep.
    expect(elapsed).toBeLessThan(20_000);
    // The verdict: UNKNOWN, never the defect.
    expect(r.stdout).toMatch(/NOTE: 'hermes plugins doctor' answered 137/);
    expect(r.stdout).not.toMatch(/did not register its hook/);
    expect(r.stdout).not.toMatch(/WARNING/);
    // The sibling call site reads 137 and 124 alike — every non-zero status
    // lands in the same arm — so it must still say the honest thing.
    expect(r.stdout).toContain("could not disable the built-in browser toolset");
    // And the box still got its device tools and its plugin.
    expect(enabledPlugins()).toEqual([PLUGIN]);
    expect((readConfig().mcp_servers as Record<string, unknown>).clawbox).toBeTruthy();
    // ...and NOTHING said the script itself was killed. `-k 5` makes `timeout`
    // die by a signal, and bash announces a signal-killed foreground child on
    // the SCRIPT's stderr — past the command's own `2>&1`. production-server.js
    // pipes this stderr into the clawbox-setup journal, so an unguarded call
    // puts "register-mcp.sh: line NNN: <pid> Killed  timeout …" in front of an
    // operator, next to the honest line. That is the misleading journal entry
    // this step exists to prevent, so it must not be one.
    expect(r.stderr).not.toMatch(/Killed/);
    expect(r.stderr).not.toMatch(/register-mcp\.sh: line/);
    // Two calls, each 1s ceiling + the 5s grace, so this one outlasts the
    // default 5s test budget by design.
  }, 60_000);

  it.each([["0"], ["00"], ["000"], ["abc"], ["9".repeat(22)]])(
    "coerces a HERMES_CLI_TIMEOUT of %s back to 45 rather than losing the bound",
    (value) => {
      // `${VAR:-45}` substitutes on unset and empty and on nothing else, and
      // this value reaches the script through an environment
      // clawbox-setup.service builds partly from a user-writable .env. Two ways
      // it silently undoes the ceiling: `timeout 0` (and `00`, `000`) means NO
      // timeout, so the wedge above becomes unbounded again; and a non-numeric
      // duration makes `timeout` exit 125 WITHOUT running the CLI, which at the
      // `tools disable browser` call is a permanent "could not disable" with
      // the browser toolset left on — a false failure carrying a functional
      // regression. The ceiling is read back out of the NOTE, which is the only
      // place the script says what it used.
      fs.writeFileSync(
        hermesBin,
        [
          "#!/usr/bin/env bash",
          'printf "%s\\n" "$*" >> "$HERMES_CALLS"',
          'if [ "$1" = "plugins" ] && [ "$2" = "doctor" ]; then exit 124; fi',
          "exit 0",
        ].join("\n"),
      );
      fs.chmodSync(hermesBin, 0o755);
      const r = run({ HERMES_CLI_TIMEOUT: value });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("answered 124 — the 45s ceiling");
      // And the CLI really RAN: `timeout abc` would have exited 125 without
      // invoking it, landing in the "could not verify" arm instead.
      expect(r.stdout).toContain("built-in browser toolset off");
    },
  );

  it("reads 124 BEFORE the doctor's words, so a banner is not a defect", () => {
    // By the time `timeout` kills it, the doctor has usually printed its
    // banner — and on the text alone that banner IS the "ran and refused"
    // branch, so the box would log a hard WARNING about a hook that is very
    // probably registered and working, on every boot. The exit status is what
    // tells the two apart, so it has to survive and be read first.
    fs.writeFileSync(
      hermesBin,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$HERMES_CALLS"',
        'if [ "$1" = "plugins" ] && [ "$2" = "doctor" ]; then',
        `  echo "Plugin Doctor: ${PLUGIN}"`,
        "  exit 124",
        "fi",
        "exit 0",
      ].join("\n"),
    );
    fs.chmodSync(hermesBin, 0o755);
    const r = run();
    expect(r.status).toBe(0);
    expect(enabledPlugins()).toEqual([PLUGIN]);
    expect(r.stdout).toMatch(/NOTE: .*answered 124/);
    expect(r.stdout).not.toMatch(/WARNING/);
  });

  it("leaves an unreadable plugins.enabled ALONE rather than making it one name", () => {
    // `hermes config set` stores this list as a JSON string. A JSON list that
    // is not also a Python literal (a `true`, a truncated write) used to fall
    // back to "the whole string is one plugin name", which would have written
    // `['["clawai", true]', 'clawbox_email_directives']` — and the customer's
    // image backend, gated by this same list, would stop loading on the next
    // boot as a side effect of a directive strip.
    fs.writeFileSync(configPath, `plugins:\n  enabled: '["clawai", true'\n`);
    const r = run();
    expect(r.status).toBe(0);
    expect(enabledPlugins()).toBe('["clawai", true');
    expect(r.stderr).toMatch(/cannot parse/);
    // And the device tools still get registered.
    expect((readConfig().mcp_servers as Record<string, unknown>).clawbox).toBeTruthy();
  });

  it("reads the JSON forms `hermes config set` actually writes", () => {
    fs.writeFileSync(configPath, `plugins:\n  enabled: '["clawai", "other"]'\n`);
    run();
    expect(enabledPlugins()).toEqual(["clawai", "other", PLUGIN]);
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
