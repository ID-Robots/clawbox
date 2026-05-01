// COLD-START FALLBACK ONLY — the live OpenRouter catalog comes from
// `/setup-api/ai-models/catalog?provider=openrouter`, which fetches
// https://openrouter.ai/api/v1/models directly. The list below is
// rendered ONLY while the async fetch is still in flight (or when it
// fails on a fresh device with no cached payload).
//
// Hand-curated lists used to be the primary source and rotted every
// time OpenRouter renamed or retired a slug — every miss silently
// degraded to local llamacpp because the gateway's 400 wasn't
// surfaced to the chat UI. We now defer to the live API and only
// keep a tiny "obvious flagships" fallback here so the picker isn't
// empty during the few-hundred-ms window of the first fetch.

export interface OpenRouterModelOption {
  id: string;
  label: string;
  hint: string;
}

export const OPENROUTER_CURATED_MODELS: readonly OpenRouterModelOption[] = [
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", hint: "Default. Fast, cheap." },
  { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5", hint: "Strong tool use." },
  { id: "openai/gpt-5", label: "GPT-5", hint: "OpenAI flagship." },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Fast multimodal." },
] as const;

export const OPENROUTER_DEFAULT_MODEL_ID = "anthropic/claude-haiku-4.5";

/**
 * OpenRouter slugs are structured `<org>/<model>` (sometimes with more
 * path segments). Validate the shape before we accept a user-supplied
 * custom model ID — stops empty strings, whitespace, and obvious typos
 * without getting in the way of legitimate rare slugs.
 */
const OPENROUTER_SLUG_RE =
  /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/i;

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
