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
// of its logic — against stub `hf`, `curl` and `openclaw` binaries on PATH.
// The `openclaw` stub really applies `config set` to the JSON file, so the
// idempotency and "never leave it half-configured" claims are checked against
// actual config state rather than against a call log alone.
//
// The embedder is Qwen3-Embedding on ClawBox's own llama.cpp, reached THROUGH
// the web server's local-AI proxy (which is what wakes it). The script's job:
// have the GGUF on disk, point memory.search at the proxy with the service
// bearer, label queries and documents, and reindex once for the new identity.

const SCRIPT = path.resolve(process.cwd(), "scripts/ensure-local-embeddings.sh");
const PRE_START = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const MODEL = "qwen3-embedding-0.6b";
const PROVIDER = "openai-compatible";
const GGUF = "Qwen3-Embedding-0.6B-Q8_0.gguf";
const HF_REPO = "Qwen/Qwen3-Embedding-0.6B-GGUF";
// Loopback, like the real one: the script treats openai-compatible at any
// other host as the owner's deliberate choice. The stub curl ignores the URL.
const PROXY = "http://127.0.0.1:3100/setup-api/local-ai/embed/v1";
const TOKEN = "0123456789abcdef0123456789abcdef";
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const canRun = hasBash && hasPython3;

let dir: string;
let binDir: string;
let configPath: string;
let statePath: string;
let callsPath: string;
let envLogPath: string;
let modelDir: string;
let tokenPath: string;

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
  envLogPath = path.join(dir, "env.log");
  modelDir = path.join(dir, "models");
  tokenPath = path.join(dir, ".local-ai-token");
  writeFileSync(configPath, JSON.stringify({ agents: { defaults: {} } }));

  // curl: the proxy. Records the argv (bearer included); answers only while PROXY_UP=1.
  writeStub(
    "curl",
    [
      'echo "curl $*" >> "$CALLS_LOG"',
      'if [ "${PROXY_UP:-1}" != "1" ]; then exit 7; fi',
      "exit 0",
    ].join("\n"),
  );

  // hf: record the download and honour a scripted exit code; on success put the
  // file where the script then looks, exactly like the real one.
  writeStub(
    "hf",
    [
      'echo "hf $*" >> "$CALLS_LOG"',
      'if [ "${HF_RC:-0}" != "0" ]; then exit "$HF_RC"; fi',
      'if [ "${HF_NO_FILE:-0}" = "1" ]; then exit 0; fi',
      'dir=""; while [ $# -gt 0 ]; do [ "$1" = "--local-dir" ] && dir="$2"; shift; done',
      `mkdir -p "$dir" && : > "$dir/${GGUF}"`,
    ].join("\n"),
  );

  // sleep: the proxy wait loop must not take real seconds.
  writeStub("sleep", "exit 0");

  // openclaw: record every call (and the tree-selecting environment it saw)
  // and really apply `config set`. Which FILE it writes follows the real
  // CLI's rules, not the test's: OPENCLAW_CONFIG_PATH when set, else
  // `$OPENCLAW_HOME/.openclaw/openclaw.json` (OpenClaw reads OPENCLAW_HOME as
  // the ACCOUNT home), else the fixture. A `--strict-json --merge` value is
  // parsed and merged into the object at the key, like the real `--merge`.
  writeStub(
    "openclaw",
    [
      'echo "openclaw $*" >> "$CALLS_LOG"',
      'echo "OPENCLAW_HOME=${OPENCLAW_HOME-<unset>} OPENCLAW_CONFIG_PATH=${OPENCLAW_CONFIG_PATH-<unset>} OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR-<unset>}" >> "$ENV_LOG"',
      'if [ "${OPENCLAW_RC:-0}" != "0" ]; then exit "$OPENCLAW_RC"; fi',
      '# FAIL_ON matches against the whole argv so a test can fail exactly one call.',
      'if [ -n "${FAIL_ON:-}" ] && [[ "$*" == *"$FAIL_ON"* ]]; then exit 1; fi',
      '# OpenClaw 2 refuses the retired key outright, exactly like the real CLI',
      '# (its owner rule for agents.defaults.memorySearch, verified in 2026.8.1).',
      'if [ "${STUB_OPENCLAW_V2:-0}" = "1" ] && [ "${1:-}" = "config" ] && [ "${2:-}" = "set" ] && [[ "${3:-}" == agents.defaults.memorySearch* ]]; then',
      '  echo "agents.defaults.memorySearch moved to memory.search. Run \\"openclaw doctor --fix\\"." >&2; exit 1',
      'fi',
      'if [ "${1:-}" = "config" ] && [ "${2:-}" = "set" ]; then',
      '  target="$TEST_CONFIG"',
      '  if [ -n "${OPENCLAW_CONFIG_PATH:-}" ]; then target="$OPENCLAW_CONFIG_PATH";',
      '  elif [ -n "${OPENCLAW_HOME:-}" ]; then target="$OPENCLAW_HOME/.openclaw/openclaw.json"; fi',
      '  if [ "${STUB_WRITE_ELSEWHERE:-0}" = "1" ]; then target="$TEST_CONFIG.elsewhere"; fi',
      '  mkdir -p "$(dirname "$target")"',
      '  [ -f "$target" ] || echo "{}" > "$target"',
      '  CFG_KEY="$3" CFG_VALUE="$4" CFG_ARGV="$*" python3 - "$target" <<\'PY\'',
      "import json, os, sys",
      "path = sys.argv[1]",
      "cfg = json.load(open(path))",
      "node = cfg",
      "parts = os.environ['CFG_KEY'].split('.')",
      "for key in parts[:-1]:",
      "    node = node.setdefault(key, {})",
      "argv = os.environ['CFG_ARGV']",
      "value = os.environ['CFG_VALUE']",
      "if '--strict-json' in argv:",
      "    value = json.loads(value)",
      "if '--merge' in argv and isinstance(value, dict) and isinstance(node.get(parts[-1]), dict):",
      "    node[parts[-1]] = {**node[parts[-1]], **value}",
      "else:",
      "    node[parts[-1]] = value",
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
  baseUrl?: string;
  apiKey?: string;
  /** Write queryInputType/documentInputType as the script would. */
  inputTypes?: boolean;
  /** Whether the GGUF is on disk (default: yes). */
  present?: boolean;
  hfRc?: number;
  hfNoFile?: boolean;
  openclawRc?: number;
  state?: string;
  proxyDown?: boolean;
  noToken?: boolean;
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
  /** Extra keys memory.search already carries (what a merge must keep). */
  extra?: Record<string, unknown>;
  /** Environment an ancestor (the updater, a login shell) may have exported. */
  extraEnv?: Record<string, string>;
  /** The stub CLI answers 0 but writes a different file — what a misdirected CLI did on the box. */
  writeElsewhere?: boolean;
};

/** The state of a box this script has already configured. */
const OURS: RunOpts = { provider: PROVIDER, model: MODEL, baseUrl: PROXY, apiKey: TOKEN, inputTypes: true };

/** The real CLI's rule: memory.search from 2026.8 on. */
function isV2Release(version: string): boolean {
  const [year, month] = version.split(".").map(Number);
  return year > 2026 || (year === 2026 && month >= 8);
}

function run(opts: RunOpts = {}) {
  // Each run starts from a clean call log so a second run in the same test
  // cannot inherit the first one's calls.
  rmSync(callsPath, { force: true });
  rmSync(envLogPath, { force: true });
  const cfg: Record<string, unknown> = {};
  if (opts.provider !== undefined) cfg.provider = opts.provider;
  if (opts.model !== undefined) cfg.model = opts.model;
  if (opts.baseUrl !== undefined || opts.apiKey !== undefined) {
    cfg.remote = {
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    };
  }
  if (opts.inputTypes) {
    cfg.queryInputType = "query";
    cfg.documentInputType = "document";
  }
  Object.assign(cfg, opts.extra ?? {});
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
  rmSync(modelDir, { recursive: true, force: true });
  if (opts.present !== false) {
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(modelDir, GGUF), "gguf");
  }
  if (opts.noToken) rmSync(tokenPath, { force: true });
  else writeFileSync(tokenPath, TOKEN);
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
      EMBED_STATE_FILE: opts.stateFile ?? statePath,
      EMBED_MODEL_DIR: modelDir,
      HF_BIN: path.join(binDir, "hf"),
      LOCAL_AI_TOKEN_FILE: tokenPath,
      EMBED_PROXY_URL: PROXY,
      EMBED_PROXY_WAIT_SECONDS: "0",
      PROXY_UP: opts.proxyDown ? "0" : "1",
      CALLS_LOG: callsPath,
      HF_RC: String(opts.hfRc ?? 0),
      HF_NO_FILE: opts.hfNoFile ? "1" : "0",
      OPENCLAW_RC: String(opts.openclawRc ?? 0),
      FAIL_ON: opts.failOn ?? "",
      FLOCK_BIN: opts.flockBin ?? "flock",
      ENV_LOG: envLogPath,
      STUB_WRITE_ELSEWHERE: opts.writeElsewhere ? "1" : "0",
      ...(opts.extraEnv ?? {}),
    },
  });
  const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf-8").trim().split("\n").filter(Boolean) : [];
  const cliEnv = existsSync(envLogPath) ? readFileSync(envLogPath, "utf-8").trim().split("\n").filter(Boolean) : [];
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    calls,
    /** The tree-selecting environment the stub CLI saw, one line per call. */
    cliEnv,
    memorySearch: (config.agents?.defaults?.memorySearch ?? {}) as Record<string, unknown>,
    /** OpenClaw 2's home for the same choice. */
    search: (config.memory?.search ?? {}) as Record<string, unknown>,
    state: existsSync(opts.stateFile ?? statePath) ? readFileSync(opts.stateFile ?? statePath, "utf-8") : "",
  };
}

const configSets = (calls: string[]) => calls.filter((c) => c.startsWith("openclaw config set"));
const downloads = (calls: string[]) => calls.filter((c) => c.startsWith("hf download"));
const reindexes = (calls: string[]) => calls.filter((c) => c.includes("memory index --force"));
const probes = (calls: string[]) => calls.filter((c) => c.startsWith("curl") && c.includes(`${PROXY}/models`));

/** The one value the script writes, spelled the way python's json.dumps spells it. */
const SETTINGS_JSON = JSON.stringify({
  model: MODEL,
  remote: { baseUrl: PROXY, apiKey: TOKEN },
  queryInputType: "query",
  documentInputType: "document",
  provider: PROVIDER,
}).replace(/,"/g, ', "').replace(/":/g, '": ');

/**
 * Everything the embedder needs, in ONE merged write: a sequence of writes
 * could be killed midway (the bearer write restarts the gateway, and during an
 * update that restart is a `systemctl stop` of the cgroup this runs in), and
 * a half-written switch is exactly what the box was found on.
 */
function ops(home: string) {
  return [`openclaw config set ${home} ${SETTINGS_JSON} --strict-json --merge`];
}
const LEGACY = "agents.defaults.memorySearch";
const V2 = "memory.search";

describe.skipIf(!canRun)("ensure-local-embeddings.sh", () => {
  it("leaves a deliberately chosen remote provider completely alone", () => {
    const r = run({ provider: "openai", model: "text-embedding-3-large" });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual([]);
    expect(downloads(r.calls)).toEqual([]);
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.memorySearch.provider).toBe("openai");
  });

  it("leaves the same provider id alone at any host that is not this box", () => {
    // openai-compatible is ours only at the loopback proxy; an owner who
    // pointed OpenClaw at a server across the room made a deliberate choice.
    const r = run({ provider: PROVIDER, model: "bge-m3", baseUrl: "http://192.168.1.50:8081/v1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("deliberate choice");
    expect(configSets(r.calls)).toEqual([]);
    expect(r.memorySearch.model).toBe("bge-m3");
  });

  it("downloads the model, points memory search at the proxy and reindexes when nothing is configured", () => {
    const r = run({ present: false });
    expect(r.status).toBe(0);
    expect(downloads(r.calls)).toEqual([`hf download ${HF_REPO} ${GGUF} --local-dir ${modelDir}`]);
    // One write: model, address, bearer, labels and provider land together or
    // not at all, so no kill or failure can leave the box between two of them.
    expect(configSets(r.calls)).toEqual(ops(LEGACY));
    expect(reindexes(r.calls)).toHaveLength(1);
    expect(r.memorySearch).toMatchObject({
      provider: PROVIDER,
      model: MODEL,
      remote: { baseUrl: PROXY, apiKey: TOKEN },
      queryInputType: "query",
      documentInputType: "document",
    });
  });

  it("probes the embedder THROUGH the proxy with the service bearer, never at its own port", () => {
    const r = run();
    expect(probes(r.calls)).toHaveLength(1);
    expect(probes(r.calls)[0]).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(r.calls.some((c) => c.includes(":8081"))).toBe(false);
  });

  it("skips the download when the GGUF is on disk but still configures and reindexes", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(downloads(r.calls)).toEqual([]);
    expect(configSets(r.calls)).toHaveLength(1);
    expect(reindexes(r.calls)).toHaveLength(1);
  });

  it("treats provider \"auto\" as unset", () => {
    const r = run({ provider: "auto" });
    expect(r.status).toBe(0);
    expect(r.memorySearch).toMatchObject({ provider: PROVIDER, model: MODEL });
  });

  it("migrates a box still on the ollama embedder", () => {
    const r = run({ provider: "ollama", model: "qwen3-embedding:0.6b" });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual(ops(LEGACY));
    expect(reindexes(r.calls)).toHaveLength(1);
    expect(r.memorySearch).toMatchObject({ provider: PROVIDER, model: MODEL });
  });

  it("is idempotent once the box is already on local embeddings", () => {
    const r = run(OURS);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to do");
    expect(configSets(r.calls)).toEqual([]);
    expect(reindexes(r.calls)).toEqual([]);
    expect(downloads(r.calls)).toEqual([]);
  });

  it("repairs a stale service token without a reindex", () => {
    // The token is minted by the web server and wiped with a factory reset,
    // so a restored config carries a dead bearer — a 401 OpenClaw never
    // retries. It is not part of the index identity, so no reindex.
    const r = run({ ...OURS, apiKey: "stale" });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual(ops(LEGACY));
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.state).not.toContain("reindex_pending=1");
    expect(r.stdout).toContain("already built");
    expect((r.memorySearch.remote as Record<string, string>).apiKey).toBe(TOKEN);
  });

  it("re-points a box whose settings drifted, and reindexes for the new identity", () => {
    const r = run({ ...OURS, model: "nomic-embed-text" });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual(ops(LEGACY));
    expect(reindexes(r.calls)).toHaveLength(1);
  });

  it("leaves the config untouched when the download fails, and does not reindex", () => {
    const r = run({ present: false, hfRc: 1 });
    expect(r.status).toBe(0);
    expect(downloads(r.calls)).toHaveLength(1);
    expect(configSets(r.calls)).toEqual([]);
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.memorySearch).toEqual({});
    expect(r.state).toContain("failures=1");
  });

  it("does not retry a failed download inside the retry window", () => {
    const recent = Math.floor(Date.now() / 1000) - 60;
    const r = run({ present: false, state: `last_attempt=${recent}\nfailures=1\n` });
    expect(r.status).toBe(0);
    expect(downloads(r.calls)).toEqual([]);
    expect(configSets(r.calls)).toEqual([]);
  });

  it("retries once the retry window has elapsed", () => {
    const old = Math.floor(Date.now() / 1000) - 7 * 60 * 60;
    const r = run({ present: false, state: `last_attempt=${old}\nfailures=1\n` });
    expect(r.status).toBe(0);
    expect(downloads(r.calls)).toHaveLength(1);
    expect(r.state).toContain("failures=0");
  });

  it("leaves memory search untouched when a download says it succeeded and left no file", () => {
    const r = run({ present: false, hfNoFile: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("still absent");
    expect(configSets(r.calls)).toEqual([]);
  });

  it("does nothing but report when the proxy does not answer — and earns no backoff for it", () => {
    // The web server may still be starting beside the gateway; that is not a
    // failure to remember for six hours, the next gateway start is the retry.
    const r = run({ proxyDown: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("did not answer");
    expect(configSets(r.calls)).toEqual([]);
    expect(r.memorySearch).toEqual({});
    expect(r.state).not.toContain("failures=1");
  });

  it("waits for the token the web server has not minted yet, rather than writing a bad one", () => {
    const r = run({ noToken: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no local-AI token");
    expect(probes(r.calls)).toEqual([]);
    expect(configSets(r.calls)).toEqual([]);
  });

  it("changes nothing when the settings write fails", () => {
    const r = run({ failOn: "config set agents.defaults.memorySearch" });
    expect(r.status).toBe(0);
    expect(r.memorySearch).toEqual({});
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.stdout).toContain("provider unchanged");
  });

  it("leaves the provider as it was when the write fails — there is no half-written embedder to be left on", () => {
    const r = run({ provider: "ollama", model: "qwen3-embedding:0.6b", failOn: "config set" });
    expect(r.status).toBe(0);
    expect(r.memorySearch).toEqual({ provider: "ollama", model: "qwen3-embedding:0.6b" });
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.stdout).toContain("provider unchanged");
  });

  it("writes the whole switch in one call, never a sequence", () => {
    // The old sequence (model, address, bearer, labels, provider) was killed
    // between the bearer and the labels on the box: the bearer write restarts
    // the gateway, and during an update that restart is a `systemctl stop`
    // of the cgroup this script runs in. There is no midway in one write.
    const r = run({ provider: "ollama", model: "qwen3-embedding:0.6b" });
    expect(configSets(r.calls)).toHaveLength(1);
    expect(configSets(r.calls)[0]).toContain("--strict-json --merge");
    for (const key of ["model", "baseUrl", "apiKey", "queryInputType", "documentInputType", "provider"]) {
      expect(configSets(r.calls)[0]).toContain(`"${key}"`);
    }
    expect(readFileSync(SCRIPT, "utf-8")).not.toMatch(/config set "\$MEMORY_SEARCH_KEY\.\$1"/);
  });

  it("merges into memory search rather than replacing it, so extraPaths survive", () => {
    const r = run({ provider: "ollama", model: "qwen3-embedding:0.6b", extra: { extraPaths: ["/home/clawbox/Documents"] } });
    expect(r.status).toBe(0);
    expect(r.memorySearch).toMatchObject({ provider: PROVIDER, model: MODEL, extraPaths: ["/home/clawbox/Documents"] });
  });

  it("pins the CLI to the file it reads, whatever OPENCLAW_HOME an ancestor exported", () => {
    // The updater exported OPENCLAW_HOME=<the .openclaw dir> into the
    // pre-start that launches this script; the CLI reads that name as the
    // ACCOUNT home and wrote every key under <.openclaw>/.openclaw/ while the
    // script read the real file and logged success. The two canonical
    // overrides must reach the CLI and the misread name must not.
    const decoy = path.join(dir, "decoy-home");
    const r = run({ provider: "ollama", model: "qwen3-embedding:0.6b", extraEnv: { OPENCLAW_HOME: decoy } });
    expect(r.status).toBe(0);
    expect(r.cliEnv.length).toBeGreaterThan(0);
    for (const line of r.cliEnv) {
      expect(line).toContain("OPENCLAW_HOME=<unset>");
      expect(line).toContain(`OPENCLAW_CONFIG_PATH=${configPath}`);
      expect(line).toContain(`OPENCLAW_STATE_DIR=${path.dirname(configPath)}`);
    }
    expect(existsSync(decoy)).toBe(false);
    expect(r.memorySearch).toMatchObject({ provider: PROVIDER, model: MODEL });
    expect(r.stdout).toContain("memory search -> local embeddings");
  });

  it("refuses to call it done when the write did not land in the file it reads", () => {
    // A CLI that answers 0 after writing some other tree is exactly the
    // failure that hid for twenty minutes on the box: the exit code is not
    // the verdict, the file is.
    const r = run({ provider: "ollama", model: "qwen3-embedding:0.6b", writeElsewhere: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("did not land");
    expect(r.stdout).not.toContain("memory search -> local embeddings");
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.memorySearch).toEqual({ provider: "ollama", model: "qwen3-embedding:0.6b" });
    // The owed reindex stays recorded: the next run writes again and finishes.
    expect(r.state).toContain("reindex_pending=1");
  });

  it("records the reindex as owed when it fails, and finishes it on the next run", () => {
    const first = run({ failOn: "memory index" });
    expect(first.status).toBe(0);
    expect(first.memorySearch).toMatchObject({ provider: PROVIDER, model: MODEL });
    expect(first.state).toContain("reindex_pending=1");
    expect(first.stdout).toContain("retrying on the next run");

    // Second run: config already correct, so a naive script says "nothing to
    // do" and leaves memory search fail-closed forever.
    const second = run({ ...OURS, state: first.state });
    expect(second.status).toBe(0);
    expect(configSets(second.calls)).toEqual([]);
    expect(reindexes(second.calls)).toHaveLength(1);
    expect(second.state).toContain("reindex_pending=0");
  });

  it("does nothing at all when it cannot take the lock", () => {
    const r = run({ flockBin: "flock-that-does-not-exist" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cannot serialise runs");
    expect(downloads(r.calls)).toEqual([]);
    expect(configSets(r.calls)).toEqual([]);
    expect(reindexes(r.calls)).toEqual([]);
  });

  it("does nothing at all when the lock file cannot be opened", () => {
    // A regular file where a directory should be: the open fails with ENOTDIR
    // for every user, including root, which a mode-0500 directory would not.
    const notADirectory = path.join(dir, "not-a-directory");
    writeFileSync(notADirectory, "");
    const r = run({ stateFile: path.join(notADirectory, "state") });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cannot open");
    expect(configSets(r.calls)).toEqual([]);
  });

  it("records the owed reindex before the switch is written, not after", () => {
    // A run killed between the write and the marker would leave a configured
    // backend and an index nobody ever rebuilds.
    const r = run({ failOn: "config set" });
    expect(r.state).toContain("reindex_pending=1");
    expect(r.memorySearch.provider).toBeUndefined();
  });

  it("writes the state file atomically and leaves no temp file behind", () => {
    const script = readFileSync(SCRIPT, "utf-8");
    expect(script).toMatch(/mv -f "\$tmp" "\$EMBED_STATE_FILE"/);
    const r = run();
    expect(r.status).toBe(0);
    // The temp name carries the pid, so match the prefix rather than one name.
    const leaked = readdirSync(path.dirname(statePath))
      .filter((f) => f.startsWith(`${path.basename(statePath)}.tmp.`));
    expect(leaked).toEqual([]);
  });

  it("takes a lock that outlives a long download rather than one that expires", () => {
    const script = readFileSync(SCRIPT, "utf-8");
    expect(script).toMatch(/"\$FLOCK_BIN" -n 9/);
    expect(script).not.toMatch(/-mmin/);
  });

  it("does not leave the provider set when openclaw config set fails", () => {
    const r = run({ openclawRc: 1 });
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
    const r = run({ ...OURS, v2Env: "1", keys: "v2" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already runs on local embeddings");
    expect(configSets(r.calls)).toEqual([]);
    expect(reindexes(r.calls)).toEqual([]);
    expect(r.search).toMatchObject({ provider: PROVIDER, model: MODEL });
  });

  it("writes memory.search in one call when pre-start says OpenClaw 2", () => {
    const r = run({ v2Env: "1" });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual(ops(V2));
    expect(reindexes(r.calls)).toHaveLength(1);
    expect(r.search).toMatchObject({ provider: PROVIDER, model: MODEL });
    // The retired path is never written on a v2 box — the CLI would refuse it anyway.
    expect(r.memorySearch).toEqual({});
  });

  it("respects a deliberate remote provider chosen under memory.search", () => {
    const r = run({ v2Env: "1", keys: "v2", provider: "openai", model: "text-embedding-3-large" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("deliberate choice");
    expect(configSets(r.calls)).toEqual([]);
    expect(downloads(r.calls)).toEqual([]);
    expect(r.search.provider).toBe("openai");
  });

  it("leaves a remote provider alone even when it is still recorded under the legacy home", () => {
    // The upgrade case: memory.search is empty, the owner's OpenAI choice sits
    // in agents.defaults.memorySearch from the box's OpenClaw 1 days, and
    // `doctor --fix` has not migrated it yet. Reading only the live home saw
    // "unset" and pointed the box at the local embedder over the owner's head.
    const r = run({ v2Env: "1", keys: "legacy", provider: "openai", model: "text-embedding-3-large" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("deliberate choice");
    expect(configSets(r.calls)).toEqual([]);
    expect(r.search).toEqual({});
    expect(r.memorySearch.provider).toBe("openai");
  });

  it("still migrates a legacy \"ollama\" onto memory.search — the guard reads both homes, the write does not", () => {
    const r = run({ v2Env: "1", keys: "legacy", provider: "ollama", model: "qwen3-embedding:0.6b" });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual(ops(V2));
    expect(r.search).toMatchObject({ provider: PROVIDER, model: MODEL });
  });

  it("derives the generation from the installed core when install.sh calls it with no env", () => {
    const r = run({ installedVersion: "2026.8.1" });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual(ops(V2));
    expect(r.search).toMatchObject({ provider: PROVIDER, model: MODEL });
  });

  it("keeps the legacy keys for a core older than 2026.8", () => {
    const r = run({ installedVersion: "2026.7.3" });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)).toEqual(ops(LEGACY));
    expect(r.search).toEqual({});
  });

  for (const version of ["next", "dev", "0.0.0-dev"]) {
    it(`refuses to read a core v2 on a version that is not a date (${version})`, () => {
      // `sort -V` reads a non-date as NEWER than 2026.8 — `next` and `dev` both
      // graded v2 — so a dev build, a fork, an `npm i -g <git url>` install or a
      // vendor rebuild picked memory.search on a core that may well be v1, whose
      // CLI then refuses the key. Unknown falls to the legacy names, which is
      // where a box with no core at all already lands and where the write fails
      // soft. TASK-657.
      const r = run({ installedVersion: version, stubV2: false });
      expect(r.status).toBe(0);
      expect(configSets(r.calls)).toEqual(ops(LEGACY));
    });
  }

  it("still reads a real date version, suffix and all", () => {
    // The control: the shape check must not reject the versions the fleet runs.
    const r = run({ installedVersion: "2026.8.1-rc.2", stubV2: true });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)[0]).toBe(ops(V2)[0]);
  });

  it("lets the generation gateway-pre-start.sh exported win over the package on disk", () => {
    // Pre-start asked the binary itself; a package.json that disagrees is the
    // mid-update case, and the binary is the process that parses the write.
    const r = run({ installedVersion: "2026.8.1", v2Env: "0", stubV2: false });
    expect(r.status).toBe(0);
    expect(configSets(r.calls)[0]).toBe(ops(LEGACY)[0]);
  });

  it("never calls `openclaw --version` to find out — it costs ~10 s on a Jetson", () => {
    const r = run({ installedVersion: "2026.8.1" });
    expect(r.calls.filter((c) => c.includes("--version"))).toEqual([]);
    expect(readFileSync(SCRIPT, "utf-8")).not.toMatch(/"\$OPENCLAW_BIN" --version/);
  });
});

describe("gateway-pre-start.sh local embeddings hand-off", () => {
  const src = readFileSync(PRE_START, "utf-8");

  it("launches the embeddings script detached instead of provisioning inline", () => {
    expect(src).toMatch(/setsid nohup "\$LOCAL_EMBEDDINGS"/);
    expect(src).toContain("ensure-local-embeddings.sh");
  });

  it("never blocks a gateway start on a model download", () => {
    expect(src).not.toMatch(/ollama pull/);
    expect(src).not.toMatch(/hf download/);
  });

  it("no longer flips memorySearch inline — that lives in one place now", () => {
    expect(src).not.toMatch(/config set agents\.defaults\.memorySearch/);
    expect(src).not.toMatch(/config set memory\.search/);
  });

  it("exports the generation it decided on, so the script cannot disagree with it", () => {
    expect(src).toMatch(/^export CLAWBOX_OPENCLAW_V2$/m);
    expect(src.indexOf("export CLAWBOX_OPENCLAW_V2")).toBeLessThan(src.indexOf('setsid nohup "$LOCAL_EMBEDDINGS"'));
  });

  it("pins every openclaw it runs, and every child, to the config it resolved — and drops the misread OPENCLAW_HOME", () => {
    // The CLI reads OPENCLAW_HOME as the ACCOUNT home; ClawBox's name for the
    // .openclaw directory must never reach it. The updater passes
    // CLAWBOX_OPENCLAW_HOME instead, and the two canonical overrides win.
    expect(src).toMatch(/^export OPENCLAW_CONFIG_PATH="\$OPENCLAW_CONFIG"$/m);
    expect(src).toMatch(/^export OPENCLAW_STATE_DIR="\$\(dirname "\$OPENCLAW_CONFIG"\)"$/m);
    expect(src).toMatch(/^unset OPENCLAW_HOME$/m);
    expect(src).toContain("${CLAWBOX_OPENCLAW_HOME:-${OPENCLAW_HOME:-$CLAWBOX_HOME_DIR/.openclaw}}");
    const firstCli = src.indexOf('"$OPENCLAW_BIN"');
    expect(src.indexOf("unset OPENCLAW_HOME")).toBeLessThan(firstCli);
    expect(src.indexOf("unset OPENCLAW_HOME")).toBeLessThan(src.indexOf('setsid nohup "$LOCAL_EMBEDDINGS"'));
  });

  it("removes the second tree a misdirected CLI left at <state>/.openclaw, and only that", () => {
    const fn = src.match(/^remove_stray_state_tree\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(fn).toBeTruthy();
    expect(src).toMatch(/^remove_stray_state_tree "\$OPENCLAW_HOME_DIR"$/m);
    const call = (state: string) =>
      spawnSync("bash", ["-c", `${fn}\nremove_stray_state_tree "$1"`, "_", state], { encoding: "utf-8" });

    // The box's case: a state dir named .openclaw with config, backups, an
    // empty index and no workspace nested inside it.
    const stray = path.join(dir, "state-a", ".openclaw");
    mkdirSync(path.join(stray, ".openclaw", "agents", "main", "agent"), { recursive: true });
    writeFileSync(path.join(stray, ".openclaw", "openclaw.json"), "{}");
    let r = call(stray);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Removed the stray OpenClaw state tree");
    expect(existsSync(path.join(stray, ".openclaw"))).toBe(false);

    // Something a person could have put there is not ours to delete.
    const real = path.join(dir, "state-b", ".openclaw");
    mkdirSync(path.join(real, ".openclaw", "workspace"), { recursive: true });
    r = call(real);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("leaving it alone");
    expect(existsSync(path.join(real, ".openclaw", "workspace"))).toBe(true);

    // Nothing there: nothing said.
    const clean = path.join(dir, "state-c", ".openclaw");
    mkdirSync(clean, { recursive: true });
    r = call(clean);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");

    // Only the literal `.openclaw/.openclaw` nesting is the bug's shape: a
    // state directory under another name keeps whatever `.openclaw` it holds,
    // workspace or not (a fresh home has none yet).
    const other = path.join(dir, "state-d", "openclaw-state");
    mkdirSync(path.join(other, ".openclaw"), { recursive: true });
    writeFileSync(path.join(other, ".openclaw", "openclaw.json"), "{}");
    r = call(other);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(path.join(other, ".openclaw", "openclaw.json"))).toBe(true);
  });
});

// install.sh runs the script synchronously and then reports which embedder the
// box ended up on (the script exits 0 on every soft failure by design).
//
// That report asks the core: `openclaw memory status --agent main --deep
// --json`, the same call src/lib/clawkeep-memory.ts makes, read with the same
// provider→location rule as providerLocation() there — including the one fact
// the status does not carry: an `openai-compatible` provider is on this box
// only at the loopback proxy, which is read from openclaw.json. So there is no
// second copy of the rule to drift, and no way to vouch for a box from a key
// its core ignores (TASK-659).
//
// These run the shipped `ensure_local_embeddings` out of install.sh — the
// edition gate, the model step, the helper, the CLI call, the classifier and
// the message it picks — under `set -euo pipefail` against stubs.
describe.skipIf(!canRun)("install.sh local embeddings post-run check", () => {
  const INSTALL_SH = readFileSync(path.resolve(process.cwd(), "install.sh"), "utf-8");

  /** The body of `ensure_local_embeddings`, sliced out of install.sh. */
  const BLOCK = (() => {
    const head = "ensure_local_embeddings() {";
    const start = INSTALL_SH.indexOf(head);
    if (start < 0) return "";
    const end = INSTALL_SH.indexOf("\n}", start);
    if (end < 0) return "";
    const body = INSTALL_SH.slice(start + head.length, end);
    // The "must not say ready" assertions would pass over a truncated slice,
    // so the slice has to reach the block's last arm to count.
    return body.includes("could not read an embedder") ? body : "";
  })();

  const READY = "Local embeddings ready";
  const LOCAL_PROXY = "http://127.0.0.1/setup-api/local-ai/embed/v1";

  interface Report {
    out: string;
    /** Every argv the stub `openclaw` was called with, one per line. */
    cliCalls: string;
    /** One line per stub invocation: "model-step" for step_embed_model, "ran" for the helper. */
    steps: string[];
  }

  function report(opts: {
    edition?: "openclaw" | "hermes";
    cli: string | null;
    cliExit?: number;
    config?: unknown;
    withoutPython?: boolean;
  }): Report {
    if (!BLOCK) throw new Error("install.sh post-run check not found, or extracted truncated");
    const home = path.join(dir, "device", "home", "clawbox");
    const project = path.join(dir, "device", "project");
    const stubBin = path.join(dir, "device", "bin");
    const cliLog = path.join(dir, "device", "openclaw-calls.log");
    const stepLog = path.join(dir, "device", "steps.log");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    mkdirSync(path.join(project, "scripts"), { recursive: true });
    mkdirSync(stubBin, { recursive: true });
    writeFileSync(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify(
        opts.config ?? {
          memory: { search: { provider: PROVIDER, model: MODEL, remote: { baseUrl: LOCAL_PROXY } } },
        },
      ),
    );
    writeFileSync(
      path.join(project, "scripts", "ensure-local-embeddings.sh"),
      `#!/usr/bin/env bash\nprintf 'ran\\n' >> ${JSON.stringify(stepLog)}\nexit 0\n`,
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
      '#!/usr/bin/env bash\nwhile [ "${1#-}" != "$1" ]; do\n  case "$1" in -k|--kill-after) shift 2 ;; *) shift ;; esac\ndone\nshift\nexec "$@"\n',
    );
    chmodSync(timeoutStub, 0o755);

    const program = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `CLAWBOX_HOME=${JSON.stringify(home)}`,
      `PROJECT_DIR=${JSON.stringify(project)}`,
      `OPENCLAW_BIN=${JSON.stringify(openclaw)}`,
      // A PATH with no python3 on it still has to resolve `bash` for the stub
      // shebangs, so it is the real bash by symlink and nothing else.
      opts.withoutPython
        ? `PATH=${JSON.stringify(stubBin)}:${JSON.stringify(pythonlessBin())}`
        : `PATH=${JSON.stringify(stubBin)}:$PATH`,
      'as_clawbox() { "$@"; }',
      'as_clawbox_login() { eval "$*"; }',
      "is_test_mode() { return 1; }",
      `has_openclaw_harness() { return ${opts.edition === "hermes" ? 1 : 0}; }`,
      `step_embed_model() { printf 'model-step\\n' >> ${JSON.stringify(stepLog)}; }`,
      "ensure_local_embeddings() {",
      BLOCK,
      "}",
      "ensure_local_embeddings",
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
      steps: existsSync(stepLog) ? readFileSync(stepLog, "utf-8").trim().split("\n").filter(Boolean) : [],
    };
  }

  /** A PATH directory carrying `bash` and nothing else. */
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

  it("caches the model first, then runs the helper, then asks the core", () => {
    const run = report({ cli: status(PROVIDER) });
    expect(run.steps).toEqual(["model-step", "ran"]);
    expect(run.cliCalls).toContain("memory status --agent main --deep --json");
    // -k, because `timeout` alone sends SIGTERM only and
    // collectMemoryStatusJson() escalates to SIGKILL after 5 s.
    expect(BLOCK).toMatch(/timeout -k \d+ \d+ "\$OPENCLAW_BIN" memory status/);
  });

  it("reports ClawBox's own embedder behind the proxy as ready", () => {
    expect(report({ cli: status(PROVIDER) }).out).toContain(READY);
  });

  it("does not call the same provider id at another host ready", () => {
    const run = report({
      cli: status(PROVIDER),
      config: { memory: { search: { provider: PROVIDER, model: MODEL, remote: { baseUrl: "http://192.168.1.50:8081/v1" } } } },
    });
    expect(run.out).not.toContain(READY);
    expect(run.out).toMatch(/cloud/i);
  });

  it("refuses to guess when the config records no address for it", () => {
    const run = report({ cli: status(PROVIDER), config: { memory: { search: { provider: PROVIDER, model: MODEL } } } });
    expect(run.out).not.toContain(READY);
    expect(run.out).not.toMatch(/cloud/i);
    expect(run.out).toMatch(/no address recorded/i);
  });

  it("does not call a box on a stale legacy block ready", () => {
    // The un-migrated upgrade, and the whole of TASK-659: openclaw.json still
    // says ollama under the OpenClaw 1 key, and the core reports openai.
    const run = report({
      cli: status("openai", "text-embedding-3-large"),
      config: { memory: { search: {} }, agents: { defaults: { memorySearch: { provider: "ollama", model: "qwen3-embedding:0.6b" } } } },
    });
    expect(run.out).not.toContain(READY);
    expect(run.out).toMatch(/cloud/i);
    expect(run.out).toContain("openai");
  });

  it("treats the old on-device providers as local whatever the model is", () => {
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
      const run = report({ cli });
      expect(run.out).not.toContain(READY);
      expect(run.out).toMatch(/could not read an embedder/i);
    });
  }

  it("does not trust a core that printed an answer and then failed", () => {
    const run = report({ cli: status(PROVIDER), cliExit: 1 });
    expect(run.out).not.toContain(READY);
    expect(run.out).toMatch(/could not read an embedder/i);
  });

  it("does not report a local provider the core named no model for as ready on nothing", () => {
    const run = report({ cli: status(PROVIDER, "") });
    expect(run.out).not.toMatch(/ready on\s*,/);
    expect(run.out).toMatch(/named no model/i);
  });

  it("blames its own missing interpreter, not the core, when it cannot parse", () => {
    const run = report({ cli: status(PROVIDER), withoutPython: true });
    expect(run.out).not.toContain(READY);
    expect(run.out).toMatch(/python3/i);
    expect(run.out).not.toMatch(/did not answer/i);
    expect(run.cliCalls).toContain("memory status");
  });

  it("says memory search is not on this edition on hermes, and does no work at all", () => {
    const run = report({ edition: "hermes", cli: status(PROVIDER) });
    expect(run.out).not.toContain(READY);
    expect(run.out).toMatch(/does not include it/i);
    expect(run.cliCalls).toBe("");
    expect(run.steps).toEqual([]);
  });
});
