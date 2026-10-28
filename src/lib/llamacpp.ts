import { getLocalAiProxyRootUrl } from "@/lib/local-ai-proxy-url";

const DEFAULT_LLAMACPP_BASE_URL = "http://127.0.0.1:8080/v1";
// The wire-visible model id. It is only llama-server's --alias, so it does NOT
// encode the quantisation provenance and must stay stable across GGUF changes:
// it is what the OpenClaw gateway config, the Hermes model options and every
// saved user model selection already refer to. Changing the GGUF changes the
// two constants below it, never this one.
const DEFAULT_LLAMACPP_MODEL = "gemma4-e2b-it-q4_0";

// Google's own QAT release. Chosen by measurement on Jetson Orin Nano 8GB
// against llama-server (the runtime we ship), not from model cards:
//
//   candidate                          agentic  gen tok/s  peak RAM  minAvail
//   google  E2B QAT q4_0      (this)     92.3%      29.0    3780 MB   3673 MB
//   gguf-org E2B "edited" q4_0 (was)     84.6%      31.2    3862 MB   3590 MB
//   unsloth E2B QAT UD-Q4_K_XL           84.6%      34.7    3540 MB   3917 MB
//   unsloth E4B QAT UD-Q4_K_XL           84.6%      18.3    5548 MB   1913 MB
//
// All four score 100% on strict JSON, so the whole quality separation is the
// two-step tool chain (search_contacts -> send_email): only this build runs it,
// the other three stop and ask the user for the address they were meant to look
// up. The superseded build additionally ships an outdated Gemma 4 chat template
// that makes llama.cpp log "applying compatibility workarounds" on every
// request. E4B buys no accuracy for 1.8 GB more RAM and 37% less throughput.
export const DEFAULT_LLAMACPP_HF_REPO = "google/gemma-4-E2B-it-qat-q4_0-gguf";
export const DEFAULT_LLAMACPP_HF_FILE = "gemma-4-E2B_q4_0-it.gguf";

/**
 * The GGUF this device shipped with before the QAT switch. Only used to
 * recognise a stale pin: a device installed earlier has the old repo/file
 * written into its .env, and `ensure_env_setting` in install.sh never
 * overwrites an existing key, so without an explicit migration the new default
 * would never reach any device that is already in the field.
 */
export const SUPERSEDED_LLAMACPP_HF_REPO = "gguf-org/gemma-4-e2b-it-gguf";
export const SUPERSEDED_LLAMACPP_HF_FILE = "gemma-4-e2b-it-edited-q4_0.gguf";

/**
 * How big a window llama-server runs, what OpenClaw is told the window is, and
 * the longest answer it may ask for. Keep in step with install.sh,
 * install-x64.sh, scripts/start-llamacpp.sh and the llamacpp block of
 * scripts/gateway-pre-start.sh — src/tests/unit/llamacpp-launch-defaults.test.ts
 * fails if they disagree.
 *
 * 32k with a q8_0 KV cache replaced 131k with q4_0. Measured on an 8 GB Jetson
 * (reports/clawbox/local-ai/BENCHMARK.md): the lean local prompt is ~1k tokens
 * and the full OpenClaw one ~13k, so a 131k window only ever held empty cache,
 * while q4_0 keys cost answer quality on a 2B model. 8192 output tokens is a
 * whole one-file web app, and it matches the 25% of the window OpenClaw keeps
 * free for the answer before it compacts.
 */
export const DEFAULT_LLAMACPP_CONTEXT_WINDOW = 32768;
export const DEFAULT_LLAMACPP_MAX_TOKENS = 8192;
export const DEFAULT_LLAMACPP_CACHE_TYPE = "q8_0";

/**
 * The values the launch shipped with before the change above. Only used to
 * recognise a device still on them: install.sh writes them into .env, and
 * `ensure_env_setting` never overwrites an existing key, so install.sh migrates
 * exactly these values and leaves any other choice an operator made alone.
 */
export const SUPERSEDED_LLAMACPP_CONTEXT_WINDOW = 131072;
export const SUPERSEDED_LLAMACPP_MAX_TOKENS = 131072;
export const SUPERSEDED_LLAMACPP_CACHE_TYPE = "q4_0";

/**
 * Thinking on the on-device model: off unless a request asks for it.
 *
 * llama-server reads `chat_template_kwargs.enable_thinking` per request, and
 * the ClawBox proxy sets it from an OpenAI-style `reasoning_effort`
 * (src/lib/local-ai-thinking.ts). OpenClaw sends that field only for a row that
 * declares `reasoning: true`; this compat makes it binary — every enabled level
 * clamps to `high`, `off` is sent as `none` — because the model has no graded
 * effort. And a reasoning row's default would be `medium`, so the row is
 * written together with an `off` default for the model (llamaCppThinkingDefaultOp),
 * which a session or one message (`/think high`) overrides.
 *
 * Measured on an 8 GB Jetson (reports/clawbox/local-ai/BENCHMARK.md): on ten
 * everyday tasks thinking roughly doubled the median answer time for no real
 * gain; on six multi-step questions it fixed one of two the model got wrong,
 * at 5-9 s more per answer. So: off by default, on for the hard ones.
 *
 * Keys of OpenClaw 2026.10+; an older core gets the old row (reasoning: false).
 * Keep in step with `_LLAMACPP_REASONING_COMPAT` in scripts/gateway-pre-start.sh.
 */
export const LLAMACPP_REASONING_COMPAT = Object.freeze({
  supportedReasoningEfforts: Object.freeze(["none", "high"]),
  reasoningEffortMap: Object.freeze({ off: "none" }),
});

/** The config-set entry that makes `off` the on-device model's own default thinking level. */
export function llamaCppThinkingDefaultOp(modelRef: string): string[] {
  return [`agents.defaults.models[${JSON.stringify(modelRef)}].params.thinking`, "off"];
}

export interface LlamaCppRecommendedModel {
  id: string;
  label: string;
  description: string;
  memoryNote: string;
}

export const LLAMACPP_RECOMMENDED_MODELS: readonly LlamaCppRecommendedModel[] = [
  {
    id: DEFAULT_LLAMACPP_MODEL,
    label: "Gemma 4 E2B Q4/INT4",
    description: "Recommended for 8GB-class devices running llama.cpp",
    memoryNote: "Gemma 4 E2B QAT Q4_0 is a 3.1GB download and measured 3.3GB resident on an 8GB Jetson, while the Ollama Gemma 4 E2B Q8_0 artifact is about 8.1GB.",
  },
] as const;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_LLAMACPP_BASE_URL;

  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.at(-1) !== "v1") {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1`;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    const fallback = trimmed.replace(/\/+$/, "");
    return fallback.endsWith("/v1") ? fallback : `${fallback}/v1`;
  }
}

export function getLlamaCppBaseUrl(): string {
  return normalizeBaseUrl(process.env.LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL);
}

export function getLlamaCppProxyBaseUrl(): string {
  return `${getLocalAiProxyRootUrl()}/setup-api/local-ai/llamacpp/v1`;
}

export function getDefaultLlamaCppModel(): string {
  return process.env.LLAMACPP_MODEL?.trim() || DEFAULT_LLAMACPP_MODEL;
}

export function getDefaultLlamaCppRepo(): string {
  return process.env.LLAMACPP_HF_REPO?.trim() || DEFAULT_LLAMACPP_HF_REPO;
}

export function getDefaultLlamaCppFile(): string {
  return process.env.LLAMACPP_HF_FILE?.trim() || DEFAULT_LLAMACPP_HF_FILE;
}

export function getLlamaCppContextWindow(): number {
  const value = Number(process.env.LLAMACPP_CONTEXT_WINDOW || DEFAULT_LLAMACPP_CONTEXT_WINDOW);
  return Number.isFinite(value) && value >= 16384 ? Math.floor(value) : DEFAULT_LLAMACPP_CONTEXT_WINDOW;
}

/**
 * The `--ctx-size` llama-server is started with: the same number OpenClaw is
 * told (getLlamaCppContextWindow). It used to be 0 when the variable was unset
 * — "the model's trained size", 128k for Gemma 4 — while OpenClaw was told the
 * default, so the two only agreed by coincidence.
 */
export function getLlamaCppServerContextSize(): number {
  return getLlamaCppContextWindow();
}

/**
 * The longest answer OpenClaw may ask for, never more than the window itself.
 */
export function getLlamaCppMaxTokens(): number {
  const contextWindow = getLlamaCppContextWindow();
  const raw = process.env.LLAMACPP_MAX_TOKENS?.trim();
  const value = raw ? Number(raw) : DEFAULT_LLAMACPP_MAX_TOKENS;
  const maxTokens = Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_LLAMACPP_MAX_TOKENS;
  return Math.min(maxTokens, contextWindow);
}
