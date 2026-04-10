const DEFAULT_LLAMACPP_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_LLAMACPP_MODEL = "gemma4-e2b-it-q4_0";
export const DEFAULT_LLAMACPP_HF_REPO = "gguf-org/gemma-4-e2b-it-gguf";
export const DEFAULT_LLAMACPP_HF_FILE = "gemma-4-e2b-it-edited-q4_0.gguf";
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
    memoryNote: "Gemma 4 E2B Q4_0 is roughly 3.2GB of model memory, while the Ollama Gemma 4 E2B Q8_0 artifact is about 8.1GB.",
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
