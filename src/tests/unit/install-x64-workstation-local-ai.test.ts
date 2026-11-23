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

/**
 * nvidia-smi as the gate asks it: `--query-gpu=memory.total` answers MiB on a
 * card with its own memory and `[N/A]` on GB10, whose GPU reads system memory.
 */
function gpu(memoryTotal: string) {
  stub("nvidia-smi", `case "$*" in *memory.total*) echo '${memoryTotal}' ;; *) echo 'GPU 0: NVIDIA (UUID: GPU-x)' ;; esac`);
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
    const is = (gib: number) => run(`${fn}\nllamacpp_workstation_host "${meminfo(gib)}"; echo rc=$?`).out;
    gpu("[N/A]");
    expect(is(128)).toContain("rc=0");
    expect(is(16)).toContain("rc=1");
    stub("nvidia-smi", "exit 9");
    expect(is(128)).toContain("rc=1");
  });

  it("asks what the GPU can hold, not only what the machine has", () => {
    // 128 GB of RAM beside a 12 GB card: the 22 GB model with --n-gpu-layers
    // 99 would not load on that GPU, so the local model would never start.
    const fn = [sliceConstants(), sliceFunction("llamacpp_workstation_host")].join("\n");
    const is = () => run(`${fn}\nllamacpp_workstation_host "${meminfo(128)}"; echo rc=$?`).out;
    gpu("12282");
    expect(is()).toContain("rc=1");
    gpu("49140");
    expect(is()).toContain("rc=0");
    gpu("[N/A]"); // GB10: unified memory, the GPU reads the machine's 128 GB
    expect(is()).toContain("rc=0");
  });

  it("seeds the MTP model, its window and its own drafting on a fresh workstation install", () => {
    gpu("[N/A]");
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
    gpu("12282");
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
    gpu("[N/A]");
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

  // TASK-2387: every chat on a workstation shares its one local engine, so the
  // box is single-engine and gateway-pre-start.sh keeps the background review
  // and dreaming off there by default.
  it("marks a fresh workstation single-engine", () => {
    gpu("[N/A]");
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "");
    expect(seed(envFile, 128).status).toBe(0);
    expect(readEnv(envFile).CLAWBOX_SINGLE_ENGINE).toBe("1");
  });

  it("marks an updated workstation that already has its model single-engine too", () => {
    // Outside the model guard: an update keeps the model AND gets the flag.
    gpu("[N/A]");
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "LLAMACPP_MODEL=qwen3.6-35b-a3b-mtp\n");
    seed(envFile, 128);
    const env = readEnv(envFile);
    expect(env.LLAMACPP_MODEL).toBe("qwen3.6-35b-a3b-mtp");
    expect(env.CLAWBOX_SINGLE_ENGINE).toBe("1");
  });

  it("does not mark a host without the memory for it", () => {
    gpu("12282");
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "");
    seed(envFile, 32);
    expect(readEnv(envFile).CLAWBOX_SINGLE_ENGINE).toBeUndefined();
  });

  it("keeps an owner's own CLAWBOX_SINGLE_ENGINE, 0 included", () => {
    gpu("[N/A]");
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "CLAWBOX_SINGLE_ENGINE=0\n");
    seed(envFile, 128);
    expect(readFileSync(envFile, "utf8").match(/^CLAWBOX_SINGLE_ENGINE=/gm)).toHaveLength(1);
    expect(readEnv(envFile).CLAWBOX_SINGLE_ENGINE).toBe("0");
  });

  it.each([
    "export CLAWBOX_SINGLE_ENGINE=0",
    "  export\tCLAWBOX_SINGLE_ENGINE = 0",
    "CLAWBOX_SINGLE_ENGINE =0",
  ])("keeps an owner's %j: no `=1` appended after it to win as the last assignment", (line) => {
    gpu("[N/A]");
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, `${line}\n`);
    seed(envFile, 128);
    expect(readFileSync(envFile, "utf8")).not.toMatch(/CLAWBOX_SINGLE_ENGINE=1/);
    expect(readFileSync(envFile, "utf8").startsWith(`${line}\n`)).toBe(true);
  });

  it("is what step_directories_permissions seeds .env with", () => {
    expect(sliceFunction("step_directories_permissions")).toContain('seed_llamacpp_env "$ENV_FILE"');
  });
});

/**
 * TASK-2501: Settings → Local AI's voice Install on a Workstation. install-x64.sh
 * had no voice step, so the root dispatcher refused `voice_kokoro_install`.
 * The steps carry install.sh's contract (0 ready, 13 declined, 12 failed, 14
 * the scripts did not deploy / an exit outside the contract), and root runs
 * its own copy of install-voice.sh, never the install user's tree.
 */
describe("the voice steps a Workstation's Local AI tab starts", () => {
  function voiceStep(step: string, exitCode: number) {
    const voiceDir = path.join(dir, "voice");
    mkdirSync(voiceDir, { recursive: true });
    writeFileSync(path.join(voiceDir, "install-voice.sh"), `echo "ran $1 as $CLAWBOX_USER in $CLAWBOX_HOME"\nexit ${exitCode}\n`);
    const script = [
      "set -euo pipefail",
      `ROOT_VOICE_DIR="${voiceDir}"`,
      "CLAWBOX_USER=owner",
      'CLAWBOX_HOME="/opt/owner-home"',
      sliceFunction("run_voice_install"),
      sliceFunction(`step_${step}`),
      `rc=0; step_${step} 2>&1 || rc=$?; echo RC=$rc`,
    ].join("\n");
    return spawnSync("bash", ["-c", script], { encoding: "utf8" }).stdout;
  }

  it.each([
    [0, 0], [12, 12], [13, 13], [1, 14], [7, 14],
  ])("voice_kokoro_install: install-voice.sh exit %i is step exit %i", (code, want) => {
    expect(voiceStep("voice_kokoro_install", code)).toContain(`RC=${want}`);
  });

  it("asks for the engine its button names, for the install user", () => {
    expect(voiceStep("voice_kokoro_install", 0)).toContain("ran --kokoro as owner in /opt/owner-home");
    expect(voiceStep("voice_whisper_install", 13)).toMatch(/ran --whisper as owner in \/opt\/owner-home[\s\S]*RC=13/);
  });

  it("is opt-in: dispatchable, never run by the full install", () => {
    const dispatch = SOURCE.slice(SOURCE.indexOf("DISPATCH_STEPS=("), SOURCE.indexOf("\n)", SOURCE.indexOf("DISPATCH_STEPS=(")));
    expect(dispatch).toContain("voice_kokoro_install voice_whisper_install");
    expect(SOURCE.slice(SOURCE.indexOf("# ── Full Install Mode"))).not.toMatch(/step_voice_/);
  });

  it("is a step the x64 launcher lets the web server start", () => {
    const launcher = readFileSync(path.resolve(process.cwd(), "scripts/x64-migration/clawbox-x64-run-root-step.sh"), "utf8");
    const list = /^WEB_ROOT_STEPS="([^"]*)"/m.exec(launcher)![1].split(/\s+/);
    expect(list).toEqual(expect.arrayContaining(["voice_kokoro_install", "voice_whisper_install"]));
  });

  it("runs root's own copy, which the root-step contract installs root-owned", () => {
    expect(sliceFunction("run_voice_install")).not.toContain("PROJECT_DIR");
    expect(sliceFunction("step_root_step_contract")).toContain(
      'install -o root -g root -m 0755 "$voice_src/$voice_f" "$ROOT_VOICE_DIR/$voice_f"',
    );
  });
});

/**
 * TASK-2501 option B: a Workstation's cluster runs its own ASR server, named in
 * .env as ASR_BASE_URL. Install pre-fills Settings → Speech's "own speech
 * server" engine from it, once, so the box transcribes on it from the start.
 */
describe("the cluster's ASR server becomes the transcription engine at install", () => {
  const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
  const config = () => path.join(dir, "data", "config.json");

  function seed(env: string, before?: Record<string, unknown>) {
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, ".env"), env);
    if (before) writeFileSync(config(), JSON.stringify(before));
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR="${dir}"`,
      'as_user() { "$@"; }',
      sliceFunction("seed_stt_endpoint_from_asr"),
      `seed_stt_endpoint_from_asr "${dir}/.env"; echo RC=$?`,
    ].join("\n");
    const out = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    let after: Record<string, unknown> | null = null;
    try {
      after = JSON.parse(readFileSync(config(), "utf8"));
    } catch {
      after = null;
    }
    return { out: `${out.stdout}${out.stderr}`, after };
  }

  it.skipIf(!hasPython3)("pre-fills the server and makes it the engine, in the shape the app reads", async () => {
    const r = seed('ASR_BASE_URL="http://127.0.0.1:8090/v1/"\nASR_MODEL=qwen3-asr\n', { password_configured: true });
    expect(r.out).toContain("RC=0");
    expect(r.after).toMatchObject({
      password_configured: true,
      stt_endpoint: { baseUrl: "http://127.0.0.1:8090/v1", model: "qwen3-asr" },
      stt_endpoint_seeded: true,
      stt_primary: "endpoint",
    });
    const { sttEndpointFromValue } = await import("@/lib/stt-endpoint");
    expect(sttEndpointFromValue(r.after!.stt_endpoint)).toEqual({ baseUrl: "http://127.0.0.1:8090/v1", model: "qwen3-asr" });
  });

  it.skipIf(!hasPython3)("falls back to the engine's default model when the server cannot be asked", () => {
    const r = seed("ASR_BASE_URL=http://127.0.0.1:9/v1\n");
    expect(r.after).toMatchObject({ stt_endpoint: { baseUrl: "http://127.0.0.1:9/v1", model: "whisper-1" } });
  });

  it.skipIf(!hasPython3)("seeds once: a server the owner removed stays removed", () => {
    const r = seed("ASR_BASE_URL=http://127.0.0.1:8090/v1\nASR_MODEL=m\n", { stt_endpoint_seeded: true, stt_primary: "cloud" });
    expect(r.after).toEqual({ stt_endpoint_seeded: true, stt_primary: "cloud" });
  });

  it.skipIf(!hasPython3)("keeps the owner's own server, and an engine the owner pinned", () => {
    const own = { stt_endpoint: { baseUrl: "http://127.0.0.1:9000/v1", model: "x" } };
    expect(seed("ASR_BASE_URL=http://127.0.0.1:8090/v1\nASR_MODEL=m\n", own).after).toEqual(own);
    rmSync(config());
    const pinned = seed("ASR_BASE_URL=http://127.0.0.1:8090/v1\nASR_MODEL=m\n", { stt_primary: "local", stt_choice_source: "owner" }).after;
    expect(pinned).toMatchObject({ stt_primary: "local", stt_endpoint: { baseUrl: "http://127.0.0.1:8090/v1" } });
    rmSync(config());
    // A cloud default nobody pinned gives way to the cluster's own server.
    const defaulted = seed("ASR_BASE_URL=http://127.0.0.1:8090/v1\nASR_MODEL=m\n", { stt_primary: "cloud" }).after;
    expect(defaulted).toMatchObject({ stt_primary: "endpoint" });
  });

  it.skipIf(!hasPython3)("writes nothing the app would refuse: stray whitespace is trimmed, a non-http value is no seed", () => {
    expect(seed("ASR_BASE_URL= 'http://127.0.0.1:8090/v1/' \t\nASR_MODEL=m \n").after).toMatchObject({
      stt_endpoint: { baseUrl: "http://127.0.0.1:8090/v1", model: "m" },
    });
    rmSync(config());
    expect(seed("ASR_BASE_URL=127.0.0.1:8090\n").after).toBeNull();
  });

  it("does nothing on a box with no ASR server", () => {
    const r = seed("LLAMACPP_MODEL=x\n");
    expect(r.out).toContain("RC=0");
    expect(r.after).toBeNull();
  });

  it("runs on an arm64 Workstation only", () => {
    expect(sliceFunction("step_directories_permissions")).toMatch(
      /if \[ "\$HOST_ARCH" = aarch64 \]; then\n\s+seed_stt_endpoint_from_asr "\$ENV_FILE"/,
    );
  });
});
