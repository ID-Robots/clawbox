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
  /**
   * Whether a SUBSCRIPTION (OAuth sign-in) credential can route this model, as
   * opposed to an API key. A provider's subscription can put it on a different
   * or a smaller set than its API key does, and a picker that renders the API
   * set while the customer is on the Subscription tab offers models their plan
   * cannot run. Which set applies is {@link SUBSCRIPTION_SURFACE}'s answer,
   * and it is the transport that decides — read the history note there before
   * assuming any particular provider narrows.
   *
   * `undefined` means UNKNOWN, not "yes": the device could not enumerate the
   * subscription surface (cold start, CLI failure), so nothing is marked and
   * the whole list stays pickable rather than the UI inventing a restriction.
   */
  availableOnSubscription?: boolean;
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
//
// They are DISPLAY ONLY, and they can never hide a live row: the route no
// longer merges them into an enumeration, and never persists them. Whatever
// renders them is holding a catalogue marked `fallback: true` and is expected
// to ask again — see `ResolvedProviderCatalog` and `useProviderCatalog`. The
// one thing they still contribute to a live row is a `hint`, which no
// enumeration returns.
export const ANTHROPIC_MODELS: readonly ProviderModelOption[] = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fastest, near-frontier." },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "Default. Speed + intelligence." },
  { id: "claude-opus-5", label: "Claude Opus 5", hint: "Most capable." },
] as const;

// OpenAI API key models — cold-start display only, like every list here.
// There is no longer a generation allowlist at the catalog route for openai:
// it matched none of the gpt-5.6 generation, so on a 2026.8.1 box it hid the
// live catalogue behind these five ids instead of supplementing them. What a
// box shows now is what `openclaw models list --provider openai --all --json`
// returns, minus the non-chat SKUs. Power users can still type any id via the
// "custom" toggle.
export const OPENAI_MODELS: readonly ProviderModelOption[] = [
  { id: "gpt-5.5-pro", label: "GPT-5.5 Pro", hint: "Latest, max reasoning." },
  { id: "gpt-5.5", label: "GPT-5.5", hint: "Latest flagship." },
  { id: "gpt-5.4-pro", label: "GPT-5.4 Pro", hint: "Max reasoning, 1M context." },
  { id: "gpt-5.4", label: "GPT-5.4", hint: "Default. 1M context." },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "Fast, cheap." },
] as const;

// ChatGPT-subscription (Codex) models. `codex` is the UI id for the
// subscription; the models themselves are written as `openai/<id>` — OpenClaw
// 2 retired the `codex` provider id (`openai-codex` before 2026.6), see
// src/lib/chatgpt-subscription.ts. Available when the user authenticates via
// ChatGPT OAuth instead of pasting an API key. NO -pro variants — those are
// API-key only (they 400 with "model
// not supported when using Codex with a ChatGPT account" on the OAuth
// path). Per developers.openai.com/codex/models the supported set via
// ChatGPT-account auth is gpt-5.6-{sol,terra,luna}, gpt-5.5, gpt-5.4,
// gpt-5.4-mini. The gpt-5.6 models are plan-gated upstream (Plus/Pro/Max)
// — the live catalog only returns them for entitled accounts, so listing
// them here just gives them stable labels; accounts without the plan
// never see them. Filter lives in ALLOWED_MODEL_RE_BY_PROVIDER (catalog).
export const CODEX_MODELS: readonly ProviderModelOption[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "Newest flagship. Plus/Pro." },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "GPT-5.6. Plus/Pro." },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "GPT-5.6, fast. Plus/Pro." },
  { id: "gpt-5.5", label: "GPT-5.5", hint: "Default. Every tier." },
  { id: "gpt-5.4", label: "GPT-5.4", hint: "Previous gen. 1M context." },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "Fast, cheap." },
] as const;

// Unlike the other picker lists, GOOGLE_MODELS is ALSO the seed for
// models.providers.google.models (ai-models/configure routes google through
// Google's OpenAI-compat endpoint), so each id here is selectable AND runnable
// — not just picker cold-start. Keep to current stable flagships; live
// /v1beta/models discovery will eventually own the full list.
export const GOOGLE_MODELS: readonly ProviderModelOption[] = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Default. Best price-performance." },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "Newest flagship." },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", hint: "Frontier-class, low cost." },
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
  { id: "deepseek-v4-flash", label: "Free/Pro Tier", hint: "Default. Faster." },
  { id: "deepseek-v4-pro", label: "Max Tier", hint: "1.6T frontier model. Max plan only." },
] as const;

// Provider IDs the live-catalog route knows how to fetch from upstream
// (`openclaw models list --provider <p>` for the first four; OpenRouter's
// own /api/v1/models for the last). Single source of truth so the route's
// allowlist, the AIModelsStep `catalogProvider` memo, and the chat-popup
// header dropdown all gate on the same set.
/**
 * What SUBSCRIPTION (OAuth sign-in) changes about the models a provider can
 * run. Three shapes, because three different things happen:
 *
 *  * `catalogProvider` — the whole namespace moves. OpenAI's ChatGPT sign-in
 *    routes through `codex`: different catalogue, different credential, and a
 *    different `<provider>/<id>` written to config (see the configure route's
 *    `subscriptionOverride`). The picker swaps catalogues wholesale.
 *  * `surfaceProvider` — the namespace STAYS, the set narrows. The provider's
 *    subscription credential is carried by a SECOND, smaller catalogue of the
 *    same plugin, and only what that catalogue lists actually routes. The
 *    picker keeps the main catalogue and marks the rest unavailable — swapping
 *    wholesale here would drop rows silently, which is the same lie in the
 *    other direction.
 *  * `nativeRouting` — the namespace stays and NOTHING narrows. The provider's
 *    own plugin carries the subscription credential on the provider's own
 *    transport, so the set it can run is the provider's own catalogue. There
 *    is no second, smaller catalogue to enumerate, and therefore no narrowing
 *    this box can observe.
 *
 * WHY ANTHROPIC MOVED (this history matters — read it before "restoring" the
 * old value). Anthropic used to be `surfaceProvider: "claude-cli"`, and that
 * was CORRECT when it was written and verified on a device: a Claude
 * subscription was routed by a `models.providers.anthropic` openai-compat
 * override, whose turns left the box as `POST /v1/chat/completions`, and the
 * only Anthropic catalogue reachable that way was the plugin's `claude-cli`
 * one — 5 models, no Fable, no Mythos, no Haiku.
 *
 * PR #532 changed the transport out from under that rule. A subscription
 * anthropic save no longer writes the openai-compat override; it hands the
 * provider to the native anthropic plugin, whose turns leave as
 * `POST /v1/messages` with `anthropic-beta: oauth-2025-04-20`. That transport
 * serves the FULL anthropic catalogue on a subscription credential — which is
 * why the same Claude sign-in has always run claude-fable-5 on the Hermes
 * edition, which routed natively all along.
 *
 * So the narrowing did not become wrong through carelessness; it became STALE.
 * `nativeRouting` is set from the same table the transport decision reads
 * ({@link routesSubscriptionNatively}, which the configure route imports
 * instead of keeping its own copy) precisely so the next transport change
 * cannot silently invalidate the availability stamp again.
 *
 * One table because this is one fact. It used to be spelled three ways in
 * three files, none of which knew about the others.
 */
export const SUBSCRIPTION_SURFACE: Readonly<Record<string, {
  catalogProvider?: string;
  surfaceProvider?: string;
  nativeRouting?: boolean;
}>> = Object.freeze({
  openai: { catalogProvider: "codex" },
  anthropic: { nativeRouting: true },
});

/**
 * Does this provider+authMode pair route through the provider's OWN plugin
 * rather than through a `models.providers.<p>` openai-compat override?
 *
 * Anthropic, and deliberately NOT "every provider that has an OAuth flow".
 * `OAUTH_PROVIDERS` also carries google (Gemini Code Assist), and google's
 * subscription reaches the configure route's `applyCloudProviderTransport` the
 * same way anthropic's does — but nothing gives it a native route to fall back
 * on. `setProviderPlugins` toggles the anthropic plugin and no other, and the
 * google branch there records that the native google plugin's auth fails at
 * call time. Dropping google's override would hand its turns to a route no one
 * has evidence about and no device to test on: the same mistake as the bug
 * #532 fixed, pointed the other way. Google stays on the override until
 * someone proves the native path on hardware.
 *
 * It lives HERE, in the table, rather than as a Set inside the configure
 * route, because the transport decision and the availability stamp are the
 * same fact. They were two facts in two files for exactly one release, and in
 * that release the stamp described a transport the box no longer used.
 */
export function routesSubscriptionNatively(provider: string, authMode: string): boolean {
  return authMode === "subscription" && SUBSCRIPTION_SURFACE[provider]?.nativeRouting === true;
}

/**
 * The provider id whose catalogue IS the subscription surface for `provider`,
 * or null when its subscription does not put it on a nameable surface (OpenAI
 * swaps the whole namespace instead — see `catalogProvider` above).
 *
 * For a natively-routed provider this is the provider ITSELF: its subscription
 * runs on its own plugin, so its own catalogue is the set. That is not a
 * no-op — it keeps the gate pointed at a real, enumerated list, so an id that
 * is in NO Anthropic catalogue is still refused rather than silently pinned.
 */
export function subscriptionSurfaceProvider(provider: string): string | null {
  const entry = SUBSCRIPTION_SURFACE[provider];
  if (!entry) return null;
  if (entry.nativeRouting) return provider;
  return entry.surfaceProvider ?? null;
}

/**
 * Can this credential run this model? The one greying-out rule, named once.
 *
 * `availableOnSubscription === undefined` means the box could not enumerate
 * the subscription surface — unknown is not "no", so an unstamped model stays
 * usable and the customer keeps the full list rather than the UI inventing a
 * restriction it never verified.
 *
 * It lives here, next to the table it reads, because BOTH model pickers have
 * to obey it: the setup wizard's (AIModelsStep) and the chat header's
 * (ChatPopup). It used to be a closure inside the wizard, so the header — the
 * surface the wizard's own help line points the customer at ("switch between
 * the curated models from the chat window anytime") — offered every
 * API-key-only model as an ordinary pickable row.
 */
export function isModelUsableOnSubscription(
  model: { availableOnSubscription?: boolean },
  isSubscription: boolean,
): boolean {
  return !isSubscription || model.availableOnSubscription !== false;
}

/**
 * The surface a refusal should NAME, so it can say which catalogue it is
 * refusing against rather than telling the customer their provider is
 * misconfigured when it is not.
 *
 * Null for a natively-routed provider as well as for an unlisted one: there
 * the surface is the provider's own catalogue, and "claude-fable-5 is not on
 * the anthropic surface (anthropic)" names nothing the customer can act on.
 * {@link subscriptionSurfaceProvider} is the one to ask for the id to
 * enumerate; this one is only for wording.
 */
export function subscriptionSurfaceLabel(provider: string): string | null {
  const entry = SUBSCRIPTION_SURFACE[provider];
  if (!entry || entry.nativeRouting) return null;
  return entry.surfaceProvider ?? null;
}

export const CATALOG_PROVIDERS = ["clawai", "anthropic", "openai", "codex", "google", "openrouter"] as const;
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
    defaultModelId: "claude-sonnet-5",
    allowCustom: true,
  },
  openai: {
    provider: "openai",
    models: OPENAI_MODELS,
    defaultModelId: "gpt-5.4",
    allowCustom: true,
  },
  codex: {
    // gpt-5.5 is the newest model available on every ChatGPT tier including
    // Free — only the gpt-5.6 generation is plan-gated — so it is the right
    // cold-start default. Entitled accounts get moved up to gpt-5.6 by the
    // sign-in probe (src/lib/codex-model-probe.ts).
    provider: "codex",
    models: CODEX_MODELS,
    defaultModelId: "gpt-5.5",
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
  availableOnSubscription?: boolean;
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
  /** True when no live device enumeration produced this payload — see
   * `CatalogResponse.fallback` in the catalog route. */
  fallback?: boolean;
  /** True when an enumeration is in flight right now, so asking again will
   * eventually get a different answer. */
  warming?: boolean;
}

/**
 * A catalogue as a component actually receives it: the shape above plus the
 * two things the picker has to know about the ANSWER rather than the models —
 * whether it is old, and whether a device produced it at all.
 */
export type ResolvedProviderCatalog = ProviderCatalog & {
  stale?: boolean;
  /**
   * True when these rows are the curated cold-start list rather than a device
   * enumeration — a placeholder for an answer, not the answer. A consumer may
   * render them, but must not treat them as facts about the box.
   */
  fallback?: boolean;
  /**
   * True when the box is enumerating RIGHT NOW, so a later ask gets a better
   * answer. This, not `fallback`, is what a consumer polls on: a provider that
   * cannot enumerate at all serves a fallback forever, and polling it would be
   * a request loop with no destination. The route holds the matching backoff.
   */
  warming?: boolean;
};

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
  opts: { signal?: AbortSignal; refresh?: boolean } = {},
): Promise<ResolvedProviderCatalog> {
  const fallback = getProviderCatalog(provider);
  try {
    // `?refresh=1` asks the route to re-enumerate NOW rather than wait out its
    // 6h interval. It still answers from cache immediately — the refresh runs
    // detached — so this costs the caller nothing and is what makes "connect a
    // provider, see its models" work without a reload.
    const url = `/setup-api/ai-models/catalog?provider=${encodeURIComponent(provider)}`
      + (opts.refresh ? "&refresh=1" : "");
    const res = await fetch(url, { signal: opts.signal, cache: "no-store" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = (await res.json()) as CatalogApiResponse;
    if (!body.models || body.models.length === 0) {
      // Empty catalog — keep the fallback so the picker isn't blank.
      if (fallback) return { ...fallback, stale: true, fallback: true };
      throw new Error("empty catalog");
    }
    return {
      provider,
      models: body.models.map(({ id, label, hint, availableOnSubscription }) => ({
        id,
        label: label || id,
        // OpenRouter sometimes ships long descriptions; trim so the
        // picker row doesn't blow up vertically.
        hint: typeof hint === "string" ? hint.slice(0, 120) : "",
        availableOnSubscription,
      })),
      defaultModelId: body.defaultModelId
        || body.models[0].id
        || fallback?.defaultModelId
        || "",
      allowCustom: body.allowCustom !== false,
      stale: body.stale,
      warming: body.warming === true ? true : undefined,
      // Carried through, never inferred: the route knows whether a device
      // enumeration produced these rows, and the client cannot tell by looking
      // at them — that is precisely how three hard-coded Claude entries passed
      // for the box's own catalogue for a day.
      fallback: body.fallback === true ? true : undefined,
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
      return { ...fallback, stale: true, fallback: true };
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
