import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fsp } from "fs";
import path from "path";
import { findOpenclawBin, openclawIsAbsent } from "@/lib/openclaw-config";
import { DATA_DIR } from "@/lib/config-store";
import {
  CATALOG_PROVIDERS,
  isCatalogProvider,
  PROVIDER_CATALOGS,
  subscriptionSurfaceProvider,
} from "@/lib/provider-models";

export const dynamic = "force-dynamic";

// /setup-api/ai-models/catalog?provider=<id>
//
// Async-first model catalog. The route never blocks on openclaw — that
// CLI takes ~3 minutes to enumerate models on the Jetson, far longer
// than any reasonable HTTP timeout. Instead:
//
// * Disk cache at data/catalog-cache/<provider>.json is the source of
//   truth across restarts. Reads are O(1) file IO.
// * Background refreshes spawn `openclaw models list --provider <p>
//   --all --json` (or fetch OpenRouter's REST endpoint) detached from
//   any request, write the result to the disk cache on success.
// * On boot, the first import of this module kicks off a refresh for
//   every CATALOG_PROVIDERS entry so picker opens are instant from
//   minute 4 onward.
// * If both caches are empty (fresh install, first picker open), we serve
//   the curated cold-start list from src/lib/provider-models.ts with
//   `warming: true` and `fallback: true`.
//
// Force-refresh via `?refresh=1` triggers a refresh in the background
// and serves whatever's currently cached — the user never waits.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP (M-05): a payload the harness did not
// produce is never persisted, and never presented as though it were. Only a
// live enumeration is written to the disk cache, and only such a payload is
// stamped `source: "live"`; everything else is served marked `fallback` so the
// client comes back for the real answer. An enumeration that returns ZERO
// models is not an answer either — the previous good catalogue is kept and the
// CLI's own reason is logged, because "0 models" means the plugin is off or the
// provider id is gone, not that the box can run nothing.

const OPENCLAW_BIN = findOpenclawBin();
const REFRESH_TIMEOUT_MS = 5 * 60_000; // openclaw on Jetson is ~3min
const REFRESH_INTERVAL_MS = 6 * 60 * 60_000; // 6h
const CACHE_DIR = path.join(DATA_DIR, "catalog-cache");
const OPENROUTER_API = "https://openrouter.ai/api/v1/models";

interface CatalogModel {
  id: string;
  label: string;
  hint?: string;
  contextWindow: number;
  input?: string;
  /** Whether the provider's SUBSCRIPTION surface carries this model. See
   * SUBSCRIPTION_SURFACE in provider-models.ts; `undefined` = not determined. */
  availableOnSubscription?: boolean;
}

interface CatalogResponse {
  provider: string;
  models: CatalogModel[];
  defaultModelId: string;
  allowCustom: boolean;
  fetchedAt: number;
  /** Set by GET when the cached payload is older than REFRESH_INTERVAL_MS. */
  stale?: boolean;
  /**
   * Set when neither cache has anything yet. The curated cold-start list is
   * served alongside it (and `fallback`), so the picker has rows to render
   * while the first enumeration runs.
   */
  warming?: boolean;
  /**
   * Where these models came from. `"live"` means a device enumeration
   * answered — `openclaw models list --provider <p> --all --json`, or
   * OpenRouter's own /api/v1/models — and ONLY such a payload is ever written
   * to the disk cache.
   *
   * Absent is not a synonym for "old": a payload persisted by a build before
   * this field existed is indistinguishable from one built out of the curated
   * cold-start arrays, which is exactly the state that made three hard-coded
   * model names the truth on a box that could run eleven. An unmarked file is
   * therefore re-enumerated — once if that succeeds, and thereafter on the
   * `nextAttemptAt` backoff if it does not, so a provider that can never
   * enumerate cannot turn this rule into a fork per request.
   */
  source?: "live";
  /**
   * Set on a response the route could not answer from a live enumeration —
   * a cold start, or a cached payload no device produced. It is served (a
   * blank picker helps nobody) but it says what it is, so the client keeps
   * asking instead of settling on the curated list for the next six hours.
   */
  fallback?: boolean;
}

// Process-local hot cache. Survives request boundaries within a single
// node process; lost on restart (disk cache covers that).
const memCache = new Map<string, CatalogResponse>();
// Single-flight guard so two concurrent requests don't both fork openclaw.
const refreshing = new Set<string>();

/**
 * "The last refresh for this provider did not answer, so re-enumerate."
 *
 * A SET rather than a flag on the cached payload, because the payload is not
 * always there to flag: `bootWarmup` runs before any request has loaded the
 * disk cache into `memCache`, so a boot-time failure had nothing to mark and
 * the next request read a live, under-6h file off disk and sat on it for the
 * rest of the interval — the failure was silently forgotten in exactly the
 * window it is most likely to happen.
 */
const staleProviders = new Set<string>();

/**
 * Earliest time a provider may be enumerated again after an attempt that did
 * not answer. Without it, "re-enumerate whenever the payload is not live"
 * means a provider that CANNOT enumerate — plugin disabled, provider id gone,
 * an edition with no CLI — forks `openclaw models list` on every request
 * forever: ~3 minutes and ~2 cores of a Jetson each, and the single-flight set
 * only collapses the concurrent ones. The client retry (12 attempts with
 * `refresh=1`) and two mounted pickers keep that loop fed.
 *
 * So a failed attempt costs the next one a wait, doubling to the ordinary
 * refresh interval; a success clears it. `?refresh=1` does NOT bypass it —
 * the retry loop is the very thing being rate-limited.
 */
const nextAttemptAt = new Map<string, number>();
const FAILED_REFRESH_BACKOFF_MS = 2 * 60_000;

function refreshBlockedUntil(provider: string): number {
  return nextAttemptAt.get(provider) ?? 0;
}

function recordFailedRefresh(provider: string): void {
  const previous = nextAttemptAt.get(provider);
  const lastWait = previous ? Math.min(previous - Date.now(), REFRESH_INTERVAL_MS) : 0;
  const wait = Math.min(
    Math.max(lastWait * 2, FAILED_REFRESH_BACKOFF_MS),
    REFRESH_INTERVAL_MS,
  );
  nextAttemptAt.set(provider, Date.now() + wait);
  staleProviders.add(provider);
}

function recordSuccessfulRefresh(provider: string): void {
  nextAttemptAt.delete(provider);
  staleProviders.delete(provider);
}

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  clawai: "deepseek-v4-flash",
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.4",
  // Newest model on every ChatGPT tier including Free; gpt-5.6 is plan-gated.
  codex: "gpt-5.5",
  google: "gemini-2.5-flash",
  openrouter: "anthropic/claude-haiku-4.5",
};

// ClawBox AI catalog is hardcoded — Mike's gateway routes via DeepSeek
// upstream but the only end-user-pickable variants are the two device
// tiers (Flash + Pro), gated by subscription. Skipping the openclaw
// spawn for clawai also dodges the 3-min CLI execution time on Jetson.
export const CLAWAI_STATIC_MODELS: CatalogModel[] = [
  // 1M/text matches what the provider definition writes to openclaw.json and
  // what a real device reports back from `openclaw models list`. The previous
  // 128K here was never the model's limit — it under-reported the window to
  // every picker that reads this catalog. `text+image` was wrong too: V4 is
  // text-in upstream, and offering image attachments only produced rejects.
  {
    id: "deepseek-v4-flash",
    label: "Free/Pro Tier",
    contextWindow: 1_000_000,
    input: "text",
    hint: "Default. Faster.",
  },
  {
    id: "deepseek-v4-pro",
    label: "Max Tier",
    contextWindow: 1_000_000,
    input: "text",
    hint: "1.6T frontier model. Max plan only.",
  },
];

function noStore() {
  return { "Cache-Control": "no-store" } as const;
}

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: noStore() });
}

async function readDiskCache(provider: string): Promise<CatalogResponse | null> {
  try {
    const file = path.join(CACHE_DIR, `${provider}.json`);
    const raw = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as CatalogResponse;
    if (!Array.isArray(parsed.models) || typeof parsed.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDiskCache(provider: string, payload: CatalogResponse): Promise<void> {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const file = path.join(CACHE_DIR, `${provider}.json`);
    const tmp = `${file}.tmp`;
    // Write-then-rename so a crash mid-write can't leave a half-JSON
    // file that breaks the next read.
    await fsp.writeFile(tmp, JSON.stringify(payload), "utf8");
    await fsp.rename(tmp, file);
  } catch (e) {
    console.error(`[catalog] disk write failed for ${provider}:`, e instanceof Error ? e.message : e);
  }
}

interface OpenclawListResponse {
  count: number;
  /**
   * A refused command answers `{ok: false, error}` on STDOUT and exits 0 —
   * measured: `models list --provider codex --all --json` on 2026.8.1 prints
   * `Unknown provider filter "codex" for this installation` in that body, with
   * an empty stderr and exit code 0. An empty list has to be able to say why,
   * so this is read rather than the exit code.
   */
  ok?: boolean;
  error?: { type?: string; message?: string };
  models: Array<{
    key: string;
    name?: string;
    input?: string;
    contextWindow?: number;
    local?: boolean;
    /**
     * The harness's own verdict on the row, tristate: `true` = a route it can
     * take, `false` = one it cannot, `null`/absent = not determined. See the
     * note below the interface before reading it as a credential check.
     */
    available?: boolean | null;
    tags?: string[];
  }>;
}

// `openclaw models list` returns an `available` field per model, and this route
// now honours it — but ONLY when it is explicitly `false`.
//
// It is TRISTATE, and the third state is the whole point. It mirrors the CLI's
// Auth column, which docs.openclaw.ai/cli/models describes as a read-only check
// resolving each route to eligible profiles and credentials and reporting `ok`,
// `unknown` or `unavailable`; in `--json` those arrive as `true`, `null` and
// `false`. Measured, on an unconfigured host: every anthropic row comes back
// `"available": null` while `openai/gpt-5.6-sol` comes back `true`. On a linked
// box every row of both providers is `true`.
//
// So `false` is the harness saying this route is unavailable on this box — a
// row a picker should not offer. `null` is the harness saying it did not
// determine one, and treating THAT as "no" would empty the list on exactly the
// boxes that have not finished setting up, which is the failure the previous
// comment here (which read the field as a credential gate and skipped it
// entirely) was written to avoid. Dropping only `false` keeps that promise and
// still stops us offering a route the box has already said it cannot take.
//
// The auth-mode surface (SUBSCRIPTION_SURFACE) is the second, narrower
// question, and it is what this route stamps on top.
//
// anthropic's surface, concretely: `openclaw models list --provider anthropic`
// is the plugin's catalogue (9 models on 2026.7.1, claude-mythos-5 and
// claude-fable-5 among them), and since PR #532 a Claude SUBSCRIPTION routes
// through that same native plugin — `POST /v1/messages` with
// `anthropic-beta: oauth-2025-04-20` — so the surface IS this catalogue and
// there is no second one to enumerate. It used to be the plugin's `claude-cli`
// catalogue (5 models, no Mythos/Fable/Haiku), which was correct while the
// transport was the openai-compat override #532 removed; the stamp described
// that transport and went stale with it. See SUBSCRIPTION_SURFACE for the
// history and for why `nativeRouting` now comes from the same table the
// transport decision reads.

interface OpenRouterListResponse {
  data: Array<{
    id: string;
    name?: string;
    description?: string;
    context_length?: number;
    architecture?: { input_modalities?: string[] };
    deprecated?: boolean;
  }>;
}

// Deprecated model ids we filter out of the catalog regardless of
// whether the upstream tagged them as such. Anthropic's
// `openclaw models list --provider anthropic` returns
// `claude-sonnet-4-20250514` without a `deprecated` tag on
// Claude.ai OAuth scopes, but Anthropic's own docs
// (https://platform.claude.com/docs/en/about-claude/models) list
// it (and the matching opus-4 snapshot) as retiring 2026-06-15.
// Surfacing them in the picker just sets users up to pick a model
// that will stop working. Add new ids here when Anthropic ships
// the next deprecation notice.
const DEPRECATED_MODEL_IDS: ReadonlySet<string> = new Set([
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
]);

// Per-provider allowlist regex. When set, only model ids matching the
// pattern survive the catalog filter.
//
// ONE entry, and it is a routing fact rather than curation.
//
// codex (ChatGPT-account auth): 5.4, 5.4-mini, 5.5, plus the 5.6
//   gpt-5.6-{sol,terra,luna} models — NO -pro variants. Per
//   developers.openai.com/codex/models, the Pro models are API-key-only
//   and the Codex/ChatGPT-account auth path 400s with "model not
//   supported when using Codex with a ChatGPT account" if you try
//   gpt-5.4-pro or gpt-5.5-pro. The gpt-5.6-sol/terra/luna models DO run
//   on the ChatGPT-account path for accounts whose plan (Plus/Pro/Max)
//   includes them — the live upstream catalog only returns them for such
//   accounts, so this allowlist just stops us from stripping them; boxes
//   on plans without 5.6 never see the entries (no dead buttons).
//
// `openai` USED to carry /^gpt-5\.[45](-pro|-mini)?$/, to keep older
// generations out of the picker. It aged into the opposite of its purpose: on
// OpenClaw 2026.8.1 the openai catalogue is already curated upstream — one row
// on a stock host (`openai/gpt-5.6-sol`, tagged default), ten on a linked box —
// and that pattern matched NONE of the 5.6 generation, so the newest models the
// box could run were filtered out of their own catalogue and the picker fell
// back to a hand-written list. A generation allowlist cannot know what the next
// generation is called; the harness's catalogue can, and the whole point of
// this route is to ask it.
const ALLOWED_MODEL_RE_BY_PROVIDER: Record<string, RegExp> = {
  // Explicit alternation, not /^gpt-5\.[45](-mini)?$/ — that would also
  // accept gpt-5.5-mini (which doesn't exist on the Codex auth path
  // and would 400 the same way gpt-5.4-pro did). Per
  // developers.openai.com/codex/models the supported set under
  // ChatGPT-account auth is gpt-5.4, gpt-5.4-mini, gpt-5.5, plus the
  // gpt-5.6-{sol,terra,luna} models (plan-gated upstream, so they only
  // appear in the live catalog for accounts entitled to them).
  codex: /^(?:gpt-5\.5|gpt-5\.4(?:-mini)?|gpt-5\.6-(?:sol|terra|luna))$/,
};

// Model families that are not CHAT models, whatever provider lists them —
// image, audio/speech, transcription, video, embeddings, moderation, and the
// pre-chat completion engines. `openclaw models list` enumerates a provider's
// whole catalogue and offers no capability filter to ask for the chat ones
// (`--all`, `--local`, `--provider` and nothing else on 2026.8.1), and the rows
// carry no capability field either: an image SKU comes back with the same shape
// as a chat model — `openai/gpt-image-1-mini` alongside `openai/gpt-5.6-sol`,
// `input` reported as "-" for both on a stock host. That gap is worth reporting
// upstream; until it closes, this is the honest stopgap.
//
// It is a MODALITY exclusion, deliberately not a generation allowlist: it can
// only hide SKUs a chat picker has no way to talk to, never a chat model the
// box has learned about. That distinction is the point — the generation
// allowlist it replaces (`/^gpt-5\.[45](-pro|-mini)?$/`) hid the whole gpt-5.6
// generation, which is the defect this change exists to fix. Older chat
// generations the box lists are now shown: the standing instruction is that the
// device's own catalogue decides, and an older model the box can route is not a
// dead button.
const NON_CHAT_MODEL_RE = new RegExp([
  "^(?:gpt-image|dall-e|whisper|tts-|text-embedding|omni-moderation|sora",
  "|davinci|babbage|codex-mini)",
  // Suffix families: gpt-4o-audio-preview, gpt-4o-realtime-preview,
  // gpt-4o-transcribe, gpt-4o-mini-tts.
  "|(?:-audio|-realtime|-transcribe|-tts)(?:-|$)",
].join(""));

/**
 * The model segment of an id, for the modality test above.
 *
 * OpenRouter ids keep their `<org>/<model>` slug (`openai/gpt-image-1`), so an
 * anchored pattern tested against the whole id can never match one — the
 * exclusion was silently inert for the single largest catalogue we serve.
 */
function modelSegment(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function isNonChatModel(id: string): boolean {
  return NON_CHAT_MODEL_RE.test(modelSegment(id));
}

// Newest-first ordering: bigger context generally means newer model on
// every catalog we ship today (claude 200k+, gpt-5 400k, gemini 1M).
// Fall back to alpha when contextWindow is unknown/equal so the list
// stays stable on re-fetch.
function compareCatalogModels(a: CatalogModel, b: CatalogModel): number {
  if (a.contextWindow !== b.contextWindow) return b.contextWindow - a.contextWindow;
  return a.label.localeCompare(b.label);
}

/**
 * Model ids the subscription surface carries, or null when it could not be
 * enumerated. Null means UNKNOWN and every caller must treat it as "do not
 * mark anything" — an empty set would silently strike out the whole list.
 *
 * The surface depends on the plugin's catalogue, not on the customer's
 * credentials, so it rides the same mem+disk cache every other catalogue
 * uses. It has to survive a restart: a process-local cache would leave the
 * picker unmarked — i.e. back to the defect this stamp exists to fix — for
 * the first three minutes after every reboot.
 */
async function fetchSubscriptionSurfaceIds(provider: string): Promise<Set<string> | null> {
  const surfaceProvider = subscriptionSurfaceProvider(provider);
  if (!surfaceProvider) return null;
  // A natively-routed provider's surface is its OWN catalogue, which this
  // refresh is already fetching. Enumerating it again would spend a second
  // multi-minute `openclaw models list` on the identical list, and — worse —
  // publish it to `<provider>.json` unmerged and unsanitized, clobbering the
  // payload the picker and the server-side guard both read. `buildPayload`
  // stamps that case from the merged list instead.
  if (surfaceProvider === provider) return null;
  const cached = memCache.get(surfaceProvider) ?? await readDiskCache(surfaceProvider);
  if (cached && Date.now() - cached.fetchedAt < REFRESH_INTERVAL_MS && cached.models.length > 0) {
    memCache.set(surfaceProvider, cached);
    return new Set(cached.models.map((m) => m.id));
  }
  try {
    const { models } = await fetchOpenclawCatalog(surfaceProvider);
    if (models.length === 0) return null;
    const payload: CatalogResponse = {
      provider: surfaceProvider,
      models,
      defaultModelId: models[0].id,
      allowCustom: false,
      fetchedAt: Date.now(),
      source: "live",
    };
    memCache.set(surfaceProvider, payload);
    await writeDiskCache(surfaceProvider, payload);
    return new Set(models.map((m) => m.id));
  } catch (err) {
    console.warn(
      `[catalog] subscription surface (${surfaceProvider}) unavailable for ${provider}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * `<provider>/<model>` split on the FIRST slash — the documented shape of a
 * `key` (docs.openclaw.ai/concepts/models), and the only parsing this route
 * does to a model name. It is split rather than prefix-stripped because the
 * catalogue a picker is asked for is not always the provider that enumerates
 * it: the ChatGPT surface is served from `openai/*` rows.
 */
function modelIdFromKey(key: string): string {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(slash + 1) : key;
}

function transformOpenclawEntries(
  provider: string,
  entries: OpenclawListResponse["models"],
): CatalogModel[] {
  const allowed = ALLOWED_MODEL_RE_BY_PROVIDER[provider];
  const out: CatalogModel[] = [];
  for (const entry of entries) {
    if (typeof entry.key !== "string") continue;
    const id = modelIdFromKey(entry.key);
    if (!id) continue;
    // Explicitly `false` only. `null`/absent is the harness saying it did not
    // determine one, and hiding a row over that would empty the picker on
    // exactly the boxes that have not finished setting up.
    if (entry.available === false) continue;
    if (entry.tags?.includes("deprecated")) continue;
    if (DEPRECATED_MODEL_IDS.has(id)) continue;
    if (isNonChatModel(id)) continue;
    if (allowed && !allowed.test(id)) continue;
    out.push({
      id,
      label: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
      contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : 0,
      input: typeof entry.input === "string" ? entry.input : undefined,
      // The live `name` is the label, and there is no live hint. Inventing one
      // is how a picker ends up describing a model nobody measured, so a hint
      // only survives where the curated entry for the SAME id already carried
      // one — see `hintFor`.
      hint: hintFor(provider, id),
    });
  }
  out.sort(compareCatalogModels);
  return out;
}

function isAllowedCatalogModel(provider: string, model: CatalogModel): boolean {
  if (!model.id) return false;
  const allowed = ALLOWED_MODEL_RE_BY_PROVIDER[provider];
  if (allowed && !allowed.test(model.id)) return false;
  if (isNonChatModel(model.id)) return false;
  if (DEPRECATED_MODEL_IDS.has(model.id)) return false;
  return true;
}

function sanitizeCatalogModels(provider: string, models: CatalogModel[]): CatalogModel[] {
  return models.filter((model) => isAllowedCatalogModel(provider, model));
}

function transformOpenRouterEntries(entries: OpenRouterListResponse["data"]): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id) continue;
    if (entry.deprecated) continue;
    const inputs = entry.architecture?.input_modalities ?? [];
    const inputMode = inputs.length > 0 ? inputs.join("+") : undefined;
    out.push({
      id: entry.id,
      label: typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.id,
      contextWindow: typeof entry.context_length === "number" ? entry.context_length : 0,
      input: inputMode,
      hint: typeof entry.description === "string" ? entry.description.slice(0, 140) : undefined,
    });
  }
  out.sort(compareCatalogModels);
  return out;
}

// Per-provider override of the default `allowCustom: true`. ClawBox AI
// is the only provider that doesn't support custom model ids today —
// Mike's gateway only routes the two device tiers (Flash/Pro), so any
// other slug would 404. Without this override, the live-cache payload
// would re-enable custom entry and contradict
// PROVIDER_CATALOGS.clawai.allowCustom = false.
const ALLOW_CUSTOM_BY_PROVIDER: Record<string, boolean> = {
  clawai: false,
};

// Context-window lookup for the curated cold-start entries. Values from each
// provider's official model docs. Read ONLY when building a fallback payload —
// a live row carries the window the device reported.
const STATIC_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic — https://platform.claude.com/docs/en/about-claude/models
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-5": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
};

/**
 * The curated cold-start entry for one id, if the shipped list carries it.
 *
 * This is the ONLY thing the curated arrays contribute to a live row: a hint,
 * which no catalogue enumeration returns. Anything else — a label, a context
 * window, the existence of the row at all — comes from the device.
 */
function hintFor(provider: string, id: string): string | undefined {
  if (!isCatalogProvider(provider)) return undefined;
  const hint = PROVIDER_CATALOGS[provider]?.models.find((m) => m.id === id)?.hint;
  return hint || undefined;
}

/**
 * The curated cold-start list for `provider`, as catalog rows.
 *
 * It is a DISPLAY fallback and nothing more. It used to be merged into every
 * live enumeration and then persisted with it, which is how a box whose
 * Anthropic plugin was disabled at 07:13 came to hold a `catalog-cache`
 * file that named three Claude models, wore a fresh `fetchedAt`, and was
 * indistinguishable from a device answer for the next six hours — while the
 * same box could run eleven. A hand-maintained list cannot know what a device
 * can route; the harness's own catalogue can, and asking it again is cheap.
 * So this list is served only while there is no live answer, always marked
 * `fallback`, and never written to disk.
 */
function staticCatalogModels(provider: string): CatalogModel[] {
  if (!isCatalogProvider(provider)) return [];
  const staticEntry = PROVIDER_CATALOGS[provider];
  if (!staticEntry) return [];
  // NOT sorted. `compareCatalogModels` orders by context window and then
  // alphabetically, which is right for an enumeration — the device reports a
  // real window for every row — and wrong here: STATIC_MODEL_CONTEXT_WINDOWS
  // only carries the Anthropic ids, so every other curated row takes the
  // 200_000 default, ties, and falls back to alphabetical. CODEX_MODELS,
  // hand-ordered newest-first, would be served GPT-5.4 first. These arrays are
  // curated in the order they should be read; that IS their metadata.
  return staticEntry.models.map((sm) => ({
    id: sm.id,
    label: sm.label,
    contextWindow: STATIC_MODEL_CONTEXT_WINDOWS[sm.id] ?? 200_000,
    hint: sm.hint,
  }));
}

function buildPayload(
  provider: string,
  models: CatalogModel[],
  surfaceIds?: Set<string> | null,
): CatalogResponse {
  // Do not trust old disk caches blindly. Earlier builds could persist
  // Codex/ChatGPT-account models like gpt-5.5-pro that the upstream
  // rejects at request time. Re-apply the current provider allowlist when
  // constructing every payload, including cached/stale ones.
  let merged = sanitizeCatalogModels(provider, models);
  // Stamped on whatever list is about to be served, live or fallback: a
  // fallback row the customer can see is a row the customer can pick, so it
  // has to carry the same verdict a live one would (ANTHROPIC_MODELS carries
  // claude-haiku-4-5, which a narrowed subscription surface does not).
  if (surfaceIds) {
    merged = merged.map((m) => ({ ...m, availableOnSubscription: surfaceIds.has(m.id) }));
  } else if (subscriptionSurfaceProvider(provider) === provider) {
    // The surface IS this catalogue — a natively-routed subscription runs on
    // the provider's own plugin, so THIS list is the set it can run and every
    // row is stamped usable. Asked as "is the surface me?" rather than
    // "is this a subscription?" because a payload is built once and served to
    // both auth modes; the stamp answers what a SUBSCRIPTION could route, and
    // `isModelUsableOnSubscription` is what decides whether that applies to
    // the box in front of the customer.
    //
    // Stamped `true` rather than left undefined so the two gates cannot
    // disagree: the server-side guard in subscription-surface.ts reads this
    // very payload back off disk, and a row the picker offers must be a row
    // that route accepts.
    merged = merged.map((m) => ({ ...m, availableOnSubscription: true }));
  }
  const fallbackDefault = DEFAULT_MODEL_BY_PROVIDER[provider];
  const defaultModelId = merged.find((m) => m.id === fallbackDefault)?.id
    ?? merged[0]?.id
    ?? fallbackDefault
    ?? "";
  return {
    provider,
    models: merged,
    defaultModelId,
    allowCustom: ALLOW_CUSTOM_BY_PROVIDER[provider] ?? true,
    fetchedAt: Date.now(),
  };
}

/**
 * A payload built from the curated cold-start list. Marked `fallback`, and
 * — the whole point — never handed to `writeDiskCache`.
 */
function buildFallbackPayload(provider: string): CatalogResponse {
  return {
    ...buildPayload(provider, staticCatalogModels(provider)),
    fetchedAt: 0,
    fallback: true,
  };
}

/** Did a device enumeration produce this payload? See `CatalogResponse.source`. */
function isLivePayload(payload: CatalogResponse | null | undefined): boolean {
  return payload?.source === "live";
}

function sanitizeCachedPayload(provider: string, cached: CatalogResponse): CatalogResponse {
  const next = buildPayload(provider, cached.models);
  return {
    ...next,
    fetchedAt: cached.fetchedAt,
    stale: cached.stale,
    warming: cached.warming,
    source: cached.source,
    // An unmarked cache — written by a build from before `source` existed, or
    // by the path that used to persist the curated list as though a device had
    // answered — is served, and says so.
    fallback: isLivePayload(cached) ? undefined : true,
  };
}

/**
 * WHY `codex` IS NOT ENUMERATED FROM `openai`, though both name the same
 * upstream.
 *
 * `codex` was a provider in the OpenClaw core through 2026.6.x. It is gone in
 * 2026.8.1: `models list --provider codex --all --json` answers
 * `{"ok": false, "error": {"message": "Unknown provider filter \"codex\"…"}}`,
 * and a ChatGPT sign-in is an `openai` OAuth profile now
 * (`openclaw models auth login --provider openai`, docs.openclaw.ai/cli/models).
 * The obvious move is to serve the ChatGPT catalogue from the `openai` one,
 * narrowed by the documented ChatGPT-account allowlist. It is wrong, twice:
 *
 *  * The openai catalogue is NOT plan-scoped. It lists `gpt-5.6-sol` on any
 *    box — measured, one row and that row on a stock host — while gpt-5.6 is
 *    plan-gated upstream (Plus/Pro/Max). A Free account would be handed it as
 *    the only row AND as the saved default, and every turn would 400. The old
 *    "no dead buttons" property came from `codex` being a plan-aware
 *    catalogue; nothing in `openai` replaces it.
 *  * `available` cannot rescue it. Every openai row reads `available: true` as
 *    soon as ANY openai profile exists — on the affected box that was the
 *    ClawBox AI image token, an API key that cannot chat.
 *
 * So this core exposes no enumeration of the ChatGPT surface, and that is a
 * finding, not a licence to synthesise one: replacing a hard-coded list with a
 * WRONG live list is the same defect pointed the other way. `codex` therefore
 * enumerates nothing, publishes nothing, and its picker is served the curated
 * list marked `fallback` — never persisted, never dressed up as the box's own
 * answer, and logged with the CLI's own refusal.
 *
 * The ChatGPT rendering belongs on the credential facts TASK-652 introduces —
 * `GET /setup-api/chat/model` rows carrying `provider: "codex"` with
 * `model: "openai/<id>"` and `reauthRequired`, and `subscriptionProviders`
 * containing `codex` — not on this catalogue.
 */

interface CatalogFetchResult {
  models: CatalogModel[];
  /**
   * Why an empty list was empty: the CLI's own `error.message` when it refused
   * the command, else its stderr. Empty when it simply had nothing to list.
   */
  diagnostic: string;
}

function toFetchResult(
  provider: string,
  parsed: OpenclawListResponse,
  stderr: string,
): CatalogFetchResult {
  const rows = parsed.models ?? [];
  const models = transformOpenclawEntries(provider, rows);
  const refusal = parsed.ok === false ? parsed.error?.message?.trim() : "";
  let diagnostic = refusal || stderr.trim();
  if (!diagnostic && models.length === 0 && rows.length > 0) {
    // The CLI answered, listed rows, and none of them survived. Which filter
    // ate them decides what an operator does next — "sign in" is a different
    // problem from "this catalogue has no chat models" — and neither is
    // "the plugin is gone", which is what a bare "0 models" implied.
    const unavailable = rows.filter((row) => row.available === false).length;
    diagnostic = unavailable === rows.length
      ? `all ${rows.length} listed rows report available: false (no route this box can take yet)`
      : `${rows.length} rows listed, none of them chat models this picker can offer`;
  }
  return { models, diagnostic };
}

function fetchOpenclawCatalog(provider: string): Promise<CatalogFetchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_BIN, ["models", "list", "--provider", provider, "--all", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: process.env.HOME ?? "/home/clawbox",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`openclaw timed out after ${REFRESH_TIMEOUT_MS}ms`)));
    }, REFRESH_TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
      // openclaw's compile-cache wrapper keeps a grandchild holding our
      // stdout pipe open for ~3 minutes after the JSON arrives. Parse
      // on each chunk so we resolve as soon as the JSON is syntactically
      // complete instead of waiting for `close`.
      if (settled || !stdout.includes("}")) return;
      try {
        const parsed = JSON.parse(stdout) as OpenclawListResponse;
        clearTimeout(timer);
        finish(() => resolve(toFetchResult(provider, parsed, stderr)));
      } catch {
        // Partial JSON — keep accumulating.
      }
    });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      clearTimeout(timer);
      finish(() => reject(new Error(`openclaw spawn failed: ${e.message}`)));
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        finish(() => reject(new Error(`openclaw exited ${code}: ${stderr.slice(-300).trim()}`)));
        return;
      }
      finish(() => {
        try {
          const parsed = JSON.parse(stdout) as OpenclawListResponse;
          resolve(toFetchResult(provider, parsed, stderr));
        } catch {
          reject(new Error(`openclaw produced non-JSON output: ${stdout.slice(0, 200)}`));
        }
      });
    });
  });
}

async function fetchOpenRouterCatalog(): Promise<CatalogFetchResult> {
  const res = await fetch(OPENROUTER_API, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}`);
  }
  const data = (await res.json()) as OpenRouterListResponse;
  return { models: transformOpenRouterEntries(data.data ?? []), diagnostic: "" };
}

// Refresh the catalog for `provider` in the background. Returns
// immediately; the actual openclaw spawn / openrouter fetch runs out
// of band. Single-flight via `refreshing` so concurrent requests
// collapse to one fork. Exported so configure/route.ts can trigger a
// refresh right after the user adds an API key — otherwise the
// catalog stays on the pre-auth snapshot from boot warmup until the
// next service restart.
export function refreshInBackground(provider: string): void {
  if (refreshing.has(provider)) return;
  // A provider that just failed to answer waits before it is asked again. This
  // is the only brake on the "not live -> re-enumerate" rule, so it comes
  // before every other check — including the edition guard below, whose log
  // line would otherwise repeat on every request of a Hermes box's session.
  const blockedUntil = refreshBlockedUntil(provider);
  if (blockedUntil > Date.now()) return;

  // OpenRouter (REST) and ClawBox AI (static) never touch the CLI; every other
  // provider's catalog comes from `openclaw models list`. On an edition without
  // the binary (Hermes) that spawn is a guaranteed ENOENT, so skip it cleanly
  // rather than fork a missing binary for each provider on every boot warmup.
  // Hermes surfaces its own model list through the Hermes dashboard, not here.
  const usesOpenclawCli = provider !== "openrouter" && provider !== "clawai";
  if (usesOpenclawCli && openclawIsAbsent()) {
    console.log(`[catalog] skipping ${provider}: the openclaw CLI is not present on this edition`);
    // Recorded as a failed attempt so the line above appears once per backoff
    // window instead of once per picker open: on this edition it can never
    // succeed, and it is the one branch that is guaranteed to repeat.
    recordFailedRefresh(provider);
    return;
  }

  refreshing.add(provider);

  let fetcher: Promise<CatalogFetchResult>;
  if (provider === "openrouter") {
    fetcher = fetchOpenRouterCatalog();
  } else if (provider === "clawai") {
    // The only catalogue with no upstream to ask: Mike's gateway routes the
    // two device tiers and nothing else, so these two rows ARE the device's
    // answer rather than a stand-in for one.
    fetcher = Promise.resolve({ models: CLAWAI_STATIC_MODELS, diagnostic: "" });
  } else {
    fetcher = fetchOpenclawCatalog(provider);
  }

  // A provider whose subscription narrows to a SECOND catalogue needs that
  // catalogue enumerated too. The two enumerations are independent — the
  // surface list never reads the main one — and each costs minutes of Jetson
  // CPU, so start both now and publish the main catalogue the moment IT lands:
  // making the picker wait on the surface would double the first-boot window
  // the whole async-first design in this file's header exists to shrink.
  //
  // Resolves to null immediately for a natively-routed provider, which has no
  // second catalogue — `buildPayload` stamps that case from the merged list on
  // the first publish, so those boxes are never served an unstamped payload.
  const surface = fetchSubscriptionSurfaceIds(provider);

  const publish = async (models: CatalogModel[], surfaceIds: Set<string> | null) => {
    const payload: CatalogResponse = { ...buildPayload(provider, models, surfaceIds), source: "live" };
    memCache.set(provider, payload);
    recordSuccessfulRefresh(provider);
    await writeDiskCache(provider, payload);
    console.log(
      `[catalog] refreshed ${provider}: ${models.length} models`
      + (surfaceIds ? ` (${surfaceIds.size} on the subscription surface)` : ""),
    );
  };

  /**
   * Keep whatever good payload this box already has, mark it stale so a later
   * request re-enumerates rather than sitting on it for the refresh interval,
   * and make the next attempt wait.
   *
   * The mark goes in `staleProviders`, not on the cached payload: at boot
   * warmup there is no cached payload to mark. Nothing is written to disk —
   * the file there is the last answer a device actually gave, and rewriting it
   * would spend a write to record that a LATER attempt failed.
   */
  const markStale = () => {
    recordFailedRefresh(provider);
    const cached = memCache.get(provider);
    if (cached) memCache.set(provider, { ...cached, stale: true });
  };

  fetcher
    .then(async ({ models, diagnostic }) => {
      if (models.length === 0) {
        // NOT a success. "[catalog] refreshed codex: 0 models" used to be
        // followed by a disk write of the curated list, which then read back
        // as a device answer — a false success in the exact shape this
        // codebase keeps producing. An empty enumeration says the plugin is
        // disabled, the provider id is gone, or the CLI failed silently; none
        // of those are facts about what the box can run.
        console.warn(
          `[catalog] ${provider}: live enumeration returned no models, keeping the previous catalogue`
          + (diagnostic ? ` — ${diagnostic.slice(-300)}` : " (the CLI gave no reason)"),
        );
        markStale();
        // Settled, not abandoned: for a provider with a genuinely narrower
        // surface this is a second multi-minute fork, and returning without it
        // would release the single-flight guard while it still burns CPU.
        await surface;
        return;
      }
      await publish(models, null);
      const surfaceIds = await surface;
      if (surfaceIds) await publish(models, surfaceIds);
    })
    .catch((err: unknown) => {
      console.error(`[catalog] refresh failed for ${provider}:`, err instanceof Error ? err.message : err);
      markStale();
    })
    .finally(() => {
      refreshing.delete(provider);
    });
}

// Boot warmup: when this module is first imported (typically when the
// user opens the AI picker for the first time post-restart), fire off
// a background refresh for every provider so subsequent picker opens
// are instant. Idempotent — guarded by `bootWarmupStarted`.
let bootWarmupStarted = false;
function bootWarmup(): void {
  if (bootWarmupStarted) return;
  bootWarmupStarted = true;
  // Stagger by 5s so we don't fork four openclaw bins at the exact
  // same instant. Each one is ~2 cores of CPU for ~3 minutes.
  CATALOG_PROVIDERS.forEach((p, i) => {
    setTimeout(() => refreshInBackground(p), i * 5_000);
  });
}

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider")?.trim().toLowerCase() ?? "";
  if (!provider) {
    return fail("'provider' query parameter is required", 400);
  }
  if (!isCatalogProvider(provider)) {
    return fail(`Unknown provider: ${provider}. Supported: ${CATALOG_PROVIDERS.join(", ")}`, 400);
  }
  const force = req.nextUrl.searchParams.get("refresh") === "1";

  bootWarmup();

  // Hot path: in-memory cache.
  let cached = memCache.get(provider);
  if (!cached) {
    const fromDisk = await readDiskCache(provider);
    if (fromDisk) {
      // Re-check after the await: a concurrent refreshInBackground (e.g. the
      // bootWarmup scheduled at module-load) can complete during the disk
      // read and put a fresher payload in memCache. Without this guard we'd
      // clobber it with the older disk snapshot — a real bug observed after
      // a deploy where memCache stayed pinned to pre-restart values for the
      // full REFRESH_INTERVAL_MS window.
      const racedIn = memCache.get(provider);
      if (racedIn && racedIn.fetchedAt >= fromDisk.fetchedAt) {
        cached = racedIn;
      } else {
        memCache.set(provider, fromDisk);
        cached = fromDisk;
      }
    }
  }

  const ageMs = cached ? Date.now() - cached.fetchedAt : Infinity;
  const isStale = ageMs > REFRESH_INTERVAL_MS
    || cached?.stale === true
    || staleProviders.has(provider);
  // A payload no device produced is a reason to ask AGAIN, not a reason to
  // wait six hours. That includes a cache written before `source` existed —
  // on an upgraded box those files hold the curated list a failed enumeration
  // left behind, and nothing else would ever dislodge them.
  if (force || isStale || !isLivePayload(cached)) {
    refreshInBackground(provider);
  }

  // "An answer is actually on its way" — the ONE thing that tells a client
  // whether coming back is worth anything. A provider under the failed-refresh
  // backoff has no enumeration running and will not get one soon, so it is not
  // warming and a picker must not sit there polling for it; the cold start,
  // where a fork really is out there, is.
  const enumerating = refreshing.has(provider);

  if (cached) {
    const sanitized = sanitizeCachedPayload(provider, cached);
    memCache.set(provider, sanitized);
    const payload: CatalogResponse = {
      ...sanitized,
      ...(isStale ? { stale: true } : {}),
      ...(enumerating && !isLivePayload(cached) ? { warming: true } : {}),
    };
    return NextResponse.json(payload, { headers: noStore() });
  }

  // Nothing cached yet — the first picker open after a restart. Serve the
  // curated list so the picker is not blank, marked `fallback` so the client
  // knows what it is holding.
  const payload: CatalogResponse = {
    ...buildFallbackPayload(provider),
    ...(enumerating ? { warming: true } : {}),
  };
  return NextResponse.json(payload, { headers: noStore() });
}
