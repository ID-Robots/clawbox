import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, chmodSync } from "node:fs";
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
      '# FAIL_ON matches against the whole argv so a test can fail exactly one call.',
      'if [ -n "${FAIL_ON:-}" ] && [[ "$*" == *"$FAIL_ON"* ]]; then exit 1; fi',
      '# OpenClaw 2 refuses the retired key outright, exactly like the real CLI',
      '# (its owner rule for agents.defaults.memorySearch, verified in 2026.8.1).',
      'if [ "${STUB_OPENCLAW_V2:-0}" = "1" ] && [ "${1:-}" = "config" ] && [ "${2:-}" = "set" ] && [[ "${3:-}" == agents.defaults.memorySearch* ]]; then',
      '  echo "agents.defaults.memorySearch moved to memory.search. Run \\"openclaw doctor --fix\\"." >&2; exit 1',
      'fi',
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
  failOn?: string;
  flockBin?: string;
  stateFile?: string;
  /** What gateway-pre-start.sh exports: "1" on OpenClaw 2, "0" before it, unset from install.sh. */
  v2Env?: "1" | "0";
  /** Where the fixture keeps provider/model: OpenClaw 2's memory.search or the legacy path. */
  keys?: "v2" | "legacy";
  /** Version of the installed core's package.json next to the binary (install.sh path: no env). */
  installedVersion?: string;
  /** Whether the stub CLI behaves like OpenClaw 2 (refuses the retired key). */
  stubV2?: boolean;
};

/** The real CLI's rule: memory.search from 2026.8 on. */
function isV2Release(version: string): boolean {
  const [year, month] = version.split(".").map(Number);
  return year > 2026 || (year === 2026 && month >= 8);
}

function run(opts: RunOpts = {}) {
  // Each run starts from a clean call log so a second run in the same test
  // cannot inherit the first one's calls.
  rmSync(callsPath, { force: true });
  const cfg: Record<string, unknown> = {};
  if (opts.provider !== undefined) cfg.provider = opts.provider;
  if (opts.model !== undefined) cfg.model = opts.model;
  const home = opts.keys === "v2" ? { memory: { search: cfg } } : { agents: { defaults: { memorySearch: cfg } } };
  writeFileSync(configPath, JSON.stringify(Object.keys(cfg).length ? home : { agents: { defaults: {} } }));
  // The binary lives in bin/ and the core's package.json in ../lib/node_modules/openclaw,
  // the npm --prefix layout of /home/clawbox/.npm-global on the box.
  let openclawBin = "openclaw";
  if (opts.installedVersion !== undefined) {
    const pkgDir = path.join(dir, "lib", "node_modules", "openclaw");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "openclaw", version: opts.installedVersion }));
    openclawBin = path.join(binDir, "openclaw");
  }
  const stubV2 = opts.stubV2 ?? (opts.v2Env === "1" || (opts.installedVersion !== undefined && isV2Release(opts.installedVersion)));
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
      OPENCLAW_BIN: openclawBin,
      OPENCLAW_CONFIG: configPath,
      CLAWBOX_OPENCLAW_V2: opts.v2Env ?? "",
      STUB_OPENCLAW_V2: stubV2 ? "1" : "0",
      TEST_CONFIG: configPath,
      OLLAMA_TAGS_URL: "http://stub/api/tags",
      TAGS_FIXTURE: tagsPath,
      EMBED_STATE_FILE: opts.stateFile ?? statePath,
      CALLS_LOG: callsPath,
      OLLAMA_PULL_RC: String(opts.pullRc ?? 0),
      OPENCLAW_RC: String(opts.openclawRc ?? 0),
      FAIL_ON: opts.failOn ?? "",
      FLOCK_BIN: opts.flockBin ?? "flock",
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
    /** OpenClaw 2's home for the same choice. */
    search: (config.memory?.search ?? {}) as Record<string, string>,
    state: existsSync(opts.stateFile ?? statePath) ? readFileSync(opts.stateFile ?? statePath, "utf-8") : "",
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
    // Order matters: the provider write is what activates local embeddings, so
    // it goes last and a failure earlier leaves the box where it was.
    expect(configSets(r.calls)).toEqual([
      `openclaw config set agents.defaults.memorySearch.model ${MODEL}`,
      "openclaw config set agents.defaults.memorySearch.provider ollama",
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

  it("rewrites only the model when the provider is already ollama", () => {
    const r = run({ provider: "ollama", model: "nomic-embed-text", present: true });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual([
      `openclaw config set agents.defaults.memorySearch.model ${MODEL}`,
    ]);
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

  it("changes nothing when the model write fails", () => {
    const r = run({ present: true, failOn: "memorySearch.model" });
    expect(r.status).toBe(0);
    expect(r.memorySearch).toEqual({});
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.stdout).toContain("nothing changed");
  });

  it("leaves the provider as it was when the provider write fails", () => {
    // Model first, provider last: a failed provider write must not leave the
    // box on ollama, and the box keeps embedding exactly where it did before.
    const r = run({ present: true, failOn: "memorySearch.provider" });
    expect(r.status).toBe(0);
    expect(r.memorySearch.provider).toBeUndefined();
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.stdout).toContain("provider is unchanged");
  });

  it("records the reindex as owed when it fails, and finishes it on the next run", () => {
    const first = run({ present: true, failOn: "memory index" });
    expect(first.status).toBe(0);
    expect(first.memorySearch).toMatchObject({ provider: "ollama", model: MODEL });
    expect(first.state).toContain("reindex_pending=1");
    expect(first.stdout).toContain("retrying on the next run");

    // Second run: config already correct, so the old code said "nothing to do"
    // and left memory search fail-closed forever.
    const second = run({ provider: "ollama", model: MODEL, present: true, state: first.state });
    expect(second.status).toBe(0);
    expect(configSets(second.calls)).toEqual([]);
    expect(reindexes(second.calls)).toHaveLength(1);
    expect(second.state).toContain("reindex_pending=0");
  });

  it("does nothing at all when it cannot take the lock", () => {
    const r = run({ present: true, flockBin: "flock-that-does-not-exist" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cannot serialise runs");
    expect(pulls(r.calls)).toEqual([]);
    expect(configSets(r.calls)).toEqual([]);
    expect(reindexes(r.calls)).toEqual([]);
  });

  it("does nothing at all when the lock file cannot be opened", () => {
    // A regular file where a directory should be: the open fails with ENOTDIR
    // for every user, including root, which a mode-0500 directory would not.
    const notADirectory = path.join(dir, "not-a-directory");
    writeFileSync(notADirectory, "");
    const r = run({ present: true, stateFile: path.join(notADirectory, "state") });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cannot open");
    expect(configSets(r.calls)).toEqual([]);
  });

  it("records the owed reindex before the provider is switched, not after", () => {
    // A run killed between the provider write and the marker would leave a
    // configured backend and an index nobody ever rebuilds.
    const r = run({ present: true, failOn: "memorySearch.provider" });
    expect(r.state).toContain("reindex_pending=1");
    expect(r.memorySearch.provider).toBeUndefined();
  });

  it("writes the state file atomically and leaves no temp file behind", () => {
    const script = readFileSync(SCRIPT, "utf-8");
    expect(script).toMatch(/mv -f "\$tmp" "\$EMBED_STATE_FILE"/);
    const r = run({ present: true });
    expect(r.status).toBe(0);
    // The temp name carries the pid, so match the prefix rather than one name.
    const leaked = readdirSync(path.dirname(statePath))
      .filter((f) => f.startsWith(`${path.basename(statePath)}.tmp.`));
    expect(leaked).toEqual([]);
  });

  it("takes a lock that outlives a long pull rather than one that expires", () => {
    const script = readFileSync(SCRIPT, "utf-8");
    expect(script).toMatch(/"\$FLOCK_BIN" -n 9/);
    expect(script).not.toMatch(/-mmin/);
  });

  it("does not leave the provider set when openclaw config set fails", () => {
    const r = run({ present: true, openclawRc: 1 });
    expect(r.status).toBe(0);
    expect(r.memorySearch).toEqual({});
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.stdout).toContain("WARN");
  });
});

// OpenClaw 2 (2026.8+) moved the embedding choice from
// agents.defaults.memorySearch.* to memory.search.* and its CLI refuses the old
// path ("moved to memory.search. Run openclaw doctor --fix"). Measured on a
// 2026.8.1 box: openclaw.json already carried memory.search.provider=ollama, the
// script read the retired path, saw "unset", tried the retired write, and logged
// "WARN: could not set the local embedding model" on every gateway boot — so
// no v2 box could ever be pointed at local embeddings, and a correctly
// configured one was told nothing changed.
describe.skipIf(!canRun)("ensure-local-embeddings.sh on OpenClaw 2", () => {
  it("sees a box already on local embeddings under memory.search and leaves it alone", () => {
    const r = run({ v2Env: "1", keys: "v2", provider: "ollama", model: MODEL, present: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already runs on local embeddings");
    expect(configSets(r.calls)).toEqual([]);
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.search).toEqual({ provider: "ollama", model: MODEL });
  });

  it("writes memory.search.* (model first, provider last) when pre-start says OpenClaw 2", () => {
    const r = run({ v2Env: "1", present: true });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual([
      `openclaw config set memory.search.model ${MODEL}`,
      "openclaw config set memory.search.provider ollama",
    ]);
    expect(reindexes(r.calls)).toHaveLength(1);
    expect(r.search).toMatchObject({ provider: "ollama", model: MODEL });
    // The retired path is never written on a v2 box — the CLI would refuse it anyway.
    expect(r.memorySearch).toEqual({});
  });

  it("respects a deliberate remote provider chosen under memory.search", () => {
    const r = run({ v2Env: "1", keys: "v2", provider: "openai", model: "text-embedding-3-large", present: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("deliberate choice");
    expect(configSets(r.calls)).toEqual([]);
    expect(pulls(r.calls)).toEqual([]);
    expect(r.search.provider).toBe("openai");
  });

  it("leaves a remote provider alone even when it is still recorded under the legacy home", () => {
    // The upgrade case: memory.search is empty, the owner's OpenAI choice sits
    // in agents.defaults.memorySearch from the box's OpenClaw 1 days, and
    // `doctor --fix` has not migrated it yet. Reading only the live home saw
    // "unset" and pointed the box at ollama over the owner's head.
    const r = run({ v2Env: "1", keys: "legacy", provider: "openai", model: "text-embedding-3-large", present: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("deliberate choice");
    expect(configSets(r.calls)).toEqual([]);
    expect(pulls(r.calls)).toEqual([]);
    expect(r.search).toEqual({});
    expect(r.memorySearch.provider).toBe("openai");
  });

  it("still migrates a legacy \"ollama\" onto memory.search — the guard reads both homes, the write does not", () => {
    const r = run({ v2Env: "1", keys: "legacy", provider: "ollama", model: MODEL, present: true });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual([
      `openclaw config set memory.search.model ${MODEL}`,
      "openclaw config set memory.search.provider ollama",
    ]);
    expect(r.search).toMatchObject({ provider: "ollama", model: MODEL });
  });

  it("derives the generation from the installed core when install.sh calls it with no env", () => {
    const r = run({ installedVersion: "2026.8.1", present: true });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual([
      `openclaw config set memory.search.model ${MODEL}`,
      "openclaw config set memory.search.provider ollama",
    ]);
    expect(r.search).toMatchObject({ provider: "ollama", model: MODEL });
  });

  it("keeps the legacy keys for a core older than 2026.8", () => {
    const r = run({ installedVersion: "2026.7.3", present: true });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual([
      `openclaw config set agents.defaults.memorySearch.model ${MODEL}`,
      "openclaw config set agents.defaults.memorySearch.provider ollama",
    ]);
    expect(r.search).toEqual({});
  });

  it("lets the generation gateway-pre-start.sh exported win over the package on disk", () => {
    // Pre-start asked the binary itself; a package.json that disagrees is the
    // mid-update case, and the binary is the process that parses the write.
    const r = run({ installedVersion: "2026.8.1", v2Env: "0", stubV2: false, present: true });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)[0]).toBe(`openclaw config set agents.defaults.memorySearch.model ${MODEL}`);
  });

  it("never calls `openclaw --version` to find out — it costs ~10 s on a Jetson", () => {
    const r = run({ installedVersion: "2026.8.1", present: true });
    expect(r.calls.filter((c) => c.includes("--version"))).toEqual([]);
    expect(readFileSync(SCRIPT, "utf-8")).not.toMatch(/"\$OPENCLAW_BIN" --version/);
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
    expect(src).not.toMatch(/config set memory\.search/);
  });

  it("exports the generation it decided on, so the script cannot disagree with it", () => {
    expect(src).toMatch(/^export CLAWBOX_OPENCLAW_V2$/m);
    expect(src.indexOf("export CLAWBOX_OPENCLAW_V2")).toBeLessThan(src.indexOf('setsid nohup "$LOCAL_EMBEDDINGS"'));
  });
});

// install.sh runs the script synchronously and then reads openclaw.json to
// report the outcome (the script exits 0 on every soft failure by design).
//
// That report has to name the embedder the INSTALLED core will use. OpenClaw 2
// (2026.8+) reads `memory.search.*` and ignores `agents.defaults.memorySearch`
// entirely; a v1 core does the reverse. The check used to read both and prefer
// whichever named a provider, so a v2 box with an empty `memory.search` and a
// stale legacy `ollama` block — the state an un-migrated upgrade leaves — was
// told "Local embeddings ready … needs no API key" while every note was being
// embedded by the default cloud provider (TASK-659). The mirror case, a v1
// core with only `memory.search` filled in, reported the same thing.
//
// These run the shipped block out of install.sh — the generation gate, the
// config read and the message it picks — under `set -euo pipefail` against a
// fake device root, once per generation.
describe.skipIf(!canRun)("install.sh local embeddings post-run check", () => {
  const INSTALL_SH = readFileSync(path.resolve(process.cwd(), "install.sh"), "utf-8");

  /**
   * The embedding half of `step_ollama_install`: from the helper path it runs
   * to the end of the function. Sliced rather than taking the whole function,
   * which would try to install Ollama itself.
   */
  const BLOCK = (() => {
    const start = INSTALL_SH.indexOf('  local ENSURE_EMBEDDINGS="$PROJECT_DIR/scripts/ensure-local-embeddings.sh"');
    if (start < 0) return "";
    const end = INSTALL_SH.indexOf("\n}", start);
    if (end < 0) return "";
    const body = INSTALL_SH.slice(start, end);
    // The "must not say ready" assertions would pass over a truncated slice,
    // so the slice has to reach the block's last statement to count.
    return body.includes("could not pull qwen3-embedding:0.6b") ? body : "";
  })();

  const READY = "Local embeddings ready";

  /**
   * Run the shipped block against a fake device root.
   *
   * `as_clawbox` is the real seam — on a device it runs the command as the
   * clawbox user, so the config it opens is that user's home. The stub keeps
   * the argv the installer builds and only redirects `/home/clawbox/...` into
   * the temp root.
   */
  function report(opts: { v2: boolean; config: unknown }): string {
    if (!BLOCK) throw new Error("install.sh post-run check not found, or extracted truncated");
    const home = path.join(dir, "device", "home", "clawbox");
    const project = path.join(dir, "device", "project");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    mkdirSync(path.join(project, "scripts"), { recursive: true });
    // `undefined` means "the file is not readable JSON" — a config the
    // installer has to survive rather than a shape it has to understand.
    writeFileSync(
      path.join(home, ".openclaw", "openclaw.json"),
      opts.config === undefined ? "{ this is not json" : JSON.stringify(opts.config),
    );
    // Best-effort and its exit code says nothing; the check under test is what
    // reads the config afterwards.
    writeFileSync(path.join(project, "scripts", "ensure-local-embeddings.sh"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(path.join(project, "scripts", "ensure-local-embeddings.sh"), 0o755);

    const program = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `FAKE_ROOT=${JSON.stringify(home)}`,
      // The device home the installer names. Never touched: as_clawbox maps it.
      'CLAWBOX_HOME="/home/clawbox"',
      `PROJECT_DIR=${JSON.stringify(project)}`,
      "as_clawbox() {",
      "  local a; local -a mapped=()",
      '  for a in "$@"; do',
      '    case "$a" in /home/clawbox*) mapped+=("$FAKE_ROOT${a#/home/clawbox}") ;; *) mapped+=("$a") ;; esac',
      "  done",
      '  "${mapped[@]}"',
      "}",
      'as_clawbox_login() { "$@"; }',
      `openclaw_is_v2() { return ${opts.v2 ? 0 : 1}; }`,
      "check_embeddings() {",
      BLOCK,
      "}",
      "check_embeddings",
      "",
    ].join("\n");

    const file = path.join(dir, "post-run-check.sh");
    writeFileSync(file, program);
    chmodSync(file, 0o755);
    const run = spawnSync("bash", [file], { encoding: "utf-8", timeout: 30_000 });
    // Best-effort by contract: the block must never abort the install, whatever
    // it finds — including a config it cannot parse.
    expect(run.status).toBe(0);
    return `${run.stdout ?? ""}${run.stderr ?? ""}`;
  }

  const LOCAL = { provider: "ollama", model: MODEL };
  const REMOTE = { provider: "openai", model: "text-embedding-3-large" };
  const cfg = (search: unknown, legacy?: unknown) => ({
    memory: { search },
    ...(legacy === undefined ? {} : { agents: { defaults: { memorySearch: legacy } } }),
  });

  it("ships the check as a block this test can run verbatim", () => {
    expect(BLOCK).toContain("import json");
  });

  it("accepts OpenClaw 2's memory.search home", () => {
    expect(report({ v2: true, config: cfg(LOCAL) })).toContain(READY);
  });

  it("still accepts the legacy agents.defaults.memorySearch home on a v1 core", () => {
    expect(report({ v2: false, config: cfg({}, LOCAL) })).toContain(READY);
  });

  it("does not report a box that is on a remote provider, or not configured, as ready", () => {
    const remote = report({ v2: true, config: cfg(REMOTE) });
    expect(remote).not.toContain(READY);
    expect(remote).toMatch(/cloud/i);
    // The provider is named so the operator knows which key to fix.
    expect(remote).toContain("openai");

    const unset = report({ v2: true, config: cfg({}) });
    expect(unset).not.toContain(READY);
    expect(unset).toMatch(/cloud/i);
    expect(unset).toContain("memory.search");

    expect(report({ v2: true, config: cfg({ model: MODEL }) })).not.toContain(READY);
  });

  it("reads only the home the installed core parses — a stale block cannot vouch for the box", () => {
    // The un-migrated upgrade: the OpenClaw 1 choice still says ollama and the
    // v2 core does not read it. "Needs no API key" would be a false claim.
    expect(report({ v2: true, config: cfg({}, LOCAL) })).not.toContain(READY);
    // Mirror image, and the reason the gate is not "prefer memory.search":
    // that same config on a v1 core IS on local embeddings.
    expect(report({ v2: false, config: cfg({}, LOCAL) })).toContain(READY);
    // And a v1 core ignores memory.search however it is filled in.
    expect(report({ v2: false, config: cfg(LOCAL, {}) })).not.toContain(READY);
    expect(report({ v2: true, config: cfg(LOCAL, REMOTE) })).toContain(READY);
  });

  it("survives a config it cannot read at all", () => {
    expect(report({ v2: true, config: undefined })).not.toContain(READY);
  });
});
