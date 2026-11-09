import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
