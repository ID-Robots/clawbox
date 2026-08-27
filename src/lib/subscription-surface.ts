import { promises as fsp } from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import { SUBSCRIPTION_SURFACE } from "@/lib/provider-models";

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
 * same rule `isModelUsableOnSubscription` applies in the pickers. An empty
 * cache is unknown too: treating it as authoritative would refuse the entire
 * catalogue on a box whose enumeration simply has not run yet.
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
  const surfaceProvider = SUBSCRIPTION_SURFACE[provider]?.surfaceProvider;
  if (!surfaceProvider) return null;
  try {
    const raw = await fsp.readFile(path.join(CACHE_DIR, `${surfaceProvider}.json`), "utf8");
    const parsed = JSON.parse(raw) as CachedSurface;
    if (!Array.isArray(parsed.models)) return null;
    const ids = parsed.models
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return ids.length > 0 ? new Set(ids) : null;
  } catch {
    // Missing, unreadable, or half-written cache. Unknown, not "no".
    return null;
  }
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
