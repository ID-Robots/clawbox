import { NextRequest, NextResponse } from "next/server";
import { coreRetiredModels } from "@/lib/core-model-lifecycle";
import { spawn } from "child_process";
import { promises as fsp } from "fs";
import path from "path";
import { findOpenclawBin, openclawIsAbsent } from "@/lib/openclaw-config";
import { DATA_DIR } from "@/lib/config-store";
import { CODEX_SUPPORTED_MODEL_RE } from "@/lib/subscription-surface";
import { lastModelSegment } from "@/lib/chat-header-pills";
import {
  CATALOG_PROVIDERS,
  getProviderCatalog,
  isCatalogProvider,
  isNonChatModelId,
  subscriptionSurfaceProvider,
} from "@/lib/provider-models";
import { forgetProviderEnumeration, recordProviderEnumeration } from "@/lib/provider-runnable";

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
//   `warming: true` and no `source`, which is what "not the box's answer"
//   means on the wire.
//
// Force-refresh via `?refresh=1` triggers a refresh in the background
// and serves whatever's currently cached — the user never waits.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP (M-05): a payload the harness did not
// produce is never persisted, and never presented as though it were. Only a
// live enumeration is written to the disk cache, and only such a payload is
// stamped `source: "live"`. Everything else arrives without that stamp, which
// is how the client knows to come back for the real answer. An enumeration that returns ZERO
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
  /**
   * The harness tagged this row `default` for its provider.
   *
   * Carried rather than dropped because it is the box's own answer to the same
   * question `PROVIDER_CATALOGS` answers by hand, and a hand-written default is
   * the identical defect to a hand-written list: on a 2026.8.1 host `openclaw
   * models list --provider openai` tags `gpt-5.6-sol`, while the curated table
   * says `gpt-5.4`. Only a live enumeration ever sets it — the curated
   * cold-start rows carry no such claim.
   */
  isDefault?: boolean;
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
   * served alongside it, without a `source`, so the picker has rows to render
   * while the first enumeration runs.
   */
  warming?: boolean;
  /**
   * Where these models came from. `"live"` means THE BOX ANSWERED — the
   * enumeration this route performs for that provider returned rows, and ONLY
   * such a payload is ever written to the disk cache.
   *
   * For every CLI provider that is `openclaw models list --provider <p> --all
   * --json`, and for openrouter it is that catalogue's own /api/v1/models. For
   * `clawai` the enumeration IS a literal (`CLAWAI_STATIC_MODELS`), and it is
   * stamped all the same, deliberately: Mike's gateway routes exactly the two
   * device tiers, so those two rows are the routing table rather than a
   * stand-in for one nobody asked. The rule this field carries is "not a
   * placeholder for an answer", not "a subprocess ran".
   *
   * Absent is not a synonym for "old": a payload persisted by a build before
   * this field existed is indistinguishable from one built out of the curated
   * cold-start arrays, which is exactly the state that made three hard-coded
   * model names the truth on a box that could run eleven. An unmarked file is
   * therefore re-enumerated — once if that succeeds, and thereafter on the
   * failed-refresh backoff if it does not, so a provider that can never
   * enumerate cannot turn this rule into a fork per request.
   */
  source?: "live";
}

// Process-local hot cache. Survives request boundaries within a single
// node process; lost on restart (disk cache covers that).
const memCache = new Map<string, CatalogResponse>();
// Single-flight guard so two concurrent requests don't both fork openclaw.
const refreshing = new Set<string>();

/**
 * "The last enumeration for this provider did not answer" — the deadline
 * before it may be asked again, and the wait that produced it.
 *
 * ONE map, carrying BOTH numbers, because neither recovers the other. The
 * deadline alone cannot: by the time a second failure records, the first
 * deadline has necessarily passed (that is how the attempt got past the
 * guard), so `deadline - now` is negative and doubling it lands back on the
 * floor every time — a flat two minutes forever, which is not a backoff. Its
 * key set is also the "is this provider stale" answer, so there is no second
 * structure for that: an entry means the last attempt failed, a publish
 * deletes it.
 *
 * A MAP rather than a flag on the cached payload, because the payload is not
 * always there to flag: `bootWarmup` runs before any request has loaded the
 * disk cache into `memCache`, so a boot-time failure had nothing to mark and
 * the next request read a live, under-6h file off disk and sat on it for the
 * rest of the interval — forgotten in exactly the window it is most likely to
 * happen.
 *
 * Why it exists: without it, "re-enumerate whenever the payload is not live"
 * means a provider that CANNOT enumerate — plugin disabled, provider id gone,
 * an edition with no CLI — forks `openclaw models list` on every request
 * forever, ~3 minutes and ~2 cores of a Jetson each, and the single-flight set
 * only collapses the concurrent ones.
 *
 * What it rate-limits is a client ASKING AGAIN. It must not survive the box
 * CHANGING, and the two are different events: a provider connect enables the
 * plugin and writes the credential, which is the moment a provider that could
 * not enumerate starts being able to. Blocking there recreates the reported
 * symptom through this very brake — no fork, therefore no `warming`, therefore
 * nothing polling, therefore the curated list stands until some unrelated
 * request happens along after the deadline. So `providerChanged` clears the
 * entry (see `refreshInBackground`), and only the poll path is held.
 *
 * Per-process on purpose. It limits THIS process's forks, it sits beside
 * `memCache` and `refreshing` which are already per-process, and a restart is
 * a legitimate reason to try again — `bootWarmup` re-enumerates anyway.
 */
interface FailedRefresh {
  /** Epoch ms before which this provider must not be enumerated again. */
  until: number;
  /** The wait that produced `until`, so the next one can double it. */
  waitMs: number;
}
const failedRefreshes = new Map<string, FailedRefresh>();
const FAILED_REFRESH_BACKOFF_MS = 2 * 60_000;

/**
 * PER-PROVIDER CHANGE GENERATION — "how many times has the box changed for this
 * provider", and which generation each answer is about.
 *
 * A boolean cannot express this, and two rounds of review found the two halves
 * it gets wrong. What has to be answerable is: *is the catalogue we are serving
 * the answer for the box as it is now?* Three facts give that:
 *
 *  * `changeSeq` — bumped by every accepted provider-set change (a connect, a
 *    plugin switched on, a credential written).
 *  * the generation the running fork will answer for, captured in `forkSeq`
 *    when it STARTS, because that is when the box it reads is fixed.
 *  * `publishedSeq` — the generation of the payload currently in `memCache`
 *    and on disk.
 *
 * Everything follows:
 *
 *  * A fork whose generation is behind `changeSeq` by the time it answers is
 *    describing a box that no longer exists. Its result is NOT published —
 *    not to memCache, not to disk, and above all not stamped `source: "live"`.
 *    Publishing it was a false success the width of the replacement fork
 *    (~3 minutes on a Jetson): every GET in that window — a reload, the chat
 *    picker, a second tab — was handed the PRE-credential list marked live and
 *    unstale, one line before the `.finally` scheduled its replacement.
 *  * `publishedSeq < changeSeq` IS the warming condition. It stays true for
 *    every poll until the current-generation fork lands, where the previous
 *    `|| force` was true for exactly one response — the single `?refresh=1` —
 *    and the hook's next poll two seconds later saw `warming: false` with three
 *    minutes still to run, so a picker open across a connect settled on the
 *    pre-change rows.
 *  * ONLY A SERVER-SIDE WRITE COUNTS, and every one of them goes through
 *    `notifyProviderSetChanged` — whose docblock is the register of which
 *    writes those are, kept in one place because nothing else enforces that a
 *    new write remembers to call it. A client's `?refresh=1` is demoted to
 *    `serveCurrent`, which asks whether the current generation has an answer
 *    and never claims one happened.
 *
 *    That split is what removed the duplicate enumeration per connect —
 *    step 8c and the client's echo are the same change, and only the write
 *    counts — WITHOUT the predicate that used to do it. That predicate read
 *    the shape of the fork in flight rather than the identity of the signal,
 *    so a second, genuinely different change 30 seconds later (a corrected
 *    key, a provider switched off and back on) landed on the same branch and
 *    was dropped: no bump, no re-entry, and the pre-change fork then published
 *    as the current generation with nothing left to re-enumerate for six
 *    hours. One write is one bump; two writes are two generations.
 *
 * Per-process, like `memCache`, `refreshing` and `failedRefreshes` beside it. A
 * restart re-enumerates through `bootWarmup` anyway.
 */
const changeSeq = new Map<string, number>();
const publishedSeq = new Map<string, number>();

/**
 * When each provider last spent a client-facing retry.
 *
 * TASK-669. The failed-refresh backoff starts at two minutes and doubles to
 * the full six-hour interval, which is the right schedule for the BOX's own
 * retries and was also the only schedule there was. A blip during boot warmup
 * — the network not up yet, the CLI mid-upgrade — records a wait while nobody
 * is looking, and the first person to open the picker afterwards is shown the
 * curated fallback with nothing on the box willing to try again. Before the
 * change generations landed, any picker open re-forked; now nothing does.
 *
 * `?refresh=1` is not the answer, and that is worth writing down because the
 * card proposed it: the client sends it ONLY as its echo of a provider-set
 * change (`useProviderCatalog`'s `forceNextLoad`), and by then
 * `notifyProviderSetChanged` has already cleared the wait server-side. The
 * plain picker open — the one that finds the box in this state — sends no
 * parameter at all.
 *
 * So the attempt is spent by the REQUEST that finds itself without the box's
 * own current answer, and it is a MINIMUM GAP rather than a once-ever count.
 * This process runs for weeks: a single allowance would be burnt by the first
 * picker open after the boot blip — very likely the one where the uplink is
 * still coming up — and the provider would then be unreachable for the life of
 * the server. `src/lib/hermes-model-options.ts` had the same problem on the
 * other edition and solved it with `EXPLICIT_REFRESH_MIN_GAP_MS`; this is that
 * primitive.
 *
 * The gap is longer than an enumeration (~3 minutes on a Jetson) so a mounted
 * picker's warming poll cannot chain one fork into the next, and it is cleared
 * by the two events that make an old failure meaningless — a successful
 * refresh, and a provider-set change.
 */
const CLIENT_RETRY_MIN_GAP_MS = 5 * 60_000;
const clientRetryAt = new Map<string, number>();

/** May a client-facing retry be spent for this provider now? */
function clientRetryIsDue(provider: string): boolean {
  const last = clientRetryAt.get(provider);
  return last === undefined || Date.now() - last >= CLIENT_RETRY_MIN_GAP_MS;
}

function currentSeq(provider: string): number {
  return changeSeq.get(provider) ?? 0;
}

/**
 * Is the payload we would serve the answer for the box as it is now?
 *
 * An unpublished provider defaults to generation 0, the same floor `changeSeq`
 * starts from, so a fresh process is "current" until something actually
 * changes. Defaulting it BELOW the floor made every provider stale and warming
 * after every restart, which put each mounted picker into a poll loop over a
 * box nobody had touched.
 */
function publishedIsCurrent(provider: string): boolean {
  return (publishedSeq.get(provider) ?? 0) >= currentSeq(provider);
}

function refreshIsBlocked(provider: string): boolean {
  const failure = failedRefreshes.get(provider);
  return failure !== undefined && failure.until > Date.now();
}

/** Did the last attempt for this provider fail? Its cached payload is stale. */
function refreshFailedLast(provider: string): boolean {
  return failedRefreshes.has(provider);
}

function recordFailedRefresh(provider: string): void {
  const previous = failedRefreshes.get(provider)?.waitMs ?? 0;
  const waitMs = Math.min(
    Math.max(previous * 2, FAILED_REFRESH_BACKOFF_MS),
    REFRESH_INTERVAL_MS,
  );
  failedRefreshes.set(provider, { until: Date.now() + waitMs, waitMs });
}

function recordSuccessfulRefresh(provider: string): void {
  failedRefreshes.delete(provider);
  // The gap only exists to ration retries against a FAILING provider. One that
  // has just answered owes nothing, and the next time it fails the client's
  // first look should get an attempt.
  clientRetryAt.delete(provider);
}

/**
 * "The box changed, so the last failure says nothing about the next attempt."
 *
 * Separate from `recordSuccessfulRefresh` because nothing succeeded — this is
 * the credential/plugin write that makes the next enumeration worth spending,
 * and it also drops the doubling back to the floor, which is right: the reason
 * the previous attempts failed has just been removed.
 */
function clearFailedRefresh(provider: string): void {
  failedRefreshes.delete(provider);
}

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
    architecture?: { input_modalities?: string[]; output_modalities?: string[] };
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
  // IMPORTED, not spelled again. `CODEX_SUPPORTED_MODEL_RE` is the same
  // alternation, and its own doc says it lives there so that "a second copy in
  // the second route is a copy that can drift" — this route was that second
  // copy. It is the rule the write path enforces, so the picker must offer
  // exactly it: a row this list shows and that guard refuses is a dead button,
  // and the reverse is a model the customer cannot reach.
  //
  // `scripts/gateway-pre-start.sh` keeps a third, hand-maintained mirror in
  // `_CODEX_SUPPORTED` (it runs before node exists), pinned by
  // src/tests/unit/gateway-pre-start-codex-models.test.ts. That one cannot
  // import; this one could, and now does.
  codex: CODEX_SUPPORTED_MODEL_RE,
};

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
  // The SAME single-flight guard the main path takes. This function publishes
  // to `<surfaceProvider>.json` like any other refresh, so without it a
  // `refreshInBackground(surfaceProvider)` arriving from a picker open could
  // run a second `openclaw models list` for that provider beside this one —
  // two multi-minute forks on a Jetson for one catalogue. Released in the
  // `finally` below, including on the error path.
  if (refreshing.has(surfaceProvider)) return null;
  refreshing.add(surfaceProvider);
  try {
    const { models } = await fetchOpenclawCatalog(surfaceProvider);
    if (models.length === 0) return null;
    // Through `buildPayload`, not hand-assembled beside it. The hand-built
    // version skipped `sanitizeCatalogModels`, the default resolution and
    // `ALLOW_CUSTOM_BY_PROVIDER` while writing to the very file the picker and
    // the server-side guard read back — a second, quieter way for this route to
    // persist something no other path would have produced.
    const payload: CatalogResponse = {
      ...buildPayload(surfaceProvider, models, null, Date.now()),
      source: "live",
    };
    memCache.set(surfaceProvider, payload);
    // Stamped like any other publish. Without it this provider is permanently
    // "not the current generation": `isStale` never clears, `warming` is true
    // whenever any fork is out, and every GET past the backoff re-enumerates a
    // catalogue that was just written.
    publishedSeq.set(surfaceProvider, currentSeq(surfaceProvider));
    recordSuccessfulRefresh(surfaceProvider);
    await writeDiskCache(surfaceProvider, payload);
    // The same count `publish` records. This is the file's second full publish
    // path, and a catalogue published here while the record still said zero
    // would keep a provider hidden that had just answered with rows. Dead
    // today — no `SUBSCRIPTION_SURFACE` entry names a separate provider — and
    // closed rather than left for the day one does, like every other rule this
    // function had to be taught twice.
    await recordProviderEnumeration(surfaceProvider, payload.models.length);
    return new Set(payload.models.map((m) => m.id));
  } catch (err) {
    console.warn(
      `[catalog] subscription surface (${surfaceProvider}) unavailable for ${provider}:`,
      err instanceof Error ? err.message : err,
    );
    recordFailedRefresh(surfaceProvider);
    return null;
  } finally {
    refreshing.delete(surfaceProvider);
    // The SECOND place that releases the guard, so it asks the same question
    // the main one does: does the current generation have an answer? A change
    // recorded while this provider was held only as somebody else's
    // subscription surface would otherwise sit unserved until an unrelated
    // fork happened along. Unreachable while SUBSCRIPTION_SURFACE names no
    // `surfaceProvider`, which is why it is closed here rather than left for
    // the day one is added.
    refreshInBackground(surfaceProvider, { serveCurrent: true });
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
  const out: CatalogModel[] = [];
  for (const entry of entries) {
    if (typeof entry.key !== "string") continue;
    const id = modelIdFromKey(entry.key);
    // Explicitly `false` only. `null`/absent is the harness saying it did not
    // determine one, and hiding a row over that would empty the picker on
    // exactly the boxes that have not finished setting up.
    if (entry.available === false) continue;
    // The only checks that read the ROW rather than the id; everything else is
    // `isOfferableModelId`, shared with the sanitiser.
    //
    // The `deprecated` TAG cannot fire on the pinned core and is kept only for
    // the day it can: `toModelRow` builds `tags` from configured entries and
    // aliases and never projects a model's lifecycle, so
    // `anthropic/claude-opus-4-8` — `status: "deprecated"` in the core's own
    // manifest — arrives here with `tags: []` (measured, 2026.8.1). The
    // lifecycle is read from where the core actually publishes it, at SERVE
    // time in `withoutRetiredModels` below — never here and never in the
    // sanitiser, so a payload an older build cached keeps every row this box
    // will still accept.
    if (entry.tags?.includes("deprecated")) continue;
    if (!isOfferableModelId(provider, id)) continue;
    out.push({
      id,
      label: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
      contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : 0,
      input: typeof entry.input === "string" ? entry.input : undefined,
      ...(entry.tags?.includes("default") ? { isDefault: true } : {}),
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

/**
 * Every rule that depends only on the model ID, in ONE place.
 *
 * Both the transform (which decides whether an enumeration answered at all)
 * and the payload sanitiser (which re-applies the current rules to a cached
 * payload) have to agree: a filter that decides what the box can run must not
 * differ between the path that publishes and the path that serves. They were
 * two hand-maintained copies, and every new rule had to be added to both.
 */
/**
 * Catalogues that publish a capability field, so the name-shaped modality guess
 * must not be applied to them: the field is the answer, and the guess can only
 * disagree with it. OpenRouter's `architecture.output_modalities` is read in
 * `outputIsRenderableChat` at transform time; every other catalogue this route
 * serves reports nothing of the sort.
 */
const MODALITY_REPORTING_PROVIDERS: ReadonlySet<string> = new Set(["openrouter"]);

function isOfferableModelId(provider: string, id: string): boolean {
  if (!id) return false;
  const allowed = ALLOWED_MODEL_RE_BY_PROVIDER[provider];
  if (allowed && !allowed.test(id)) return false;
  if (!MODALITY_REPORTING_PROVIDERS.has(provider) && isNonChatModelId(id)) return false;
  // Matched on the last path segment, like `isNonChatModelId`, because
  // OpenRouter ids keep their `<org>/` slug: tested against the whole id this
  // set could never fire for the largest catalogue we serve. Measured on the
  // live endpoint (423 rows, 2026-09-02) it changes nothing today — no row's
  // segment is one of these two, and none carries `deprecated: true` — so this
  // is the set doing what it says rather than a change in what is offered.
  if (DEPRECATED_MODEL_IDS.has(lastModelSegment(id))) return false;
  return true;
}

/**
 * The payload as the PICKER should see it: without the models the installed
 * core has retired.
 *
 * Applied when a payload is SERVED, never when one is stored, and that
 * distinction is the whole of it. `subscription-surface.ts` reads the cache
 * file back as the set of ids this box will ACCEPT — "a row the picker offers
 * must be a row that route accepts" — so filtering the stored payload would not
 * merely stop recommending a retired model, it would start REFUSING one the
 * customer is already on, with `… is not in the Anthropic model catalogue this
 * box enumerated`. That sentence would be untrue on both halves: the box did
 * enumerate it, and the core still routes it by exact reference. What we
 * recommend and what we accept are two questions, and only the first one has a
 * new answer.
 *
 * The default is re-resolved, because dropping rows can drop the one the
 * payload named — and a `defaultModelId` outside `models` is a picker with
 * nothing selected.
 *
 * ASYMMETRY, deliberate and worth naming: the lookup is keyed on the CATALOGUE
 * provider, and the core ships no `codex` extension — so the openai picker
 * loses `gpt-5.5` while the codex picker keeps it as its default. That is the
 * same upstream model, hidden on one auth mode and offered on the other, and it
 * is the behaviour we want today: the core's replacement, `gpt-5.6-sol`, is
 * plan-gated, and a Free ChatGPT account handed it as the only row AND as the
 * saved default would 400 on every turn. If a `codex` manifest ever appears, or
 * the mapping is "fixed" to consult openai's, that default moves silently —
 * which is what `curated-defaults-offerable.test.ts` is there to notice.
 */
function withoutRetiredModels(payload: CatalogResponse): CatalogResponse {
  // Resolved ONCE. A payload can run to hundreds of rows (the OpenRouter
  // catalogue was measured at 423), and asking per row would put one blocking
  // stat per row on the request thread.
  const retired = coreRetiredModels(payload.provider);
  if (retired.size === 0) return payload;
  const models = payload.models.filter((m) => !retired.has(m.id));
  if (models.length === payload.models.length) return payload;
  // Never to empty. If the core has retired everything this box enumerated,
  // the honest picker is the one the box actually has — an empty one offers
  // the customer nothing to do.
  if (models.length === 0) return payload;
  const defaultModelId = models.some((m) => m.id === payload.defaultModelId)
    ? payload.defaultModelId
    : (models.find((m) => m.isDefault)?.id ?? models[0].id);
  return { ...payload, models, defaultModelId };
}

function sanitizeCatalogModels(provider: string, models: CatalogModel[]): CatalogModel[] {
  return models.filter((model) => isOfferableModelId(provider, model.id));
}

/**
 * OpenRouter's own namespace — `openrouter/auto`, `openrouter/auto-beta` and
 * the other meta entries. A row here is a ROUTER, not a model, and the
 * modalities it declares are the union over everything it can route to: both
 * `auto` rows report `["image","text"]` output for that reason while routing
 * text prompts to text models. So the modality test below, which is a fact
 * about one model, does not apply to them.
 */
function isOpenRouterMetaModel(id: string): boolean {
  return id.startsWith("openrouter/");
}

/**
 * Is this row's OUTPUT something a chat picker can render?
 *
 * This is the capability answer the harness cannot give us: `openclaw models
 * list` publishes no capability field, so those catalogues fall back to the
 * name-shaped `isNonChatModelId`. OpenRouter DOES publish one, so it is read
 * here and the guess is not used at all for this catalogue.
 *
 * Measured against the live endpoint this route fetches (2026-09-02, 423 rows):
 * every row carries `output_modalities`; 408 are `["text"]`, 11 are
 * `["image","text"]` and 4 are `["audio","text"]`. Of the 15 non-text rows, 13
 * are real image/audio SKUs (`google/gemini-2.5-flash-image`,
 * `openai/gpt-5-image`, `google/lyria-3-pro-preview`, `openai/gpt-audio`, …)
 * that the name-shaped rule let through, and the other 2 are the meta routers
 * above. A row whose output includes image or audio is not something this chat
 * surface can show, so it is not offered.
 *
 * A row with no field at all is KEPT — absent is not "no", the same rule the
 * per-row `available` tristate follows.
 */
function outputIsRenderableChat(entry: OpenRouterListResponse["data"][number]): boolean {
  const outputs = entry.architecture?.output_modalities;
  if (!Array.isArray(outputs) || outputs.length === 0) return true;
  if (isOpenRouterMetaModel(entry.id)) return true;
  return outputs.every((modality) => modality === "text");
}

function transformOpenRouterEntries(entries: OpenRouterListResponse["data"]): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id) continue;
    if (entry.deprecated) continue;
    if (!outputIsRenderableChat(entry)) continue;
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

/**
 * The curated cold-start entry for one id, if the shipped list carries it.
 *
 * This is the ONLY thing the curated arrays contribute to a live row: a hint,
 * which no catalogue enumeration returns. Anything else — a label, a context
 * window, the existence of the row at all — comes from the device.
 */
function hintFor(provider: string, id: string): string | undefined {
  const hint = getProviderCatalog(provider)?.models.find((m) => m.id === id)?.hint;
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
  const staticEntry = getProviderCatalog(provider);
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
    // Zero, not a guess. A curated row has no MEASURED window — the device is
    // the only thing that reports one — and the table of hand-copied numbers
    // that used to sit here was read by nothing: the client drops the field on
    // a fallback row, and the comparator above is deliberately not applied to
    // this list. A number nobody reads is a number that silently goes stale.
    contextWindow: 0,
    hint: sm.hint,
  }));
}

function buildPayload(
  provider: string,
  models: CatalogModel[],
  surfaceIds?: Set<string> | null,
  // A parameter, because every caller overwrote the `Date.now()` this used to
  // stamp: only a live publish means "as of now".
  fetchedAt = 0,
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
  // The BOX's answer first. `openclaw models list` tags one row `default` per
  // provider, and preferring the curated default over it is the same defect
  // this change exists to fix, pointed at the default instead of the list: on a
  // stock 2026.8.1 host the curated table picks `gpt-5.4` while the box says
  // `gpt-5.6-sol`. `PROVIDER_CATALOGS` stays as the fallback for a catalogue
  // that tags nothing and for the curated cold-start rows, which carry no tag
  // at all — one table, the same one the picker renders.
  const fallbackDefault = getProviderCatalog(provider)?.defaultModelId;
  const defaultModelId = merged.find((m) => m.isDefault)?.id
    ?? merged.find((m) => m.id === fallbackDefault)?.id
    ?? merged[0]?.id
    ?? fallbackDefault
    ?? "";
  return {
    provider,
    models: merged,
    defaultModelId,
    allowCustom: ALLOW_CUSTOM_BY_PROVIDER[provider] ?? true,
    fetchedAt,
  };
}

/**
 * A payload built from the curated cold-start list. It carries no
 * `source: "live"` stamp — that absence IS the marking — and, the whole point,
 * is never handed to `writeDiskCache`.
 */
function buildFallbackPayload(provider: string): CatalogResponse {
  return buildPayload(provider, staticCatalogModels(provider));
}

/** Did a device enumeration produce this payload? See `CatalogResponse.source`. */
function isLivePayload(payload: CatalogResponse | null | undefined): boolean {
  return payload?.source === "live";
}

function sanitizeCachedPayload(provider: string, cached: CatalogResponse): CatalogResponse {
  return {
    ...buildPayload(provider, cached.models, null, cached.fetchedAt),
    stale: cached.stale,
    source: cached.source,
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

/**
 * Providers this route never asks `openclaw models list` about.
 *
 * Not "providers with no catalogue": openrouter enumerates over its own REST
 * endpoint, and clawai's two device tiers ARE the gateway's whole routing
 * table. Only codex has nothing to ask, because it is not a provider on this
 * core at all — see the note above. What the three share is that the CLI is
 * not the thing that answers for them, and naming that in one place keeps
 * "who is CLI-backed" a single fact: it was spelled as two inequalities in
 * one function and a separate branch in another.
 */
const NO_CLI_ENUMERATION_PROVIDERS: ReadonlySet<string> = new Set(["openrouter", "clawai", "codex"]);

/**
 * Of those three, the one with NOTHING to ask rather than something else to
 * ask. openrouter has a REST catalogue and clawai has its routing table; codex
 * has no enumeration on this core in any form, so unlike the other two it is
 * not merely CLI-exempt — no state the box can reach makes it listable, which
 * is why a provider-set change does not clear its backoff.
 */
function hasNoEnumerationOnThisCore(provider: string): boolean {
  return provider === "codex";
}

interface CatalogFetchResult {
  models: CatalogModel[];
  /**
   * Why an empty list was empty: the CLI's own `error.message` when it refused
   * the command, else its stderr. Empty when it simply had nothing to list.
   */
  diagnostic: string;
  /**
   * True when an empty `models` is THE BOX'S ANSWER rather than a failure to
   * get one: the CLI ran, refused nothing, and either listed no rows at all
   * (`count: 0`) or listed rows and marked every one of them
   * `available: false`.
   *
   * The distinction is the whole false-failure guard for TASK-668: a refusal, a
   * timeout, a plugin that is gone, or rows that our own chat-model filter ate
   * all produce an empty list too, and recording any of them as "this box can
   * run no <provider> model" would hide a provider that works. Only the clean
   * zero is recorded, and only it stops the row being offered.
   */
  emptyIsAnswer: boolean;
}

function toFetchResult(
  provider: string,
  parsed: OpenclawListResponse,
  stderr: string,
): CatalogFetchResult {
  // `Array.isArray`, not `?? []`: the type says this is a list, the JSON on the
  // other side is whatever the CLI printed, and a non-array here would be
  // iterated by `transformOpenclawEntries` and then `.filter`ed below. That
  // throw used to be swallowed by the chunk handler's partial-JSON `catch`
  // AFTER it had set `settled`, so the promise never settled, the `.finally`
  // never ran, and `refreshing` kept the provider for the process lifetime:
  // every later refresh returned at the single-flight guard and `warming`
  // stayed true, so the picker polled a fork that no longer existed. A
  // malformed payload is an empty enumeration, which this route already knows
  // how to report.
  const rows = Array.isArray(parsed.models) ? parsed.models : [];
  const models = transformOpenclawEntries(provider, rows);
  const refusal = parsed.ok === false ? parsed.error?.message?.trim() : "";
  let diagnostic = refusal || stderr.trim();
  // How many listed rows the harness did NOT say it cannot route.
  //
  // TRISTATE, and only `false` counts against a row — see the long note above
  // `transformOpenclawEntries`. `null`/absent is "the harness did not
  // determine", which is what an unconfigured provider answers, and counting
  // that as unavailable would write off every provider on a box that has not
  // finished being set up. Measured on the OpenClaw box (2026.8.1): with no
  // Google credential all ten google rows come back `available: null`, while
  // every deepseek row on the same box — that one is linked — comes back
  // `true`. So `false` is a statement and `null` is a shrug.
  const availableRows = rows.length - rows.filter((row) => row.available === false).length;
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
  // A clean zero: the command ran, said nothing was wrong, and STATED that it
  // has nothing — `count: 0` beside an empty `models`. Read positively rather
  // than inferred from absence, because a truncated or shape-shifted payload
  // parses into the same emptiness as a real answer and this verdict hides a
  // row. `diagnostic` covers the rest: a refusal or stderr fills it above, and
  // rows that were all filtered out by OUR chat rule fill it just now.
  //
  // STDERR IS NOT A FAILURE on these boxes, and requiring it to be empty made
  // this whole rule dead code on the ones that ship. Measured on the OpenClaw
  // box: every `openclaw models list` invocation, exit code 0, prints
  // `[agents/model-registry] model catalog load issue: … Provider openai, model
  // gpt-image-1-mini: no "api" specified` — a warning about an unrelated
  // provider's catalogue, on every provider's enumeration. With `!diagnostic`
  // in the condition, a genuine `count: 0` answer could never be recorded
  // there. What actually says the answer is untrustworthy is the CLI REFUSING
  // (`ok: false`, which it reports on stdout while still exiting 0) or the
  // process failing outright — and that second one rejects long before here.
  //
  // The positive statement is what is required instead: `count: 0` present in a
  // payload that parsed. A truncated or shape-shifted body has no count and is
  // still not an answer.
  //
  // TWO shapes of the same answer, and the second is the one that fires while
  // the CLI still has a catalogue to print: it listed rows and marked every one
  // of them `available: false`. Our own transform drops those rows, so `models`
  // is empty either way — what tells them apart from a failure is that the
  // command ran and refused nothing.
  const noRowsAtAll = rows.length === 0 && parsed.count === 0;
  const noRoutableRows = rows.length > 0 && availableRows === 0;
  const emptyIsAnswer = models.length === 0
    && parsed.ok !== false
    && !refusal
    && (noRowsAtAll || noRoutableRows);
  return { models, diagnostic, emptyIsAnswer };
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
      let parsed: OpenclawListResponse;
      try {
        parsed = JSON.parse(stdout) as OpenclawListResponse;
      } catch {
        // Partial JSON — keep accumulating. Only the PARSE is guarded here:
        // this `catch` used to wrap the settle as well, so anything the
        // transform threw was read as "not valid JSON yet" and swallowed —
        // after `finish` had already set `settled`, which left the promise
        // unsettled forever and the provider stuck in `refreshing`.
        return;
      }
      clearTimeout(timer);
      finish(() => {
        // A payload that parses but cannot be transformed is a refresh that
        // FAILED, not one that never ended: rejecting records the backoff and
        // releases the guard, the way the `close` handler already does for
        // output that is not JSON at all.
        try {
          resolve(toFetchResult(provider, parsed, stderr));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
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
  // Never an authoritative empty: this is openrouter.ai's catalogue, not this
  // box's answer about what it can route, and an empty `data` from a REST
  // endpoint is far more likely to be a bad hour upstream than a fact.
  return { models: transformOpenRouterEntries(data.data ?? []), diagnostic: "", emptyIsAnswer: false };
}

// Refresh the catalog for `provider` in the background. Returns
// immediately; the actual openclaw spawn / openrouter fetch runs out
// of band. Single-flight via `refreshing` so concurrent requests
// collapse to one fork. Exported so configure/route.ts can trigger a
// refresh right after the user adds an API key — otherwise the
// catalog stays on the pre-auth snapshot from boot warmup until the
// next service restart.
export function refreshInBackground(
  provider: string,
  opts: {
    /**
     * The PROVIDER SET changed — a connect, a plugin switched on, a credential
     * written — as opposed to a client polling for an answer. Clears the
     * failed-refresh backoff, because the condition that produced those
     * failures is the one that just changed.
     *
     * Set by `notifyProviderSetChanged` and by nothing else — go there for the
     * list of writes that count, which is the only place that list is kept. A
     * client's `?refresh=1` deliberately cannot set it; it asks for
     * `serveCurrent` instead.
     *
     * The fork rate stays bounded without the backoff here: `refreshing` admits
     * one enumeration per provider at a time, and every counting caller sits
     * behind a write the owner had to make.
     */
    providerChanged?: boolean;
    /**
     * "Make sure the CURRENT generation has an answer." Starts a fork only when
     * the published payload is behind `changeSeq`; never counts a change.
     *
     * This is what a client's `?refresh=1` is, and what the re-entries below
     * are. A client cannot know that the provider set changed — only the write
     * that changed it can — and treating its nudge as news is what let a
     * genuinely different change be mistaken for `configure`'s echo. It is
     * also what makes the nudge harmless: nothing to bump, no backoff to
     * clear, no running fork's work to discard.
     */
    serveCurrent?: boolean;
    /**
     * A CLIENT is looking at this provider and does NOT have the box's own
     * current answer — the curated fallback, a live list every current
     * sanitiser rule filters away, or one older than the refresh interval.
     *
     * Set by the GET handler, which has already computed exactly that three
     * lines above the call, and by nothing else. It counts no change and bumps
     * nothing; all it buys is one attempt against a recorded failure, no more
     * often than `CLIENT_RETRY_MIN_GAP_MS`.
     *
     * Deliberately NOT `isStale`: that includes `refreshFailedLast`, which is
     * true by construction whenever the wait is running, so gating on it would
     * fire for every blocked provider including one whose catalogue is
     * perfectly good.
     */
    clientHasNoCurrentAnswer?: boolean;
  } = {},
): void {
  // Providers that never touch the CLI (see NO_CLI_ENUMERATION_PROVIDERS);
  // every other one's catalog comes from `openclaw models list`. On an edition
  // without the binary (Hermes) that spawn is a guaranteed ENOENT.
  const usesOpenclawCli = !NO_CLI_ENUMERATION_PROVIDERS.has(provider);
  const cliMissing = usesOpenclawCli && openclawIsAbsent();

  // "Could any change to this box make this provider enumerable?" Two say no
  // for reasons no credential touches: `codex` is not a provider on this core
  // at all (see the note above NO_CLI_ENUMERATION_PROVIDERS), and an edition
  // without the CLI has nothing to ask. Clearing the wait for either would only
  // reprint their one log line on every `?refresh=1` the picker sends, which is
  // the property that log line's own comment claims.
  const changeCouldMakeItEnumerable = !hasNoEnumerationOnThisCore(provider) && !cliMissing;

  // A SERVER-SIDE WRITE changed the provider set. Every such write counts, and
  // they all arrive through `notifyProviderSetChanged` (see its docblock for
  // which writes those are) — which is what makes the generation trustworthy
  // enough for the client's nudge to be demoted.
  //
  // There is deliberately no "is this the same change twice" test here any
  // more. The predicate that used to do it read the SHAPE of the fork in
  // flight — change-started, current generation — and so could not tell
  // `configure`'s echo from a second, genuinely different change 30 seconds
  // later: both landed on the identical branch, and the second was dropped
  // with no bump and no re-entry, after which the pre-change fork published as
  // the current generation and nothing re-enumerated for six hours. One write
  // is one bump; two writes are two generations; a client nudge is neither.
  if (opts.providerChanged === true && changeCouldMakeItEnumerable) {
    changeSeq.set(provider, currentSeq(provider) + 1);
    // The condition that produced any recorded failure is the one that just
    // changed, so the next attempt must not be made to wait it out. Cleared
    // here rather than after the single-flight check, because the fork in
    // flight is about to be discarded and it is the re-entry that needs the
    // wait gone. The client-retry gap goes with it, for the same reason: it
    // describes a box that no longer exists.
    clearFailedRefresh(provider);
    clientRetryAt.delete(provider);
  }

  // Nothing to do: the answer on file is already for the box as it is.
  if (opts.serveCurrent === true && publishedIsCurrent(provider)) return;

  if (refreshing.has(provider)) return;
  // Somebody is looking at a catalogue that is not the box's own current
  // answer, and the box has decided to wait. Spend one attempt.
  //
  // NOT for the two providers that can never enumerate here: `cliMissing` and
  // the no-enumeration-on-this-core case both `recordFailedRefresh` precisely
  // so their one log line appears once per backoff window instead of once per
  // picker open, and `changeCouldMakeItEnumerable` is the question they
  // already answer.
  //
  // NOT while anything else is enumerating. `refreshing` is per-provider, so
  // it is the only concurrency discipline this file has apart from
  // `bootWarmup`'s 5 s stagger — and the wizard's provider list re-runs
  // `useProviderCatalog` on every click, so a walk down anthropic → openai →
  // google could otherwise start three ~2-core, ~3-minute forks at once on an
  // Orin. Leaving it unspent is also the honest answer: something IS on its
  // way, and the response says `warming`.
  //
  // The wait is LIFTED, not cleared: `clearFailedRefresh` deletes the entry
  // and `recordFailedRefresh` then restarts the doubling from its two-minute
  // floor, so a provider that had climbed to the six-hour cap would re-climb
  // it through eight more picker-driven forks — and `refreshFailedLast` would
  // go false for the length of the retry, dropping the `stale` flag off a
  // payload no device produced. Expiring the deadline while keeping the window
  // it had reached does neither.
  if (
    opts.clientHasNoCurrentAnswer === true
    && changeCouldMakeItEnumerable
    && refreshing.size === 0
    && refreshIsBlocked(provider)
    && clientRetryIsDue(provider)
  ) {
    clientRetryAt.set(provider, Date.now());
    const failure = failedRefreshes.get(provider);
    if (failure) failedRefreshes.set(provider, { until: 0, waitMs: failure.waitMs });
    console.log(`[catalog] ${provider}: a client is waiting on a fallback list, retrying once`);
  }
  if (refreshIsBlocked(provider)) return;

  // Skip a missing binary cleanly rather than fork it for each provider on
  // every boot warmup. Hermes surfaces its own model list through the Hermes
  // dashboard, not here.
  if (cliMissing) {
    console.log(`[catalog] skipping ${provider}: the openclaw CLI is not present on this edition`);
    // Recorded as a failed attempt so the line above appears once per backoff
    // window instead of once per picker open: on this edition it can never
    // succeed, and it is the one branch that is guaranteed to repeat.
    recordFailedRefresh(provider);
    return;
  }

  refreshing.add(provider);
  // Captured at START, because that is when the box this fork reads is fixed.
  const forkSeq = currentSeq(provider);

  if (hasNoEnumerationOnThisCore(provider)) {
    // Documented above: this core has no ChatGPT-surface enumeration, and the
    // CLI answers `Unknown provider filter "codex"`. Forking a whole openclaw
    // process on a Jetson to be told that again — at every boot, and once per
    // backoff window after — buys a log line whose content is already written
    // down here. The picker gets the curated list marked `fallback`.
    console.log(`[catalog] ${provider}: no enumeration on this core, serving the curated list`);
    recordFailedRefresh(provider);
    refreshing.delete(provider);
    return;
  }

  let fetcher: Promise<CatalogFetchResult>;
  if (provider === "openrouter") {
    fetcher = fetchOpenRouterCatalog();
  } else if (provider === "clawai") {
    // The only catalogue with no upstream to ask: Mike's gateway routes the
    // two device tiers and nothing else, so these two rows ARE the device's
    // answer rather than a stand-in for one.
    fetcher = Promise.resolve({ models: CLAWAI_STATIC_MODELS, diagnostic: "", emptyIsAnswer: false });
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
  // `.catch` attached HERE, not minutes later in the `.finally`. Node's default
  // `--unhandled-rejections=throw` kills the process on a rejection that is
  // unhandled at the end of its turn, and the window between creating this and
  // the `.finally` touching it is as wide as the enumeration. Unreachable
  // today — the function returns before it can throw — but the `finally` block
  // inside it is not itself inside a `try`.
  const surface = fetchSubscriptionSurfaceIds(provider).catch(() => null);

  const publish = async (models: CatalogModel[], surfaceIds: Set<string> | null) => {
    // The CLI answered, so the provider is enumerable — that much is true
    // whatever generation this is, and it is what the backoff tracks.
    recordSuccessfulRefresh(provider);

    if (forkSeq < currentSeq(provider)) {
      // The box changed after this fork started. What it is holding is the
      // answer for a box that no longer exists — on the connect path, the
      // PRE-credential list: one openai row where the linked box lists ten.
      // Serving it would be this route's own false success, and stamping it
      // `source: "live"` with a fresh `fetchedAt` is what made the previous
      // build sit on it. The replacement follows on its own: `publishedSeq`
      // stays behind `changeSeq`, and the `.finally` below asks for the
      // current generation.
      console.log(
        `[catalog] discarding ${provider}: ${models.length} models from before the provider changed`
        + ` (generation ${forkSeq} < ${currentSeq(provider)}), re-enumerating`,
      );
      return;
    }

    const payload: CatalogResponse = {
      ...buildPayload(provider, models, surfaceIds, Date.now()),
      source: "live",
    };
    memCache.set(provider, payload);
    publishedSeq.set(provider, forkSeq);
    await writeDiskCache(provider, payload);
    // What the box can run, for the surfaces that only need the COUNT (the
    // Providers rows, the picker). Written from the published list rather than
    // the raw one, so the number and the catalogue the picker is offered cannot
    // disagree. Reached only past the generation guard above, so a fork from
    // before the box changed records nothing.
    await recordProviderEnumeration(provider, payload.models.length);
    console.log(
      `[catalog] refreshed ${provider}: ${models.length} models`
      + (surfaceIds ? ` (${surfaceIds.size} on the subscription surface)` : ""),
    );
  };

  /**
   * Keep whatever good payload this box already has, and record the failure —
   * which both makes the next attempt wait and marks the provider stale, since
   * `refreshFailedLast` reads the same map GET consults.
   *
   * Recorded in that map rather than stamped on the cached payload, because at
   * boot warmup there is no cached payload to stamp. Nothing is written to
   * disk either: the file there is the last answer a device actually gave, and
   * rewriting it would spend a write to record that a LATER attempt failed.
   */
  const markStale = () => {
    recordFailedRefresh(provider);
  };

  fetcher
    .then(async ({ models, diagnostic, emptyIsAnswer }) => {
      if (models.length === 0) {
        // NOT a success, and every line of beta's handling stands: nothing is
        // published, the previous catalogue is kept, and `markStale` records
        // the backoff that rations the retries. "[catalog] refreshed codex: 0
        // models" used to be followed by a disk write of the curated list,
        // which then read back as a device answer.
        //
        // What is NEW is only that a clean zero is written down as a COUNT
        // (TASK-668). Under `models.mode: "replace"` the core skips the
        // authenticated catalogue and `openclaw models list --provider google`
        // genuinely lists nothing, and the surfaces need to know that to stop
        // offering a connected provider whose every row the gateway refuses.
        // It changes no freshness or backoff rule: this branch behaves exactly
        // as it does on beta, and the record is an extra fact beside it.
        //
        // Generation-guarded like `publish` is, and for the same reason: a fork
        // that started before a credential landed is answering about a box that
        // no longer exists, and its zero would hide the provider the customer
        // just connected.
        if (emptyIsAnswer && forkSeq >= currentSeq(provider)) {
          await recordProviderEnumeration(provider, 0);
        }
        console.warn(
          `[catalog] ${provider}: live enumeration returned no models, keeping the previous catalogue`
          + (diagnostic ? ` — ${diagnostic.slice(-300)}` : " (the CLI gave no reason)"),
        );
        markStale();
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
    .finally(async () => {
      // The guard is released only once BOTH forks are settled, and it is
      // released here rather than in each arm above because the arms that end
      // early — an empty enumeration, a rejection — are exactly the ones that
      // used to forget. For a provider with a genuinely narrower surface the
      // surface enumeration is a second multi-minute `openclaw models list`,
      // and releasing while it still holds ~2 cores of a Jetson lets the next
      // request start a second MAIN enumeration beside it.
      //
      // Already carries its own handler (see where it is created), so this is
      // just "wait for it".
      await surface;
      refreshing.delete(provider);
      // "Does the current generation have an answer?" — asked once, here, on
      // every path. A fork that published for the current generation makes this
      // a no-op; one that was discarded, failed, or was superseded while it ran
      // leaves the generation unanswered and this starts its replacement. No
      // pending set to keep in step with the release: the counter IS the record.
      refreshInBackground(provider, { serveCurrent: true });
    });
}

/**
 * "A server-side write just changed the provider set for `ocProvider`."
 *
 * The ONE entry point for every route that mutates the provider set, so the
 * openclaw-side id mapping and the two "is this a change this route can act
 * on?" tests exist once rather than once per caller. `ocProvider` is the
 * openclaw id (`anthropic`, `openai`, `codex`, `google`, `deepseek`); the
 * catalogue calls ClawBox AI `clawai`.
 *
 * Two kinds of provider are dropped here rather than at each call site:
 *
 *  * one that is not in the catalogue at all (local-only, llamacpp);
 *  * one whose catalogue THIS BOX CANNOT CHANGE. `openrouter` is fetched from
 *    openrouter.ai, `clawai` is a constant and `codex` has no enumeration, so
 *    no write on the box can alter what any of them lists. Counting one would
 *    discard whatever fetch is in flight, re-run it for the identical answer,
 *    and clear the failed-refresh backoff — announcing a change that, for that
 *    provider, did not happen. The compat auto-extend in `chat/model` writes
 *    `models.providers.openrouter.models` on exactly this path.
 *
 * Counting the change server-side is what lets the client's `?refresh=1` be a
 * nudge instead of a claim — see `refreshInBackground`. A write that forgets to
 * call this leaves its change invisible to the catalogue until the 6h refresh.
 *
 * Its callers, which are every server-side write that can change what
 * `openclaw models list` answers: `configure` step 8c (credential + plugin) and
 * its `setProviderPlugins` result; `chat/model`'s compat auto-extend, its
 * `setProviderPlugins` result and the ON half of the same gate; and the
 * Local-only restore in `local-ai/exclusive`. `providers/default` inherits
 * `chat/model`'s on OpenClaw.
 */
export function notifyProviderSetChanged(ocProvider: string | null | undefined): void {
  if (!ocProvider) return;
  const catalogProvider = ocProvider === "deepseek" ? "clawai" : ocProvider;
  // The recorded model COUNT is about the box as it was, and the box has just
  // changed (TASK-668). Forgetting it is what makes a hidden row come back on
  // the next render — a plan change, a model install, a key paste — without
  // waiting for an enumeration that, for a hidden provider, nothing would ask
  // for. It costs one small file write and starts nothing.
  void forgetProviderEnumeration(catalogProvider);
  if (!isCatalogProvider(catalogProvider)) return;
  if (NO_CLI_ENUMERATION_PROVIDERS.has(catalogProvider)) return;
  refreshInBackground(catalogProvider, { providerChanged: true });
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

  // Sanitised BEFORE freshness is judged, because the sanitiser is what decides
  // how many rows this response actually carries. A live, under-6h payload
  // whose every row the CURRENT rules filter out is served as `models: []` —
  // and judged on the raw cache it looked fresh, live and unfailed, so nothing
  // re-enumerated and the picker sat on the curated list. That state arrives
  // the first time a filter is tightened, which is exactly what this branch
  // just did to the previous generation of caches.
  const sanitized = cached ? sanitizeCachedPayload(provider, cached) : null;
  const servedEmpty = sanitized !== null && sanitized.models.length === 0;

  const ageMs = cached ? Date.now() - cached.fetchedAt : Infinity;
  const isStale = ageMs > REFRESH_INTERVAL_MS
    || cached?.stale === true
    || refreshFailedLast(provider)
    || servedEmpty
    // The box changed after the payload we hold was enumerated. Age says
    // nothing about that: the pre-connect answer is seconds old and wrong.
    || !publishedIsCurrent(provider);
  // A payload no device produced is a reason to ask AGAIN, not a reason to
  // wait six hours. That includes a cache written before `source` existed —
  // on an upgraded box those files hold the curated list a failed enumeration
  // left behind, and nothing else would ever dislodge them.
  if (isStale || !isLivePayload(cached)) {
    // On THIS branch and not only on the nudge below: a cold process whose
    // boot warmup failed lands here, never on `serveCurrent`, and the plain
    // picker open carries no `?refresh=1` at all (TASK-669).
    //
    // The flag is the question this handler has already answered — is what we
    // are about to serve the box's own current answer? — rather than a second
    // derivation of half of it. `servedEmpty` is a live payload the current
    // sanitiser rules empty out, which is exactly the state that arrives the
    // first time a filter is tightened; the age term is the box that was off
    // for three weeks. In both the client is looking at the curated list.
    refreshInBackground(provider, {
      clientHasNoCurrentAnswer: !isLivePayload(cached)
        || servedEmpty
        || ageMs > REFRESH_INTERVAL_MS
        // The box changed after this payload was enumerated, and the fork that
        // change started has already failed. `notifyProviderSetChanged` cleared
        // the wait and forked; when that fork fails, the wait is back and every
        // later request is blocked — so without this term a picker sits on the
        // PRE-change list, seconds old and live, for the whole window.
        || !publishedIsCurrent(provider),
    });
  } else if (force) {
    // `?refresh=1` is a NUDGE, not news. The client cannot know the provider
    // set changed — only the write that changed it can, and every such write
    // now counts it — so this asks whether the current generation has an
    // answer and stops there. It used to say `providerChanged`, which let a
    // client bump the generation, clear the backoff, and discard a running
    // fork's three minutes of work; and it made a real change arriving in the
    // same window indistinguishable from this one.
    refreshInBackground(provider, { serveCurrent: true });
  }

  // "An answer is actually on its way" — the ONE thing that tells a client
  // whether coming back is worth anything. A provider under the failed-refresh
  // backoff has no enumeration running and will not get one soon, so it is not
  // warming and a picker must not sit there polling for it; the cold start,
  // where a fork really is out there, is.
  const enumerating = refreshing.has(provider);

  if (cached && sanitized) {
    memCache.set(provider, sanitized);
    const payload: CatalogResponse = {
      ...sanitized,
      ...(isStale ? { stale: true } : {}),
      // `warming` means "asking again is worth something", so it is true
      // whenever a fork is out there AND what this response carries is not the
      // answer that fork will bring:
      //  * the payload is not a device's (cold start, upgraded cache);
      //  * the sanitiser emptied it, so the client is about to render the
      //    curated rows instead;
      //  * the box has CHANGED since this payload was enumerated — even a live
      //    one is then the pre-change answer. Read from the generation rather
      //    than from `force`, which was true for exactly one response (the
      //    single `?refresh=1` the hook sends per signal); its next poll two
      //    seconds later saw `warming: false` with three minutes of enumeration
      //    still to run, so a picker open across a connect settled on the
      //    pre-change rows. The generation stays behind until the fork that
      //    answers for the new box actually publishes.
      // The plain 6h refresh passes none of these, which is what keeps every
      // mounted picker from polling through it.
      ...(enumerating && (!isLivePayload(cached) || servedEmpty || !publishedIsCurrent(provider))
        ? { warming: true }
        : {}),
    };
    return NextResponse.json(withoutRetiredModels(payload), { headers: noStore() });
  }

  // Nothing cached yet — the first picker open after a restart. Serve the
  // curated list so the picker is not blank; it carries no `source`, which is
  // how the client knows what it is holding.
  const payload: CatalogResponse = {
    ...buildFallbackPayload(provider),
    ...(enumerating ? { warming: true } : {}),
  };
  return NextResponse.json(withoutRetiredModels(payload), { headers: noStore() });
}
