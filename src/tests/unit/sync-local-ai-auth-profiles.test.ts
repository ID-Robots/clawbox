import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts real node processes (the script, and the fake CLI it spawns): the
// 5 s / 10 s defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// vite cannot bundle the builtin; a test file is never bundled, so reaching it
// lazily here is safe (same rule as codex-auth-mirror.test.ts).
const requireNodeSqlite = createRequire(import.meta.url);
const { DatabaseSync } = requireNodeSqlite("node:sqlite");

/**
 * TASK-1196, bug #1: an updated box kept a STALE `llamacpp:default` /
 * `ollama:default` auth profile in core's SQLite store while boot re-pointed
 * only `models.providers.<provider>.apiKey` at `data/.local-ai-token`. Core tries
 * the profile first, the local-AI proxy accepts nothing but the file's token,
 * so every local-model turn opened with a 401 and a failover to another
 * profile.
 *
 * These run the real shipped script against a temp OpenClaw home and a fake
 * `openclaw` that records what it was asked, so the contract is pinned end to
 * end: compare fingerprints, re-save only a stale profile, re-save it the way
 * setup does (the token on stdin, never argv), read the store back, and never
 * print a credential.
 */

const SCRIPT = path.resolve(process.cwd(), "scripts/sync-local-ai-auth-profiles.js");

const TOKEN = "a1".repeat(32);
/** What an image built elsewhere, or an older build, left in the store. */
const STALE = "f0".repeat(32);
const SENTINEL = "llamacpp-local";
const PROXY = "http://127.0.0.1/setup-api/local-ai";

let dir: string;
let root: string;
let home: string;
let fakeBin: string;
let callLog: string;
let stdinLog: string;

const fp = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lai-auth-sync-"));
  root = path.join(dir, "clawbox");
  home = path.join(dir, ".openclaw");
  mkdirSync(path.join(root, "data"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(root, "data", ".local-ai-token"), TOKEN + "\n");
  callLog = path.join(dir, "calls.jsonl");
  stdinLog = path.join(dir, "stdin.jsonl");
  fakeBin = path.join(dir, "openclaw");
  writeFakeCli();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for `openclaw models auth paste-api-key`. It writes the pasted key
 * into the agent's own `auth_profile_store` — the top of core's read-through,
 * which is where the configure route measured the real paste landing — unless
 * FAKE_OPENCLAW_MODE says to fail (echoing what it was given, so redaction is
 * tested against a CLI that misbehaves) or to succeed without writing.
 */
function writeFakeCli(): void {
  writeFileSync(
    fakeBin,
    [
      `#!${process.execPath}`,
      '"use strict";',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const argv = process.argv.slice(2);",
      "fs.appendFileSync(process.env.FAKE_OPENCLAW_CALLS, JSON.stringify(argv) + '\\n');",
      "const stdin = fs.readFileSync(0, 'utf8');",
      "fs.appendFileSync(process.env.FAKE_OPENCLAW_STDIN, JSON.stringify(stdin) + '\\n');",
      "const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };",
      "const mode = process.env.FAKE_OPENCLAW_MODE || 'write';",
      "if (mode === 'fail') { process.stderr.write('refused key ' + stdin.trim() + ' over old ' + process.env.FAKE_OPENCLAW_ECHO + '\\n'); process.exit(3); }",
      "if (mode === 'noop') process.exit(0);",
      "const agentDir = path.join(process.env.FAKE_OPENCLAW_HOME, 'agents', flag('--agent') || 'main', 'agent');",
      "fs.mkdirSync(agentDir, { recursive: true });",
      "const { DatabaseSync } = require('node:sqlite');",
      "const db = new DatabaseSync(path.join(agentDir, 'openclaw-agent.sqlite'));",
      "db.exec('CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER)');",
      "const row = db.prepare('SELECT store_json FROM auth_profile_store WHERE store_key = ?').get('primary');",
      "const store = row ? JSON.parse(row.store_json) : { version: 1, profiles: {} };",
      "store.profiles[flag('--profile-id')] = { type: 'api_key', provider: flag('--provider'), key: stdin.trim() };",
      "db.prepare('INSERT OR REPLACE INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)').run('primary', JSON.stringify(store), Date.now());",
      "db.close();",
      "",
    ].join("\n"),
  );
  chmodSync(fakeBin, 0o755);
}

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(path.join(home, "openclaw.json"), JSON.stringify(cfg));
}

function localProviders(keys: { llamacpp?: string; ollama?: string }): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  if (keys.llamacpp !== undefined) {
    providers.llamacpp = { baseUrl: `${PROXY}/llamacpp/v1`, api: "openai-completions", apiKey: keys.llamacpp, models: [] };
  }
  if (keys.ollama !== undefined) {
    providers.ollama = { baseUrl: `${PROXY}/ollama`, api: "ollama", apiKey: keys.ollama, models: [] };
  }
  return { models: { providers } };
}

function apiKeyProfile(provider: string, key: string) {
  return { type: "api_key", provider, key };
}

function agentDb(agent = "main"): string {
  return path.join(home, "agents", agent, "agent", "openclaw-agent.sqlite");
}

function seedAgentStore(profiles: Record<string, unknown>, agent = "main"): void {
  mkdirSync(path.dirname(agentDb(agent)), { recursive: true });
  const db = new DatabaseSync(agentDb(agent));
  db.exec("CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER)");
  db.prepare("INSERT OR REPLACE INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)")
    .run("primary", JSON.stringify({ version: 1, profiles }), Date.now());
  db.close();
}

/** OpenClaw 2's relocated store: `state/openclaw.sqlite`, owned when `auth.sharedStore` says `state-db`. */
function seedSharedStore(profiles: Record<string, unknown>): void {
  const file = path.join(home, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)");
  const upsert = db.prepare("INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)");
  upsert.run("authProfiles.store", JSON.stringify({ version: 1, profiles }), Date.now());
  upsert.run("auth.sharedStore", JSON.stringify({ location: "state-db" }), Date.now());
  db.close();
}

function storedKey(profileId: string, agent = "main"): string | undefined {
  if (!existsSync(agentDb(agent))) return undefined;
  const db = new DatabaseSync(agentDb(agent), { readOnly: true });
  const row = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary") as
    | { store_json: string }
    | undefined;
  db.close();
  return row ? JSON.parse(row.store_json).profiles?.[profileId]?.key : undefined;
}

function calls(): string[][] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function stdins(): string[] {
  if (!existsSync(stdinLog)) return [];
  return readFileSync(stdinLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function run(env: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [SCRIPT, home, fakeBin], {
    encoding: "utf8",
    // Pinned, not inherited: a dev shell or CI job exporting any of these would
    // point the child at another box's files.
    env: {
      ...process.env,
      CLAWBOX_ROOT: root,
      OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
      OPENCLAW_STATE_DIR: "",
      CLAWBOX_OPENCLAW_V2: "1",
      LOCAL_AI_TOKEN: "",
      FAKE_OPENCLAW_HOME: home,
      FAKE_OPENCLAW_CALLS: callLog,
      FAKE_OPENCLAW_STDIN: stdinLog,
      FAKE_OPENCLAW_ECHO: STALE,
      ...env,
    },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function expectNoCredentialIn(out: { stdout: string; stderr: string }): void {
  for (const secret of [TOKEN, STALE, SENTINEL]) {
    expect(out.stdout).not.toContain(secret);
    expect(out.stderr).not.toContain(secret);
  }
}

describe("mismatched stored/default profile fingerprints", () => {
  it("re-saves a stale llamacpp:default the way setup does, and reads it back", async () => {
    writeConfig(localProviders({ llamacpp: TOKEN }));
    seedAgentStore({ "llamacpp:default": apiKeyProfile("llamacpp", STALE) });
    expect(fp(storedKey("llamacpp:default")!)).not.toBe(fp(TOKEN));

    const out = run();

    expect(out.status).toBe(0);
    // Exactly the configure route's paste: provider and profile id in argv…
    expect(calls()).toEqual([
      ["models", "auth", "paste-api-key", "--provider", "llamacpp", "--profile-id", "llamacpp:default"],
    ]);
    // …the key on stdin, and nowhere in argv.
    expect(stdins()).toEqual([TOKEN + "\n"]);
    expect(calls().flat()).not.toContain(TOKEN);
    expect(fp(storedKey("llamacpp:default")!)).toBe(fp(TOKEN));
    expect(out.stdout).toContain("Re-synced auth profile llamacpp:default");
    expectNoCredentialIn(out);
  });

  it("treats a legacy sentinel in the store as stale too", () => {
    writeConfig(localProviders({ ollama: TOKEN }));
    seedAgentStore({ "ollama:default": apiKeyProfile("ollama", SENTINEL) });

    const out = run();

    expect(calls()).toEqual([
      ["models", "auth", "paste-api-key", "--provider", "ollama", "--profile-id", "ollama:default"],
    ]);
    expect(storedKey("ollama:default")).toBe(TOKEN);
    expectNoCredentialIn(out);
  });

  it("finds a stale profile in OpenClaw 2's shared state store", () => {
    writeConfig(localProviders({ llamacpp: TOKEN }));
    seedSharedStore({ "llamacpp:default": apiKeyProfile("llamacpp", STALE) });

    const out = run();

    expect(calls()).toHaveLength(1);
    // The agent's own row now sits on top of the stale inherited one, which is
    // what core resolves — so the read-back counts it as converged.
    expect(storedKey("llamacpp:default")).toBe(TOKEN);
    expect(out.stdout).toContain("Re-synced auth profile llamacpp:default");
    expect(out.stderr).not.toContain("WARN");
    expectNoCredentialIn(out);
  });

  it("re-saves both local providers when both are stale, one paste each", () => {
    writeConfig(localProviders({ llamacpp: TOKEN, ollama: TOKEN }));
    seedAgentStore({
      "llamacpp:default": apiKeyProfile("llamacpp", STALE),
      "ollama:default": apiKeyProfile("ollama", STALE),
    });

    run();

    expect(calls().map((argv) => argv[argv.indexOf("--profile-id") + 1])).toEqual([
      "llamacpp:default",
      "ollama:default",
    ]);
    expect(storedKey("llamacpp:default")).toBe(TOKEN);
    expect(storedKey("ollama:default")).toBe(TOKEN);
  });

  it("checks a roster agent, and leaves a stray agent directory alone", () => {
    writeConfig({ ...localProviders({ llamacpp: TOKEN }), agents: { list: [{ id: "pro-agent" }] } });
    seedAgentStore({ "llamacpp:default": apiKeyProfile("llamacpp", TOKEN) }, "pro-agent");
    // A removed agent's leftovers: no turn routes through it.
    seedAgentStore({ "llamacpp:default": apiKeyProfile("llamacpp", STALE) }, "carl_pir");

    const out = run();

    expect(calls()).toEqual([]);
    expect(out.stdout).toBe("");
  });

  it("warns, redacted, when the CLI refuses — and never fails the boot", () => {
    writeConfig(localProviders({ llamacpp: TOKEN }));
    seedAgentStore({ "llamacpp:default": apiKeyProfile("llamacpp", STALE) });

    const out = run({ FAKE_OPENCLAW_MODE: "fail" });

    expect(out.status).toBe(0);
    expect(out.stderr).toContain("WARN: could not re-save auth profile llamacpp:default (exit 3");
    // The fake echoed both keys back; neither reaches the journal.
    expect(out.stderr).toContain("[redacted]");
    expectNoCredentialIn(out);
    expect(storedKey("llamacpp:default")).toBe(STALE);
  });

  it("says so when the store still resolves the stale key after a paste", () => {
    writeConfig(localProviders({ llamacpp: TOKEN }));
    seedAgentStore({ "llamacpp:default": apiKeyProfile("llamacpp", STALE) });

    const out = run({ FAKE_OPENCLAW_MODE: "noop" });

    expect(out.status).toBe(0);
    expect(out.stdout).not.toContain("Re-synced");
    expect(out.stderr).toContain("still resolves a stale key for agent main");
    expectNoCredentialIn(out);
  });
});

describe("gateway-pre-start.sh runs it on every gateway start", () => {
  const PRE_START = readFileSync(path.resolve(process.cwd(), "scripts/gateway-pre-start.sh"), "utf8");
  const START = 'LOCAL_AI_AUTH_SYNC="$SCRIPT_DIR/sync-local-ai-auth-profiles.js"';

  /** The block exactly as shipped, from its assignment to its closing `fi`. */
  function block(): string {
    const start = PRE_START.indexOf(START);
    expect(start).toBeGreaterThan(-1);
    const end = PRE_START.indexOf("\nfi\n", start);
    expect(end).toBeGreaterThan(start);
    return PRE_START.slice(start, end + "\nfi\n".length);
  }

  it("after the config write and the legacy auth-profile migration", () => {
    const at = PRE_START.indexOf(START);
    // The Python pass writes the reconciled apiKey this reads…
    expect(PRE_START.indexOf('print("  Updated gateway config")')).toBeLessThan(at);
    // …and OpenClaw 2's doctor migration settles the store it reads.
    expect(PRE_START.indexOf("Migrating legacy auth profiles into OpenClaw 2 SQLite state")).toBeLessThan(at);
  });

  function runBlock(extra: string): { stdout: string; stderr: string; status: number | null } {
    const program = [
      "set -euo pipefail",
      `SCRIPT_DIR=${JSON.stringify(path.dirname(SCRIPT))}`,
      `CLAWBOX_ROOT=${JSON.stringify(root)}`,
      `OPENCLAW_CONFIG=${JSON.stringify(path.join(home, "openclaw.json"))}`,
      `OPENCLAW_BIN=${JSON.stringify(fakeBin)}`,
      "CLAWBOX_OPENCLAW_V2=1",
      "export OPENCLAW_CONFIG_PATH=\"$OPENCLAW_CONFIG\"",
      extra,
      block(),
      "echo BOOT-CONTINUES",
    ].join("\n");
    const result = spawnSync("bash", ["-c", program], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: "",
        FAKE_OPENCLAW_HOME: home,
        FAKE_OPENCLAW_CALLS: callLog,
        FAKE_OPENCLAW_STDIN: stdinLog,
        FAKE_OPENCLAW_ECHO: STALE,
      },
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  it("re-syncs a stale profile through the shipped block", () => {
    writeConfig(localProviders({ llamacpp: TOKEN }));
    seedAgentStore({ "llamacpp:default": apiKeyProfile("llamacpp", STALE) });

    const out = runBlock(`clawbox_node_bin() { printf '%s' ${JSON.stringify(process.execPath)}; }`);

    expect(out.status).toBe(0);
    expect(out.stdout).toContain("Re-synced auth profile llamacpp:default");
    expect(out.stdout).toContain("BOOT-CONTINUES");
    expect(storedKey("llamacpp:default")).toBe(TOKEN);
    expectNoCredentialIn(out);
  });

  it("never stops the boot — not without node, not when the check itself dies", () => {
    writeConfig(localProviders({ llamacpp: TOKEN }));
    seedAgentStore({ "llamacpp:default": apiKeyProfile("llamacpp", STALE) });

    const noNode = runBlock("clawbox_node_bin() { return 1; }");
    expect(noNode.status).toBe(0);
    expect(noNode.stderr).toContain("the local-AI auth profiles were not checked");
    expect(noNode.stdout).toContain("BOOT-CONTINUES");

    const dies = runBlock(`clawbox_node_bin() { printf '%s' ${JSON.stringify(path.join(dir, "no-such-node"))}; }`);
    expect(dies.status).toBe(0);
    expect(dies.stderr).toContain("the local-AI auth profile check did not finish");
    expect(dies.stdout).toContain("BOOT-CONTINUES");
    expect(calls()).toEqual([]);
  });
});

describe("profiles that are not stale, or not this script's to judge", () => {
  it("does nothing, and says nothing, when the fingerprints already match", () => {
    writeConfig(localProviders({ llamacpp: TOKEN, ollama: TOKEN }));
    seedAgentStore({
      "llamacpp:default": apiKeyProfile("llamacpp", TOKEN),
      "ollama:default": apiKeyProfile("ollama", TOKEN),
    });

    const out = run();

    expect(calls()).toEqual([]);
    expect(out.stdout).toBe("");
  });

  it("leaves the profile alone when the provider's apiKey is not the token", () => {
    // The Python pass skips a `${VAR}` key and an entry off this box's proxy;
    // the profile follows the config's key, so it is skipped with it.
    writeConfig(localProviders({ llamacpp: "${LOCAL_AI_TOKEN}", ollama: "operator-own-ollama-key-123" }));
    seedAgentStore({
      "llamacpp:default": apiKeyProfile("llamacpp", STALE),
      "ollama:default": apiKeyProfile("ollama", STALE),
    });

    run();

    expect(calls()).toEqual([]);
  });

  it("never pastes over a missing or too-short token file", () => {
    writeConfig(localProviders({ llamacpp: "short" }));
    writeFileSync(path.join(root, "data", ".local-ai-token"), "short");
    seedAgentStore({ "llamacpp:default": apiKeyProfile("llamacpp", STALE) });

    run();
    rmSync(path.join(root, "data", ".local-ai-token"));
    run();

    expect(calls()).toEqual([]);
  });

  it("never replaces a sign-in, a SecretRef or a ${VAR} credential", () => {
    writeConfig(localProviders({ llamacpp: TOKEN, ollama: TOKEN }));
    seedAgentStore({
      "llamacpp:default": { type: "oauth", provider: "llamacpp", access: STALE },
      "ollama:default": { type: "api_key", provider: "ollama", keyRef: { source: "env", id: "OLLAMA_KEY" } },
    });

    run();
    seedAgentStore({ "llamacpp:default": apiKeyProfile("llamacpp", "${LOCAL_AI_TOKEN}") });
    run();

    expect(calls()).toEqual([]);
  });

  it("judges nothing through a substitute when the state database cannot be read", () => {
    // Which store core inherits from is recorded IN that database, so an
    // unreadable one leaves the question open — main's own table is not an
    // answer for another agent, and a paste on its account would be a guess.
    writeConfig({ ...localProviders({ llamacpp: TOKEN }), agents: { list: [{ id: "pro-agent" }] } });
    seedAgentStore({ "llamacpp:default": apiKeyProfile("llamacpp", STALE) }, "main");
    mkdirSync(path.join(home, "state"), { recursive: true });
    writeFileSync(path.join(home, "state", "openclaw.sqlite"), "not a database");

    const out = run();

    expect(calls()).toEqual([]);
    expect(out.stderr).toContain("could not read");
    expect(out.stderr).toContain(path.join("state", "openclaw.sqlite"));
    expectNoCredentialIn(out);
  });

  it("creates no profile where there is none", () => {
    writeConfig(localProviders({ llamacpp: TOKEN }));

    const out = run();

    expect(calls()).toEqual([]);
    expect(out.stdout).toBe("");
  });

  it("reads a legacy auth-profiles.json on OpenClaw 1 and ignores it on OpenClaw 2", () => {
    writeConfig(localProviders({ llamacpp: TOKEN }));
    const legacy = path.join(home, "agents", "main", "agent", "auth-profiles.json");
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ version: 1, profiles: { "llamacpp:default": apiKeyProfile("llamacpp", STALE) } }));

    // OpenClaw 2 refuses to start beside that file and never reads it.
    run({ CLAWBOX_OPENCLAW_V2: "1" });
    expect(calls()).toEqual([]);

    // OpenClaw 1 resolves it; the fake's store write lands in the table, which
    // the legacy file still shadows, so the read-back is honest about it.
    const out = run({ CLAWBOX_OPENCLAW_V2: "0" });
    expect(calls()).toHaveLength(1);
    expect(out.stderr).toContain("still resolves a stale key");
    expectNoCredentialIn(out);
  });
});
