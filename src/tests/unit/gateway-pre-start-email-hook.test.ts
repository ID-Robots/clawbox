import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// The gateway boot reconcile that installs ClawBox's outbound EMAIL:-directive
// plugin into the OpenClaw core, enables it, and proves it loaded.
//
// This runs the BLOCK OUT OF THE SHIPPED SCRIPT rather than a copy — the same
// approach the other gateway-pre-start suites take — so the test fails if the
// real script drifts away from it.
//
// The three failure shapes it pins:
//
//   probe-once    — a plugin installed once and assumed present for ever. The
//                   copy, the enable and the load check all run on EVERY
//                   gateway start, because ~/.openclaw does not survive a
//                   factory reset.
//   false success — `plugins.entries.<id>.enabled: true` in the config proves
//                   nothing about a module that throws on import. The readback
//                   is `plugins inspect --runtime`, and the hook names it looks
//                   at are the TOP-LEVEL `typedHooks[]` (`plugin.hookNames` is
//                   empty even when `hookCount` is not).
//   false failure — none of it may stop the gateway. This is an ExecStartPre
//                   under `set -euo pipefail`: a missing `openclaw`, a wedged
//                   CLI or an unreadable config must all leave exit 0.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const REPO = path.resolve(process.cwd());
const PLUGIN_ID = "clawbox-email-directives";

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

/** The shipped block, from its banner to the section that follows it. */
function block(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const from = "# ── The outbound EMAIL:-directive hook plugin ";
  const to = "# Seed CLAWBOX.md in the OpenClaw workspace";
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error("the EMAIL: directive hook block is not in gateway-pre-start.sh");
  return src.slice(start, end);
}

let dir: string;
let openclawHome: string;
let configPath: string;
let binDir: string;

/** An `openclaw` whose `plugins inspect` answers whatever the test staged. */
function stubOpenclaw(body: string) {
  const p = path.join(binDir, "openclaw");
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$OC_CALLS"\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function loadedInspection(hookNames: string[]) {
  return `cat <<'JSON'\n${JSON.stringify({
    plugin: { id: PLUGIN_ID, status: "loaded", activated: true, hookCount: hookNames.length, hookNames: [] },
    typedHooks: hookNames.map((name) => ({ name })),
    diagnostics: [],
  })}\nJSON`;
}

function run(root = REPO) {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_HOME_DIR=${JSON.stringify(openclawHome)}`,
    `OPENCLAW_BIN=${JSON.stringify(path.join(binDir, "openclaw"))}`,
    block(),
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({ PATH: `${binDir}:/usr/bin:/bin`, OC_CALLS: path.join(dir, "calls.log") }),
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The gateway config as JSON. `entries` is indexed by plugin id in the tests. */
type OpenclawConfig = { plugins?: { entries?: Record<string, Record<string, unknown> | undefined> } };

function readConfig(): OpenclawConfig {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function installed(): string[] {
  const target = path.join(openclawHome, "extensions", PLUGIN_ID);
  return existsSync(target) ? readdirSync(target).sort() : [];
}

function calls(): string {
  const p = path.join(dir, "calls.log");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

d("gateway-pre-start.sh — the outbound EMAIL: directive hook plugin", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "oc-email-hook-"));
    openclawHome = path.join(dir, ".openclaw");
    binDir = path.join(dir, "bin");
    mkdirSync(openclawHome, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    configPath = path.join(openclawHome, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({ plugins: { entries: { deepseek: { enabled: true } } } }));
    stubOpenclaw(loadedInspection(["reply_payload_sending"]));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs the shipped plugin and enables it", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(installed()).toEqual(["email-directives.mjs", "index.mjs", "openclaw.plugin.json", "package.json"]);
    expect(readConfig().plugins?.entries?.[PLUGIN_ID]).toEqual({ enabled: true });
    expect(r.stdout).toContain("reply_payload_sending registered");
  });

  it("copies the real plugin, not a placeholder", () => {
    run();
    const shipped = readFileSync(path.join(REPO, "scripts/openclaw-plugins", PLUGIN_ID, "index.mjs"), "utf-8");
    const there = readFileSync(path.join(openclawHome, "extensions", PLUGIN_ID, "index.mjs"), "utf-8");
    expect(there).toBe(shipped);
  });

  it("leaves every other plugin entry alone", () => {
    run();
    expect(readConfig().plugins?.entries?.deepseek).toEqual({ enabled: true });
  });

  it("keeps a config that already carries our entry with extra keys", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { [PLUGIN_ID]: { hooks: { timeoutMs: 5000 } } } } }),
    );
    run();
    expect(readConfig().plugins?.entries?.[PLUGIN_ID]).toEqual({ hooks: { timeoutMs: 5000 }, enabled: true });
  });

  it("does not rewrite the config on a second boot", () => {
    run();
    const before = readFileSync(configPath, "utf-8");
    const r = run();
    expect(r.stdout).toContain("already enabled");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("checks that the plugin LOADED on every boot, not once at install", () => {
    run();
    writeFileSync(path.join(dir, "calls.log"), "");
    const r = run();
    expect(calls()).toContain(`plugins inspect ${PLUGIN_ID} --runtime --json`);
    expect(r.stdout).toContain("reply_payload_sending registered");
  });

  it("warns when the plugin loaded but registered no outbound hook", () => {
    // The false success: the config says enabled, `plugins list` would agree,
    // and every channel reply still carries the directive.
    stubOpenclaw(loadedInspection(["gateway_start"]));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*did not register reply_payload_sending/);
    expect(r.stderr).toContain("gateway_start");
  });

  it("carries the core's own diagnostic when the plugin did not load", () => {
    stubOpenclaw(
      `cat <<'JSON'\n${JSON.stringify({
        plugin: { id: PLUGIN_ID, status: "error" },
        typedHooks: [],
        diagnostics: ["plugin manifest requires id"],
      })}\nJSON`,
    );
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("plugin manifest requires id");
  });

  it("does not read hookNames, which the core leaves empty", () => {
    // `plugin.hookNames` is [] even when hookCount is 5; the names live in the
    // top-level typedHooks[]. Reading the wrong one would warn on a plugin that
    // is working perfectly.
    stubOpenclaw(
      `cat <<'JSON'\n${JSON.stringify({
        plugin: { id: PLUGIN_ID, status: "loaded", hookCount: 1, hookNames: [] },
        typedHooks: [{ name: "reply_payload_sending" }],
        diagnostics: [],
      })}\nJSON`,
    );
    const r = run();
    expect(r.stdout).toContain("reply_payload_sending registered");
  });

  it("survives an openclaw that is missing, and still exits 0", () => {
    // An ExecStartPre under `set -euo pipefail`: a failing command substitution
    // in an assignment aborts the script, and the gateway would never start —
    // over a diagnostic.
    rmSync(path.join(binDir, "openclaw"));
    const r = run();
    expect(r.status).toBe(0);
    expect(readConfig().plugins?.entries?.[PLUGIN_ID]).toEqual({ enabled: true });
    expect(r.stderr).toMatch(/WARNING.*did not register reply_payload_sending/);
  });

  it("survives an openclaw that fails or prints nonsense", () => {
    stubOpenclaw('echo "not json at all"; exit 3');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("no runtime inspection");
  });

  it("does not enable a plugin whose files are not in the checkout", () => {
    const bare = mkdtempSync(path.join(tmpdir(), "oc-bare-root-"));
    try {
      const r = run(bare);
      expect(r.status).toBe(0);
      expect(installed()).toEqual([]);
      expect(readConfig().plugins?.entries?.[PLUGIN_ID]).toBeUndefined();
      expect(r.stderr).toContain("not a complete plugin");
      // And it never asked the CLI about a plugin it did not install.
      expect(calls()).not.toContain("plugins inspect");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("does not overwrite a config it cannot parse", () => {
    writeFileSync(configPath, "{ this is not json");
    const r = run();
    expect(r.status).toBe(0);
    expect(readFileSync(configPath, "utf-8")).toBe("{ this is not json");
  });
});
