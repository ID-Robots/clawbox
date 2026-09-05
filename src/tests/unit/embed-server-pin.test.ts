import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_EMBED_BASE_URL,
  DEFAULT_EMBED_BATCH,
  EMBED_HF_FILE,
  EMBED_HF_REPO,
  EMBED_MODEL_ALIAS,
  EMBED_RUNTIME_SUBDIR,
  EMBED_UNIT,
  MIN_EMBED_BATCH,
} from "@/lib/embed-runtime-ids";
import { LOCAL_EMBEDDING_MODEL } from "@/lib/memory-shard-state";
import { DATA_DIR_PUBLIC_SUBTREES } from "@/lib/file-guard";

/**
 * The memory embedder's numbers live in five places that cannot import each
 * other: the TypeScript module, the unit's start script (environment
 * defaults), install.sh's .env seeding, .env.example, and the boot helper.
 * A drift between any two is a box whose Local AI page says one thing while
 * llama-server runs another. This reads them all as text and pins them to the
 * module, the way llamacpp-gguf-pin.test.ts does for Gemma.
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

const START = read("scripts/start-embed-server.sh");
const INSTALL = read("install.sh");
const HELPER = read("scripts/ensure-local-embeddings.sh");
const ENV_EXAMPLE = read(".env.example");
const UNIT = read("config/clawbox-embed.service");

/** `NAME="${ENV:-default}"` in a shell script → the default. */
function shellDefault(src: string, env: string): string | null {
  const m = new RegExp(`\\$\\{${env}:-([^}]*)\\}`).exec(src);
  return m ? m[1] : null;
}

/** `ensure_env_setting "$ENV_FILE" "KEY" "value"` in install.sh → value. */
function seeded(env: string): string | null {
  const m = new RegExp(`ensure_env_setting "\\$ENV_FILE" "${env}" "([^"]*)"`).exec(INSTALL);
  return m ? m[1] : null;
}

describe("the embedder's numbers agree everywhere", () => {
  it("names one model file, one repo and one alias", () => {
    expect(shellDefault(START, "EMBED_HF_REPO")).toBe(EMBED_HF_REPO);
    expect(shellDefault(START, "EMBED_HF_FILE")).toBe(EMBED_HF_FILE);
    expect(shellDefault(START, "EMBED_MODEL")).toBe(EMBED_MODEL_ALIAS);
    expect(shellDefault(HELPER, "EMBED_HF_REPO")).toBe(EMBED_HF_REPO);
    expect(shellDefault(HELPER, "EMBED_HF_FILE")).toBe(EMBED_HF_FILE);
    expect(shellDefault(HELPER, "EMBED_MODEL")).toBe(EMBED_MODEL_ALIAS);
    expect(seeded("EMBED_HF_REPO")).toBe(EMBED_HF_REPO);
    expect(seeded("EMBED_HF_FILE")).toBe(EMBED_HF_FILE);
    expect(seeded("EMBED_MODEL")).toBe(EMBED_MODEL_ALIAS);
    expect(ENV_EXAMPLE).toContain(`EMBED_HF_REPO=${EMBED_HF_REPO}`);
    expect(ENV_EXAMPLE).toContain(`EMBED_HF_FILE=${EMBED_HF_FILE}`);
    expect(ENV_EXAMPLE).toContain(`EMBED_MODEL=${EMBED_MODEL_ALIAS}`);
    // install.sh's own model cache reads the same defaults.
    expect(INSTALL).toContain(`"EMBED_HF_REPO" "${EMBED_HF_REPO}"`);
    expect(INSTALL).toContain(`"EMBED_HF_FILE" "${EMBED_HF_FILE}"`);
  });

  it("is the model OpenClaw is told to send", () => {
    // Memory Shard writes this as memory.search.model; llama-server answers to
    // it as its --alias. Two spellings would be a 404 on every embed.
    expect(LOCAL_EMBEDDING_MODEL).toBe(EMBED_MODEL_ALIAS);
  });

  it("runs the batch the module promises, and refuses one below the floor", () => {
    expect(shellDefault(START, "EMBED_BATCH")).toBe(String(DEFAULT_EMBED_BATCH));
    expect(seeded("EMBED_BATCH")).toBe(String(DEFAULT_EMBED_BATCH));
    expect(ENV_EXAMPLE).toContain(`EMBED_BATCH=${DEFAULT_EMBED_BATCH}`);
    // The floor: pooled embeddings need the whole input in one batch, and
    // measured documents reach 484 tokens.
    expect(START).toMatch(new RegExp(`-lt ${MIN_EMBED_BATCH} \\]`));
    expect(DEFAULT_EMBED_BATCH).toBeGreaterThanOrEqual(MIN_EMBED_BATCH);
  });

  it("listens where the module and .env say", () => {
    const url = new URL(DEFAULT_EMBED_BASE_URL);
    expect(shellDefault(START, "EMBED_PORT")).toBe(url.port);
    expect(shellDefault(START, "EMBED_HOST")).toBe(url.hostname);
    expect(seeded("EMBED_BASE_URL")).toBe(DEFAULT_EMBED_BASE_URL);
    expect(ENV_EXAMPLE).toContain(`EMBED_BASE_URL=${DEFAULT_EMBED_BASE_URL}`);
  });

  it("keeps its runtime under the data/ subtree the file guard exposes", () => {
    expect(DATA_DIR_PUBLIC_SUBTREES.has(EMBED_RUNTIME_SUBDIR)).toBe(true);
    expect(shellDefault(START, "EMBED_MODEL_DIR")).toBe(`$PROJECT_DIR/data/${EMBED_RUNTIME_SUBDIR}/models`);
    expect(shellDefault(HELPER, "EMBED_MODEL_DIR")).toBe(`/home/clawbox/clawbox/data/${EMBED_RUNTIME_SUBDIR}/models`);
  });
});

describe("the unit runs the script, and the script runs an embedder", () => {
  it("is a system unit for the clawbox user with no [Install] section", () => {
    expect(UNIT).toContain("User=clawbox");
    expect(UNIT).toContain("ExecStart=/home/clawbox/clawbox/scripts/start-embed-server.sh");
  });

  it("every script a unit runs straight from Exec* is executable in git", () => {
    // A launcher committed as 100644 is one every checkout writes without
    // its mode bit, and systemd then fails the unit with 203/EXEC
    // ("Permission denied") on any box that took the branch through git —
    // install.sh chmods nothing here. Seen on a box the moment beta carried
    // this unit. Every unit's script is held to it, not only this one.
    // EVERY Exec* directive (Start, StartPre, StartPost, Stop, StopPost,
    // Reload, Condition), after systemd's command-line prefixes (`-@:+!`),
    // and only a script that is the COMMAND: one run through `/bin/bash …`
    // or `/usr/bin/env node …` needs no mode bit and is left alone.
    const scripts = new Set<string>();
    for (const unit of fs.readdirSync(path.join(ROOT, "config")).filter((f) => f.endsWith(".service"))) {
      for (const m of read(`config/${unit}`).matchAll(/^\s*Exec[A-Za-z]*=[-@:+!]*\/home\/clawbox\/clawbox\/(scripts\/\S+)/gm)) {
        scripts.add(m[1]);
      }
    }
    expect(scripts.has("scripts/start-embed-server.sh")).toBe(true);
    expect(scripts.size).toBeGreaterThan(3);
    const modes = execFileSync("git", ["-C", ROOT, "ls-files", "-s", "--", ...scripts], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean)
      .map((line) => ({ mode: line.split(" ")[0], file: line.split("\t")[1] }));
    expect(modes.map((m) => m.file).sort()).toEqual([...scripts].sort());
    expect(modes.filter((m) => m.mode !== "100755").map((m) => `${m.file} ${m.mode}`)).toEqual([]);
    expect(UNIT).toContain("Restart=no");
    expect(UNIT).toContain("MemoryAccounting=yes");
    // Enabled at boot it would be 2 GB resident for nothing: the proxy starts it.
    expect(UNIT).not.toMatch(/^\[Install\]/m);
    expect(path.basename("config/clawbox-embed.service")).toBe(EMBED_UNIT);
  });

  it("passes the flags the memory arithmetic and the vectors depend on", () => {
    for (const flag of [
      "--embedding",
      "--pooling last",
      // OpenClaw's ollama adapter normalised client-side; its openai-compatible
      // adapter does not, so the server has to.
      "--embd-normalize 2",
      '--ctx-size "$BATCH"',
      '--batch-size "$BATCH"',
      '--ubatch-size "$BATCH"',
      "--parallel 1",
      "--fit off",
      "--flash-attn on",
      '--cache-type-k "$CACHE_TYPE_K"',
      '--cache-type-v "$CACHE_TYPE_V"',
      "--no-webui",
    ]) {
      expect(START, flag).toContain(flag);
    }
    // q8_0 KV, like ollama ran it — f16 doubles the cache.
    expect(shellDefault(START, "EMBED_CACHE_TYPE_K")).toBe("q8_0");
    expect(shellDefault(START, "EMBED_CACHE_TYPE_V")).toBe("q8_0");
    expect(seeded("EMBED_CACHE_TYPE_K")).toBe("q8_0");
  });

  it("execs the server, so the unit's main pid is llama-server", () => {
    expect(START).toMatch(/^exec "\$BIN_PATH"/m);
  });

  it("carries the same sentinels the llama.cpp launcher does, for the repair path", () => {
    expect(START).toContain("[embed] Missing llama-server at");
    expect(START).toContain("[embed] Missing local model at");
  });
});
