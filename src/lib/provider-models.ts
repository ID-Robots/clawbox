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

// COLD-START FALLBACK ONLY — the live catalog comes from
// `/setup-api/ai-models/catalog?provider=<id>`, which proxies
// `openclaw models list --provider <p> --all --json` (and OpenRouter's
// own /api/v1/models endpoint for openrouter). The arrays below are
// rendered ONLY when:
//   * the picker is mounting and the async fetch hasn't returned yet, or
//   * the catalog endpoint failed AND no cached payload was previously
//     served (network blip on a fresh device).
//
// Hand-curated lists used to be the primary source and rotted every
// time an upstream rename or deprecation shipped (gemini-2.0-flash,
// claude-haiku-4-5 dash vs dot, grok-4-1-fast, gpt-5.4, …). The fix is
// to make these short enough to keep current by sight (3-4 obviously
// stable entries per provider) and let the live catalog fill in the
// rest. If you find yourself adding the latest model here, stop —
// that's the catalog route's job.
export const ANTHROPIC_MODELS: readonly ProviderModelOption[] = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fastest, near-frontier." },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Default. Speed + intelligence." },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "Most capable." },
] as const;

// OpenAI API key models. Curated to the 5.4 + 5.5 generations only —
// older gens (4.1, 5.0, 5.1, 5.2, 5.3) are filtered out at the catalog
// route via ALLOWED_MODEL_RE_BY_PROVIDER. Power users can still hit
// older models via the "custom" toggle.
export const OPENAI_MODELS: readonly ProviderModelOption[] = [
  { id: "gpt-5.5-pro", label: "GPT-5.5 Pro", hint: "Latest, max reasoning." },
  { id: "gpt-5.5", label: "GPT-5.5", hint: "Latest flagship." },
  { id: "gpt-5.4-pro", label: "GPT-5.4 Pro", hint: "Max reasoning, 1M context." },
  { id: "gpt-5.4", label: "GPT-5.4", hint: "Default. 1M context." },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "Fast, cheap." },
] as const;

// OpenAI ChatGPT subscription (Codex) models. Available when the user
// authenticates via OAuth instead of pasting an API key. NO -pro
// variants — those are API-key only (they 400 with "model not
// supported when using Codex with a ChatGPT account" on the OAuth
// path). Per developers.openai.com/codex/models the supported set
// via ChatGPT-account auth is gpt-5.5, gpt-5.4, gpt-5.4-mini.
// Filter lives in ALLOWED_MODEL_RE_BY_PROVIDER (catalog route).
export const OPENAI_CODEX_MODELS: readonly ProviderModelOption[] = [
  { id: "gpt-5.5", label: "GPT-5.5", hint: "Latest flagship." },
  { id: "gpt-5.4", label: "GPT-5.4", hint: "Default. 1M context." },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "Fast, cheap." },
] as const;

export const GOOGLE_MODELS: readonly ProviderModelOption[] = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Default. Best price-performance." },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", hint: "Fastest, budget-friendly." },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Complex reasoning." },
] as const;

// ClawBox AI tiers — surfaced via the secondary model picker after
// consolidating Flash/Pro into one "ClawBox AI" provider row in the
// chat dropdown. Model ids are the upstream DeepSeek slugs since
// Mike's gateway forwards via the deepseek provider; the UI labels
// match the subscription plans (Flash → "Pro plan", Pro → "Max plan")
// so users see the same word on the device that they paid for.
export const CLAWAI_MODELS: readonly ProviderModelOption[] = [
  { id: "deepseek-v4-flash", label: "Pro Tier", hint: "Default. Faster, lower cost." },
  { id: "deepseek-v4-pro", label: "Max Tier", hint: "1.6T frontier model. Max plan only." },
] as const;

// Provider IDs the live-catalog route knows how to fetch from upstream
// (`openclaw models list --provider <p>` for the first four; OpenRouter's
// own /api/v1/models for the last). Single source of truth so the route's
// allowlist, the AIModelsStep `catalogProvider` memo, and the chat-popup
// header dropdown all gate on the same set.
export const CATALOG_PROVIDERS = ["clawai", "anthropic", "openai", "openai-codex", "google", "openrouter"] as const;
export type CatalogProvider = typeof CATALOG_PROVIDERS[number];

export function isCatalogProvider(provider: string | null | undefined): provider is CatalogProvider {
  if (!provider) return false;
  return (CATALOG_PROVIDERS as readonly string[]).includes(provider);
}

export const PROVIDER_CATALOGS = Object.freeze({
  clawai: {
    provider: "clawai",
    models: CLAWAI_MODELS,
    defaultModelId: "deepseek-v4-flash",
    allowCustom: false,
  },
  anthropic: {
    provider: "anthropic",
    models: ANTHROPIC_MODELS,
    defaultModelId: "claude-sonnet-4-6",
    allowCustom: true,
  },
  openai: {
    provider: "openai",
    models: OPENAI_MODELS,
    defaultModelId: "gpt-5.4",
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

/**
 * Synchronous fallback catalog. Returns the cold-start arrays defined
 * above so callers always have *something* to render before the live
 * fetch resolves. Prefer {@link fetchProviderCatalog} in components —
 * the live catalog from `/setup-api/ai-models/catalog` is the source
 * of truth for routeable model IDs.
 */
export function getProviderCatalog(provider: string | null | undefined): ProviderCatalog | null {
  if (!provider) return null;
  return Object.prototype.hasOwnProperty.call(PROVIDER_CATALOGS, provider)
    ? PROVIDER_CATALOGS[provider as ProviderCatalogKey]
    : null;
}

interface CatalogApiModel {
  id: string;
  label: string;
  hint?: string;
  contextWindow: number;
  input?: string;
}

interface CatalogApiResponse {
  provider: string;
  models: CatalogApiModel[];
  defaultModelId: string;
  allowCustom: boolean;
  fetchedAt: number;
  /** True when the route fell back to a stale cached payload because the
   * upstream catalog query just failed; UI may want to show a warning. */
  stale?: boolean;
}

/**
 * Fetch the live model catalog for `provider` from the catalog route.
 * The route proxies `openclaw models list --provider <p> --all --json`
 * (and OpenRouter's own /api/v1/models endpoint for openrouter), so the
 * returned list is by construction routeable through the gateway.
 *
 * On network failure or non-2xx response, returns the static fallback
 * catalog so the picker still has *something* to show. Callers can
 * detect a fallback render by comparing the returned `defaultModelId`
 * to the live one — or by checking whether the call rejected (we
 * resolve, not reject, on the fallback path so picker render stays
 * synchronous).
 */
export async function fetchProviderCatalog(
  provider: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ProviderCatalog & { stale?: boolean }> {
  const fallback = getProviderCatalog(provider);
  try {
    const url = `/setup-api/ai-models/catalog?provider=${encodeURIComponent(provider)}`;
    const res = await fetch(url, { signal: opts.signal, cache: "no-store" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = (await res.json()) as CatalogApiResponse;
    if (!body.models || body.models.length === 0) {
      // Empty catalog — keep the fallback so the picker isn't blank.
      if (fallback) return { ...fallback, stale: true };
      throw new Error("empty catalog");
    }
    return {
      provider,
      models: body.models.map(({ id, label, hint }) => ({
        id,
        label: label || id,
        // OpenRouter sometimes ships long descriptions; trim so the
        // picker row doesn't blow up vertically.
        hint: typeof hint === "string" ? hint.slice(0, 120) : "",
      })),
      defaultModelId: body.defaultModelId
        || body.models[0].id
        || fallback?.defaultModelId
        || "",
      allowCustom: body.allowCustom !== false,
      stale: body.stale,
    };
  } catch (err) {
    // AbortError isn't a real failure — the consumer cancelled because
    // the provider changed. Re-throw so the caller's signal handler can
    // discard the result without it falling back through to the static
    // catalog (which would race the fresh provider's fetch and visibly
    // flash the wrong list).
    if ((err as { name?: string })?.name === "AbortError") {
      throw err;
    }
    if (fallback) {
      console.warn(
        `[provider-models] catalog fetch failed for ${provider}, using fallback:`,
        err instanceof Error ? err.message : err,
      );
      return { ...fallback, stale: true };
    }
    throw err;
  }
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
