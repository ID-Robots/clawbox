import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// These run the shipped scripts/ensure-local-embeddings.sh itself — not a copy
// of its logic — against stub `curl`, `ollama` and `openclaw` binaries on PATH.
// The `openclaw` stub really applies `config set` to the JSON file, so the
// idempotency and "never leave it half-configured" claims are checked against
// actual config state rather than against a call log alone.

const SCRIPT = path.resolve(process.cwd(), "scripts/ensure-local-embeddings.sh");
const PRE_START = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const MODEL = "qwen3-embedding:0.6b";
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const canRun = hasBash && hasPython3;

let dir: string;
let binDir: string;
let configPath: string;
let statePath: string;
let callsPath: string;
let tagsPath: string;

/** A tags payload shaped like ollama's /api/tags. */
function tags(models: string[]): string {
  return JSON.stringify({ models: models.map((m) => ({ name: m, model: m })) });
}

function writeStub(name: string, body: string) {
  const p = path.join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "local-embeddings-"));
  binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  configPath = path.join(dir, "openclaw.json");
  statePath = path.join(dir, "data", "local-embeddings.state");
  callsPath = path.join(dir, "calls.log");
  tagsPath = path.join(dir, "tags.json");
  writeFileSync(configPath, JSON.stringify({ agents: { defaults: {} } }));

  // curl: serve the fixture, or fail like an unreachable ollama when it is absent.
  writeStub(
    "curl",
    [
      'echo "curl $*" >> "$CALLS_LOG"',
      'if [ ! -s "$TAGS_FIXTURE" ]; then exit 7; fi',
      'cat "$TAGS_FIXTURE"',
    ].join("\n"),
  );

  // ollama: record the pull and honour a scripted exit code; on success add the
  // model to the fixture so the script's re-check sees it, exactly like the real one.
  writeStub(
    "ollama",
    [
      'echo "ollama $*" >> "$CALLS_LOG"',
      'if [ "${OLLAMA_PULL_RC:-0}" != "0" ]; then exit "$OLLAMA_PULL_RC"; fi',
      'if [ -n "${TAGS_AFTER_PULL:-}" ]; then printf %s "$TAGS_AFTER_PULL" > "$TAGS_FIXTURE"; fi',
    ].join("\n"),
  );

  // openclaw: record every call and really apply `config set a.b.c value`.
  writeStub(
    "openclaw",
    [
      'echo "openclaw $*" >> "$CALLS_LOG"',
      'if [ "${OPENCLAW_RC:-0}" != "0" ]; then exit "$OPENCLAW_RC"; fi',
      'if [ "${1:-}" = "config" ] && [ "${2:-}" = "set" ]; then',
      '  CFG_KEY="$3" CFG_VALUE="$4" python3 - "$TEST_CONFIG" <<\'PY\'',
      "import json, os, sys",
      "path = sys.argv[1]",
      "cfg = json.load(open(path))",
      "node = cfg",
      "parts = os.environ['CFG_KEY'].split('.')",
      "for key in parts[:-1]:",
      "    node = node.setdefault(key, {})",
      "node[parts[-1]] = os.environ['CFG_VALUE']",
      "json.dump(cfg, open(path, 'w'))",
      "PY",
      "fi",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type RunOpts = {
  provider?: string;
  model?: string;
  present?: boolean;
  pullRc?: number;
  openclawRc?: number;
  state?: string;
  tagsAfterPull?: string;
  unreachable?: boolean;
};

function run(opts: RunOpts = {}) {
  const cfg: Record<string, unknown> = {};
  if (opts.provider !== undefined) cfg.provider = opts.provider;
  if (opts.model !== undefined) cfg.model = opts.model;
  writeFileSync(
    configPath,
    JSON.stringify({ agents: { defaults: Object.keys(cfg).length ? { memorySearch: cfg } : {} } }),
  );
  writeFileSync(tagsPath, opts.unreachable ? "" : opts.present ? tags([MODEL]) : tags(["llama3:8b"]));
  if (opts.state !== undefined) {
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, opts.state);
  }
  const res = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      OPENCLAW_BIN: "openclaw",
      OPENCLAW_CONFIG: configPath,
      TEST_CONFIG: configPath,
      OLLAMA_TAGS_URL: "http://stub/api/tags",
      TAGS_FIXTURE: tagsPath,
      EMBED_STATE_FILE: statePath,
      CALLS_LOG: callsPath,
      OLLAMA_PULL_RC: String(opts.pullRc ?? 0),
      OPENCLAW_RC: String(opts.openclawRc ?? 0),
      TAGS_AFTER_PULL: opts.tagsAfterPull ?? tags([MODEL]),
    },
  });
  const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf-8").trim().split("\n").filter(Boolean) : [];
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    calls,
    memorySearch: (config.agents?.defaults?.memorySearch ?? {}) as Record<string, string>,
    state: existsSync(statePath) ? readFileSync(statePath, "utf-8") : "",
  };
}

const configSets = (calls: string[]) => calls.filter((c) => c.startsWith("openclaw config set"));
const pulls = (calls: string[]) => calls.filter((c) => c.startsWith("ollama pull"));
const reindexes = (calls: string[]) => calls.filter((c) => c.includes("memory index --force"));

describe.skipIf(!canRun)("ensure-local-embeddings.sh", () => {
  it("leaves a deliberately chosen remote provider completely alone", () => {
    const r = run({ provider: "openai", model: "text-embedding-3-large", present: true });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual([]);
    expect(pulls(r.calls)).toEqual([]);
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.memorySearch.provider).toBe("openai");
  });

  it("pulls the model, switches the provider and reindexes when nothing is configured", () => {
    const r = run({ present: false });
    expect(r.status).toBe(0);
    expect(pulls(r.calls)).toEqual([`ollama pull ${MODEL}`]);
    expect(configSets(r.calls)).toEqual([
      "openclaw config set agents.defaults.memorySearch.provider ollama",
      `openclaw config set agents.defaults.memorySearch.model ${MODEL}`,
    ]);
    expect(reindexes(r.calls)).toHaveLength(1);
    expect(r.memorySearch).toMatchObject({ provider: "ollama", model: MODEL });
  });

  it("skips the pull when the model is already in ollama but still switches and reindexes", () => {
    const r = run({ present: true });
    expect(r.status).toBe(0);
    expect(pulls(r.calls)).toEqual([]);
    expect(configSets(r.calls)).toHaveLength(2);
    expect(reindexes(r.calls)).toHaveLength(1);
  });

  it("treats provider \"auto\" as unset", () => {
    const r = run({ provider: "auto", present: true });
    expect(r.status).toBe(0);
    expect(r.memorySearch).toMatchObject({ provider: "ollama", model: MODEL });
  });

  it("is idempotent once the box is already on local embeddings", () => {
    const r = run({ provider: "ollama", model: MODEL, present: true });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual([]);
    expect(reindexes(r.calls)).toEqual([]);
    expect(pulls(r.calls)).toEqual([]);
  });

  it("still switches when the provider is ollama but the model is a different one", () => {
    const r = run({ provider: "ollama", model: "nomic-embed-text", present: true });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toHaveLength(2);
    expect(reindexes(r.calls)).toHaveLength(1);
  });

  it("leaves the config untouched when the pull fails, and does not reindex", () => {
    const r = run({ present: false, pullRc: 1 });
    expect(r.status).toBe(0);
    expect(pulls(r.calls)).toHaveLength(1);
    expect(configSets(r.calls)).toEqual([]);
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.memorySearch).toEqual({});
    expect(r.state).toContain("failures=1");
  });

  it("does not retry a failed pull inside the retry window", () => {
    const recent = Math.floor(Date.now() / 1000) - 60;
    const r = run({ present: false, state: `last_attempt=${recent}\nfailures=1\n` });
    expect(r.status).toBe(0);
    expect(pulls(r.calls)).toEqual([]);
    expect(configSets(r.calls)).toEqual([]);
  });

  it("retries once the retry window has elapsed", () => {
    const old = Math.floor(Date.now() / 1000) - 7 * 60 * 60;
    const r = run({ present: false, state: `last_attempt=${old}\nfailures=1\n` });
    expect(r.status).toBe(0);
    expect(pulls(r.calls)).toHaveLength(1);
    expect(r.state).toContain("failures=0");
  });

  it("does nothing but report when ollama is unreachable", () => {
    const r = run({ present: false, unreachable: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("not reachable");
    expect(pulls(r.calls)).toEqual([]);
    expect(configSets(r.calls)).toEqual([]);
    expect(r.memorySearch).toEqual({});
  });

  it("does not leave the provider set when openclaw config set fails", () => {
    const r = run({ present: true, openclawRc: 1 });
    expect(r.status).toBe(0);
    expect(r.memorySearch).toEqual({});
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.stdout).toContain("WARN");
  });
});

describe("gateway-pre-start.sh local embeddings hand-off", () => {
  const src = readFileSync(PRE_START, "utf-8");

  it("launches the embeddings script detached instead of pulling inline", () => {
    expect(src).toMatch(/setsid nohup "\$LOCAL_EMBEDDINGS"/);
    expect(src).toContain("ensure-local-embeddings.sh");
  });

  it("never blocks a gateway start on an ollama pull", () => {
    expect(src).not.toMatch(/ollama pull/);
  });

  it("no longer flips memorySearch inline — that lives in one place now", () => {
    expect(src).not.toMatch(/config set agents\.defaults\.memorySearch/);
  });
});
