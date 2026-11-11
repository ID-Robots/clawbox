import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Values the installers write into OpenClaw's config that must stay off every
 * argument list, because sudo records its command line. Each block runs as the
 * installer runs it, with the sudo helper replaced by a recorder of its
 * arguments, `node` and `openssl` by recording shims, and the OpenClaw CLI by a
 * fake that keeps what each `--batch-file` held.
 */

// Starts real processes (bash, node): see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const KEY_MARKER = "sk-ArgvMarkerNotARealKey";
const TOKEN_MARKER = "feedface".repeat(8);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-config-set-batch-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const source = (file: string): string => fs.readFileSync(path.join(REPO, file), "utf-8");

/**
 * A top-level shell function, from `name() {` or `name() (` to its closer in
 * column 0; "" when the file has none.
 */
function shellFunction(text: string, name: string): string {
  for (const [open, close] of [
    ["{", "}"],
    ["(", ")"],
  ]) {
    const start = text.indexOf(`\n${name}() ${open}\n`);
    if (start < 0) continue;
    const end = text.indexOf(`\n${close}\n`, start);
    if (end < 0) throw new Error(`${name} never closes`);
    return text.slice(start + 1, end + 3);
  }
  return "";
}

/** From the line `open` to the first two-space-indented `fi` after it; "" for an `optional` one the file lacks. */
function block(text: string, open: string, optional = false): string {
  const from = text.indexOf(`${open}\n`);
  if (from < 0 && optional) return "";
  if (from < 0) throw new Error(`no block opening with ${open}`);
  const close = text.indexOf("\n  fi\n", from);
  if (close < 0) throw new Error(`block ${open} never closes`);
  return text.slice(from, close + "\n  fi\n".length);
}

function executable(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every argument list the recorders saw, sudo helper and shims alike. */
  argv: string[][];
  /** What each `--batch-file` held when the CLI read it. */
  batches: unknown[];
  /** `<file mode> <directory mode>` of each batch file. */
  modes: string[];
  /** The directory each batch file sat in. */
  batchDirs: string[];
}

const log = (name: string): string => path.join(dir, name);
const lines = (name: string): string[] =>
  fs.existsSync(log(name)) ? fs.readFileSync(log(name), "utf-8").split("\n").filter(Boolean) : [];

/** The shims and the fake CLI in a fresh bin/, and the environment that points at them. */
function harness(env: Record<string, string>): NodeJS.ProcessEnv {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  executable(path.join(bin, "node"), `#!/bin/bash\nprintf '%s\\0' node "$@" >> "$ARGV_LOG"\nprintf '\\n' >> "$ARGV_LOG"\nexec "${process.execPath}" "$@"\n`);
  executable(path.join(bin, "openssl"), `#!/bin/bash\nprintf '%s\\0' openssl "$@" >> "$ARGV_LOG"\nprintf '\\n' >> "$ARGV_LOG"\necho "${TOKEN_MARKER}"\n`);
  executable(
    path.join(bin, "openclaw"),
    [
      "#!/bin/bash",
      `printf '%s\\0' openclaw "$@" >> "$ARGV_LOG"; printf '\\n' >> "$ARGV_LOG"`,
      'if [ "$1 $2" = "models auth" ]; then cat > /dev/null; exit 0; fi',
      'if [ "$1 $2" = "config get" ]; then exit 0; fi',
      // FAKE_CORE=old answers as OpenClaw 2026.2.26 does (its help verbatim,
      // less the banner), mute gives no help at all, and the default answers
      // as the pinned core does.
      'if [ "$1" = "--version" ]; then',
      '  [ "${FAKE_CORE:-}" = old ] && echo "OpenClaw 2026.2.26 (bc50708)" || echo "OpenClaw 2026.10.9 (0000000)"; exit 0',
      "fi",
      'if [ "$1 $2 $3" = "config set --help" ]; then',
      '  case "${FAKE_CORE:-}" in',
      '    mute) exit 1 ;;',
      "    old) printf 'Usage: openclaw config set [options] <path> <value>\\n\\nOptions:\\n  --json  Legacy alias for --strict-json\\n' ;;",
      "    *) printf 'Usage: openclaw config set [options] [path] [value]\\n\\nOptions:\\n  --batch-file <path>  Batch mode\\n' ;;",
      "  esac",
      "  exit 0",
      "fi",
      'if [ "${FAKE_CORE:-}" = old ] && [ "$3" = "--batch-file" ]; then echo "error: unknown option \'--batch-file\'" >&2; exit 1; fi',
      'if [ "$1 $2 $3" = "config set --batch-file" ]; then',
      '  f="$4"; cat "$f" >> "$BATCHES"; printf "\\n" >> "$BATCHES"',
      '  printf "%s %s\\n" "$(stat -c %a "$f")" "$(stat -c %a "$(dirname "$f")")" >> "$MODES"',
      '  dirname "$f" >> "$BATCH_DIRS"',
      '  [ -n "${HANG:-}" ] && sleep 30',
      '  grep -q "\\"path\\":\\"${FAIL_PATH:-none}\\"" "$f" && exit 1',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "config set ${FAIL_PATH:-none}" ]; then exit 1; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    OPENCLAW_BIN: path.join(bin, "openclaw"),
    ARGV_LOG: log("argv"),
    BATCHES: log("batches"),
    MODES: log("modes"),
    BATCH_DIRS: log("batch-dirs"),
    ...env,
  };
}

function run(script: string, env: Record<string, string>): Run {
  const res = spawnSync("bash", ["-c", script], { env: harness(env), encoding: "utf-8" });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    argv: lines("argv").map((l) => l.split("\0").filter(Boolean)),
    batches: lines("batches").map((l) => JSON.parse(l) as unknown),
    modes: lines("modes"),
    batchDirs: lines("batch-dirs"),
  };
}

const until = async (done: () => boolean, ms: number): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return done();
};

/**
 * Run `script` while the CLI holds its batch file, then SIGTERM the whole
 * process group, as systemd stops a unit or Ctrl-C stops a terminal, and
 * return the batch directories left once the dust settles.
 */
async function runKilled(script: string): Promise<{ seen: string[]; left: string[] }> {
  const child = spawn("bash", ["-c", script], { env: harness({ HANG: "1" }), detached: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  if (!(await until(() => lines("batch-dirs").length > 0, 10_000))) throw new Error("the batch file never reached the CLI");
  process.kill(-(child.pid as number), "SIGTERM");
  await exited;
  await until(() => lines("batch-dirs").every((d) => !fs.existsSync(d)), 5_000);
  const seen = lines("batch-dirs");
  return { seen, left: seen.filter((d) => fs.existsSync(d)) };
}

function expectNoMarker(r: Run, marker: string): void {
  expect(r.argv.filter((args) => args.some((a) => a.includes(marker)))).toEqual([]);
  expect(r.stdout).not.toContain(marker);
  expect(r.stderr).not.toContain(marker);
}

describe("install.sh writes the ClawBox AI provider block without the key on a command line", () => {
  const PROVIDER = {
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    apiKey: KEY_MARKER,
    models: [
      {
        id: "deepseek-chat",
        name: "ClawBox AI",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65536,
        maxTokens: 8192,
      },
    ],
  };

  function providerScript(): string {
    const text = source("install.sh");
    return [
      "set -euo pipefail",
      'as_clawbox() { printf \'%s\\0\' as_clawbox "$@" >> "$ARGV_LOG"; printf \'\\n\' >> "$ARGV_LOG"; [ "$1" = "-H" ] && shift; "$@"; }',
      "sleep() { :; }",
      "openclaw_is_v2() { return 0; }",
      shellFunction(text, "oc_config_set"),
      shellFunction(text, "oc_config_set_batch"),
      shellFunction(text, "openclaw_config_set_lacks_batch_file"),
      "provider() {",
      `  local CLAWBOX_AI_KEY="${KEY_MARKER}" AUTH_PROFILES="${path.join(dir, "auth-profiles.json")}"`,
      block(text, '  if [ -n "$CLAWBOX_AI_KEY" ] && openclaw_config_set_lacks_batch_file; then', true),
      block(text, '  if [ -n "$CLAWBOX_AI_KEY" ]; then'),
      "}",
      "provider",
    ].join("\n");
  }

  const runProvider = (env: Record<string, string> = {}): Run => run(providerScript(), env);

  it("hands the CLI a 0600 batch file in a private directory, and no argument holds the key", () => {
    const r = runProvider();

    expect(r.status).toBe(0);
    expectNoMarker(r, KEY_MARKER);
    expect(r.batches).toEqual([[{ path: "models.providers.deepseek", value: PROVIDER }]]);
    expect(r.modes).toEqual(["600 700"]);
    expect(r.batchDirs.filter((d) => fs.existsSync(d))).toEqual([]);
  });

  it("keeps the retries, the messages and the abort when the write fails, and still removes the file", () => {
    const r = runProvider({ FAIL_PATH: "models.providers.deepseek" });

    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("  config set models.providers.deepseek failed (attempt 1/3) — retrying...\n");
    expect(r.stdout).toContain("  config set models.providers.deepseek failed (attempt 2/3) — retrying...\n");
    expect(r.stderr).toContain("  ERROR: config set models.providers.deepseek failed after 3 attempts\n");
    expect(r.batches).toHaveLength(3);
    expect(r.batchDirs.filter((d) => fs.existsSync(d))).toEqual([]);
    expectNoMarker(r, KEY_MARKER);
  });

  it("removes the batch directory when the install is stopped by a signal mid-write", async () => {
    const { seen, left } = await runKilled(providerScript());

    expect(seen).toHaveLength(1);
    expect(left).toEqual([]);
  });

  // The helper's traps live in its own subshell; the installer's stay its own.
  it("leaves the caller's EXIT trap in place", () => {
    const r = run(`trap 'echo caller-exit-trap' EXIT\n${providerScript()}`, {});

    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd().endsWith("caller-exit-trap")).toBe(true);
  });

  // A rollback override can install a core older than `config set
  // --batch-file`. Its only other way to take the block is the key on a
  // command line, so the installer leaves the fallback out and finishes.
  it("on a core without config set --batch-file, writes no fallback and puts the key on no command line", () => {
    const r = runProvider({ FAKE_CORE: "old" });

    expect(r.status).toBe(0);
    expect(r.stderr).toContain(
      "  WARN: ClawBox AI fallback not configured: OpenClaw 2026.2.26 has no 'config set --batch-file' (2026.3.22 and newer have it) to take its key off the command line\n",
    );
    expectNoMarker(r, KEY_MARKER);
    const cli = r.argv.filter((args) => args[0] === "openclaw").map((args) => args.join(" "));
    expect(cli).toEqual(["openclaw config set --help", "openclaw --version"]);
    expect(r.batches).toEqual([]);
    expect(r.stdout).not.toContain("ClawBox AI fallback model configured");
  });

  it("takes a help it cannot read as no verdict, and writes through the batch file", () => {
    const r = runProvider({ FAKE_CORE: "mute" });

    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("WARN");
    expect(r.batches).toEqual([[{ path: "models.providers.deepseek", value: PROVIDER }]]);
    expectNoMarker(r, KEY_MARKER);
  });
});

describe("install-x64.sh seeds the gateway token without it on a command line", () => {
  function seedScript(): string {
    const text = source("install-x64.sh");
    return [
      "set -euo pipefail",
      'as_user() { printf \'%s\\0\' as_user "$@" >> "$ARGV_LOG"; printf \'\\n\' >> "$ARGV_LOG"; "$@"; }',
      shellFunction(text, "as_user_config_set_batch"),
      "seed() {",
      "  local GW_TOKEN_STRONG=0 GW_TOKEN",
      block(text, '  if [ "$GW_TOKEN_STRONG" -eq 0 ]; then'),
      "}",
      "seed",
    ].join("\n");
  }

  const runSeed = (env: Record<string, string> = {}): Run => run(seedScript(), env);

  it("hands the CLI a 0600 batch file in a private directory, and no argument holds the token", () => {
    const r = runSeed();

    expect(r.status).toBe(0);
    expectNoMarker(r, TOKEN_MARKER);
    expect(r.batches).toEqual([[{ path: "gateway.auth.token", value: TOKEN_MARKER }]]);
    expect(r.modes).toEqual(["600 700"]);
    expect(r.batchDirs.filter((d) => fs.existsSync(d))).toEqual([]);
  });

  it("stays non-fatal when the write fails, and still removes the file", () => {
    const r = runSeed({ FAIL_PATH: "gateway.auth.token" });

    expect(r.status).toBe(0);
    expect(r.batchDirs).toHaveLength(1);
    expect(r.batchDirs.filter((d) => fs.existsSync(d))).toEqual([]);
    expectNoMarker(r, TOKEN_MARKER);
  });

  it("removes the batch directory when the install is stopped by a signal mid-write", async () => {
    const { seen, left } = await runKilled(seedScript());

    expect(seen).toHaveLength(1);
    expect(left).toEqual([]);
  });
});
