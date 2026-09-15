import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { UI_ROOT_STEPS, WEB_ROOT_STEPS } from "@/lib/root-steps";

/**
 * install.sh force-installs no local model or engine except the llama.cpp
 * runtime and Gemma 4 (the owner's ruling, 2026-09-15: "we are not force
 * installing any models in install.sh except gemma4").
 *
 * Measured that day on beta 7c889b05: an in-app update spent 15 of its 35
 * minutes on things the owner never asked for. `step_post_update` ran
 * `install-voice.sh --tts-only`, which had grown into the Kokoro engine (the
 * cusparselt wheel, the 1.5 GB Jetson torch wheel, the Kokoro packages, the
 * 313 MB model) AND the STT half (faster-whisper, a 6.5-minute from-source
 * CTranslate2 CUDA build, the Whisper weights); then `ensure_local_embeddings`
 * downloaded the 639 MB embedding GGUF through `step_embed_model`; and
 * `gateway-pre-start.sh` detached `ensure-local-embeddings.sh` on EVERY gateway
 * start, which downloaded the same GGUF on its own — mid-update, at 15:10:41.
 *
 * Every other engine and model is opt-in now, installed ONLY from Settings →
 * Local AI's on-click installers: `voice_kokoro_install`,
 * `voice_whisper_install`, `--step embed_model`, the llama.cpp model routes.
 * These tests are grep-style pins over the shipped scripts, in the shape of
 * install-no-time-limits.test.ts: a rewrite that keeps the words and puts an
 * install back on an automatic path fails here.
 */

const REPO = process.cwd();
const NL = String.fromCharCode(10);
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const VOICE_SH = readFileSync(path.join(REPO, "scripts", "install-voice.sh"), "utf-8");
const PRE_START = readFileSync(path.join(REPO, "scripts", "gateway-pre-start.sh"), "utf-8");
const EMBED_SH = readFileSync(path.join(REPO, "scripts", "ensure-local-embeddings.sh"), "utf-8");
const DISPATCHER = readFileSync(path.join(REPO, "config", "clawbox-root-step.sh"), "utf-8");
const LAUNCHER = readFileSync(path.join(REPO, "config", "clawbox-run-root-step.sh"), "utf-8");

/** One shell function, verbatim, from `name() {` to its column-zero `}`. */
function extractShellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf(`${NL}}`, start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end + 2);
}

/** The function's CODE: comment lines dropped, so a sentence about the old behaviour cannot trip a grep. */
function code(text: string): string {
  return text
    .split(NL)
    .filter((l) => !/^\s*#/.test(l))
    .join(NL);
}

/** The full-install flow — everything after the `--step` dispatch block. */
const MAIN_FLOW = (() => {
  const at = INSTALL_SH.indexOf("# ── Full Install Mode");
  if (at < 0) throw new Error("the full-install flow marker moved");
  return code(INSTALL_SH.slice(at));
})();

/** Numbered lines of a file, comments excluded. */
function codeLines(text: string): { n: number; text: string }[] {
  return text
    .split(NL)
    .map((t, i) => ({ n: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*#/.test(t));
}

/** The name of the function a line of install.sh sits in, or "" at file scope. */
function enclosingFunction(line: number): string {
  const lines = INSTALL_SH.split(NL);
  for (let i = line - 1; i >= 0; i--) {
    if (/^}\s*$/.test(lines[i])) return "";
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/.exec(lines[i]);
    if (m) return m[1];
  }
  return "";
}

describe("neither an install nor an update installs a voice engine", () => {
  const POST_UPDATE = code(extractShellFunction(INSTALL_SH, "step_post_update"));
  const OPENCLAW_SETUP = code(extractShellFunction(INSTALL_SH, "step_openclaw_setup"));
  const TTS_STEP = code(extractShellFunction(INSTALL_SH, "step_openclaw_tts"));

  it("step_post_update and step_openclaw_setup call the TTS step bare — the refresh, never an install mode", () => {
    for (const [name, body] of [["step_post_update", POST_UPDATE], ["step_openclaw_setup", OPENCLAW_SETUP]] as const) {
      expect(body, `${name} no longer refreshes the voice scripts`).toMatch(/^\s*step_openclaw_tts(\s*\|\|.*)?$/m);
      expect(body, `${name} passes an install mode`).not.toMatch(/step_openclaw_tts\s+--/);
      expect(body, `${name} runs an engine install`).not.toMatch(/--tts-only|--kokoro|--whisper|install_kokoro_tts|install_whisper_stt|step_voice_/);
    }
  });

  it("the TTS step defaults to --scripts-only, and only the two voice_*_install steps ask for more", () => {
    expect(TTS_STEP).toMatch(/VOICE_MODE="\$\{1:---scripts-only\}"/);
    expect(TTS_STEP).toMatch(/install-voice\.sh" "\$VOICE_MODE"/);
    expect(TTS_STEP, "the refresh mode hard-codes an install").not.toMatch(/install-voice\.sh" --/);
    // The whole of install.sh: --kokoro reaches the script from
    // step_voice_kokoro_install alone, --whisper from step_voice_whisper_install
    // alone, --tts-only from nowhere.
    const hits = (re: RegExp) =>
      codeLines(INSTALL_SH).filter(({ text }) => re.test(text)).map(({ n }) => enclosingFunction(n));
    expect(hits(/--tts-only/)).toEqual([]);
    expect(new Set(hits(/--kokoro\b/))).toEqual(new Set(["step_openclaw_tts", "step_voice_kokoro_install"]));
    expect(new Set(hits(/--whisper\b/))).toEqual(new Set(["step_voice_whisper_install"]));
    expect(code(extractShellFunction(INSTALL_SH, "step_voice_kokoro_install"))).toMatch(/step_openclaw_tts --kokoro/);
    expect(code(extractShellFunction(INSTALL_SH, "step_voice_whisper_install"))).toMatch(/install-voice\.sh" --whisper/);
  });

  it("the main flow starts no voice engine install either", () => {
    expect(MAIN_FLOW).not.toMatch(/step_voice_kokoro_install|step_voice_whisper_install|install-voice\.sh/);
    expect(MAIN_FLOW).toMatch(/^\s*step_openclaw_setup\s*$/m);
  });

  it("install-voice.sh --scripts-only reaches nothing that installs", () => {
    // The dispatch names the present-engine check for that mode, and the
    // check itself carries none of the install steps.
    const dispatch = VOICE_SH.slice(VOICE_SH.indexOf('if [ "$VOICE_MODE" != "full" ]; then'), VOICE_SH.indexOf("Voice Pipeline Installer"));
    expect(code(dispatch)).toMatch(/^\s*scripts-only\)\s*kokoro_report_present \|\| KOKORO_RC=\$\?\s*;;\s*$/m);
    expect(code(dispatch)).toMatch(/^\s*kokoro\|tts-only\)\s*install_kokoro_tts \|\| KOKORO_RC=\$\?\s*;;\s*$/m);
    const present = code(extractShellFunction(VOICE_SH, "kokoro_report_present"));
    expect(present).not.toMatch(/pip_as_clawbox|install_cuda_torch|install_kokoro_packages|kokoro_predownload_model|install_kokoro_tts|install_whisper_stt|build_ctranslate2_cuda/);
    expect(present).toMatch(/kokoro_report "absent"/);
    const refresh = code(extractShellFunction(VOICE_SH, "whisper_refresh_present"));
    expect(refresh).not.toMatch(/pip_as_clawbox|build_ctranslate2_cuda|whisper_predownload_model|install_whisper_stt/);
  });

  it("the absent verdict is in every reader's vocabulary as a plain state", () => {
    expect(code(extractShellFunction(VOICE_SH, "tts_verdict_explain"))).toMatch(/^\s*absent\)/m);
    const validator = code(extractShellFunction(INSTALL_SH, "step_validate_services"));
    expect(validator).toMatch(/""\|ready\|absent\|skipped:\?\*\|failed:\?\*\)/);
    // An `absent)` arm of its own that adds nothing to the failed probes.
    const arm = validator.slice(validator.indexOf("absent)"), validator.indexOf("skipped:?*)", validator.indexOf("absent)")));
    expect(arm).not.toContain("failed_probe+=");
    // And the step never records it.
    const absentArm = TTS_STEP.slice(TTS_STEP.indexOf('if [ "$KOKORO_ABSENT" = true ] && [ "$VOICE_RC" -eq 0 ]; then'), TTS_STEP.indexOf("elif", TTS_STEP.indexOf('if [ "$KOKORO_ABSENT" = true ] && [ "$VOICE_RC" -eq 0 ]; then')));
    expect(absentArm).not.toContain("record_provision_failure");
    expect(absentArm).toContain("install it from Settings → Local AI");
  });
});

describe("neither an install nor an update downloads the memory-search embedder", () => {
  it("every `hf download` in install.sh sits in one of the two cache functions", () => {
    const owners = codeLines(INSTALL_SH)
      .filter(({ text }) => /\bhf download\b/.test(text))
      .map(({ n }) => enclosingFunction(n));
    expect(owners.sort()).toEqual(["ensure_embed_model_cached", "ensure_llamacpp_model_cached"]);
  });

  it("step_embed_model is reached by nothing but the --step dispatch", () => {
    // Its definition, and the generic `"step_${local_step}"` call — no direct
    // caller anywhere: the Local AI tab's click is `--step embed_model`.
    const callers = codeLines(INSTALL_SH)
      .filter(({ text }) => /\bstep_embed_model\b/.test(text) && !/^step_embed_model\(\)/.test(text))
      .map(({ n, text }) => `${n}: ${text.trim()}`);
    expect(callers).toEqual([]);
    expect(codeLines(INSTALL_SH).filter(({ text }) => /\bensure_embed_model_cached\b/.test(text) && !/^ensure_embed_model_cached\(\)/.test(text)).map(({ n }) => enclosingFunction(n)))
      .toEqual(["step_embed_model"]);
  });

  it("the main flow announces the model step and defers it on every edition", () => {
    expect(MAIN_FLOW).not.toMatch(/\bstep_embed_model\b/);
    expect(MAIN_FLOW).toMatch(/^log "Memory-search model/m);
    expect(MAIN_FLOW).toMatch(/^echo "  Deferred: Settings → Local AI/m);
  });

  it("ensure_local_embeddings wires an embedder that is on disk and fetches none", () => {
    const body = code(extractShellFunction(INSTALL_SH, "ensure_local_embeddings"));
    expect(body).not.toMatch(/\bstep_embed_model\b|\bhf download\b/);
    expect(body).toMatch(/as_clawbox_login "\$helper" --no-download <\/dev\/null \|\| true/);
    expect(body).toMatch(/MODEL_PATH="\$\(embed_model_path\)"/);
    expect(body).toMatch(/if \[ ! -f "\$MODEL_PATH" \]; then\s*\n\s*echo "  The memory-search embedder is not installed on this box[^\n]*\n\s*return 0/);
  });

  it("embed_model_path and ensure_embed_model_cached name the same file", () => {
    const file = /get_env_setting_or_default "[^"]*" "EMBED_HF_FILE" "([^"]+)"/g;
    const pins = [...INSTALL_SH.matchAll(file)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pins).size).toBe(1);
  });

  it("gateway-pre-start.sh passes --no-download and stands down under an update", () => {
    const launch = codeLines(PRE_START).filter(({ text }) => /setsid nohup "\$LOCAL_EMBEDDINGS"/.test(text));
    expect(launch).toHaveLength(1);
    expect(launch[0].text).toMatch(/"\$LOCAL_EMBEDDINGS" --no-download /);
    expect(PRE_START).toMatch(/^update_owns_box\(\) \{/m);
    expect(PRE_START.indexOf("if update_owns_box; then")).toBeLessThan(PRE_START.indexOf('setsid nohup "$LOCAL_EMBEDDINGS"'));
    const fn = code(extractShellFunction(PRE_START, "update_owns_box"));
    expect(fn).toContain('"update_in_progress"');
    expect(fn).toContain('"update_needs_continuation"');
  });

  it("ensure-local-embeddings.sh honours --no-download before it reads its backoff", () => {
    const body = code(EMBED_SH);
    expect(body).toMatch(/--no-download\) NO_DOWNLOAD=1 ;;/);
    const check = body.indexOf('if [ "$NO_DOWNLOAD" = "1" ]; then');
    expect(check).toBeGreaterThan(body.indexOf('if [ ! -f "$MODEL_PATH" ]; then'));
    expect(check).toBeLessThan(body.indexOf('NOW="$(date +%s)"'));
    expect(check).toBeLessThan(body.indexOf('"$HF_BIN" download'));
  });
});

describe("what the installers DO fetch, and nothing more", () => {
  it("keeps the llama.cpp runtime and Gemma 4 on the main flow, and the Gemma re-cache in post_update", () => {
    expect(MAIN_FLOW).toMatch(/^\s*step_llamacpp_install\s*$/m);
    expect(MAIN_FLOW).toMatch(/^\s*step_ollama_install\s*$/m);
    const post = code(extractShellFunction(INSTALL_SH, "step_post_update"));
    expect(post).toMatch(/optional_step llamacpp_model step_llamacpp_model/);
    expect(code(extractShellFunction(INSTALL_SH, "step_llamacpp_model"))).toMatch(/ensure_llamacpp_model_cached/);
  });

  it("step_ollama_install installs the daemon and pulls no model", () => {
    const body = code(extractShellFunction(INSTALL_SH, "step_ollama_install"));
    expect(body).not.toMatch(/\bollama\s+(pull|run)\b/);
    expect(body).toMatch(/ollama\.com\/install\.sh/);
  });

  it("the two engine installs are dispatchable, web-startable and off the UI/MCP list", () => {
    const dispatch = /^DISPATCH_STEPS=\(([^)]*)\)/m.exec(INSTALL_SH);
    expect(dispatch).not.toBeNull();
    const dispatchable = dispatch![1].split(/\s+/).filter((t) => t && !t.startsWith("#"));
    const allowed = /^ALLOWED_STEPS="([^"]*)"/m.exec(DISPATCHER)![1].split(/\s+/).filter(Boolean);
    const launcher = /^WEB_ROOT_STEPS="([^"]*)"/m.exec(LAUNCHER)![1].split(/\s+/).filter(Boolean);
    for (const step of ["voice_kokoro_install", "voice_whisper_install"]) {
      expect(dispatchable, `${step} is not dispatchable`).toContain(step);
      expect(allowed, `${step} is not on the root dispatcher's list`).toContain(step);
      expect(launcher, `${step} is not on the launcher's list`).toContain(step);
      expect(WEB_ROOT_STEPS).toContain(step);
      expect(UI_ROOT_STEPS, `${step} is offered to install/run-step, which the MCP bearer reaches`).not.toContain(step);
      expect(INSTALL_SH).toMatch(new RegExp(`^step_${step}\\(\\) \\{`, "m"));
    }
  });
});
