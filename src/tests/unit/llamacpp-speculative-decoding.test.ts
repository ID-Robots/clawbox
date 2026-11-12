import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs bash: vitest's 5 s default is not enough on a loaded CI runner
// (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Speculative decoding for the local model, through scripts/start-llamacpp.sh.
 *
 * Measured on a DGX Spark (GB10), llama.cpp 29c720e, Qwen3.6-35B-A3B UD-Q4_K_XL
 * from unsloth's -MTP GGUF, 512 tokens at temperature 0:
 *   no speculation                 66.9 tok/s
 *   --spec-type draft-mtp, n-max 2  94.4 tok/s (310 of 400 drafts accepted)
 *   --spec-type draft-mtp, n-max 3  93.6
 *   --spec-type draft-mtp, n-max 4  88.9
 * A model with its own multi-token-prediction head drafts for itself; an
 * EAGLE-3 or plain draft model is a second GGUF beside the first. The launcher
 * passed neither, so no box could have it whatever its .env said.
 *
 * The load mode, below, goes through the same launcher and the same fake.
 */
const SCRIPT = path.join(process.cwd(), "scripts", "start-llamacpp.sh");

let dir: string;
let modelDir: string;
let argsFile: string;
let envFile: string;
let helpFile: string;
let logPath: string;
let fakeServer: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-llamacpp-spec-"));
  modelDir = path.join(dir, "models");
  mkdirSync(modelDir);
  writeFileSync(path.join(modelDir, "model.gguf"), "GGUF");
  argsFile = path.join(dir, "args");
  envFile = path.join(dir, "env");
  helpFile = path.join(dir, "help-calls");
  logPath = path.join(dir, "server.log");
  fakeServer = path.join(dir, "llama-server");
  writeServer(CURRENT_HELP);
});

/** Lines of `llama-server --help` from the build the feature was proven on (29c720e). */
const CURRENT_HELP = [
  "--spec-draft-model, -md, --model-draft FNAME",
  "--spec-draft-n-max N                    number of tokens to draft for speculative decoding (default: 3)",
  "--spec-type none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,ngram-simple",
];
/** An older build, from before any of it. */
const OLD_HELP = ["--model, -m FNAME", "--n-gpu-layers, -ngl N"];

/**
 * The fake records its argv and environment as llama-server was exec'd, and
 * one line per `--help` asked of it: the LLAMA_ARG_LOAD_MODE it saw, or unset.
 */
function writeServer(help: string[]) {
  writeFileSync(fakeServer, [
    "#!/usr/bin/env bash",
    `if [ "\${1:-}" = "--help" ]; then echo "\${LLAMA_ARG_LOAD_MODE-unset}" >> "${helpFile}"; printf '%s\\n' ${help.map((l) => `'${l}'`).join(" ")}; exit 0; fi`,
    `printf '%s\\n' "$@" > "${argsFile}"`,
    `env > "${envFile}"`,
    "",
  ].join("\n"));
  chmodSync(fakeServer, 0o755);
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (file: string) => {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
};

/** The launcher's Jetson marker for this test; writing it makes the "box" a Jetson. */
const tegraRelease = () => path.join(dir, "nv_tegra_release");
const onJetson = () => writeFileSync(tegraRelease(), "# R36 (release), REVISION: 4.3\n");

/**
 * One start. `log` is what this start wrote, not the starts before it. The
 * Jetson marker is a path in the test directory, absent unless a test writes
 * it: never the real /etc/nv_tegra_release, so these run the same on a box.
 */
function start(env: Record<string, string> = {}) {
  rmSync(argsFile, { force: true });
  rmSync(envFile, { force: true });
  rmSync(helpFile, { force: true });
  const logBefore = read(logPath).length;
  const r = spawnSync(
    "bash",
    [SCRIPT, modelDir, "org/repo", "model.gguf", "local-model", "127.0.0.1", "8080", logPath, fakeServer, "/nonexistent/hf", "32768"],
    {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", HOME: dir, LLAMACPP_TEGRA_RELEASE: tegraRelease(), ...env },
    },
  );
  const args = read(argsFile) ? read(argsFile).trim().split("\n") : [];
  const childEnv: Record<string, string> = {};
  for (const line of read(envFile).split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) childEnv[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const help = read(helpFile).split("\n").filter(Boolean);
  return { status: r.status, args, env: childEnv, help, log: read(logPath).slice(logBefore) };
}

/** The value that follows `flag` on the command line, or null. */
function argAfter(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? null : null;
}

describe("start-llamacpp.sh speculative decoding", () => {
  it("is off unless .env asks for it", () => {
    const r = start();
    expect(r.args).toContain("--model");
    expect(r.args).not.toContain("--spec-type");
  });

  it("drafts with the model's own multi-token-prediction head", () => {
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-mtp", LLAMACPP_SPEC_DRAFT_N_MAX: "2" });
    expect(argAfter(r.args, "--spec-type")).toBe("draft-mtp");
    expect(argAfter(r.args, "--spec-draft-n-max")).toBe("2");
    expect(r.log).toMatch(/speculative decoding: .*draft-mtp/);
  });

  it("loads an EAGLE-3 draft model from the model directory", () => {
    writeFileSync(path.join(modelDir, "eagle3.gguf"), "GGUF");
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-eagle3", LLAMACPP_SPEC_DRAFT_FILE: "eagle3.gguf" });
    expect(argAfter(r.args, "--spec-type")).toBe("draft-eagle3");
    expect(argAfter(r.args, "--spec-draft-model")).toBe(path.join(modelDir, "eagle3.gguf"));
  });

  it("starts without speculation, and says why, when the draft model is missing", () => {
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-eagle3", LLAMACPP_SPEC_DRAFT_FILE: "absent.gguf" });
    expect(r.args).toContain("--model");
    expect(r.args).not.toContain("--spec-type");
    expect(r.log).toMatch(/LLAMACPP_SPEC_DRAFT_FILE/);
  });

  it("never reads a draft model from outside the model directory", () => {
    writeFileSync(path.join(dir, "outside.gguf"), "GGUF");
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-eagle3", LLAMACPP_SPEC_DRAFT_FILE: "../outside.gguf" });
    expect(r.args).not.toContain("--spec-type");
    expect(r.args.join(" ")).not.toContain("outside.gguf");
  });

  it("starts without speculation on a type llama-server would reject, instead of not starting", () => {
    // A typo in .env must not leave the box with no local model at all.
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-mtpp" });
    expect(r.args).toContain("--model");
    expect(r.args).not.toContain("--spec-type");
    expect(r.log).toMatch(/Invalid LLAMACPP_SPEC_TYPE/);
  });

  it("starts without speculation on a llama-server too old to know it, asked of the binary itself", () => {
    // An older binary exits on an argument it does not know: .env alone must
    // never be able to cost the box its local model.
    writeServer(OLD_HELP);
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-mtp", LLAMACPP_SPEC_DRAFT_N_MAX: "2" });
    expect(r.args).toContain("--model");
    expect(r.args).not.toContain("--spec-type");
    expect(r.args).not.toContain("--spec-draft-n-max");
    expect(r.log).toMatch(/does not support --spec-type draft-mtp/);
  });

  it("ignores a draft length that is not a small positive number", () => {
    for (const bad of ["0", "-1", "abc", "99"]) {
      const r = start({ LLAMACPP_SPEC_TYPE: "draft-mtp", LLAMACPP_SPEC_DRAFT_N_MAX: bad });
      expect(argAfter(r.args, "--spec-type")).toBe("draft-mtp");
      expect(r.args).not.toContain("--spec-draft-n-max");
      expect(r.log).toMatch(/Invalid LLAMACPP_SPEC_DRAFT_N_MAX/);
    }
  });
});

/**
 * The model's load mode, through scripts/start-llamacpp.sh.
 *
 * Measured on an Orin Nano Super 8 GB, Gemma 4 E2B Q4_0, the product's launch
 * arguments, MemAvailable after load / lowest during the run:
 *   llama.cpp 5f490d7, default load mode (auto)   512 /  390 MB, killed by the memory guard
 *   llama.cpp 5f490d7, load mode mmap            2534 / 2251 MB
 *   llama.cpp db7d8b2 (its default is mmap)      2738 / 2403 MB
 * `auto` turns mmap off for a CUDA integrated GPU, so the 2152 MiB of
 * CPU-side tensors sat in pinned host memory instead of the page cache.
 */
const LOAD_MODES = ["none", "mmap", "mlock", "mmap+mlock", "dio"];

/** The argv start-llamacpp.sh exec'd before the load mode existed, byte for byte. */
const baseArgs = () => [
  "--host", "127.0.0.1", "--port", "8080", "--alias", "local-model",
  "--model", path.join(modelDir, "model.gguf"), "--no-mmproj",
  "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--ctx-size", "32768",
  "--n-gpu-layers", "99", "--reasoning", "off", "--jinja",
];

const loadModeLines = (log: string) => log.split("\n").filter((l) => /load-mode|LOAD_MODE/.test(l));

describe("start-llamacpp.sh load mode", () => {
  it("hands LLAMACPP_LOAD_MODE to llama-server as LLAMA_ARG_LOAD_MODE, and says so", () => {
    const r = start({ LLAMACPP_LOAD_MODE: "mmap" });
    expect(r.env.LLAMA_ARG_LOAD_MODE).toBe("mmap");
    expect(r.args).toEqual(baseArgs());
    expect(loadModeLines(r.log)).toEqual(["[llamacpp] load-mode=mmap"]);
  });

  it("takes every value all three pinned llama.cpp builds accept", () => {
    for (const mode of LOAD_MODES) {
      expect(start({ LLAMACPP_LOAD_MODE: mode }).env.LLAMA_ARG_LOAD_MODE).toBe(mode);
    }
  });

  it("asks nothing of the binary: no --help when speculative decoding is off", () => {
    expect(start({ LLAMACPP_LOAD_MODE: "mmap" }).help).toEqual([]);
    expect(start().help).toEqual([]);
  });

  it("passes nothing off a Jetson when .env sets no load mode, and the launch is as it was", () => {
    const r = start();
    expect(r.env).not.toHaveProperty("LLAMA_ARG_LOAD_MODE");
    expect(r.args).toEqual(baseArgs());
    expect(loadModeLines(r.log)).toEqual(["[llamacpp] load-mode=binary default: LLAMACPP_LOAD_MODE not set"]);
  });

  it("refuses auto, an empty value and anything else: one line, and off a Jetson nothing passed", () => {
    // db7d8b2 has no `auto`, and llama-server exits on a LLAMA_ARG_* value it
    // does not know: .env alone must never make llama-server exit.
    for (const bad of ["auto", "bogus", ""]) {
      const r = start({ LLAMACPP_LOAD_MODE: bad });
      expect(r.env, bad).not.toHaveProperty("LLAMA_ARG_LOAD_MODE");
      expect(r.args).toEqual(baseArgs());
      expect(loadModeLines(r.log), bad).toHaveLength(1);
    }
    expect(loadModeLines(start({ LLAMACPP_LOAD_MODE: "auto" }).log)).toEqual([
      "[llamacpp] load-mode=binary default: invalid LLAMACPP_LOAD_MODE='auto' (expected none|mmap|mlock|mmap+mlock|dio)",
    ]);
    expect(loadModeLines(start({ LLAMACPP_LOAD_MODE: "" }).log)).toEqual([
      "[llamacpp] load-mode=binary default: LLAMACPP_LOAD_MODE is empty",
    ]);
  });

  it("leaves an inherited LLAMA_ARG_LOAD_MODE alone when .env sets none, and names it", () => {
    const r = start({ LLAMA_ARG_LOAD_MODE: "none" });
    expect(r.env.LLAMA_ARG_LOAD_MODE).toBe("none");
    expect(loadModeLines(r.log)).toEqual([
      "[llamacpp] load-mode='none' from the inherited LLAMA_ARG_LOAD_MODE: LLAMACPP_LOAD_MODE not set",
    ]);
  });

  it("is read again on every start: nothing is remembered between them", () => {
    expect(start({ LLAMACPP_LOAD_MODE: "mmap" }).env.LLAMA_ARG_LOAD_MODE).toBe("mmap");
    expect(start({ LLAMACPP_LOAD_MODE: "none" }).env.LLAMA_ARG_LOAD_MODE).toBe("none");
    expect(start().env).not.toHaveProperty("LLAMA_ARG_LOAD_MODE");
  });

  it("leaves speculative decoding as it was, its --help asked before the load mode is set", () => {
    const r = start({ LLAMACPP_LOAD_MODE: "mmap", LLAMACPP_SPEC_TYPE: "draft-mtp", LLAMACPP_SPEC_DRAFT_N_MAX: "2" });
    expect(r.args).toEqual([...baseArgs(), "--spec-type", "draft-mtp", "--spec-draft-n-max", "2"]);
    expect(r.help).toEqual(["unset"]);
    expect(r.env.LLAMA_ARG_LOAD_MODE).toBe("mmap");
  });
});

/**
 * On a Jetson the launcher holds the invariant itself. Seeding mmap into .env
 * is not enough on its own: a box whose .env lacks the key, or holds a value
 * llama-server would refuse, would otherwise run the newer build's own
 * default, auto, which ran the 8 GB Orin out of memory. mmap is valid at every
 * pinned build and was db7d8b2's own default.
 */
describe("start-llamacpp.sh load mode on a Jetson", () => {
  it("falls back to mmap when .env sets none, an empty value or one it refuses, and names why", () => {
    onJetson();
    const why: Record<string, string> = {
      auto: "invalid LLAMACPP_LOAD_MODE='auto' (expected none|mmap|mlock|mmap+mlock|dio)",
      bogus: "invalid LLAMACPP_LOAD_MODE='bogus' (expected none|mmap|mlock|mmap+mlock|dio)",
      "": "LLAMACPP_LOAD_MODE is empty",
    };
    for (const [value, reason] of Object.entries(why)) {
      const r = start({ LLAMACPP_LOAD_MODE: value });
      expect(r.env.LLAMA_ARG_LOAD_MODE, value).toBe("mmap");
      expect(r.args).toEqual(baseArgs());
      expect(loadModeLines(r.log)).toEqual([`[llamacpp] load-mode=mmap, the Jetson fallback: ${reason}`]);
    }
    const unset = start();
    expect(unset.env.LLAMA_ARG_LOAD_MODE).toBe("mmap");
    expect(loadModeLines(unset.log)).toEqual(["[llamacpp] load-mode=mmap, the Jetson fallback: LLAMACPP_LOAD_MODE not set"]);
  });

  it("keeps the owner's valid choice, and an inherited LLAMA_ARG_LOAD_MODE", () => {
    onJetson();
    expect(start({ LLAMACPP_LOAD_MODE: "none" }).env.LLAMA_ARG_LOAD_MODE).toBe("none");
    expect(start({ LLAMA_ARG_LOAD_MODE: "dio" }).env.LLAMA_ARG_LOAD_MODE).toBe("dio");
    expect(start({ LLAMA_ARG_LOAD_MODE: "dio", LLAMACPP_LOAD_MODE: "auto" }).env.LLAMA_ARG_LOAD_MODE).toBe("dio");
  });

  it("knows a Jetson by the marker the installers use, /etc/nv_tegra_release", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain('"${LLAMACPP_TEGRA_RELEASE:-/etc/nv_tegra_release}"');
  });
});

describe("LLAMACPP_LOAD_MODE in .env", () => {
  const repoFile = (name: string) => readFileSync(path.join(process.cwd(), name), "utf8");
  const INSTALL = repoFile("install.sh");
  const installFunction = (name: string) => {
    const at = INSTALL.indexOf(`\n${name}() {\n`);
    if (at < 0) throw new Error(`${name}() not found in install.sh`);
    return INSTALL.slice(at + 1, INSTALL.indexOf("\n}\n", at + 1) + 2);
  };
  // install.sh's .env writers run as the service account; the suite's own user
  // owns the fixtures, so the account is that user here. With no PROJECT_DIR,
  // hand_over_checkout has no checkout to hand over.
  const JETSON_WRITERS = ["as_clawbox() { \"$@\"; }\n", ...["append_as_clawbox", "hand_over_checkout"].map(installFunction)];

  /** Every .env line step_directories_permissions writes on a Jetson, run against `envFile`. */
  function seedJetsonEnv(file: string) {
    const lines = installFunction("step_directories_permissions")
      .split("\n")
      .filter((l) => /^ {2}(ensure|migrate)_env_setting "\$ENV_FILE" /.test(l));
    const helpers = ["ensure_env_setting", "migrate_env_setting", "get_env_setting_or_default"].map(installFunction);
    const r = spawnSync("bash", ["-c", [...JETSON_WRITERS, ...helpers, `ENV_FILE="${file}"`, ...lines].join("\n")], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    // Without errexit a writer missing a helper still exits 0; it says so here.
    expect(r.stderr).toBe("");
    return read(file);
  }

  it("is seeded mmap on a Jetson by install.sh, on install and on every update, never over an owner's value", () => {
    const fresh = path.join(dir, "fresh.env");
    writeFileSync(fresh, "LLAMACPP_REASONING=off\n");
    expect(seedJetsonEnv(fresh)).toMatch(/^LLAMACPP_LOAD_MODE=mmap$/m);

    const owned = path.join(dir, "owned.env");
    writeFileSync(owned, "LLAMACPP_LOAD_MODE=none\n");
    const after = seedJetsonEnv(owned);
    expect(after).toMatch(/^LLAMACPP_LOAD_MODE=none$/m);
    expect(after.match(/^LLAMACPP_LOAD_MODE=/gm)).toHaveLength(1);

    // The install's setup_config and every update's rebuild_reboot run it.
    expect(installFunction("step_setup_config")).toMatch(/^ {2}step_directories_permissions$/m);
    expect(installFunction("step_rebuild_reboot")).toMatch(/^ {2}step_directories_permissions$/m);
  });

  it("is never seeded on a PC, never written as LLAMA_ARG_*, and only documented in .env.example", () => {
    // x64 hosts and the DGX Spark are unmeasured; install-x64.sh copies
    // .env.example verbatim, so the key may sit there only as a comment. The
    // embedder's unit loads the same .env, so a LLAMA_ARG_* line there would
    // reach the embedder too.
    for (const pc of ["install-x64.sh", "scripts/x64-migration/clawbox-x64-step.sh"]) {
      expect(repoFile(pc), pc).not.toMatch(/LLAMACPP_LOAD_MODE|LLAMA_ARG_LOAD_MODE/);
    }
    expect(INSTALL).not.toMatch(/_env_setting "\$ENV_FILE" "LLAMA_ARG_/);
    const example = repoFile(".env.example");
    expect(example).toContain("# LLAMACPP_LOAD_MODE=mmap");
    expect(example).not.toMatch(/^\s*(LLAMACPP_LOAD_MODE|LLAMA_ARG_\w+)=/m);
  });

  it.each(["install.sh", "install-x64.sh"])(
    "%s: ensure_env_setting puts a key on its own line when a hand-edited .env lacks a final newline",
    (installer) => {
      const src = repoFile(installer);
      const at = src.indexOf("\nensure_env_setting() {\n");
      const helper = src.slice(at + 1, src.indexOf("\n}\n", at + 1) + 2);
      const writers = installer === "install.sh" ? JETSON_WRITERS.join("\n") : "";
      const add = (body: string) => {
        const file = path.join(dir, `${installer}.env`);
        writeFileSync(file, body);
        const r = spawnSync("bash", ["-c", `${writers}\n${helper}\nensure_env_setting "${file}" LLAMACPP_LOAD_MODE mmap`], { encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stderr).toBe("");
        return read(file);
      };
      // Glued on, the owner's last key would be corrupted and the new one unset.
      expect(add("EMBED_CACHE_TYPE_V=q8_0")).toBe("EMBED_CACHE_TYPE_V=q8_0\nLLAMACPP_LOAD_MODE=mmap\n");
      expect(add("EMBED_CACHE_TYPE_V=q8_0\n")).toBe("EMBED_CACHE_TYPE_V=q8_0\nLLAMACPP_LOAD_MODE=mmap\n");
      expect(add("")).toBe("LLAMACPP_LOAD_MODE=mmap\n");
      expect(add("LLAMACPP_LOAD_MODE=none")).toBe("LLAMACPP_LOAD_MODE=none");
    },
  );
});
