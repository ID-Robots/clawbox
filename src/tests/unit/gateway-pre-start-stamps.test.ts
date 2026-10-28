import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { GATEWAY_PRE_START, inspectAllJson, repairHelpers, sliceScript } from "@/tests/helpers/gateway-pre-start";

// Starts real python and bash processes per case.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

/**
 * The gateway pre-start's stamps (scripts/gateway-pre-start-stamps.py).
 *
 * A provider sign-in that has to restart the gateway waited ~36 s for a
 * pre-start whose every check said "already current" — three of them a CLI
 * cold start each (8-12 s on a Jetson) whatever their answer. The stamps let a
 * start take the last full check's answer, and these cases pin the two halves
 * of that bargain: the answer IS reused when nothing it reads has changed (a
 * provider, model or sign-in switch among those), and is NEVER reused when
 * something it reads did change, when the record is old, or when the last
 * start gives no proof that it came up.
 */

const STAMPS = path.resolve(process.cwd(), "scripts/gateway-pre-start-stamps.py");
const SCRIPTS_DIR = path.dirname(GATEWAY_PRE_START);
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** The setup block: the stamp helpers, the step timer and its EXIT trap. */
const SETUP = sliceScript(
  "# ── Step timings, and the checks a start may take on trust",
  "# OpenClaw 2026.10 or later.",
);

let dir: string;
let root: string;
let home: string;
let config: string;
let bin: string;
let corePkg: string;
let script: string;

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

const BASE_CONFIG = {
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
  auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
  models: { mode: "merge", providers: {} },
  gateway: { auth: { mode: "token", token: "t".repeat(64) } },
  plugins: { entries: { deepseek: { enabled: true }, codex: { enabled: true } } },
};

/** The start-guard's record, as the top of this same pre-start leaves it. */
function proveLastStart(options: { restarts?: number; ready?: boolean; recorded?: boolean } = {}): void {
  const now = Date.now() / 1000;
  const { restarts = 0, ready = true, recorded = true } = options;
  writeJson(path.join(root, "data", "openclaw-start-guard.json"), {
    version: 1,
    starts: [
      { at: now - 3600, restarts: 0 },
      { at: recorded ? now - 2 : now - 7200, restarts },
    ],
    // `gateway ready` after the previous start began — or only before it.
    provenAt: ready ? now - 3000 : now - 4000,
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "clawbox-stamps-"));
  root = path.join(dir, "clawbox");
  home = path.join(dir, "home", ".openclaw");
  config = path.join(home, "openclaw.json");
  bin = path.join(dir, "home", ".npm-global", "bin");
  corePkg = path.join(dir, "home", ".npm-global", "lib", "node_modules", "openclaw", "package.json");
  // A copy, so a case can play "a ClawBox update changed the pre-start".
  script = path.join(dir, "gateway-pre-start.sh");
  copyFileSync(GATEWAY_PRE_START, script);
  writeJson(config, BASE_CONFIG);
  writeJson(corePkg, { name: "openclaw", version: "2026.10.7" });
  mkdirSync(bin, { recursive: true });
  // The plugin payloads, in the layouts the pre-start resolves.
  writeJson(path.join(home, "extensions", "clawbox-email-directives", "package.json"), { name: "clawbox-email-directives", version: "1.0.0" });
  writeJson(path.join(home, "extensions", "clawbox-email-directives", "openclaw.plugin.json"), { id: "clawbox-email-directives" });
  const project = path.join(home, "npm", "projects", "abc123");
  writeJson(path.join(project, "package.json"), { dependencies: { "@openclaw/codex": "2026.10.7" } });
  writeJson(path.join(project, "node_modules", "@openclaw", "codex", "package.json"), { name: "@openclaw/codex", version: "2026.10.7" });
  writeJson(path.join(project, "node_modules", "@openclaw", "codex", "node_modules", "openclaw", "package.json"), { version: "2026.10.7" });
  writeJson(path.join(project, "node_modules", "@openclaw", "deepseek", "package.json"), { name: "@openclaw/deepseek", version: "2026.10.7" });
  proveLastStart();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface CheckAnswer {
  state: string;
  key: string;
  rest: string;
}

function check(step: string, extra: string[] = [], kind: "plugins" | "claude" = "plugins"): CheckAnswer {
  const args = [
    "-I", STAMPS, "check", "--step", step, "--kind", kind,
    "--record", path.join(root, "data", "gateway-pre-start-stamps.json"),
    "--guard", path.join(root, "data", "openclaw-start-guard.json"),
    "--script", script,
    "--core-pkg", corePkg,
    ...(kind === "plugins" ? ["--config", config, "--openclaw-home", home, "--global-modules", path.join(dir, "global")] : []),
    ...extra,
  ];
  const res = spawnSync("python3", args, { encoding: "utf-8" });
  expect(res.status).toBe(0);
  const [state, key, ...rest] = res.stdout.replace(/\n$/, "").split("\t");
  return { state, key, rest: rest.join("\t") };
}

function remember(step: string, key: string, value: string): number | null {
  return spawnSync("python3", [
    "-I", STAMPS, "remember", "--step", step, "--key", key, "--value", value,
    "--record", path.join(root, "data", "gateway-pre-start-stamps.json"),
  ], { encoding: "utf-8" }).status;
}

/** A first full check on record, as a boot that just ran one leaves it. */
function recordFullCheck(step = "plugin-consent", value = "ok consented:deepseek"): string {
  const first = check(step);
  expect(first.state).toBe("miss");
  expect(remember(step, first.key, value)).toBe(0);
  return first.key;
}

describe.skipIf(!hasPython3)("the stamp helper", () => {
  it("re-uses a full check's answer only once one is on record", () => {
    const first = check("plugin-consent");
    expect(first).toEqual({ state: "miss", key: expect.stringMatching(/^[0-9a-f]{64}$/), rest: "no earlier full check on record" });
    expect(remember("plugin-consent", first.key, "ok consented:deepseek seen:clawbox-email-directives")).toBe(0);

    expect(check("plugin-consent")).toEqual({
      state: "hit",
      key: first.key,
      rest: "ok consented:deepseek seen:clawbox-email-directives",
    });
    // Steps are recorded apart: one check's record answers for no other.
    expect(check("codex-registry").state).toBe("miss");
  });

  it("still re-uses it after a provider, model or sign-in switch: none of what it reads changed", () => {
    const key = recordFullCheck();
    writeJson(config, {
      ...BASE_CONFIG,
      agents: { defaults: { model: { primary: "deepseek/deepseek-chat", fallbacks: ["deepseek/deepseek-chat"] } } },
      auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
      models: { mode: "merge", providers: { deepseek: { baseUrl: "https://example.invalid/v1", models: [] } } },
      meta: { lastTouchedAt: "2026-10-28T00:00:00.000Z" },
    });

    expect(check("plugin-consent")).toEqual({ state: "hit", key, rest: "ok consented:deepseek" });
  });

  it.each<[string, () => void]>([
    ["a plugin was switched on or off", () => writeJson(config, {
      ...BASE_CONFIG,
      plugins: { entries: { ...BASE_CONFIG.plugins.entries, discord: { enabled: true } } },
    })],
    ["a plugin payload was updated", () => writeJson(
      path.join(home, "npm", "projects", "abc123", "node_modules", "@openclaw", "deepseek", "package.json"),
      { name: "@openclaw/deepseek", version: "2026.10.8" },
    )],
    ["a plugin manifest changed", () => writeJson(
      path.join(home, "extensions", "clawbox-email-directives", "openclaw.plugin.json"),
      { id: "clawbox-email-directives", contracts: { hooks: ["message:send"] } },
    )],
    ["a plugin payload was removed", () => rmSync(path.join(home, "extensions", "clawbox-email-directives"), { recursive: true })],
    ["a plugin payload was added", () => writeJson(path.join(home, "extensions", "whatsapp", "package.json"), { name: "whatsapp" })],
    ["the Codex plugin's peer link went", () => rmSync(
      path.join(home, "npm", "projects", "abc123", "node_modules", "@openclaw", "codex", "node_modules"),
      { recursive: true },
    )],
    ["the core was updated", () => writeJson(corePkg, { name: "openclaw", version: "2026.10.8" })],
    ["the core was reinstalled at the same version", () => {
      const later = new Date(Date.now() + 60_000);
      utimesSync(corePkg, later, later);
    }],
    ["a ClawBox update changed the pre-start", () => writeFileSync(script, `${readFileSync(script, "utf-8")}\n# changed\n`)],
  ])("checks again in full when %s", (_what, change) => {
    const key = recordFullCheck();
    change();

    const after = check("plugin-consent");
    expect(after.state).toBe("miss");
    expect(after.rest).toBe("something it reads changed since the last full check");
    expect(after.key).not.toBe(key);
  });

  it.each<[string, () => void, string]>([
    ["systemd is restarting the gateway after a failure", () => proveLastStart({ restarts: 1 }),
      "systemd is restarting the gateway after a failure"],
    ["the previous start never reached gateway ready", () => proveLastStart({ ready: false }),
      "the previous start did not reach gateway ready"],
    ["the start-guard did not record this start", () => proveLastStart({ recorded: false }),
      "this start was not recorded"],
    ["there is no start-guard record at all (a core before 2026.10)",
      () => unlinkSync(path.join(root, "data", "openclaw-start-guard.json")),
      "no start record to prove the last start reached gateway ready"],
  ])("never re-uses it when %s", (_what, change, reason) => {
    recordFullCheck();
    change();

    expect(check("plugin-consent")).toEqual(expect.objectContaining({ state: "miss", rest: reason }));
  });

  it("runs every check in full at least once a day", () => {
    const key = recordFullCheck();
    const record = readJson(path.join(root, "data", "gateway-pre-start-stamps.json"));
    const steps = record.steps as Record<string, { savedAt: number }>;
    steps["plugin-consent"].savedAt -= 25 * 60 * 60;
    writeJson(path.join(root, "data", "gateway-pre-start-stamps.json"), record);

    expect(check("plugin-consent")).toEqual({ state: "miss", key, rest: "the last full check is more than a day old" });
  });

  it("re-uses nothing when the operator asks for a full run", () => {
    const key = recordFullCheck();
    expect(check("plugin-consent", ["--no-reuse"])).toEqual({
      state: "miss",
      key,
      rest: "a full check was asked for (CLAWBOX_PRESTART_FULL)",
    });
  });

  it("answers a config it cannot read with a miss and no key, which is never recorded", () => {
    recordFullCheck();
    writeFileSync(config, "{ not json");

    const after = check("plugin-consent");
    expect(after.state).toBe("miss");
    expect(after.key).toBe("-");
    expect(after.rest).toMatch(/^its inputs could not be read/);
    expect(remember("plugin-consent", "-", "ok")).toBe(1);
  });

  it("keys the Claude Code check on the binaries it would ask and on the core install", () => {
    const claude = path.join(dir, "home", ".local", "bin", "claude");
    mkdirSync(path.dirname(claude), { recursive: true });
    writeFileSync(claude, "#!/bin/sh\necho '2.1.273 (Claude Code)'\n");
    chmodSync(claude, 0o755);
    const first = check("claude-code", ["--candidate", claude], "claude");
    expect(first.state).toBe("miss");
    expect(remember("claude-code", first.key, "2.1.273")).toBe(0);
    expect(check("claude-code", ["--candidate", claude], "claude")).toEqual({ state: "hit", key: first.key, rest: "2.1.273" });

    // A Claude Code update replaces the binary.
    writeFileSync(claude, "#!/bin/sh\n# a newer build\necho '2.1.300 (Claude Code)'\n");
    expect(check("claude-code", ["--candidate", claude], "claude").state).toBe("miss");
    // No binary to key on is a miss, never a hit.
    expect(check("claude-code", [], "claude")).toEqual(expect.objectContaining({ state: "miss", key: "-" }));
  });
});

/** A fake `openclaw` that logs every call and answers the two plugin questions. */
function fakeOpenclaw(options: { inspect?: string; registryDepsOk?: boolean } = {}): { log: string; calls: () => string[] } {
  const log = path.join(dir, "openclaw-calls.log");
  const inspect = path.join(dir, "inspect.json");
  writeFileSync(inspect, options.inspect ?? inspectAllJson([{ id: "deepseek" }, { id: "codex" }]));
  const registry = JSON.stringify({
    plugins: [{ id: "codex", dependencyStatus: { requiredInstalled: options.registryDepsOk !== false } }],
  });
  writeFileSync(path.join(bin, "openclaw"), [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    `if [ "$1 $2" = "plugins inspect" ]; then cat ${JSON.stringify(inspect)}; exit 0; fi`,
    `if [ "$1 $2" = "plugins list" ]; then printf '%s' '${registry}'; exit 0; fi`,
    "exit 0",
  ].join("\n"));
  chmodSync(path.join(bin, "openclaw"), 0o755);
  return {
    log,
    calls: () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean) : []),
  };
}

function runBash(program: string, env: Record<string, string> = {}): { status: number | null; out: string } {
  const res = spawnSync("bash", ["-c", `set -euo pipefail\n${program}`], {
    encoding: "utf-8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: path.join(dir, "home"),
      SCRIPT_DIR: SCRIPTS_DIR,
      CLAWBOX_ROOT: root,
      OPENCLAW_BIN: path.join(bin, "openclaw"),
      OPENCLAW_CONFIG: config,
      OPENCLAW_HOME_DIR: home,
      CLAWBOX_OPENCLAW_V2: "1",
      CLAWBOX_PRESTART_FULL: "",
      ...env,
    },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe.skipIf(!hasPython3)("the step timings", () => {
  it.each<[string, string, number]>([
    ["a clean finish", "", 0],
    ["an explicit exit status", "exit 3", 3],
    ["a failure under set -e", "false", 1],
  ])("log every step and the total on %s, and keep the script's own exit status", (_what, ending, status) => {
    const res = runBash(`${SETUP}\n"\${CLAWBOX_STEP:-:}" "first step"\nsleep 0.05\n"\${CLAWBOX_STEP:-:}" "second step"\n${ending}`);

    expect(res.status).toBe(status);
    expect(res.out).toMatch(/Timing: startup and version probe \d+ ms/);
    const first = Number(/Timing: first step (\d+) ms/.exec(res.out)?.[1]);
    expect(first).toBeGreaterThanOrEqual(40);
    expect(res.out).toMatch(/Timing: second step \d+ ms/);
    expect(res.out).toContain(`Timing: pre-start total`);
    expect(res.out).toContain(`(exit ${status}); reused instead of re-checked: nothing`);
  });

  it("is a no-op where a suite runs one section of the script on its own", () => {
    const res = runBash(`"\${CLAWBOX_STEP:-:}" "a step"\necho done`);
    expect(res.status).toBe(0);
    expect(res.out.trim()).toBe("done");
  });
});

describe.skipIf(!hasPython3)("the plugin-consent check, on the boot path", () => {
  const MANAGED = sliceScript(
    "# ── Capability consent for the OTHER ClawBox-managed plugins",
    "# Codex reads its ChatGPT session",
  );
  const PROGRAM = () => `${SETUP}\n${repairHelpers()}\n${MANAGED}`;

  it("asks the core once, then takes that report on the next start instead of a CLI cold start", () => {
    const cli = fakeOpenclaw();
    const first = runBash(PROGRAM());
    expect(first.status).toBe(0);
    expect(cli.calls().filter((c) => c.startsWith("plugins inspect"))).toHaveLength(1);
    expect(first.out).toContain("Plugin consent: asking the core (no earlier full check on record)");
    expect(first.out).toContain("deepseek plugin capabilities accepted/current");
    const record = readJson(path.join(root, "data", "gateway-pre-start-stamps.json"));
    expect((record.steps as Record<string, { value: string }>)["plugin-consent"].value).toBe("ok consented:codex consented:deepseek");

    // The sign-in restart: the model, the credential and its metadata changed.
    writeJson(config, {
      ...BASE_CONFIG,
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: { profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } },
    });
    proveLastStart();
    const second = runBash(PROGRAM());
    expect(second.status).toBe(0);
    expect(cli.calls().filter((c) => c.startsWith("plugins inspect"))).toHaveLength(1);
    expect(cli.calls().some((c) => c.startsWith("plugins enable"))).toBe(false);
    expect(second.out).toContain("reusing that report instead of asking again");
    expect(second.out).toContain("deepseek plugin capabilities accepted/current");
    expect(second.out).toContain("reused instead of re-checked: plugin-consent");
  });

  it.each<[string, () => Record<string, string>]>([
    ["the operator asks for a full run", () => ({ CLAWBOX_PRESTART_FULL: "1" })],
    ["systemd is restarting the gateway after a failure", () => {
      proveLastStart({ restarts: 2 });
      return {};
    }],
  ])("asks the core again when %s", (_what, setUp) => {
    const cli = fakeOpenclaw();
    expect(runBash(PROGRAM()).status).toBe(0);
    const env = setUp();
    expect(runBash(PROGRAM(), env).status).toBe(0);
    expect(cli.calls().filter((c) => c.startsWith("plugins inspect"))).toHaveLength(2);
  });

  it("never records a report with a consent still pending, so the next start asks again", () => {
    const cli = fakeOpenclaw({ inspect: inspectAllJson([{ id: "deepseek", consentRequired: true }]) });
    expect(runBash(PROGRAM()).status).toBe(0);
    expect(cli.calls()).toContain("plugins enable deepseek --accept-capabilities");
    const record = path.join(root, "data", "gateway-pre-start-stamps.json");
    expect(existsSync(record) ? (readJson(record).steps as Record<string, unknown>)["plugin-consent"] : undefined).toBeUndefined();

    proveLastStart();
    expect(runBash(PROGRAM()).status).toBe(0);
    expect(cli.calls().filter((c) => c.startsWith("plugins inspect"))).toHaveLength(2);
  });

  it("asks the core, then and there, about a plugin the recorded report does not settle", () => {
    const cli = fakeOpenclaw();
    // A record under the right key that does not name deepseek.
    const key = check("plugin-consent").key;
    expect(remember("plugin-consent", key, "ok consented:codex")).toBe(0);

    const res = runBash(PROGRAM());
    expect(res.status).toBe(0);
    expect(res.out).toContain("Plugin consent: the recorded report does not settle deepseek; asking the core");
    expect(cli.calls().filter((c) => c.startsWith("plugins inspect"))).toHaveLength(1);
    // The core's answer settles it: no enable is spent on the stale record.
    expect(cli.calls().some((c) => c.startsWith("plugins enable"))).toBe(false);
    expect(res.out).toContain("deepseek plugin capabilities accepted/current");
  });
});

describe.skipIf(!hasPython3)("the Codex registry-dependency check, on the boot path", () => {
  const RESOLVER = sliceScript(
    'CODEX_PLUGIN_DIR="$OPENCLAW_HOME_DIR/npm/node_modules/@openclaw/codex"',
    'NEEDS_CODEX_PLUGIN="$(python3',
  );
  const PROGRAM = `${SETUP}\n${RESOLVER}\necho "deps=$CODEX_REGISTRY_DEPS_OK"`;

  it("takes a recorded positive verdict on the next start instead of `plugins list`", () => {
    const cli = fakeOpenclaw();
    const first = runBash(PROGRAM);
    expect(first.out).toContain("deps=1");
    expect(cli.calls().filter((c) => c.startsWith("plugins list"))).toHaveLength(1);

    proveLastStart();
    const second = runBash(PROGRAM);
    expect(second.status).toBe(0);
    expect(second.out).toContain("deps=1");
    expect(second.out).toContain("Codex plugin dependencies: nothing they depend on changed");
    expect(cli.calls().filter((c) => c.startsWith("plugins list"))).toHaveLength(1);
  });

  it("never records a negative verdict", () => {
    const cli = fakeOpenclaw({ registryDepsOk: false });
    expect(runBash(PROGRAM).out).toContain("deps=0");
    proveLastStart();
    expect(runBash(PROGRAM).out).toContain("deps=0");
    expect(cli.calls().filter((c) => c.startsWith("plugins list"))).toHaveLength(2);
  });
});

describe.skipIf(!hasPython3)("the Claude Code version report, on the boot path", () => {
  const CLAUDE = sliceScript(
    "# ── Report the installed Claude Code to Anthropic",
    "# ── Agent databases: migration status, compaction, migration copies",
  );
  const BUNDLE = 'var X;init(()=>{ANTHROPIC_CLAUDE_CODE_VERSION=`2.1.75`});';

  function claudeAt(version: string): { calls: () => number } {
    const log = path.join(dir, "claude-calls.log");
    const claude = path.join(dir, "home", ".local", "bin", "claude");
    mkdirSync(path.dirname(claude), { recursive: true });
    writeFileSync(claude, `#!/bin/sh\necho x >> ${JSON.stringify(log)}\necho "${version} (Claude Code)"\n`);
    chmodSync(claude, 0o755);
    return { calls: () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").length : 0) };
  }

  it("asks Claude Code and reads the bundle once, then not again until either changes", () => {
    fakeOpenclaw();
    const bundle = path.join(path.dirname(corePkg), "dist", "anthropic-abc.js");
    mkdirSync(path.dirname(bundle), { recursive: true });
    writeFileSync(bundle, BUNDLE);
    const claude = claudeAt("2.1.273");

    const first = runBash(`${SETUP}\n${CLAUDE}`);
    expect(first.status).toBe(0);
    expect(first.out).toMatch(/now reporting the installed 2\.1\.273/);
    expect(claude.calls()).toBe(1);

    proveLastStart();
    const second = runBash(`${SETUP}\n${CLAUDE}`);
    expect(second.out).toContain("the core and Claude Code are unchanged since the last full check (Claude Code 2.1.273); not asked again");
    expect(claude.calls()).toBe(1);

    // A Claude Code update: asked again, and the new number reported.
    const updated = claudeAt("2.1.300");
    proveLastStart();
    const third = runBash(`${SETUP}\n${CLAUDE}`);
    expect(third.out).toMatch(/now reporting the installed 2\.1\.300/);
    expect(updated.calls()).toBe(2);
    expect(readFileSync(bundle, "utf-8")).toContain("ANTHROPIC_CLAUDE_CODE_VERSION=`2.1.300`");
  });
});
