import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The local embedding model was fresh-install-only, then it lived inside
 * ollama, and now it runs on ClawBox's own llama.cpp as clawbox-embed.service,
 * reached through the web server's local-AI proxy. Three things install.sh has
 * to get right for that, on an UPDATE as well as on a fresh install:
 *
 *  - the GGUF is cached as root BEFORE anything points OpenClaw at the
 *    embedder (`step_embed_model`), because a first request that had to
 *    download 640 MB would not fit OpenClaw's own timeouts;
 *  - `ensure_local_embeddings` runs the helper and asks the CORE what it
 *    resolved, and cannot fail the update whatever it finds;
 *  - the old embedder inside ollama is stopped afterwards, and the build frees
 *    the new unit's memory the way it frees ollama's.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const INSTALL_SH_PATH = path.join(REPO, "install.sh");
const INSTALL_SH = readFileSync(INSTALL_SH_PATH, "utf-8");
const NL = String.fromCharCode(10);

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf(`${NL}}`, start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end);
}

/** A single-quoted shell word for an arbitrary string, so a hostile pin reaches the stub verbatim. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellCode(fn: string): string {
  return fn
    .split(NL)
    .filter((l) => !l.trim().startsWith("#"))
    .join(NL)
    .replace(new RegExp("\\\\" + NL + "\\s*", "g"), " ");
}

describe("the embedding model is repaired on an update, not only on a fresh install", () => {
  const POST_UPDATE = shellCode(extractShellFunction("step_post_update"));

  it("post_update calls it", () => {
    expect(POST_UPDATE).toMatch(/^\s*ensure_local_embeddings\b/m);
  });

  it("and cannot be failed by it", () => {
    // errexit is live and step bodies are called bare, so a missing embedding
    // model must never be the reason an update stops.
    const line = POST_UPDATE.split(NL).find((l) => l.trim().startsWith("ensure_local_embeddings"));
    expect(line).toBeDefined();
    expect(line).toContain("|| echo");
  });

  it("runs after the unit, its sudoers grant and its memory cap are installed", () => {
    // The helper reaches the embedder through the proxy, and the proxy starts
    // clawbox-embed.service through `sudo systemctl start` — a grant
    // step_systemd_services writes. Called earlier it would wake nothing.
    // indexOf answers -1 for a step that is gone, and -1 is "before" anything,
    // so each marker has to be there before its position means a thing.
    expect(POST_UPDATE).toContain("ensure_local_embeddings");
    expect(POST_UPDATE).toContain("step_systemd_services");
    expect(POST_UPDATE).toContain("step_resource_limits");
    const at = POST_UPDATE.indexOf("ensure_local_embeddings");
    expect(POST_UPDATE.indexOf("step_systemd_services")).toBeLessThan(at);
    expect(POST_UPDATE.indexOf("step_resource_limits")).toBeLessThan(at);
  });

  it("stops the old embedder inside ollama afterwards — stop, never disable", () => {
    const at = POST_UPDATE.indexOf("ensure_local_embeddings");
    const stop = POST_UPDATE.indexOf("systemctl stop ollama.service");
    expect(stop).toBeGreaterThan(at);
    expect(POST_UPDATE).not.toMatch(/systemctl disable[^\n]*ollama/);
  });

  it("no longer pulls the model through ollama anywhere", () => {
    expect(INSTALL_SH).not.toMatch(/ollama pull qwen3/);
    expect(INSTALL_SH).not.toContain("ollama_wait_ready");
    const OLLAMA = shellCode(extractShellFunction("step_ollama_install"));
    expect(OLLAMA).not.toContain("ensure-local-embeddings");
    expect(OLLAMA).not.toContain("memory status");
  });

  it("frees the embedder's memory before a build, the way it frees ollama's", () => {
    const FREE = shellCode(extractShellFunction("free_memory_for_build"));
    expect(FREE).toContain("systemctl stop clawbox-embed.service");
    expect(FREE).toContain("stop ollama.service");
    expect(FREE.indexOf("stop ollama.service")).toBeLessThan(FREE.indexOf("stop clawbox-embed.service"));
  });

  it("registers the unit as installed-but-never-enabled, and dispatches the model step", () => {
    const listStart = INSTALL_SH.indexOf("EXPECTED_INSTALLED_SERVICES=(");
    const listEnd = INSTALL_SH.indexOf(")", listStart);
    expect(INSTALL_SH.slice(listStart, listEnd)).toContain("clawbox-embed.service");
    const SYSTEMD = shellCode(extractShellFunction("step_systemd_services"));
    expect(SYSTEMD).toMatch(/"\$svc" == "clawbox-embed\.service" \]\] && continue/);
    const dispatchStart = INSTALL_SH.indexOf("DISPATCH_STEPS=(");
    const dispatchEnd = INSTALL_SH.indexOf(")", dispatchStart);
    expect(INSTALL_SH.slice(dispatchStart, dispatchEnd)).toMatch(/\bembed_model\b/);
  });

  it("on a fresh install, caches the model early and points memory search at it only once the web server is up", () => {
    const main = INSTALL_SH.slice(INSTALL_SH.lastIndexOf('log "Installing llama.cpp runtime..."'));
    expect(main.indexOf("step_embed_model")).toBeGreaterThan(main.indexOf("step_llamacpp_install"));
    expect(main.indexOf("ensure_local_embeddings")).toBeGreaterThan(main.indexOf("step_start_services"));
  });
});

describe("every HF pin read from .env is checked before it reaches an as_clawbox_login command", () => {
  // as_clawbox_login runs its argument through `su -c`; a pin with shell
  // syntax in it would run as clawbox. The check has to sit between the read
  // and the command in BOTH functions that build one from these pins.
  for (const [fn, repoKey, fileKey] of [
    ["ensure_llamacpp_model_cached", "LLAMACPP_HF_REPO", "LLAMACPP_HF_FILE"],
    ["ensure_embed_model_cached", "EMBED_HF_REPO", "EMBED_HF_FILE"],
  ] as const) {
    it(`${fn} validates ${repoKey} and ${fileKey} first`, () => {
      const code = shellCode(extractShellFunction(fn));
      const repoCheck = `require_safe_hf_ref "${repoKey}" "$HF_REPO" || return 1`;
      const fileCheck = `require_safe_hf_ref "${fileKey}" "$HF_FILE" || return 1`;
      expect(code).toContain(repoCheck);
      expect(code).toContain(fileCheck);
      expect(code).toContain("as_clawbox_login");
      expect(code.indexOf(repoCheck)).toBeLessThan(code.indexOf("as_clawbox_login"));
      expect(code.indexOf(fileCheck)).toBeLessThan(code.indexOf("as_clawbox_login"));
    });
  }

  function verdicts(values: readonly string[]): string[] {
    const script = [
      "set -uo pipefail",
      `sed -n '/^require_safe_hf_ref() {/,/^}/p' "$1" > "$2"`,
      '. "$2"',
      'shift 2; for v in "$@"; do if require_safe_hf_ref KEY "$v" 2>/dev/null; then echo ok; else echo refused; fi; done',
    ].join(NL);
    const fn = path.join(os.tmpdir(), `hf-ref-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
    try {
      return execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH, fn, ...values], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
        .split(NL)
        .filter(Boolean);
    } finally {
      fs.rmSync(fn, { force: true });
    }
  }

  it("accepts every pin this installer ships or migrates from, and a subfolder inside a repo", () => {
    const shipped = [
      "google/gemma-4-E2B-it-qat-q4_0-gguf",
      "gemma-4-E2B_q4_0-it.gguf",
      "gguf-org/gemma-4-e2b-it-gguf",
      "gemma-4-e2b-it-edited-q4_0.gguf",
      "Qwen/Qwen3-Embedding-0.6B-GGUF",
      "Qwen3-Embedding-0.6B-Q8_0.gguf",
      "q8_0/model.gguf",
    ];
    expect(verdicts(shipped)).toEqual(shipped.map(() => "ok"));
  });

  it("refuses shell syntax, a `..` segment, a leading dash or slash, and an empty pin", () => {
    const hostile = [
      "Qwen/$(id)",
      "Qwen/`id`",
      'x" ; id ; "',
      "a;b",
      "a b",
      "..",
      "../x.gguf",
      "a/../x.gguf",
      "a/..",
      "-rf",
      "--local-dir",
      "/etc/passwd",
      "",
      "a\nb",
    ];
    expect(verdicts(hostile)).toEqual(hostile.map(() => "refused"));
  });
});

/**
 * The behaviour that matters most cannot be read out of a regex: that these
 * never fail the run and never fetch what is already there. Drive the real
 * functions against stubs.
 */
describe("step_embed_model — driven against stubs", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "embed-model-"));
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function run({
    hermes = false,
    testMode = false,
    hf = true,
    present = false,
    hfRc = 0,
    pins = {} as Record<string, string>,
  } = {}) {
    const project = path.join(tmp, "project");
    fs.mkdirSync(path.join(project, "data"), { recursive: true });
    fs.writeFileSync(path.join(project, ".env"), "");
    const modelDir = path.join(project, "data", "embed", "models");
    if (present) {
      fs.mkdirSync(modelDir, { recursive: true });
      fs.writeFileSync(path.join(modelDir, "Qwen3-Embedding-0.6B-Q8_0.gguf"), "gguf");
    }
    const log = path.join(tmp, "calls.log");
    fs.writeFileSync(log, "");
    // hf: record the argv; on success create the file the caller then looks for.
    fs.writeFileSync(
      path.join(tmp, "bin", "hf"),
      [
        "#!/bin/sh",
        'printf "hf %s\\n" "$*" >> "$LOG"',
        '[ "$HF_RC" = "0" ] || exit "$HF_RC"',
        'dir=""; while [ $# -gt 0 ]; do [ "$1" = "--local-dir" ] && dir="$2"; shift; done',
        'mkdir -p "$dir" && : > "$dir/Qwen3-Embedding-0.6B-Q8_0.gguf"',
      ].join(NL),
      { mode: 0o755 },
    );
    const script = [
      "set -euo pipefail",
      // The step's refusals go to stderr, and a script that ends in `echo RC=`
      // exits 0 — execFileSync then hands back stdout alone. Fold the two so
      // the refusal is in what the cases read.
      "exec 2>&1",
      // The stub hf comes first on PATH on EVERY run: a box with the real CLI
      // on the developer's PATH must never download 640 MB inside a unit test.
      `export PATH="${tmp}/bin:$PATH"`,
      `PROJECT_DIR="${project}"`,
      "CLAWBOX_USER=$(id -un)",
      `is_test_mode() { ${testMode ? "return 0" : "return 1"}; }`,
      `has_openclaw_harness() { ${hermes ? "return 1" : "return 0"}; }`,
      // as_clawbox_login runs a command string as the clawbox user; here, us.
      // "No hf" is the clawbox user's PATH lacking it, which is what the
      // step's `command -v hf` probe asks — so that probe is what says no.
      hf
        ? 'as_clawbox_login() { eval "$*"; }'
        : 'as_clawbox_login() { case "$*" in *"command -v hf"*) return 1 ;; *) eval "$*" ;; esac; }',
      // What .env says for a key, or the function's own default: the way the
      // real helper answers, minus the file.
      `get_env_setting_or_default() { case "$2" in ${Object.entries(pins)
        .map(([k, v]) => `${k}) printf '%s' ${shellQuote(v)} ;;`)
        .join(" ")} *) printf '%s' "$3" ;; esac; }`,
      `sed -n '/^require_safe_hf_ref() {/,/^}/p' "$1" > "${tmp}/fn.sh"`,
      `sed -n '/^ensure_embed_model_cached() {/,/^}/p' "$1" >> "${tmp}/fn.sh"`,
      `sed -n '/^step_embed_model() {/,/^}/p' "$1" >> "${tmp}/fn.sh"`,
      `. "${tmp}/fn.sh"`,
      "rc=0; step_embed_model || rc=$?; echo RC=$rc",
    ].join(NL);
    let out: string;
    let code = 0;
    try {
      out = execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LOG: log, HF_RC: String(hfRc) },
      });
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    return {
      out,
      code,
      calls: fs.readFileSync(log, "utf8").split(NL).filter(Boolean),
      cached: fs.existsSync(path.join(modelDir, "Qwen3-Embedding-0.6B-Q8_0.gguf")),
    };
  }

  it("downloads the GGUF with hf into data/embed/models when it is missing", () => {
    const r = run();
    expect(r.out).toContain("RC=0");
    expect(r.calls).toEqual([
      expect.stringMatching(/^hf download Qwen\/Qwen3-Embedding-0\.6B-GGUF Qwen3-Embedding-0\.6B-Q8_0\.gguf --local-dir .*\/data\/embed\/models$/),
    ]);
    expect(r.cached).toBe(true);
  });

  it("is a no-op when the file is already there", () => {
    const r = run({ present: true });
    expect(r.out).toContain("already cached");
    expect(r.calls).toEqual([]);
  });

  it("reports a failed download as a failure the caller can `|| echo` past", () => {
    const r = run({ hfRc: 1 });
    expect(r.out).toContain("RC=1");
    expect(r.cached).toBe(false);
  });

  // The pin is spliced into an as_clawbox_login command string, which the
  // real helper hands to `su -c`: without the check, $(...) inside .env runs
  // as the clawbox user, and here the eval-backed stub would run it just the
  // same and hand hf the expanded word.
  for (const [what, pins, key] of [
    // Expanded, the substitution leaves a marker file beside the call log:
    // the proof that nothing ran is that the file is never there. The refusal
    // itself may well quote the pin back, so its text is not the test.
    ["a repo id carrying a command substitution", { EMBED_HF_REPO: 'Qwen/$(touch "$LOG.injected")' }, "EMBED_HF_REPO"],
    ["a file name that climbs out of the models directory", { EMBED_HF_FILE: "../../.ssh/authorized_keys" }, "EMBED_HF_FILE"],
    ["a file name that would become an hf option", { EMBED_HF_FILE: "--local-dir" }, "EMBED_HF_FILE"],
  ] as const) {
    it(`refuses ${what} before anything runs as clawbox`, () => {
      const r = run({ pins: { ...pins } });
      expect(r.calls).toEqual([]);
      expect(fs.existsSync(path.join(tmp, "calls.log.injected"))).toBe(false);
      expect(r.out).toContain("RC=1");
      expect(r.out).toMatch(new RegExp(`Error: ${key}=`));
      expect(r.cached).toBe(false);
    });
  }

  for (const [name, opts, said] of [
    ["a hermes box with no core to point at the model", { hermes: true }, /does not include it/],
    ["the e2e container", { testMode: true }, /skipping/],
    ["a box without the Hugging Face CLI", { hf: false }, /Hugging Face CLI not installed/],
  ] as const) {
    it(`does nothing but say so on ${name}`, () => {
      const r = run(opts);
      expect(r.out).toContain("RC=0");
      expect(r.out).toMatch(said);
      expect(r.calls).toEqual([]);
    });
  }
});

describe("ensure_local_embeddings never fails the update", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "embed-ensure-"));
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "bin", "sleep"), `#!/bin/sh${NL}exit 0${NL}`, { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** @param hermes edition without a core; @param helper whether the script is there */
  function run({ hermes = false, helper = true, testMode = false, modelStepFails = false } = {}) {
    const project = path.join(tmp, "project");
    fs.mkdirSync(path.join(project, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "home", ".openclaw"), { recursive: true });
    if (helper) {
      fs.writeFileSync(
        path.join(project, "scripts", "ensure-local-embeddings.sh"),
        `#!/bin/sh${NL}echo HELPER_RAN${NL}`,
        { mode: 0o755 },
      );
    }
    const script = [
      "set -euo pipefail",
      `export PATH="${tmp}/bin:$PATH"`,
      `PROJECT_DIR="${project}"`,
      `CLAWBOX_HOME="${tmp}/home"`,
      // A core that never answers: the verdict must then be "could not read".
      "OPENCLAW_BIN=/bin/false",
      `is_test_mode() { ${testMode ? "return 0" : "return 1"}; }`,
      `has_openclaw_harness() { ${hermes ? "return 1" : "return 0"}; }`,
      `step_embed_model() { echo MODEL_STEP_RAN; ${modelStepFails ? "return 1" : "return 0"}; }`,
      'as_clawbox() { "$@"; }',
      // as_clawbox_login runs a command string as the clawbox user; here, us.
      'as_clawbox_login() { eval "$*"; }',
      `sed -n '/^ensure_local_embeddings() {/,/^}/p' "$1" > "${tmp}/fn.sh"`,
      `. "${tmp}/fn.sh"`,
      "ensure_local_embeddings; echo RC=$?",
    ].join(NL);
    let out: string;
    let code = 0;
    try {
      out = execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    return { out, code };
  }

  it("caches the model, then runs the helper, on a healthy OpenClaw box", () => {
    const r = run();
    expect(r.out).toContain("MODEL_STEP_RAN");
    expect(r.out).toContain("HELPER_RAN");
    expect(r.out.indexOf("MODEL_STEP_RAN")).toBeLessThan(r.out.indexOf("HELPER_RAN"));
    expect(r.out).toContain("RC=0");
  });

  it("still runs the helper when the model cache fails — the unit fetches on first use", () => {
    const r = run({ modelStepFails: true });
    expect(r.out).toContain("HELPER_RAN");
    expect(r.out).toContain("RC=0");
  });

  it("bounds the helper so it cannot hold a quiesced gateway open for ever", () => {
    // post_update carries a 900s budget and stops the gateway while it runs.
    expect(shellCode(extractShellFunction("ensure_local_embeddings"))).toMatch(/timeout -k \d+ \d+/);
  });

  it("puts no verdict on a core that never answers", () => {
    const r = run();
    expect(r.out).toMatch(/could not read an embedder/i);
    expect(r.out).not.toContain("Local embeddings ready");
  });

  for (const [name, opts] of [
    ["a hermes box with no core to point at the model", { hermes: true }],
    ["a checkout whose helper is missing", { helper: false }],
    ["the e2e container", { testMode: true }],
  ] as const) {
    it(`returns 0 on ${name}`, () => {
      const r = run(opts);
      expect(r.out).toContain("RC=0");
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("HELPER_RAN");
      expect(r.out).not.toContain("MODEL_STEP_RAN");
    });
  }
});
