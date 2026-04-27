// Curated model lists per cloud AI provider. Surfaced in the setup
// wizard, Settings, and the chat popup's secondary dropdown. Each
// provider only shows a handful of broadly-useful models; power users
// can enter a custom model ID via the "custom" toggle (newer releases,
// region-specific variants, models we haven't added to the catalog yet).
//
// `id` is the provider-native model identifier (no `<provider>/` prefix).
// The fully-qualified model stored in `agents.defaults.model.primary` is
// `${provider}/${id}`. For OpenRouter the id itself contains a slash
// (e.g. `anthropic/claude-haiku-4-5`) since OpenRouter's catalog uses
// `<org>/<model>` slugs.

import {
  OPENROUTER_CURATED_MODELS,
  OPENROUTER_DEFAULT_MODEL_ID,
  isValidOpenRouterModelId,
} from "./openrouter-models";

export interface ProviderModelOption {
  id: string;
  label: string;
  hint: string;
}

export interface ProviderCatalog {
  provider: string;
  models: readonly ProviderModelOption[];
  defaultModelId: string;
  /** True if the user may enter a custom model ID outside the curated list. */
  allowCustom: boolean;
}

// IMPORTANT: every `id` below must be a real model the provider's API
// currently accepts. Invented/speculative slugs (e.g. guessing a version
// that hasn't shipped) produce a 400 from the upstream and the chat
// silently falls back to the local model. When adding entries, verify
// against the provider's docs — don't guess based on marketing names.
//
// Anthropic direct API uses hyphen-dash versioning (claude-haiku-4-5),
// OpenRouter mirrors with dot versioning (anthropic/claude-haiku-4.5),
// and the two catalogs update at different cadences — OpenRouter
// typically lags Anthropic by one release, so the latest Anthropic
// flagship (Sonnet 4.6, Opus 4.7) may not be on OR yet.
// Source: https://platform.claude.com/docs/en/docs/about-claude/models/overview
export const ANTHROPIC_MODELS: readonly ProviderModelOption[] = [
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    hint: "Fastest, near-frontier, cheap.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    hint: "Default. Best speed + intelligence balance.",
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    hint: "Most capable, complex reasoning, pricier.",
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    hint: "Legacy flagship, still supported.",
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    hint: "Legacy Sonnet, still supported.",
  },
] as const;

export const OPENAI_MODELS: readonly ProviderModelOption[] = [
  {
    id: "gpt-5",
    label: "GPT-5",
    hint: "Flagship.",
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 Mini",
    hint: "Cheap, very fast.",
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 Nano",
    hint: "Cheapest, lightweight.",
  },
] as const;

// OpenAI ChatGPT subscription (Codex) models. Available when the user
// authenticates via OAuth instead of pasting an API key. IDs verified
// against `openclaw models list --provider openai-codex --all` — the
// ChatGPT backend uses its own internal versioning separate from the
// platform API (e.g. `gpt-5.4` here has no equivalent on api.openai.com).
export const OPENAI_CODEX_MODELS: readonly ProviderModelOption[] = [
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    hint: "Default. ChatGPT flagship.",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    hint: "Fast, cheap.",
  },
  {
    id: "gpt-5.4-pro",
    label: "GPT-5.4 Pro",
    hint: "Max reasoning.",
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    hint: "Codex coding model.",
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    hint: "Newer Codex variant.",
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    hint: "Prior flagship.",
  },
  {
    id: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    hint: "Coding-specialized.",
  },
  {
    id: "gpt-5.1",
    label: "GPT-5.1",
    hint: "Legacy flagship.",
  },
  {
    id: "gpt-5.1-codex-max",
    label: "GPT-5.1 Codex Max",
    hint: "Large-context coding.",
  },
  {
    id: "gpt-5.1-codex-mini",
    label: "GPT-5.1 Codex Mini",
    hint: "Compact coding.",
  },
] as const;

// Source: https://ai.google.dev/gemini-api/docs/models
// 2.5 line is production; 3.x are preview (marked -preview in the ID).
// Gemini 3 Pro has no `-pro` stable yet — the preview is what's shipping.
export const GOOGLE_MODELS: readonly ProviderModelOption[] = [
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    hint: "Default. Best price-performance.",
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    hint: "Fastest, most budget-friendly.",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "Complex reasoning and coding.",
  },
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash (preview)",
    hint: "Frontier-class performance at Flash cost.",
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (preview)",
    hint: "Advanced reasoning and agentic.",
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash-Lite (preview)",
    hint: "Speed and efficiency optimized.",
  },
] as const;

export const PROVIDER_CATALOGS = Object.freeze({
  anthropic: {
    provider: "anthropic",
    models: ANTHROPIC_MODELS,
    defaultModelId: "claude-sonnet-4-6",
    allowCustom: true,
  },
  openai: {
    provider: "openai",
    models: OPENAI_MODELS,
    defaultModelId: "gpt-5",
    allowCustom: true,
  },
  "openai-codex": {
    provider: "openai-codex",
    models: OPENAI_CODEX_MODELS,
    defaultModelId: "gpt-5.4",
    allowCustom: true,
  },
  google: {
    provider: "google",
    models: GOOGLE_MODELS,
    defaultModelId: "gemini-2.5-flash",
    allowCustom: true,
  },
  openrouter: {
    provider: "openrouter",
    models: OPENROUTER_CURATED_MODELS,
    defaultModelId: OPENROUTER_DEFAULT_MODEL_ID,
    allowCustom: true,
  },
} satisfies Record<string, ProviderCatalog>);

type ProviderCatalogKey = keyof typeof PROVIDER_CATALOGS;

export function getProviderCatalog(provider: string | null | undefined): ProviderCatalog | null {
  if (!provider) return null;
  return Object.prototype.hasOwnProperty.call(PROVIDER_CATALOGS, provider)
    ? PROVIDER_CATALOGS[provider as ProviderCatalogKey]
    : null;
}

/**
 * Splits a fully-qualified model string like `anthropic/claude-sonnet-4-6`
 * or `openrouter/anthropic/claude-haiku-4-5` into provider + modelId.
 * Pure helper, safe to import from browser code (unlike the server-side
 * `parseFullyQualifiedModel` in openclaw-config which drags in fs/child_process).
 */
export function parseModelSlug(
  fullyQualified: string | null | undefined,
): { provider: string; modelId: string } | null {
  if (typeof fullyQualified !== "string") return null;
  const trimmed = fullyQualified.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf("/");
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, idx), modelId: trimmed.slice(idx + 1) };
}

/**
 * Returns the modelId portion of `fullyQualified` when it matches the
 * expected provider, or null otherwise. Useful for seeding a provider-specific
 * picker from `agents.defaults.model.primary` in config.
 */
export function extractProviderModelId(
  fullyQualified: string | null | undefined,
  provider: string,
): string | null {
  const parsed = parseModelSlug(fullyQualified);
  if (!parsed || parsed.provider !== provider) return null;
  return parsed.modelId;
}

// Generic cloud-provider model ID shape: letters/digits, plus `._-`, no
// slashes. OpenRouter has its own validator (isValidOpenRouterModelId)
// because OpenRouter slugs contain one or more slashes.
const GENERIC_MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Validates a provider-native model ID. For OpenRouter, defers to the
 * OpenRouter-specific validator (which requires the <org>/<model> shape).
 * For other providers, enforces the generic no-slash shape.
 *
 * We intentionally do NOT enforce membership in the curated list —
 * users can type newer model IDs that haven't been added to the catalog
 * yet, as long as the shape is sane.
 */
export function isValidModelId(provider: string, modelId: string): boolean {
  if (!modelId || typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (!trimmed) return false;
  if (provider === "openrouter") {
    return isValidOpenRouterModelId(trimmed);
  }
  return GENERIC_MODEL_ID_RE.test(trimmed);
}
