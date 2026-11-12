import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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

function check(
  step: string,
  extra: string[] = [],
  kind: "plugins" | "claude" = "plugins",
  env: Record<string, string> = {},
): CheckAnswer {
  const args = [
    "-I", STAMPS, "check", "--step", step, "--kind", kind,
    "--record", path.join(root, "data", "gateway-pre-start-stamps.json"),
    "--guard", path.join(root, "data", "openclaw-start-guard.json"),
    "--script", script,
    "--core-pkg", corePkg,
    ...(kind === "plugins" ? ["--config", config, "--openclaw-home", home, "--global-modules", path.join(dir, "global")] : []),
    ...extra,
  ];
  const res = spawnSync("python3", args, { encoding: "utf-8", env: { ...process.env, ...env } });
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

/** The pinned core's DDL for the table its plugin index lives in (OpenClaw 2026.10.9, state schema). */
const INDEX_DDL = "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, "
  + "value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT";

/**
 * The core's state database, `<state dir>/state/openclaw.sqlite`, holding the
 * `plugins.installedIndex` row as `valueJson` (no row when it is null).
 */
function writeIndex(valueJson: string | null, updatedAtMs = 1_794_522_213_591): string {
  const db = path.join(home, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(db), { recursive: true });
  const res = spawnSync("python3", ["-I", "-c", [
    "import sqlite3, sys",
    "con = sqlite3.connect(sys.argv[1])",
    "con.execute('DROP TABLE IF EXISTS config_machine_state')",
    "con.execute(sys.argv[2])",
    "if len(sys.argv) > 3:",
    "    con.execute('INSERT INTO config_machine_state VALUES (?, ?, ?)', ('plugins.installedIndex', sys.argv[3], int(sys.argv[4])))",
    "con.commit()",
  ].join("\n"), db, INDEX_DDL, ...(valueJson === null ? [] : [valueJson, String(updatedAtMs)])], { encoding: "utf-8" });
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  return db;
}

/**
 * A `plugins.installedIndex` value in the shape the pinned core writes and an
 * 8 GB box held (read-only, 2026-11-13): `{revision, index}`, the install
 * records an object keyed by plugin id, the cached view a list of entries keyed
 * by `pluginId`.
 */
function indexValue(change: {
  records?: Record<string, unknown>;
  plugins?: unknown[];
  index?: Record<string, unknown>;
  revision?: number;
} = {}): Record<string, unknown> {
  const deepseekRoot = path.join(home, "npm", "projects", "abc123", "node_modules", "@openclaw", "deepseek");
  const bundled = path.join(path.dirname(corePkg), "dist", "extensions", "telegram");
  return {
    revision: change.revision ?? 1_794_522_213_591,
    index: {
      version: 1,
      generatedAtMs: 1_794_522_213_591,
      refreshReason: "migration",
      policyHash: "p".repeat(64),
      workspaceDir: path.join(home, "workspace"),
      diagnostics: [],
      installRecords: change.records ?? {
        deepseek: { source: "npm", spec: "@openclaw/deepseek@2026.10.7", installPath: deepseekRoot, installedAt: "2026-11-12T22:23:33.000Z" },
      },
      plugins: change.plugins ?? [
        { pluginId: "deepseek", rootDir: deepseekRoot, source: path.join(deepseekRoot, "dist", "index.js"), manifestHash: "a".repeat(64), origin: "global", enabled: true },
        { pluginId: "telegram", rootDir: bundled, source: path.join(bundled, "index.js"), manifestHash: "b".repeat(64), origin: "bundled", enabled: false },
      ],
      ...change.index,
    },
  };
}

/** `check` with the plugin index, as the pre-start asks it for the "no Codex" answer. */
function indexCheck(env: Record<string, string> = {}): CheckAnswer {
  return check("codex-absent", ["--plugin-index", path.join(home, "state", "openclaw.sqlite")], "plugins", {
    OPENCLAW_WORKSPACE_DIR: "",
    ...env,
  });
}

/** Python's `json.dumps(sort_keys=True, separators=(",", ":"))`, for the keys pinned below. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A box with no Codex anywhere paid a `plugins list --json` cold start (2.4-2.8 s
 * on an 8 GB Jetson) on every gateway start to hear "no Codex" again. The
 * pre-start may now take that answer on trust, and only under a key over every
 * input that command answers from: the core's persisted plugin index (its
 * install records and its cached plugin view), every agent workspace's
 * `.openclaw/extensions` and every `plugins.load.paths` entry — on top of what
 * the `plugins` key already covers.
 */
describe.skipIf(!hasPython3)("the plugin index key (--plugin-index)", () => {
  const ws = (root: string) => path.join(root, ".openclaw", "extensions", "codex", "openclaw.plugin.json");
  // Thunks: the table is built before any case's temp directory exists.
  const withAgents = (agents: () => Record<string, unknown>) => () => writeJson(config, { ...BASE_CONFIG, agents: agents() });
  const withLoadPaths = (paths: () => string[]) => () => writeJson(config, {
    ...BASE_CONFIG,
    plugins: { ...BASE_CONFIG.plugins, load: { paths: paths() } },
  });

  it.each<[string, { setUp?: () => void; change: () => void; env?: () => Record<string, string> }]>([
    ["the core records a new install", {
      change: () => writeIndex(JSON.stringify(indexValue({
        records: { ...(indexValue().index as { installRecords: object }).installRecords, codex: { source: "npm", spec: "@openclaw/codex" } },
      }))),
    }],
    ["a plugin joins the core's cached view", {
      change: () => writeIndex(JSON.stringify(indexValue({
        plugins: [...(indexValue().index as { plugins: unknown[] }).plugins, { pluginId: "codex", rootDir: path.join(dir, "g", "codex"), manifestHash: "c".repeat(64) }],
      }))),
    }],
    ["only a cached plugin's manifest hash changed", {
      change: () => writeIndex(JSON.stringify(indexValue({
        plugins: (indexValue().index as { plugins: Array<Record<string, unknown>> }).plugins
          .map((p) => (p.pluginId === "deepseek" ? { ...p, manifestHash: "d".repeat(64) } : p)),
      }))),
    }],
    ["a manifest appears in the default workspace", { change: () => writeJson(ws(path.join(home, "workspace")), { id: "codex" }) }],
    ["a manifest appears in the workspace the index was built for", {
      setUp: () => writeIndex(JSON.stringify(indexValue({ index: { workspaceDir: path.join(dir, "built-for") } }))),
      change: () => writeJson(ws(path.join(dir, "built-for")), { id: "codex" }),
    }],
    ["a manifest appears in agents.defaults.workspace", {
      setUp: withAgents(() => ({ defaults: { workspace: path.join(dir, "ws-default") } })),
      change: () => writeJson(ws(path.join(dir, "ws-default")), { id: "codex" }),
    }],
    ["a manifest appears in an agent's own workspace", {
      setUp: withAgents(() => ({ entries: { main: {}, ops: { workspace: path.join(dir, "ws-ops") } } })),
      change: () => writeJson(ws(path.join(dir, "ws-ops")), { id: "codex" }),
    }],
    ["a manifest appears in a roster agent's derived workspace under the state directory", {
      setUp: withAgents(() => ({ entries: { main: {}, ops: {} } })),
      change: () => writeJson(ws(path.join(home, "workspace-ops")), { id: "codex" }),
    }],
    ["a manifest appears in a roster agent's derived workspace under the shared root", {
      setUp: withAgents(() => ({ defaults: { workspace: path.join(dir, "shared") }, entries: { main: {}, ops: {} } })),
      change: () => writeJson(ws(path.join(dir, "shared", "ops")), { id: "codex" }),
    }],
    ["a manifest appears in a workspace named with ~", {
      setUp: withAgents(() => ({ entries: { ops: { workspace: "~/ws-tilde" } } })),
      change: () => writeJson(ws(path.join(dir, "home", "ws-tilde")), { id: "codex" }),
      env: () => ({ HOME: path.join(dir, "home") }),
    }],
    ["a manifest appears in OPENCLAW_WORKSPACE_DIR", {
      change: () => writeJson(ws(path.join(dir, "ws-env")), { id: "codex" }),
      env: () => ({ OPENCLAW_WORKSPACE_DIR: path.join(dir, "ws-env") }),
    }],
    ["a Codex root appears under a plugins.load.paths entry", {
      setUp: withLoadPaths(() => [path.join(dir, "local-plugins")]),
      change: () => writeJson(path.join(dir, "local-plugins", "codex", "package.json"), { name: "@openclaw/codex" }),
    }],
    ["a plugins.load.paths entry becomes a plugin itself", {
      setUp: withLoadPaths(() => [path.join(dir, "one-plugin")]),
      change: () => writeJson(path.join(dir, "one-plugin", "openclaw.plugin.json"), { id: "codex" }),
    }],
    ["a plugins.load.paths file is edited", {
      setUp: () => {
        withLoadPaths(() => [path.join(dir, "plugin.js")])();
        writeFileSync(path.join(dir, "plugin.js"), "export default {id: 'other'};\n");
      },
      change: () => writeFileSync(path.join(dir, "plugin.js"), "export default {id: 'codex'};\n"),
    }],
  ])("moves when %s", (_what, { setUp, change, env }) => {
    writeIndex(JSON.stringify(indexValue()));
    setUp?.();
    const before = indexCheck(env?.());
    expect(before.state).toBe("miss");
    expect(before.key).toMatch(/^[0-9a-f]{64}$/);
    expect(remember("codex-absent", before.key, "absent")).toBe(0);
    expect(indexCheck(env?.())).toEqual({ state: "hit", key: before.key, rest: "absent" });

    change();

    const after = indexCheck(env?.());
    expect(after).toEqual({ state: "miss", key: expect.stringMatching(/^[0-9a-f]{64}$/), rest: "something it reads changed since the last full check" });
    expect(after.key).not.toBe(before.key);
  });

  it("stays put when the core only rewrote the row's times and revision, and over a provider or model switch", () => {
    writeIndex(JSON.stringify(indexValue()));
    const before = indexCheck();
    expect(remember("codex-absent", before.key, "absent")).toBe(0);

    writeIndex(JSON.stringify(indexValue({
      revision: 1_794_600_000_000,
      index: { generatedAtMs: 1_794_600_000_000, refreshReason: "manual" },
    })), 1_794_600_000_000);
    writeJson(config, {
      ...BASE_CONFIG,
      agents: { defaults: { model: { primary: "deepseek/deepseek-chat" } } },
      auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
    });

    expect(indexCheck()).toEqual({ state: "hit", key: before.key, rest: "absent" });
  });

  it.each<[string, () => void]>([
    ["there is no state database", () => rmSync(path.join(home, "state"), { recursive: true, force: true })],
    ["the state database is not a database", () => writeFileSync(path.join(home, "state", "openclaw.sqlite"), "not sqlite at all, not even close")],
    ["the core keeps no plugin index row", () => writeIndex(null)],
    ["the row is not JSON", () => writeIndex("{ not json")],
    ["the row is not an object", () => writeIndex("[]")],
    ["the row has no index object", () => writeIndex(JSON.stringify({ revision: 1, installRecords: {}, plugins: [] }))],
    ["the index has no install records object", () => writeIndex(JSON.stringify({ revision: 1, index: { plugins: [] } }))],
    ["the install records are a list", () => writeIndex(JSON.stringify({ revision: 1, index: { installRecords: [], plugins: [] } }))],
    ["the index has no plugin list", () => writeIndex(JSON.stringify({ revision: 1, index: { installRecords: {} } }))],
    ["the cached plugins are not a list", () => writeIndex(JSON.stringify({ revision: 1, index: { installRecords: {}, plugins: {} } }))],
    ["a cached plugin is not an object", () => writeIndex(JSON.stringify({ revision: 1, index: { installRecords: {}, plugins: ["codex"] } }))],
    ["a cached plugin has no id", () => writeIndex(JSON.stringify({ revision: 1, index: { installRecords: {}, plugins: [{ rootDir: "/x" }] } }))],
    ["agents.entries is not an object", () => {
      writeIndex(JSON.stringify(indexValue()));
      writeJson(config, { ...BASE_CONFIG, agents: { entries: [{ id: "ops" }] } });
    }],
  ])("is a miss with no key, never a constant, when %s", (_what, setUp) => {
    writeIndex(JSON.stringify(indexValue()));
    setUp();

    const answer = indexCheck();
    expect(answer.state).toBe("miss");
    expect(answer.key).toBe("-");
    expect(answer.rest).toMatch(/^its inputs could not be read/);
  });

  it("adds nothing to a key asked for without it: the other checks' keys are what they were", () => {
    const empty = path.join(dir, "empty-home");
    mkdirSync(empty);
    const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const core = statSync(corePkg, { bigint: true });
    // The parts the `plugins` key has always had, re-derived here, not read back.
    const today = createHash("sha256").update([
      "record=1",
      "kind=plugins",
      `script=${sha(script)}`,
      `core=${sha(corePkg)} ${core.size}:${core.mtimeNs}`,
      `plugins-config=${canonicalJson(BASE_CONFIG.plugins)}`,
    ].join("\n")).digest("hex");

    writeIndex(JSON.stringify(indexValue()));
    writeJson(ws(path.join(home, "workspace")), { id: "codex" });
    expect(check("plugin-consent", ["--openclaw-home", empty]).key).toBe(today);
    expect(check("codex-registry", ["--openclaw-home", empty]).key).toBe(today);
  });
});

/**
 * A fake `openclaw` that logs every call and answers the two plugin questions.
 * `registry` is the whole `plugins list --json` answer, printed before exiting
 * with `registryExit`; by default the registry lists Codex.
 */
function fakeOpenclaw(options: {
  inspect?: string;
  registryDepsOk?: boolean;
  registry?: string;
  registryExit?: number;
} = {}): { log: string; calls: () => string[] } {
  const log = path.join(dir, "openclaw-calls.log");
  const inspect = path.join(dir, "inspect.json");
  writeFileSync(inspect, options.inspect ?? inspectAllJson([{ id: "deepseek" }, { id: "codex" }]));
  const registry = options.registry ?? JSON.stringify({
    plugins: [{ id: "codex", dependencyStatus: { requiredInstalled: options.registryDepsOk !== false } }],
  });
  writeFileSync(path.join(bin, "openclaw"), [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    `if [ "$1 $2" = "plugins inspect" ]; then cat ${JSON.stringify(inspect)}; exit 0; fi`,
    `if [ "$1 $2" = "plugins list" ]; then printf '%s' '${registry}'; exit ${options.registryExit ?? 0}; fi`,
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
      // Never the host's own marker: a case says whether it runs on a Jetson.
      CLAWBOX_TEGRA_RELEASE: path.join(dir, "no-nv_tegra_release"),
      OPENCLAW_WORKSPACE_DIR: "",
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

  it("never records a negative dependency verdict", () => {
    const cli = fakeOpenclaw({ registryDepsOk: false });
    expect(runBash(PROGRAM).out).toContain("deps=0");
    proveLastStart();
    expect(runBash(PROGRAM).out).toContain("deps=0");
    expect(cli.calls().filter((c) => c.startsWith("plugins list"))).toHaveLength(2);
  });

  describe("with no Codex in either managed layout", () => {
    const LOCATE = `${SETUP}\n${RESOLVER}\necho "dir=$CODEX_PLUGIN_DIR layout=$CODEX_PLUGIN_LAYOUT deps=$CODEX_REGISTRY_DEPS_OK"`;
    const NO_CODEX = JSON.stringify({
      plugins: [{ id: "deepseek", rootDir: "/opt/deepseek", dependencyStatus: { requiredInstalled: true } }],
    });
    const TODAY = () => `dir=${path.join(home, "npm", "node_modules", "@openclaw", "codex")} layout=flat-managed deps=0`;
    const asked = (cli: { calls: () => string[] }) => cli.calls().filter((c) => c.startsWith("plugins list")).length;
    const recorded = () => {
      const file = path.join(root, "data", "gateway-pre-start-stamps.json");
      return existsSync(file) ? (readJson(file).steps as Record<string, { value: string }>)["codex-absent"] : undefined;
    };
    /** The Jetson marker, present. */
    const JETSON = () => {
      const marker = path.join(dir, "nv_tegra_release");
      writeFileSync(marker, "# R36 (release), REVISION: 4.4\n");
      return { CLAWBOX_TEGRA_RELEASE: marker };
    };

    beforeEach(() => {
      rmSync(path.join(home, "npm", "projects", "abc123", "node_modules", "@openclaw", "codex"), { recursive: true });
      writeIndex(JSON.stringify(indexValue()));
    });

    it("takes the registry's recorded \"no Codex\" on the next start instead of `plugins list`", () => {
      const cli = fakeOpenclaw({ registry: NO_CODEX });
      const first = runBash(LOCATE, JETSON());
      expect(first.status).toBe(0);
      expect(first.out).toContain(TODAY());
      expect(first.out).toContain("Codex plugin: asking the core's registry (no earlier full check on record)");
      expect(asked(cli)).toBe(1);
      expect(recorded()).toEqual(expect.objectContaining({ value: "absent" }));

      proveLastStart();
      const second = runBash(LOCATE, JETSON());
      expect(second.status).toBe(0);
      expect(second.out).toContain(TODAY());
      expect(second.out).toContain(
        "Codex plugin: the core's registry listed no Codex at the last full check and nothing it reads has changed; not asked again",
      );
      expect(second.out).toContain("reused instead of re-checked: codex-absent");
      expect(asked(cli)).toBe(1);
    });

    it.each<[string, { registry: string; registryExit?: number }]>([
      ["garbage", { registry: "Error: not json at all" }],
      ["JSON that is not an object", { registry: "[]" }],
      ["an object whose plugins are not a list", { registry: JSON.stringify({ plugins: { deepseek: {} } }) }],
      ["a list with an entry that is not an object", { registry: JSON.stringify({ plugins: ["deepseek"] }) }],
      ["no Codex, then a failed exit", { registry: NO_CODEX, registryExit: 1 }],
    ])("asks every start and records nothing when the registry answers %s", (_what, answer) => {
      const cli = fakeOpenclaw(answer);
      const first = runBash(LOCATE, JETSON());
      expect(first.status).toBe(0);
      expect(first.out).toContain(TODAY());
      proveLastStart();
      expect(runBash(LOCATE, JETSON()).out).toContain(TODAY());
      expect(asked(cli)).toBe(2);
      expect(recorded()).toBeUndefined();
    });

    it("loads a Codex the registry lists at its own root, and records no \"no Codex\"", () => {
      const global = path.join(dir, "global", "@openclaw", "codex");
      writeJson(path.join(global, "package.json"), { name: "@openclaw/codex", version: "2026.10.7" });
      fakeOpenclaw({
        registry: JSON.stringify({ plugins: [{ id: "codex", rootDir: global, dependencyStatus: { requiredInstalled: true } }] }),
      });
      const res = runBash(LOCATE, JETSON());
      expect(res.status).toBe(0);
      expect(res.out).toContain(`dir=${global} layout=registry deps=1`);
      expect(recorded()).toBeUndefined();
    });

    it.each<[string, () => Record<string, string>, string]>([
      ["the core recorded a new install", () => {
        writeIndex(JSON.stringify(indexValue({ records: { codex: { source: "npm", spec: "@openclaw/codex" } } })));
        return {};
      }, "something it reads changed since the last full check"],
      ["the operator asks for a full run", () => ({ CLAWBOX_PRESTART_FULL: "1" }),
        "a full check was asked for (CLAWBOX_PRESTART_FULL)"],
      ["systemd is restarting the gateway after a failure", () => {
        proveLastStart({ restarts: 1 });
        return {};
      }, "systemd is restarting the gateway after a failure"],
    ])("asks the registry again when %s", (_what, setUp, why) => {
      const cli = fakeOpenclaw({ registry: NO_CODEX });
      expect(runBash(LOCATE, JETSON()).status).toBe(0);
      expect(recorded()).toEqual(expect.objectContaining({ value: "absent" }));
      proveLastStart();
      const env = setUp();

      const second = runBash(LOCATE, { ...JETSON(), ...env });
      expect(second.status).toBe(0);
      expect(second.out).toContain(`Codex plugin: asking the core's registry (${why})`);
      expect(second.out).toContain(TODAY());
      expect(asked(cli)).toBe(2);
    });

    it("records nothing from the updater's run outside the unit; the unit's own start asks and records", () => {
      const cli = fakeOpenclaw({ registry: NO_CODEX });
      expect(runBash(LOCATE, { ...JETSON(), CLAWBOX_PRESTART_OUTSIDE_UNIT: "1" }).status).toBe(0);
      expect(recorded()).toBeUndefined();

      proveLastStart();
      expect(runBash(LOCATE, JETSON()).status).toBe(0);
      expect(asked(cli)).toBe(2);
      expect(recorded()).toEqual(expect.objectContaining({ value: "absent" }));
    });

    // The x64 desktop and the DGX Spark run this same script: there it stays
    // exactly what it was. Passes before and after the change.
    it("off a Jetson, asks the registry on every start and records nothing, as before", () => {
      const cli = fakeOpenclaw({ registry: NO_CODEX });
      const outs = [runBash(LOCATE), (proveLastStart(), runBash(LOCATE))];
      for (const res of outs) {
        expect(res.status).toBe(0);
        expect(res.out).toContain(TODAY());
        expect(res.out).not.toContain("Codex plugin:");
        expect(res.out).toContain("reused instead of re-checked: nothing");
      }
      expect(asked(cli)).toBe(2);
      expect(recorded()).toBeUndefined();
    });
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

/**
 * The updater runs this script itself, with the gateway stopped and outside its
 * unit (gateway_verify, a core-only update, the plugin retry). The start-guard
 * at its top records every run, and that run then became "the previous start"
 * of the unit's next real start — one that never reaches `gateway ready`, since
 * no gateway ran — so that start re-ran every full check (10 s on a Jetson)
 * behind a false "the previous start did not reach gateway ready".
 */
describe.skipIf(!hasPython3)("a pre-start run outside the gateway unit", () => {
  const START_GUARD = sliceScript(
    "# ── Start-loop recovery: a database the core refuses at every start",
    '"${CLAWBOX_STEP:-:}" "config check"',
  );

  /** One unit start, seconds ago, and whether it reached `gateway ready`. */
  function seedUnitStart(ready: boolean): number {
    const now = Date.now() / 1000;
    // Seconds, not minutes: the guard also reads the core's fixed log directory
    // /tmp/openclaw, where a live gateway's `gateway ready` written after this
    // start would make the start that never came up look as if it had.
    const provenAt = ready ? now - 3 : now - 8;
    writeJson(path.join(root, "data", "openclaw-start-guard.json"), {
      version: 1,
      starts: [{ at: now - 5, restarts: 0 }],
      provenAt,
    });
    return provenAt;
  }

  /** The updater's run, then the unit's next start: the real `program`, twice. */
  function updaterRunThenUnitStart(program = START_GUARD): {
    guard: { provenAt: number; starts: Array<Record<string, unknown>> };
    outs: string[];
    asked: () => number;
  } {
    const cli = fakeOpenclaw();
    // systemctl answers NRestarts; the journal has nothing from the gateway.
    for (const [name, body] of [["systemctl", "echo 0"], ["journalctl", "exit 0"]]) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
    const env = { CLAWBOX_OPENCLAW_2026_10: "1", OPENCLAW_STATE_DIR: home, TMPDIR: dir };
    const outs = [{ ...env, CLAWBOX_PRESTART_OUTSIDE_UNIT: "1" }, env].map((run) => {
      const res = runBash(program, run);
      expect(res.status).toBe(0);
      expect(res.out).not.toContain("start-loop recovery stopped");
      return res.out;
    });
    const guard = readJson(path.join(root, "data", "openclaw-start-guard.json"));
    expect(guard.starts).toHaveLength(3);
    return {
      guard: guard as { provenAt: number; starts: Array<Record<string, unknown>> },
      outs,
      asked: () => cli.calls().filter((c) => c.startsWith("plugins inspect")).length,
    };
  }

  it("is not taken for the previous start: the unit's next start reuses what the last real one proved", () => {
    seedUnitStart(true);
    const key = recordFullCheck();

    const { guard } = updaterRunThenUnitStart();

    expect(check("plugin-consent")).toEqual({ state: "hit", key, rest: "ok consented:deepseek" });
    expect(guard.starts[1].outsideUnit).toBe(true);
    expect(guard.starts[2]).not.toHaveProperty("outsideUnit");
  });

  it("still re-uses nothing when the last real start did not reach gateway ready", () => {
    const provenAt = seedUnitStart(false);
    const key = recordFullCheck();

    const { guard } = updaterRunThenUnitStart();

    // Nothing outside this case's own files said `gateway ready`.
    expect(guard.provenAt).toBe(provenAt);
    expect(check("plugin-consent")).toEqual({ state: "miss", key, rest: "the previous start did not reach gateway ready" });
  });

  // The consent check itself, run by the updater and then by the unit.
  const CONSENT_START = () => `${SETUP}\n${START_GUARD}\n${repairHelpers()}\n${sliceScript(
    "# ── Capability consent for the OTHER ClawBox-managed plugins",
    "# Codex reads its ChatGPT session",
  )}`;
  const SETTLED = "ok consented:codex consented:deepseek";

  it("takes the last real start's answer in both runs while nothing it reads changed", () => {
    seedUnitStart(true);
    recordFullCheck("plugin-consent", SETTLED);

    const { outs, asked } = updaterRunThenUnitStart(CONSENT_START());

    for (const out of outs) expect(out).toContain("reusing that report instead of asking again");
    expect(asked()).toBe(0);
  });

  // A core-only update installs a NEW core, then the updater's run checks it and
  // `doctor --fix` runs before the unit's next start, which is the first gateway
  // start on that core. The updater's answer came before doctor and no gateway
  // ever came up on it, so that start must ask the core itself.
  it("leaves the unit's next start no answer of its own: after a new core, that start asks again", () => {
    seedUnitStart(true);
    const oldKey = recordFullCheck("plugin-consent", SETTLED);
    writeJson(corePkg, { name: "openclaw", version: "2026.10.9" });

    const { outs: [updater, unit], asked } = updaterRunThenUnitStart(CONSENT_START());

    // The updater's run still asks, and acts on that answer itself.
    expect(updater).toContain("Plugin consent: asking the core (something it reads changed since the last full check)");
    expect(updater).toContain("deepseek plugin capabilities accepted/current");
    // The unit's start does not take that answer as proven.
    expect(unit).toContain("Plugin consent: asking the core (something it reads changed since the last full check)");
    expect(unit).not.toContain("reusing that report");
    expect(asked()).toBe(2);
    // The unit's own full check is what the start after it may reuse.
    const now = check("plugin-consent");
    expect(now.key).not.toBe(oldKey);
    const steps = readJson(path.join(root, "data", "gateway-pre-start-stamps.json")).steps as Record<string, { key: string }>;
    expect(steps["plugin-consent"].key).toBe(now.key);
  });
});
