import { promises as fsp } from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import {
  getProviderCatalog,
  subscriptionSurfaceLabel,
  subscriptionSurfaceProvider,
} from "@/lib/provider-models";

/**
 * Server-side reads of the SUBSCRIPTION facts the UI already gets stamped into
 * its catalogue — so a model id that reaches an API route without passing
 * through a current browser tab is judged by the same rule the picker used.
 *
 * Deliberately read-only. The catalog route
 * (/setup-api/ai-models/catalog) owns enumerating and refreshing the surface;
 * it spawns `openclaw models list`, which takes ~3 minutes on a Jetson and has
 * no business happening inside a model-switch request. This module only reads
 * the cache that route maintains.
 */

const CACHE_DIR = path.join(DATA_DIR, "catalog-cache");

/** Only the part of the catalog route's cached payload this module reads. */
interface CachedSurface {
  models?: Array<{ id?: unknown }>;
}

/**
 * Model ids the subscription surface for `provider` carries, or null when it
 * could not be determined.
 *
 * Null means UNKNOWN and every caller must treat it as "do not refuse" — the
 * same rule `isModelUsableOnSubscription` applies in the pickers. A missing
 * cache is unknown: treating it as authoritative would refuse the entire
 * catalogue on a box whose enumeration simply has not run yet. A cache that
 * EXISTS but enumerated nothing is judged by the curated catalogue alone —
 * that is exactly what the catalog route serves for the same file, so the
 * picker on that box offers the curated rows and nothing else. Answering
 * UNKNOWN there would let a typed id the picker never offered through the
 * very write this guard exists to refuse. Only when neither list has an id
 * (a NARROWER named surface with no curated catalogue, enumerated empty) is
 * there nothing to judge against.
 *
 * No age check and no memo. Both are deliberate:
 *
 *  * No memo, because the cache is refreshed behind our back on the catalog
 *    route's own 6h schedule (and on `?refresh=1`). A module-level probe would
 *    pin this guard to whatever the surface looked like the first time anyone
 *    switched model after a restart, and then refuse a model the box has since
 *    learned it can run.
 *  * No age check, because this must agree with what the CUSTOMER WAS SHOWN.
 *    The picker's stamps come from this same cache via the catalog route,
 *    which serves stale payloads rather than blocking. Expiring the file here
 *    but not there would let the UI grey a row out while the route accepted
 *    it, or the reverse.
 */
export async function readSubscriptionSurfaceIds(
  provider: string,
): Promise<Set<string> | null> {
  const surfaceProvider = subscriptionSurfaceProvider(provider);
  if (!surfaceProvider) return null;
  // No short-circuit when the surface is the provider ITSELF, unlike the
  // catalog route's own copy of this lookup. There, resolving to the provider
  // means "do not enumerate a second time"; here it means "open the file the
  // route already wrote", which is exactly the list the pickers were stamped
  // from. Making this one bail too would take the guard back to UNKNOWN on
  // every box and stop refusing ids that are in no catalogue at all.
  try {
    const raw = await fsp.readFile(path.join(CACHE_DIR, `${surfaceProvider}.json`), "utf8");
    const parsed = JSON.parse(raw) as CachedSurface;
    if (!Array.isArray(parsed.models)) return null;
    const ids = parsed.models
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    // Union the CURATED catalogue for the surface provider, because the
    // catalog route serves its cached payload through `buildPayload` ->
    // `augmentWithStaticCatalog`, which appends exactly these ids to whatever
    // the live enumeration returned. Reading the raw file without them asks a
    // different question than the picker answered: a ClawBox release that adds
    // a model to PROVIDER_CATALOGS ships a picker offering it on day one,
    // while the on-disk cache keeps the previous list for up to the route's
    // 6h refresh interval — and in that window this guard refused the very row
    // the customer had just been shown. `augmentWithStaticCatalog` is a no-op
    // for a provider with no curated catalogue (a NARROWER named surface such
    // as claude-cli), and so is this, which is what keeps a narrowed surface
    // narrow.
    //
    // The curated ids count BEFORE the empty check, for the same reason: a
    // file holding `models: []` is served to the picker through that same
    // augmentation, so the customer was shown the curated list, not nothing.
    const curated = getProviderCatalog(surfaceProvider)?.models ?? [];
    if (ids.length === 0 && curated.length === 0) return null;
    for (const model of curated) {
      ids.push(model.id);
    }
    return new Set(ids);
  } catch {
    // Missing, unreadable, or half-written cache. Unknown, not "no".
    return null;
  }
}

/**
 * Models selectable while the device is on ChatGPT/Codex subscription auth.
 *
 * GPT-5.6 Sol/Terra/Luna are subscription-eligible — OpenClaw's ChatGPT route
 * catalog carries all three, and `openai/gpt-5.6-sol` is the documented
 * default for a fresh Codex OAuth setup. Keeping them out of this allowlist
 * rejected them locally with "not supported with ChatGPT subscription auth"
 * before the request ever reached OpenAI. GPT-5.6 is a limited preview, so
 * per-account access still varies: let the pick through and surface the
 * upstream access error instead of pre-rejecting it here. `-pro` tiers stay
 * out — those remain API-key only.
 *
 * It lives here, beside the Claude rule, for the same reason that one does:
 * both write paths to `agents.defaults.model.primary` have to apply it, and a
 * second copy in the second route is a copy that can drift.
 * `scripts/gateway-pre-start.sh` keeps a hand-maintained mirror of this list
 * in `_CODEX_SUPPORTED`, pinned by
 * `src/tests/unit/gateway-pre-start-codex-models.test.ts`.
 */
export const CODEX_SUPPORTED_MODEL_RE = /^(?:gpt-5\.6-(?:sol|terra|luna)|gpt-5\.5|gpt-5\.4(?:-mini)?)$/;

/**
 * The refusal for a model id the ChatGPT subscription cannot run, as a
 * message — or null when the target is fine, or is not on the ChatGPT surface
 * at all.
 *
 * The `codex/` NAMESPACE is the subscription test, which is why this takes no
 * config and no getter: ClawBox writes that namespace only for an OpenAI save
 * in subscription mode (`PROVIDERS.openai.subscriptionOverride`), while an
 * API-key save writes `openai/`, where the `-pro` tiers route perfectly well.
 * So "provider is codex" already means "this box reaches OpenAI through a
 * ChatGPT account", with no profile inspection needed.
 *
 * Unlike the Claude surface this is a static allowlist rather than a cache
 * read, so there is no UNKNOWN case: the ChatGPT route catalogue is fixed by
 * the plugin, not enumerated per box.
 */
export function offSurfaceCodexModelMessage(
  provider: string | null | undefined,
  modelId: string,
  // OpenClaw 2 writes the subscription under `openai/`, where the namespace
  // no longer says anything: the caller that knows the box reaches OpenAI
  // through a ChatGPT account passes that in (src/lib/chatgpt-subscription.ts).
  chatgptSubscription: boolean = provider === "codex",
): string | null {
  if (!chatgptSubscription) return null;
  if (CODEX_SUPPORTED_MODEL_RE.test(modelId)) return null;
  return `${modelId} is not supported with ChatGPT subscription auth. `
    + "Use GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4, or GPT-5.4 Mini, "
    + "or switch OpenAI to API-key mode for Pro/API-only models.";
}

/** Auth-profile modes that mean "this provider has a bearer key of its own". */
const KEY_MODES = new Set(["token", "api_key", "api-key"]);

/**
 * Providers this box authenticates to by SUBSCRIPTION only — an OAuth profile
 * and no key-based profile for the same provider.
 *
 * "and no key" matters: a box that has signed in with Claude AND pasted an API
 * key can still route the API-only models, so calling it subscription-only
 * would grey out rows it can actually run. This mirrors the reasoning already
 * spelled out for OpenAI in the chat/model route
 * (`!hasOpenAiKey && hasCodexOauth`), generalised so every provider in
 * SUBSCRIPTION_SURFACE gets the same answer from one place.
 *
 * `normalize` collapses provider ALIASES, and it is applied here rather than
 * to the result because the two are not interchangeable: deepseek and clawai
 * are one provider under two names (wire format vs UI id), so an OAuth profile
 * written under one and an API key under the other read as two providers if
 * the alias is collapsed afterwards — and the box gets called
 * subscription-only over a credential it does have. Aliasing has to happen
 * before the credentials are counted, not after.
 */
export function subscriptionOnlyProviders(
  profiles: Record<string, { provider?: string; mode?: string } | undefined> | undefined,
  normalize: (provider: string) => string | null = (provider) => provider,
): string[] {
  const oauth = new Set<string>();
  const keyed = new Set<string>();
  for (const [profileKey, entry] of Object.entries(profiles ?? {})) {
    const rawProvider = typeof entry?.provider === "string" && entry.provider.trim()
      ? entry.provider
      : profileKey.split(":")[0];
    const provider = normalize(rawProvider.trim().toLowerCase()) ?? "";
    if (!provider) continue;
    const mode = typeof entry?.mode === "string" ? entry.mode.trim().toLowerCase() : "";
    if (mode === "oauth") oauth.add(provider);
    else if (KEY_MODES.has(mode)) keyed.add(provider);
  }
  return [...oauth].filter((provider) => !keyed.has(provider)).sort();
}

/** Auth-profile entries as `openclaw.json` carries them under `auth.profiles`. */
export type AuthProfileEntries =
  Record<string, { provider?: string; mode?: string } | undefined> | undefined;

/**
 * Does this profile set mean the box reaches Claude by SUBSCRIPTION only?
 *
 * Named once because two routes ask it and both must get the same answer. It
 * is deliberately a question about a profile SET rather than about a config
 * object: the wizard save has to ask it about the profiles it is *about to*
 * write, which no file on disk carries yet.
 */
export function isClaudeSubscriptionOnly(
  profiles: AuthProfileEntries,
  normalize?: (provider: string) => string | null,
): boolean {
  return subscriptionOnlyProviders(profiles, normalize).includes("anthropic");
}

/**
 * The refusal for a Claude model id the box's subscription surface does not
 * carry, as a message — or null when the target is fine (not Claude, not a
 * Claude-subscription box, or the surface could not be read).
 *
 * The set it judges against is {@link subscriptionSurfaceProvider}'s, which
 * since PR #532 is anthropic's OWN catalogue: a Claude subscription is routed
 * by the native anthropic plugin on `POST /v1/messages`, which serves the full
 * catalogue. It used to be the plugin's smaller `claude-cli` catalogue, and
 * while the openai-compat override was the transport that was right — see the
 * history note on SUBSCRIPTION_SURFACE. What survives the change is the reason
 * this guard exists at all: a model id in NO Anthropic catalogue must not be
 * written to `agents.defaults.model.primary`, because that failure is silent,
 * sticky, and survives a reboot.
 *
 * It lives here, not in a route, because there are TWO write paths to
 * `agents.defaults.model.primary` and each of them has more than one door:
 *
 *   * `/setup-api/chat/model` — the custom-model branch, an id that already
 *     matches `state.options`, and `{"source":"primary"}`.
 *   * `/setup-api/ai-models/configure` — a typed custom id from the wizard or
 *     Settings, and the PROVIDERS-table default the same save writes when
 *     nothing is typed.
 *
 * A second copy of this rule in the second route is a copy that can drift, and
 * drift is precisely how the first route ended up guarded and the second not.
 *
 * `null` from `readSubscriptionSurfaceIds` means UNKNOWN, not "no": refusing
 * where the pickers allow would be a rejection over something that works.
 *
 * `isClaudeSubscription` and `getSurfaceIds` are GETTERS, not values. The
 * provider check comes first, so a save or a switch aimed at any other
 * provider costs no config read and no cache read at all — on a Jetson
 * neither is free.
 */
export async function offSurfaceClaudeModelMessage(
  provider: string | null | undefined,
  modelId: string,
  isClaudeSubscription: () => boolean | Promise<boolean>,
  getSurfaceIds: () => Promise<Set<string> | null> = () =>
    readSubscriptionSurfaceIds("anthropic"),
): Promise<string | null> {
  if (provider !== "anthropic") return null;
  if (!(await isClaudeSubscription())) return null;
  const surfaceIds = await getSurfaceIds();
  if (!surfaceIds || surfaceIds.has(modelId)) return null;
  const choices = `Pick one of ${[...surfaceIds].sort().join(", ")}`;
  const surface = subscriptionSurfaceLabel("anthropic");
  // A NAMED narrower surface can be named, and the customer has a second
  // lever: an API key reaches the models that surface omits. When the
  // subscription routes natively there is no narrower surface and no such
  // lever — the id is simply in no Anthropic catalogue this box knows — so
  // recommending API-key mode would send them after a fix that changes
  // nothing.
  if (surface) {
    return `${modelId} is not on the Claude subscription surface (${surface}). `
      + `${choices}, or switch Anthropic to API-key mode for the API-only models.`;
  }
  return `${modelId} is not in the Anthropic model catalogue this box enumerated. `
    + `${choices}, or check the id for a typo.`;
}
