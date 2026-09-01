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
const DEFAULT_LLAMACPP_CONTEXT_WINDOW = 131072;

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
  const configuredPort = (process.env.CLAWBOX_PORT || process.env.PORT || "80").trim();
  const validPort = /^\d+$/.test(configuredPort)
    && Number(configuredPort) >= 1
    && Number(configuredPort) <= 65535;
  const port = validPort ? configuredPort : "80";
  const defaultRoot = `http://127.0.0.1${port === "80" ? "" : `:${port}`}`;
  const root = (process.env.CLAWBOX_LOCAL_AI_PROXY_BASE_URL || defaultRoot)
    .trim()
    .replace(/\/+$/, "");
  return `${root}/setup-api/local-ai/llamacpp/v1`;
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
 * Return the explicit llama.cpp server context size. A value of 0 is
 * intentional here and means "let llama-server load the trained context size
 * from the model" rather than forcing an app-level cap.
 */
export function getLlamaCppServerContextSize(): number {
  const value = Number(process.env.LLAMACPP_CONTEXT_WINDOW);
  return Number.isFinite(value) && value >= 16384 ? Math.floor(value) : 0;
}

export function getLlamaCppMaxTokens(): number | undefined {
  const raw = process.env.LLAMACPP_MAX_TOKENS?.trim();
  if (!raw) return getLlamaCppContextWindow();

  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : getLlamaCppContextWindow();
}
