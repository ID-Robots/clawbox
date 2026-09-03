import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
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

// install.sh runs the script synchronously and then reports which embedder the
// box ended up on (the script exits 0 on every soft failure by design).
//
// That report used to be re-derived from openclaw.json, and it read BOTH
// `memory.search` and `agents.defaults.memorySearch`, preferring whichever
// named a provider. OpenClaw 2 reads only the first and a v1 core only the
// second, so a v2 box with an empty `memory.search` and a stale legacy
// `ollama` block — the state an un-migrated upgrade leaves — was told
// "Local embeddings ready … needs no API key" while every note was being
// embedded by the default cloud provider (TASK-659).
//
// It now asks the core: `openclaw memory status --agent main --deep --json`,
// the same call src/lib/clawkeep-memory.ts makes, read with the same
// provider→location rule as providerLocation() there. So there is no second
// copy of the generation rule to drift, and no way to vouch for a box from a
// key its core ignores.
//
// These run the shipped block out of install.sh — the edition gate, the CLI
// call, the classifier and the message it picks — under `set -euo pipefail`
// against a stub `openclaw`. The openclaw.json fixture is still written on
// every run: it is what the old check read, so a regression back to reading
// the config is visible rather than silently equivalent.
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

  interface Report {
    out: string;
    /** Every argv the stub `openclaw` was called with, one per line. */
    cliCalls: string;
    /** One line per invocation of the stub ensure-local-embeddings.sh. */
    helperCalls: string;
  }

  /**
   * Run the shipped block against a fake device root.
   *
   * `as_clawbox` is the real seam — on a device it runs the command as the
   * clawbox user. The stub keeps the argv the installer builds and only
   * redirects `/home/clawbox/...` into the temp root.
   *
   * `cli` scripts the stub `openclaw`: a JSON string to print, or `null` to
   * exit 1 saying nothing (a core that is not there, or cannot answer).
   * `cliExit` is the status it then exits with — the case where a core prints
   * a complete, parseable answer and still fails.
   */
  function report(opts: {
    edition?: "openclaw" | "hermes";
    cli: string | null;
    cliExit?: number;
    config?: unknown;
    /**
     * Run the block on a box with no `python3`. `--step ollama_install` runs
     * standalone, without `step_apt_update`, so the interpreter this block
     * parses with is not guaranteed on that path — and the message it prints
     * when it cannot parse names the wrong culprit if it blames the core.
     */
    withoutPython?: boolean;
  }): Report {
    if (!BLOCK) throw new Error("install.sh post-run check not found, or extracted truncated");
    const home = path.join(dir, "device", "home", "clawbox");
    const project = path.join(dir, "device", "project");
    const stubBin = path.join(dir, "device", "bin");
    const cliLog = path.join(dir, "device", "openclaw-calls.log");
    const helperLog = path.join(dir, "device", "helper-calls.log");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    mkdirSync(path.join(project, "scripts"), { recursive: true });
    mkdirSync(stubBin, { recursive: true });
    // What the OLD check read. Deliberately the state that made it lie: an
    // empty v2 home beside a stale legacy block still naming ollama.
    writeFileSync(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify(
        opts.config ?? {
          memory: { search: {} },
          agents: { defaults: { memorySearch: { provider: "ollama", model: MODEL } } },
        },
      ),
    );
    // Best-effort and its exit code says nothing; the check under test is what
    // reports afterwards.
    writeFileSync(
      path.join(project, "scripts", "ensure-local-embeddings.sh"),
      `#!/usr/bin/env bash\nprintf 'ran\\n' >> ${JSON.stringify(helperLog)}\nexit 0\n`,
    );
    chmodSync(path.join(project, "scripts", "ensure-local-embeddings.sh"), 0o755);
    const openclaw = path.join(stubBin, "openclaw");
    writeFileSync(
      openclaw,
      opts.cli === null
        ? `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(cliLog)}\nexit 1\n`
        : `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(cliLog)}\ncat <<'JSON'\n${opts.cli}\nJSON\nexit ${opts.cliExit ?? 0}\n`,
    );
    chmodSync(openclaw, 0o755);
    // A bounded call is part of the contract, but the real `timeout` is not on
    // every dev host; the stub keeps the argv assertable and runs the command.
    const timeoutStub = path.join(stubBin, "timeout");
    writeFileSync(
      timeoutStub,
      // Skip the options (-k takes a value) and the duration, then run it.
      '#!/usr/bin/env bash\nwhile [ "${1#-}" != "$1" ]; do\n  case "$1" in -k|--kill-after) shift 2 ;; *) shift ;; esac\ndone\nshift\nexec "$@"\n',
    );
    chmodSync(timeoutStub, 0o755);

    const program = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `FAKE_ROOT=${JSON.stringify(home)}`,
      // The device home the installer names. Never touched: as_clawbox maps it.
      'CLAWBOX_HOME="/home/clawbox"',
      `PROJECT_DIR=${JSON.stringify(project)}`,
      `OPENCLAW_BIN=${JSON.stringify(openclaw)}`,
      // A PATH with no python3 on it still has to resolve `bash` for the stub
      // shebangs, so it is the real bash by symlink and nothing else.
      opts.withoutPython
        ? `PATH=${JSON.stringify(stubBin)}:${JSON.stringify(pythonlessBin())}`
        : `PATH=${JSON.stringify(stubBin)}:$PATH`,
      "as_clawbox() {",
      "  local a; local -a mapped=()",
      '  for a in "$@"; do',
      '    case "$a" in /home/clawbox*) mapped+=("$FAKE_ROOT${a#/home/clawbox}") ;; *) mapped+=("$a") ;; esac',
      "  done",
      '  "${mapped[@]}"',
      "}",
      'as_clawbox_login() { "$@"; }',
      `has_openclaw_harness() { return ${opts.edition === "hermes" ? 1 : 0}; }`,
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
    // it finds — a core that hangs, is absent, or answers nonsense included.
    expect(run.status).toBe(0);
    return {
      out: `${run.stdout ?? ""}${run.stderr ?? ""}`,
      cliCalls: existsSync(cliLog) ? readFileSync(cliLog, "utf-8") : "",
      helperCalls: existsSync(helperLog) ? readFileSync(helperLog, "utf-8") : "",
    };
  }

  /**
   * A PATH directory carrying `bash` and nothing else, so `python3` is
   * genuinely unresolvable rather than merely stubbed to fail — which is what
   * a box that never ran `step_apt_update` looks like to this block.
   */
  function pythonlessBin(): string {
    const bin = path.join(dir, "device", "nopython");
    mkdirSync(bin, { recursive: true });
    const bash = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf-8" }).stdout.trim();
    if (!bash) throw new Error("could not locate bash");
    symlinkSync(bash, path.join(bin, "bash"));
    return bin;
  }

  /** One `openclaw memory status --json` row, as the core shapes it. */
  const status = (provider: unknown, model: unknown = MODEL) =>
    JSON.stringify([{ agentId: "main", status: { provider, model } }]);

  it("ships the check as a block this test can run verbatim", () => {
    expect(BLOCK).toContain("memory status");
  });

  it("asks the core, bounded, instead of re-reading openclaw.json", () => {
    const run = report({ cli: status("ollama") });
    expect(run.cliCalls).toContain("memory status --agent main --deep --json");
    // -k, because `timeout` alone sends SIGTERM only and
    // collectMemoryStatusJson() escalates to SIGKILL after 5 s: a CLI that
    // ignores SIGTERM must not hang the installer where it would not hang the
    // panel this block exists to agree with.
    expect(BLOCK).toMatch(/timeout -k \d+ \d+ "\$OPENCLAW_BIN" memory status/);
  });

  it("reports the model the core resolved as ready", () => {
    expect(report({ cli: status("ollama") }).out).toContain(READY);
  });

  it("does not call a box on a stale legacy block ready", () => {
    // The un-migrated upgrade, and the whole of TASK-659: openclaw.json still
    // says ollama under the OpenClaw 1 key, and the core reports openai.
    const run = report({ cli: status("openai", "text-embedding-3-large") });
    expect(run.out).not.toContain(READY);
    expect(run.out).toMatch(/cloud/i);
    // Named so the operator knows which provider is being paid for.
    expect(run.out).toContain("openai");
  });

  it("treats an on-device provider as local whatever the model is", () => {
    // providerLocation() in src/lib/clawkeep-memory.ts maps ollama and local to
    // "local" regardless of model, and the Memory Shard panel shows that. The
    // installer must not call the same box a cloud embedder.
    const run = report({ cli: status("ollama", "nomic-embed-text") });
    expect(run.out).not.toMatch(/cloud/i);
    expect(run.out).toContain("nomic-embed-text");
  });

  it("reports a core that switched memory search off as off, not as ready", () => {
    const run = report({ cli: status("none", "") });
    expect(run.out).not.toContain(READY);
    expect(run.out).toMatch(/switched off/i);
  });

  for (const [name, cli] of [
    ["a core that cannot answer", null],
    ["a core that answers nonsense", "not json at all"],
    ["a core that answers an empty provider", JSON.stringify([{ agentId: "main", status: {} }])],
  ] as const) {
    it(`says it could not ask over ${name}, rather than guessing`, () => {
      // Every one of these used to collapse into a claim about the config.
      const run = report({ cli });
      expect(run.out).not.toContain(READY);
      // One message for three states: the CLI could not be asked, its answer
      // could not be read, or it answered without naming a provider. Naming
      // only the first was wrong for the third, which did answer.
      expect(run.out).toMatch(/could not read an embedder/i);
    });
  }

  it("does not trust a core that printed an answer and then failed", () => {
    // TASK-659's own defect, re-entered through the exit code instead of the
    // config key. `--deep` failing its provider probe after emitting the
    // shallow status, a core that reports and then exits on an unrelated
    // warning, or `timeout` killing the CLI after a complete document has
    // already been written — each is a box whose embedder is NOT known.
    // collectMemoryStatusJson() in src/lib/clawkeep-memory.ts rejects on
    // `code !== 0`; this block must not disagree with it.
    const run = report({ cli: status("ollama"), cliExit: 1 });
    expect(run.out).not.toContain(READY);
    expect(run.out).toMatch(/could not read an embedder/i);
  });

  it("does not report a local provider the core named no model for as ready on nothing", () => {
    // `local:` + an empty model fell through to the `local:*` arm and printed
    // "Local embeddings ready on , not qwen3-embedding:0.6b" — a sentence with
    // a hole in it that still claims READY over a box whose index cannot be
    // matched to anything.
    const run = report({ cli: status("ollama", "") });
    expect(run.out).not.toMatch(/ready on\s*,/);
    expect(run.out).not.toMatch(/on\s+,\s+not/);
    // On-device and keyless is still true and worth saying; the model is not.
    expect(run.out).toMatch(/named no model/i);
    expect(run.out).toMatch(/non-fatal/);
  });

  it("blames its own missing interpreter, not the core, when it cannot parse", () => {
    // The catch-all says "openclaw memory status did not answer, or named no
    // provider". With no python3 the core answered perfectly and the installer
    // could not read it — a warning that names the wrong thing sends the
    // operator to the wrong box.
    const run = report({ cli: status("ollama"), withoutPython: true });
    expect(run.out).not.toContain(READY);
    expect(run.out).toMatch(/python3/i);
    expect(run.out).not.toMatch(/did not answer/i);
    expect(run.out).toMatch(/non-fatal/);
    // It still ASKED: the core was reached and answered, which is why blaming
    // it would be false.
    expect(run.cliCalls).toContain("memory status");
  });

  it("says memory search is not on this edition on hermes, and asks no core", () => {
    // step_ollama_install has no edition guard, and a hermes box has no core,
    // no openclaw.json and no memory search to have an embedder.
    const run = report({ edition: "hermes", cli: status("ollama") });
    expect(run.out).not.toContain(READY);
    expect(run.out).toMatch(/does not include it/i);
    expect(run.cliCalls).toBe("");
  });

  it("does no embedding work at all on hermes, not just no reporting", () => {
    // The gate used to sit below the helper, so a hermes box ran
    // ensure-local-embeddings.sh, found no provider anywhere, and pulled a
    // ~640 MB model whose config write then failed soft by design — and the
    // very next line told the operator the edition does not have the feature.
    expect(report({ edition: "hermes", cli: status("ollama") }).helperCalls).toBe("");
    // The control: it still runs where there IS a core to configure.
    expect(report({ cli: status("ollama") }).helperCalls).toContain("ran");
  });
});
