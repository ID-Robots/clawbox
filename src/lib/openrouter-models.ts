// Curated list of OpenRouter models surfaced in the ClawBox setup wizard,
// Settings, and chat popup. OpenRouter itself exposes 340+ models — showing
// all of them would be unusable, so we keep a short list of broadly-useful
// defaults and let power users enter any other OpenRouter slug via the
// "Custom model ID…" option in the UI.
//
// `id` is the OpenRouter slug passed as `agents.defaults.model.primary`
// prefixed with `openrouter/`. `label` and `hint` are purely UI copy.
//
// Adding/removing entries here is the only change needed to update the
// picker surface — no code path hardcodes individual slugs.

export interface OpenRouterModelOption {
  id: string;
  label: string;
  hint: string;
}

export const OPENROUTER_CURATED_MODELS: readonly OpenRouterModelOption[] = [
  {
    id: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    hint: "Default. Fast, cheap, strong tool use.",
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    hint: "Anthropic flagship, strongest tool use.",
  },
  {
    id: "anthropic/claude-opus-4-7",
    label: "Claude Opus 4.7",
    hint: "Max reasoning, slower and pricier.",
  },
  {
    id: "openai/gpt-5.4",
    label: "GPT-5.4",
    hint: "OpenAI flagship.",
  },
  {
    id: "openai/gpt-5-mini",
    label: "GPT-5 Mini",
    hint: "Cheap, very fast, good for tool calls.",
  },
  {
    id: "google/gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    hint: "Very fast, multimodal.",
  },
  {
    id: "google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "Long-context reasoning.",
  },
  {
    id: "x-ai/grok-4-1-fast",
    label: "Grok 4.1 Fast",
    hint: "xAI, quick responses.",
  },
  {
    id: "moonshotai/kimi-k2-0905",
    label: "Kimi K2",
    hint: "Moonshot, agentic-first.",
  },
  {
    id: "deepseek/deepseek-chat-v3",
    label: "DeepSeek Chat V3",
    hint: "Cheap and capable.",
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B",
    hint: "Meta open-weights.",
  },
  {
    id: "qwen/qwen3-next",
    label: "Qwen 3 Next",
    hint: "Alibaba, strong multilingual.",
  },
] as const;

export const OPENROUTER_DEFAULT_MODEL_ID = "anthropic/claude-haiku-4-5";

/**
 * OpenRouter slugs are structured `<org>/<model>` (sometimes with more
 * path segments). Validate the shape before we accept a user-supplied
 * custom model ID — stops empty strings, whitespace, and obvious typos
 * without getting in the way of legitimate rare slugs.
 */
const OPENROUTER_SLUG_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i;

export function isValidOpenRouterModelId(id: string): boolean {
  return OPENROUTER_SLUG_RE.test(id.trim());
}

/**
 * Convert a fully-qualified model like `openrouter/anthropic/claude-haiku-4-5`
 * to just the OpenRouter slug (`anthropic/claude-haiku-4-5`). Returns null
 * if the input isn't an openrouter model.
 */
export function extractOpenRouterSlug(fullyQualifiedModel: string | null | undefined): string | null {
  if (typeof fullyQualifiedModel !== "string") return null;
  const prefix = "openrouter/";
  if (!fullyQualifiedModel.startsWith(prefix)) return null;
  const slug = fullyQualifiedModel.slice(prefix.length);
  return slug || null;
}
