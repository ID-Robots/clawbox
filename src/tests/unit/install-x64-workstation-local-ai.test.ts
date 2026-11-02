import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs bash: vitest's 5 s default is not enough on a loaded CI runner
// (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The local model a fresh PC install seeds.
 *
 * The shipped Local AI model is Gemma 4 E2B: 3 GB, sized for an 8 GB Jetson.
 * install-x64.sh seeded it on every host, so a DGX Spark — 128 GB of memory a
 * Blackwell GPU reads directly — ran a model a phone could. A fresh install on
 * a host with a CUDA GPU and at least 96 GiB now seeds Qwen3.6-35B-A3B from
 * unsloth's MTP GGUF, with its own multi-token-prediction head drafting
 * (start-llamacpp.sh's LLAMACPP_SPEC_TYPE). An existing .env keeps whatever
 * model it has: an update must never swap an owner's model out from under them.
 */
const SOURCE = readFileSync(path.resolve(process.cwd(), "install-x64.sh"), "utf8");

function sliceFunction(name: string): string {
  const start = SOURCE.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name}() not found in install-x64.sh`);
  const end = SOURCE.indexOf("\n}\n", start + 1);
  return SOURCE.slice(start + 1, end + 3);
}

function sliceConstants(): string {
  // The LLAMACPP_WORKSTATION_* assignments, wherever they sit.
  const lines = SOURCE.split("\n").filter((l) => /^LLAMACPP_WORKSTATION_[A-Z_]+=/.test(l));
  if (lines.length === 0) throw new Error("no LLAMACPP_WORKSTATION_* constants in install-x64.sh");
  return lines.join("\n");
}

let dir: string;
let bin: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-x64-ws-"));
  bin = path.join(dir, "bin");
  mkdirSync(bin);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stub(name: string, body: string) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function meminfo(gib: number): string {
  const file = path.join(dir, `meminfo-${gib}`);
  writeFileSync(file, `MemTotal:       ${gib * 1024 * 1024} kB\nMemFree:        1000 kB\n`);
  return file;
}

function run(script: string) {
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** seed_llamacpp_env against `envFile` on a host with `gib` of memory. */
function seed(envFile: string, gib: number) {
  const helpers = ["ensure_env_setting", "migrate_env_setting", "get_env_setting_or_default"]
    .map(sliceFunction)
    .join("\n");
  return run([
    helpers,
    sliceConstants(),
    sliceFunction("llamacpp_workstation_host"),
    sliceFunction("seed_llamacpp_env"),
    `LLAMACPP_WORKSTATION_MEMINFO="${meminfo(gib)}"`,
    `seed_llamacpp_env "${envFile}"`,
  ].join("\n"));
}

describe("install-x64.sh: the local model a workstation gets", () => {
  it("counts a host as a workstation only with a CUDA GPU and the memory for it", () => {
    const fn = [sliceConstants(), sliceFunction("llamacpp_workstation_host")].join("\n");
    stub("nvidia-smi", "echo 'GPU 0: NVIDIA GB10 (UUID: GPU-x)'");
    expect(run(`${fn}\nllamacpp_workstation_host "${meminfo(128)}"; echo rc=$?`).out).toContain("rc=0");
    expect(run(`${fn}\nllamacpp_workstation_host "${meminfo(16)}"; echo rc=$?`).out).toContain("rc=1");
    stub("nvidia-smi", "exit 9");
    expect(run(`${fn}\nllamacpp_workstation_host "${meminfo(128)}"; echo rc=$?`).out).toContain("rc=1");
  });

  it("seeds the MTP model, its window and its own drafting on a fresh workstation install", () => {
    stub("nvidia-smi", "echo 'GPU 0: NVIDIA GB10'");
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "");
    const r = seed(envFile, 128);
    expect(r.status).toBe(0);
    const env = readEnv(envFile);
    expect(env.LLAMACPP_MODEL).toBe("qwen3.6-35b-a3b-mtp");
    expect(env.LLAMACPP_HF_REPO).toBe("unsloth/Qwen3.6-35B-A3B-MTP-GGUF");
    expect(env.LLAMACPP_HF_FILE).toBe("Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf");
    expect(env.LLAMACPP_CONTEXT_WINDOW).toBe("65536");
    expect(env.LLAMACPP_SPEC_TYPE).toBe("draft-mtp");
    expect(env.LLAMACPP_SPEC_DRAFT_N_MAX).toBe("2");
    // The rest of the launch defaults are the shared ones.
    expect(env.LLAMACPP_CACHE_TYPE_K).toBe("q8_0");
    expect(env.LLAMACPP_MAX_TOKENS).toBe("8192");
  });

  it("seeds Gemma on a host without the memory, exactly as before", () => {
    stub("nvidia-smi", "echo 'GPU 0: NVIDIA GeForce RTX 4070'");
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "");
    seed(envFile, 32);
    const env = readEnv(envFile);
    expect(env.LLAMACPP_MODEL).toBe("gemma4-e2b-it-q4_0");
    expect(env.LLAMACPP_HF_FILE).toBe("gemma-4-E2B_q4_0-it.gguf");
    expect(env.LLAMACPP_CONTEXT_WINDOW).toBe("32768");
    expect(env.LLAMACPP_SPEC_TYPE).toBeUndefined();
  });

  it("never swaps the model of a box that already has one", () => {
    stub("nvidia-smi", "echo 'GPU 0: NVIDIA GB10'");
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, [
      "LLAMACPP_MODEL=gemma4-e2b-it-q4_0",
      "LLAMACPP_HF_REPO=google/gemma-4-E2B-it-qat-q4_0-gguf",
      "LLAMACPP_HF_FILE=gemma-4-E2B_q4_0-it.gguf",
      "LLAMACPP_CONTEXT_WINDOW=32768",
      "",
    ].join("\n"));
    seed(envFile, 128);
    const env = readEnv(envFile);
    expect(env.LLAMACPP_MODEL).toBe("gemma4-e2b-it-q4_0");
    expect(env.LLAMACPP_HF_FILE).toBe("gemma-4-E2B_q4_0-it.gguf");
    expect(env.LLAMACPP_CONTEXT_WINDOW).toBe("32768");
    expect(env.LLAMACPP_SPEC_TYPE).toBeUndefined();
  });

  it("keeps the workstation window clear of the 131072 the shared block migrates away", () => {
    // seed_llamacpp_env moves a 131072 window to 32768 on every run (the
    // superseded default). A workstation window of 131072 would be undone by
    // the next install, so it must be some other number.
    expect(SOURCE).toMatch(/^LLAMACPP_WORKSTATION_CONTEXT_WINDOW=65536$/m);
  });

  it("is what step_directories_permissions seeds .env with", () => {
    expect(sliceFunction("step_directories_permissions")).toContain('seed_llamacpp_env "$ENV_FILE"');
  });
});
