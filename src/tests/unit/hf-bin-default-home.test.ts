import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where the Hugging Face CLI is looked for when HF_BIN is unset.
 *
 * Both launch specs defaulted to `/home/clawbox/.local/bin/hf`, the Jetson
 * appliance's user. On a PC installed by install-x64.sh — a DGX Spark, an x64
 * desktop — the install user is whoever owns the machine, pipx puts `hf` in
 * THAT user's ~/.local/bin, and nothing sets HF_BIN. So whenever a model had to
 * be fetched at start (a model switched in .env, a cache cleared), the
 * launcher reported a missing CLI that was installed one home over.
 *
 * `$HOME/.local/bin` is pipx's directory, not the only one `hf` lands in: apt,
 * an active venv, a pyenv shim and /usr/local/bin all put it elsewhere, and on
 * those hosts the home path names a file that does not exist — the same
 * "missing CLI" report, for a CLI on PATH. PATH is searched first now, so the
 * tests that pin the home fallback have to stub PATH to a directory with no
 * `hf` in it; left as the runner's own PATH they would pass or fail on whether
 * the developer's machine happens to have the CLI installed.
 */
describe("the Hugging Face CLI default", () => {
  const OWNER_HOME = "/srv/owner-home";
  const HOME_HF = path.join(OWNER_HOME, ".local", "bin", "hf");
  let dir: string;
  let emptyPathDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clawbox-hf-bin-"));
    // A real directory on PATH with no `hf` in it: the fallback's precondition.
    emptyPathDir = mkdtempSync(path.join(dir, "nothing-here-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  /** An executable `hf` in its own directory, as apt or a venv would leave it. */
  function hfOnPath(mode = 0o755): { dir: string; bin: string } {
    const binDir = mkdtempSync(path.join(dir, "bin-"));
    const bin = path.join(binDir, "hf");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, mode);
    return { dir: binDir, bin };
  }

  async function llamaHfBin(): Promise<string> {
    vi.resetModules();
    const mod = await import("@/lib/llamacpp-server");
    return mod.getLlamaCppLaunchSpec("local-model").hfBinPath;
  }

  async function embedHfBin(): Promise<string> {
    vi.resetModules();
    const mod = await import("@/lib/embed-server");
    return mod.getEmbedLaunchSpec().hfBinPath;
  }

  it("is the running user's own home, for the local model, when PATH has no hf", async () => {
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "");
    vi.stubEnv("PATH", emptyPathDir);
    expect(await llamaHfBin()).toBe(HOME_HF);
  });

  it("is the running user's own home, for the memory embedder, when PATH has no hf", async () => {
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "");
    vi.stubEnv("PATH", emptyPathDir);
    expect(await embedHfBin()).toBe(HOME_HF);
  });

  it("takes the hf on PATH over a home directory that has none", async () => {
    // The host this finding is about: `hf` from apt or a venv, pipx never run,
    // so ~/.local/bin/hf does not exist and the launcher refused to start.
    const { dir: binDir, bin } = hfOnPath();
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "");
    vi.stubEnv("PATH", `${emptyPathDir}${path.delimiter}${binDir}`);
    expect(await llamaHfBin()).toBe(bin);
    expect(await embedHfBin()).toBe(bin);
  });

  it("takes the first hf on PATH, as the shell would", async () => {
    // Two that could both be run: the answer is the one PATH names first, not
    // whichever the walk happens to reach last.
    const first = hfOnPath();
    const second = hfOnPath();
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "");
    vi.stubEnv("PATH", [first.dir, second.dir].join(path.delimiter));
    expect(await llamaHfBin()).toBe(first.bin);
  });

  it("walks past an hf it cannot execute", async () => {
    const unusable = hfOnPath(0o644);
    const usable = hfOnPath();
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "");
    vi.stubEnv("PATH", [unusable.dir, usable.dir].join(path.delimiter));
    expect(await llamaHfBin()).toBe(usable.bin);
  });

  it("ignores an empty or relative PATH entry rather than resolving hf off the cwd", async () => {
    // "" and "." mean the current directory, which for the server is wherever
    // it was started: a stray ./hf there is not the host's CLI. The relative
    // entry here is a real directory with a real `hf` in it, reached through
    // the cwd — without the isAbsolute guard this case resolves to it, so the
    // test fails if the guard goes.
    const { dir: binDir, bin } = hfOnPath();
    const relative = path.relative(process.cwd(), binDir);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(path.resolve(relative, "hf")).toBe(bin);
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "");
    vi.stubEnv("PATH", [".", relative, emptyPathDir].join(path.delimiter));
    expect(await llamaHfBin()).toBe(HOME_HF);
    expect(await embedHfBin()).toBe(HOME_HF);
  });

  it("falls back to the home path when PATH is empty, and when it is unset", async () => {
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "");
    vi.stubEnv("PATH", "");
    expect(await llamaHfBin()).toBe(HOME_HF);
    // Not merely empty: no PATH in the environment at all, which is what a unit
    // with `Environment=` cleared and a bare `execve` leave behind.
    vi.stubEnv("PATH", undefined);
    expect(process.env.PATH).toBeUndefined();
    expect(await llamaHfBin()).toBe(HOME_HF);
    expect(await embedHfBin()).toBe(HOME_HF);
  });

  it("still yields to HF_BIN when it is set, over both PATH and the home path", async () => {
    const { dir: binDir } = hfOnPath();
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "/opt/hf/bin/hf");
    vi.stubEnv("PATH", binDir);
    expect(await llamaHfBin()).toBe("/opt/hf/bin/hf");
    expect(await embedHfBin()).toBe("/opt/hf/bin/hf");
  });
});

describe("the shell launchers' Hugging Face CLI default", () => {
  function source(script: string): string[] {
    return readFileSync(path.join(process.cwd(), script), "utf8").split("\n");
  }

  it("scripts/start-embed-server.sh follows $HOME", () => {
    // The unit's own launcher: systemd starts it with a bare PATH and the
    // appliance's `hf` is in the install user's ~/.local/bin.
    const line = source("scripts/start-embed-server.sh").find((l) => l.startsWith("HF_BIN="));
    expect(line).toBe('HF_BIN="${HF_BIN:-${HOME:-/home/clawbox}/.local/bin/hf}"');
  });

  it("scripts/ensure-local-embeddings.sh takes an hf on PATH before the $HOME fallback", () => {
    // The same ORDER as the two TS launch specs above, for the same reason: an
    // explicit HF_BIN first, then whatever `hf` the shell itself can run, then
    // pipx's directory under $HOME for the appliance. Not the same code, so not
    // the same edge cases — `command -v` honours a relative PATH entry, which
    // the TS walk skips, and does not trim a whitespace-only HF_BIN.
    const lines = source("scripts/ensure-local-embeddings.sh").filter((l) => l.startsWith("HF_BIN="));
    expect(lines).toEqual([
      'HF_BIN="${HF_BIN:-$(command -v hf 2>/dev/null || true)}"',
      'HF_BIN="${HF_BIN:-${HOME:-/home/clawbox}/.local/bin/hf}"',
    ]);
  });
});

// Runs bash: vitest's 5 s default is not enough on a loaded CI runner
// (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("install-x64.sh names in .env an hf it accepted off the unit's PATH", () => {
  // Its llama.cpp step installs no CLI when `hf` is already on the owner's
  // LOGIN PATH (a conda env, a pyenv shim, ~/bin). The launch specs search the
  // UI unit's PATH, which carries none of those, and then ~/.local/bin: without
  // HF_BIN in .env, a model fetched later named a CLI that did not exist.
  const INSTALLER = readFileSync(path.join(process.cwd(), "install-x64.sh"), "utf8");
  function sliceFunction(name: string): string {
    const start = INSTALLER.indexOf(`\n${name}() {`);
    if (start < 0) throw new Error(`${name}() not found in install-x64.sh`);
    const end = INSTALLER.indexOf("\n}\n", start + 1);
    return INSTALLER.slice(start + 1, end + 3);
  }

  let dir: string;
  let home: string;
  let envFile: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clawbox-hf-bin-"));
    home = path.join(dir, "home");
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    mkdirSync(path.join(dir, "opt", "bin"), { recursive: true });
    envFile = path.join(dir, ".env");
    writeFileSync(envFile, "LLAMACPP_BIN=/usr/local/bin/llama-server\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function executable(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }

  /** record_hf_bin with the owner's login PATH holding `opt/bin`; the profile prints a banner first. */
  function recordHfBin() {
    const r = spawnSync("bash", ["-c", [
      "set -euo pipefail",
      `CLAWBOX_HOME="${home}"`,
      'as_user() { "$@"; }',
      `as_user_login() { PATH="${dir}/opt/bin:/usr/bin:/bin" bash -c "echo 'Welcome to the workstation'; $1"; }`,
      sliceFunction("ensure_env_setting"),
      sliceFunction("get_env_setting_or_default"),
      sliceFunction("migrate_env_setting"),
      sliceFunction("record_hf_bin"),
      `record_hf_bin "${envFile}"`,
      'echo "step continues"',
    ].join("\n")], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
    expect(`${r.stdout}${r.stderr}`).toContain("step continues");
    return r.status;
  }

  it("records the hf the step accepted when ~/.local/bin has none", () => {
    executable(path.join(dir, "opt", "bin", "hf"));
    expect(recordHfBin()).toBe(0);
    expect(readFileSync(envFile, "utf8")).toBe(
      `LLAMACPP_BIN=/usr/local/bin/llama-server\nHF_BIN=${path.join(dir, "opt", "bin", "hf")}\n`,
    );
  });

  it("leaves .env alone when ~/.local/bin/hf exists, as pipx and pip --user put it", () => {
    executable(path.join(home, ".local", "bin", "hf"));
    executable(path.join(dir, "opt", "bin", "hf"));
    expect(recordHfBin()).toBe(0);
    expect(readFileSync(envFile, "utf8")).toBe("LLAMACPP_BIN=/usr/local/bin/llama-server\n");
  });

  it("keeps an HF_BIN that runs, whoever set it", () => {
    const pinned = path.join(dir, "tools", "hf");
    executable(pinned);
    executable(path.join(dir, "opt", "bin", "hf"));
    writeFileSync(envFile, `HF_BIN=${pinned}\n`);
    expect(recordHfBin()).toBe(0);
    expect(readFileSync(envFile, "utf8")).toBe(`HF_BIN=${pinned}\n`);
  });

  it("moves an HF_BIN that no longer runs to the CLI the step found", () => {
    // An hf recorded once and then removed: the step installs one in
    // ~/.local/bin, and the dead pin must not keep shadowing it.
    writeFileSync(envFile, `LLAMACPP_BIN=/usr/local/bin/llama-server\nHF_BIN=${path.join(dir, "gone", "hf")}\n`);
    executable(path.join(home, ".local", "bin", "hf"));
    expect(recordHfBin()).toBe(0);
    expect(readFileSync(envFile, "utf8")).toBe(
      `LLAMACPP_BIN=/usr/local/bin/llama-server\nHF_BIN=${path.join(home, ".local", "bin", "hf")}\n`,
    );

    // With no ~/.local/bin/hf, to the one on the login PATH.
    rmSync(path.join(home, ".local", "bin", "hf"));
    writeFileSync(envFile, `HF_BIN=${path.join(dir, "gone", "hf")}\n`);
    executable(path.join(dir, "opt", "bin", "hf"));
    expect(recordHfBin()).toBe(0);
    expect(readFileSync(envFile, "utf8")).toBe(`HF_BIN=${path.join(dir, "opt", "bin", "hf")}\n`);
  });

  it("records nothing when no hf is found, and creates no .env", () => {
    expect(recordHfBin()).toBe(0);
    expect(readFileSync(envFile, "utf8")).toBe("LLAMACPP_BIN=/usr/local/bin/llama-server\n");
    rmSync(envFile);
    executable(path.join(dir, "opt", "bin", "hf"));
    expect(recordHfBin()).toBe(0);
    expect(existsSync(envFile)).toBe(false);
  });

  it("runs in the llama.cpp step after the CLI check, whichever branch it took", () => {
    // Right after the check's closing `fi`: on a host whose hf was found, and
    // on one where the step installed it.
    const step = sliceFunction("step_llamacpp_install");
    expect(step).toContain('    echo "  Hugging Face CLI already installed"\n  fi\n  record_hf_bin "$PROJECT_DIR/.env"\n');
    expect(step.split('record_hf_bin "$PROJECT_DIR/.env"')).toHaveLength(2);
  });
});
