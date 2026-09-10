import { promises as fsp } from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import {
  getProviderCatalog,
  subscriptionSurfaceLabel,
  subscriptionSurfaceProvider,
} from "@/lib/provider-models";
import { chatgptSurface } from "@/lib/chatgpt-surface";
import {
  isOauthProfile,
  profileProviderId,
} from "@/lib/chatgpt-subscription";

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
 * catalogue on a box whose enumeration simply has not run yet.
 *
 * A MISSING cache is now the state a thin or failed enumeration leaves behind
 * (M-05: the route stopped persisting a payload it did not get from a device),
 * where it used to leave a file holding the curated ids. That moves such a box
 * from "refuse anything outside the curated three" to UNKNOWN, and that is the
 * right direction, not a gap: the curated three are not what the device can
 * run, so refusing against them refused models the box routes perfectly well —
 * the false-failure this file's own rule above forbids. The guard still
 * refuses against a REAL enumeration, which is the case it was built for.
 *
 * A cache that exists but lists nothing can no longer occur; if a downgrade
 * leaves one behind it is judged by the curated catalogue alone, which is what
 * the picker shows for that same file.
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
  {
    const ids = await readCachedCatalogueIds(surfaceProvider);
    // A missing, unreadable or half-written cache is UNKNOWN here — this
    // answer REFUSES models, and the header above says why that must never be
    // decided by the curated list alone.
    if (ids === null) return null;
    // Union the CURATED catalogue for the surface provider, because that is
    // what the picker renders whenever the catalog route has no live
    // enumeration to serve: a cold start, or a box whose provider is not
    // listable yet, gets the curated rows marked `fallback`. Reading the raw
    // file without them asks a different question than the picker answered,
    // and this guard would refuse the very row the customer had just been
    // shown. It is a no-op for a provider with no curated catalogue (a
    // NARROWER named surface such as claude-cli), which is what keeps a
    // narrowed surface narrow.
    //
    // The union is the PERMISSIVE direction, deliberately. Since M-05 the
    // route no longer merges the curated list into a live enumeration or
    // persists it, so a cache file is either a device answer or absent — this
    // is the one place the two lists still meet, and it meets them by allowing
    // a curated id rather than refusing a live one.
    //
    // The curated ids count BEFORE the empty check for the same reason: the
    // route serves a file holding `models: []` as an empty payload, and
    // `fetchProviderCatalog` renders the curated catalogue for an empty one, so
    // the customer was shown that list, not nothing.
    const curated = getProviderCatalog(surfaceProvider)?.models ?? [];
    if (ids.length === 0 && curated.length === 0) return null;
    for (const model of curated) {
      ids.push(model.id);
    }
    return new Set(ids);
  }
}

/**
 * The catalog route's cached enumeration for `provider`, or null when there is
 * no readable one.
 *
 * The file read only — the two callers below draw OPPOSITE conclusions from an
 * absent cache and each states its own, which is why the policy is not in here.
 * Read-only and spawn-free: the catalog route owns enumerating and refreshing
 * (`openclaw models list` takes ~3 minutes on a Jetson) — and, for a provider
 * that core cannot enumerate, DELETING: `discardUnwritableDiskCache` drops
 * `codex.json`, so this answers null for it and `readKnownModelIds` falls back
 * to the curated list alone rather than adding an older build's ids back.
 */
async function readCachedCatalogueIds(provider: string): Promise<string[] | null> {
  try {
    const raw = await fsp.readFile(path.join(CACHE_DIR, `${provider}.json`), "utf8");
    const parsed = JSON.parse(raw) as CachedSurface;
    if (!Array.isArray(parsed.models)) return null;
    return parsed.models
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return null;
  }
}

/**
 * Every model id this box HAS for `provider` — the cached live enumeration and
 * the curated catalogue together — or null when it has neither.
 *
 * The opposite null policy to `readSubscriptionSurfaceIds` above, deliberately,
 * because the two answers are used for opposite things. That one REFUSES a
 * model, so a cold cache must not narrow it to the curated three. This one only
 * decides whether to TELL SOMEONE an id looks wrong, so a curated catalogue on
 * its own is a perfectly good list to judge against — and the cold box with no
 * enumeration yet is exactly the state the cold-start default is written in
 * (TASK-705, where the id written was in no openai catalogue anywhere).
 *
 * Null is still UNKNOWN and still means "say nothing": a provider with no
 * curated catalogue and no enumeration — llamacpp, ollama, deepseek — cannot
 * be judged at all, and a caller that read null as "the id does not exist"
 * would report a defect about every one of them.
 */
export async function readKnownModelIds(provider: string): Promise<Set<string> | null> {
  const cached = await readCachedCatalogueIds(provider);
  const curated = getProviderCatalog(provider)?.models ?? [];
  const ids = [...(cached ?? []), ...curated.map((m) => m.id)];
  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * Is this model id selectable while the device is on ChatGPT/Codex
 * subscription auth?
 *
 * THE CHATGPT SURFACE IS THE ANSWER — {@link chatgptSurface}, and nothing
 * beside it. This used to be a second spelling of that list as a GENERATION
 * regex (`/^(?:gpt-5\.6-(?:sol|terra|luna)|gpt-5\.5|gpt-5\.4(?:-mini)?)$/`),
 * and it failed the way generation allowlists always fail here: the `openai`
 * provider carried the identical pattern until it hid the whole gpt-5.6 family
 * and was removed with "a generation allowlist cannot know what the next
 * generation is called"; the codex copy survived and hid
 * `gpt-5.3-codex-spark`, a model the installed core routes on THIS surface and
 * on no other. One list cannot disagree with itself, and a row the surface
 * gains now reaches the picker, both write guards and the refusal sentence
 * together.
 *
 * WHAT UPSTREAM SAYS, and why it is no longer a hand-kept mirror of it. The
 * core's `extensions/openai` manifest states the route per model — the rows it
 * ships, which of them are suppressed ON `chatgpt.com`, and which are
 * suppressed on `api.openai.com` and therefore reachable on this route alone —
 * so `chatgptSurface()` reads it from the INSTALLED core and the curated
 * `CODEX_MODELS` is what it falls back to where there is no manifest to read.
 * The mirror that was here answered for one core version: on 2026.9.3 it is
 * wrong in both directions at once (no `gpt-6-astra`, and `gpt-5.4` plus
 * `gpt-5.4-mini` retired from the route it still offers them on).
 *
 * The surface is deliberately NARROWER than everything the manifest lists, in
 * the two respects `chatgpt-surface.ts` documents: the `-pro` tiers answer
 * "model not supported when using Codex with a ChatGPT account" on the
 * subscription path (developers.openai.com/codex/models), and `-nano` is in the
 * core's platform set and not its ChatGPT one. Plan gating is the opposite case
 * and is NOT filtered — gpt-5.6 access varies per account, so the pick goes
 * through and the upstream access error is what the customer sees.
 *
 * It lives here, beside the Claude rule, for the same reason that one does:
 * both write paths to `agents.defaults.model.primary` have to apply it, and a
 * second copy in the second route is a copy that can drift.
 * `scripts/gateway-pre-start.sh` keeps a hand-maintained mirror of the CURATED
 * fallback in `_CODEX_SUPPORTED`, pinned by
 * `src/tests/unit/gateway-pre-start-codex-models.test.ts`. That mirror is
 * OpenClaw 1 ONLY — its single consumer, `_openai_gpt_to_codex`, rewrites
 * `openai/<id>` into the retired namespace and is skipped on
 * `CLAWBOX_OPENCLAW_V2`. It stays because a box mid-update still runs the v1
 * branch; nothing on the pinned core reads it.
 */
export function isCodexSupportedModelId(modelId: string): boolean {
  // `chatgptSurface()` directly, not `getProviderCatalog(CHATGPT_UI_PROVIDER)`:
  // that lookup takes a plain string, answers `null` for a key nobody renamed it
  // for — `openai-codex` already became `codex` once — and this guard would then
  // refuse EVERY model with "use a model the ChatGPT subscription supports",
  // naming none. A guard that fails CLOSED on an unreadable list is the one
  // shape the rest of this file spends three docblocks forbidding, which is also
  // why the surface itself answers the curated list rather than an empty one
  // when the core cannot be read.
  // No `trim()` — the anchored regex this replaces did not trim either, and the
  // caller writes the id it passed in, not the one this judged.
  return chatgptSurface().models.some((model) => model.id === modelId);
}

/**
 * The models this box can name when it refuses one, as a sentence fragment.
 *
 * Built from the ChatGPT surface rather than hand-written, because the same
 * list was spelled in three places and had already drifted: the chat route's
 * keyless refusal omitted the GPT-5.6 generation the allowlist accepts. A
 * model the surface gains now reaches every refusal by itself — including one
 * that arrived with a core upgrade, which is the case a hand-written sentence
 * could never have covered.
 */
export function chatgptSupportedModelsSentence(): string {
  const labels = chatgptSurface().models.map((model) => model.label);
  // Never an empty fragment: the callers embed this mid-sentence, and "Use ,
  // or switch OpenAI to API-key mode" is worse than naming the surface
  // generically. Unreachable while the surface falls back to the curated list,
  // which is exactly why it is cheap to make impossible.
  if (labels.length === 0) return "a model the ChatGPT subscription supports";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The refusal for a model id the ChatGPT subscription cannot run, as a
 * message — or null when the target is fine, or is not on the ChatGPT surface
 * at all.
 *
 * `chatgptSubscription` is REQUIRED, and it is the whole test. It used to be
 * derivable here, from `provider === "codex"`: ClawBox wrote that namespace
 * only for an OpenAI save in subscription mode, so the namespace already said
 * "this box reaches OpenAI through a ChatGPT account". OpenClaw 2 retired the
 * namespace — the subscription and the API key are both `openai/<id>` — so
 * only the caller, which knows which credential the pick resolved onto, can
 * answer it. Defaulting it would hand a caller that forgot the flag the
 * behaviour this PR retired instead of a type error.
 *
 * Unlike the Claude surface there is no UNKNOWN case, even though the list is
 * now read per box: the ChatGPT route comes from the installed core's own
 * plugin manifest, and a box that cannot read one is answered the curated
 * fallback rather than nothing — so this never refuses a model because a file
 * was missing.
 */
export function offSurfaceCodexModelMessage(
  provider: string | null | undefined,
  modelId: string,
  chatgptSubscription: boolean,
): string | null {
  if (!chatgptSubscription) return null;
  if (isCodexSupportedModelId(modelId)) return null;
  return `${modelId} is not supported with ChatGPT subscription auth. `
    + `Use ${chatgptSupportedModelsSentence()}, `
    + "or switch OpenAI to API-key mode for Pro/API-only models.";
}

/** Auth-profile modes that mean "this provider has a bearer key of its own". */
const KEY_MODES: ReadonlySet<string> = new Set(["token", "api_key", "api-key"]);

/**
 * Does this auth profile carry a key/token of its own (as opposed to OAuth)?
 * Exported because the chat route asks the same question of the openai
 * profiles and had its own hard-coded copy of the mode set.
 */
export function isKeyModeProfile(entry: { mode?: string } | undefined): boolean {
  return typeof entry?.mode === "string" && KEY_MODES.has(entry.mode.trim().toLowerCase());
}

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
    const provider = normalize(profileProviderId(profileKey, entry)) ?? "";
    if (!provider) continue;
    if (isOauthProfile(entry)) oauth.add(provider);
    else if (isKeyModeProfile(entry)) keyed.add(provider);
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
