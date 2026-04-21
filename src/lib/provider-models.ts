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
// Anthropic uses hyphen-dash versioning (claude-haiku-4-5), OpenRouter
// uses dot versioning (anthropic/claude-haiku-4.5) for the SAME model.
// Keep the two catalogs in sync when a new version ships.
export const ANTHROPIC_MODELS: readonly ProviderModelOption[] = [
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    hint: "Fast, cheap, strong tool use.",
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    hint: "Flagship, best balance.",
  },
  {
    id: "claude-opus-4-1",
    label: "Claude Opus 4.1",
    hint: "Max reasoning, slower and pricier.",
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

export const GOOGLE_MODELS: readonly ProviderModelOption[] = [
  {
    id: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    hint: "Very fast, multimodal.",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    hint: "Fast, balanced.",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "Long-context reasoning.",
  },
] as const;

export const PROVIDER_CATALOGS: Record<string, ProviderCatalog> = {
  anthropic: {
    provider: "anthropic",
    models: ANTHROPIC_MODELS,
    defaultModelId: "claude-sonnet-4-5",
    allowCustom: true,
  },
  openai: {
    provider: "openai",
    models: OPENAI_MODELS,
    defaultModelId: "gpt-5",
    allowCustom: true,
  },
  google: {
    provider: "google",
    models: GOOGLE_MODELS,
    defaultModelId: "gemini-2.0-flash",
    allowCustom: true,
  },
  openrouter: {
    provider: "openrouter",
    models: OPENROUTER_CURATED_MODELS,
    defaultModelId: OPENROUTER_DEFAULT_MODEL_ID,
    allowCustom: true,
  },
};

export function getProviderCatalog(provider: string | null | undefined): ProviderCatalog | null {
  if (!provider) return null;
  return PROVIDER_CATALOGS[provider] ?? null;
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
