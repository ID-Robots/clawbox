// Curated list of OpenRouter models surfaced in the ClawBox setup wizard,
// Settings, and chat popup. OpenRouter itself exposes 340+ models — showing
// all of them would be unusable, so we keep a short list of broadly-useful
// defaults and let power users enter any other OpenRouter slug via the
// "Custom model ID…" option in the UI.
//
// IMPORTANT: every `id` below must be a real slug in OpenRouter's catalog
// (https://openrouter.ai/api/v1/models). Invented/speculative IDs return
// `400 <slug> is not a valid model ID` and the chat silently falls back
// to the local model. When adding entries, verify against the live
// OpenRouter catalog — don't guess based on marketing names.
//
// `id` is the OpenRouter slug passed as `agents.defaults.model.primary`
// prefixed with `openrouter/`. `label` and `hint` are purely UI copy.

export interface OpenRouterModelOption {
  id: string;
  label: string;
  hint: string;
}

export const OPENROUTER_CURATED_MODELS: readonly OpenRouterModelOption[] = [
  {
    id: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    hint: "Default. Fast, cheap, strong tool use.",
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    label: "Claude Sonnet 4.5",
    hint: "Anthropic flagship, strongest tool use.",
  },
  {
    id: "anthropic/claude-opus-4.1",
    label: "Claude Opus 4.1",
    hint: "Max reasoning, slower and pricier.",
  },
  {
    id: "openai/gpt-5",
    label: "GPT-5",
    hint: "OpenAI flagship.",
  },
  {
    id: "openai/gpt-5-mini",
    label: "GPT-5 Mini",
    hint: "Cheap, very fast, good for tool calls.",
  },
  {
    id: "openai/gpt-5-nano",
    label: "GPT-5 Nano",
    hint: "Cheapest OpenAI, lightweight tasks.",
  },
  {
    id: "google/gemini-2.0-flash-001",
    label: "Gemini 2.0 Flash",
    hint: "Very fast, multimodal.",
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    hint: "Fast Gemini, balanced price.",
  },
  {
    id: "google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "Long-context reasoning.",
  },
  {
    id: "x-ai/grok-4-fast",
    label: "Grok 4 Fast",
    hint: "xAI, quick responses.",
  },
  {
    id: "x-ai/grok-4",
    label: "Grok 4",
    hint: "xAI flagship.",
  },
  {
    id: "moonshotai/kimi-k2-0905",
    label: "Kimi K2",
    hint: "Moonshot, agentic-first.",
  },
  {
    id: "deepseek/deepseek-chat-v3.1",
    label: "DeepSeek Chat V3.1",
    hint: "Cheap and capable.",
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B",
    hint: "Meta open-weights.",
  },
  {
    id: "qwen/qwen3-max",
    label: "Qwen 3 Max",
    hint: "Alibaba flagship, strong multilingual.",
  },
] as const;

export const OPENROUTER_DEFAULT_MODEL_ID = "anthropic/claude-haiku-4.5";

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
 * Convert a fully-qualified model like `openrouter/anthropic/claude-haiku-4.5`
 * to just the OpenRouter slug (`anthropic/claude-haiku-4.5`). Returns null
 * if the input isn't an openrouter model.
 */
export function extractOpenRouterSlug(fullyQualifiedModel: string | null | undefined): string | null {
  if (typeof fullyQualifiedModel !== "string") return null;
  const prefix = "openrouter/";
  if (!fullyQualifiedModel.startsWith(prefix)) return null;
  const slug = fullyQualifiedModel.slice(prefix.length);
  return slug || null;
}
