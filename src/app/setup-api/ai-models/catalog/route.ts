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
// * If both caches are empty (fresh install, first picker open), we
//   return an empty payload with `warming: true`. The client then
//   falls back to the static catalog in src/lib/provider-models.ts.
//
// Force-refresh via `?refresh=1` triggers a refresh in the background
// and serves whatever's currently cached — the user never waits.

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
  /** Set when neither cache has anything yet — client falls back to static catalog. */
  warming?: boolean;
}

// Process-local hot cache. Survives request boundaries within a single
// node process; lost on restart (disk cache covers that).
const memCache = new Map<string, CatalogResponse>();
// Single-flight guard so two concurrent requests don't both fork openclaw.
const refreshing = new Set<string>();

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
  models: Array<{
    key: string;
    name?: string;
    input?: string;
    contextWindow?: number;
    local?: boolean;
    tags?: string[];
  }>;
}

// `openclaw models list` also returns an `available` boolean per model. It is
// deliberately NOT read here: it answers "can THIS box's currently-configured
// credentials route this model", and during setup no credential is written
// yet, so every entry comes back false. Gating the picker on it would empty
// the list at exactly the moment the customer needs it. The auth-mode surface
// (SUBSCRIPTION_SURFACE) is the part that IS knowable in the wizard, and it is
// what this route stamps instead.
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
// pattern survive the catalog filter. Used to curate noisy upstream
// catalogs down to a useful set without the picker exploding to 40+
// entries the user has to scroll past.
//
// openai (API-key auth): all 5.4 + 5.5 SKUs including -pro variants.
//   Pros require an API key and DO work on the api.openai.com path.
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
// Older generations (4.1, 5.0, 5.1, 5.2, 5.3) are intentionally
// excluded per user request. New generations matching the pattern
// (e.g. a future gpt-5.6) will auto-appear; new families (gpt-6) will
// require updating the regex.
const ALLOWED_MODEL_RE_BY_PROVIDER: Record<string, RegExp> = {
  openai: /^gpt-5\.[45](-pro|-mini)?$/,
  // Explicit alternation, not /^gpt-5\.[45](-mini)?$/ — that would also
  // accept gpt-5.5-mini (which doesn't exist on the Codex auth path
  // and would 400 the same way gpt-5.4-pro did). Per
  // developers.openai.com/codex/models the supported set under
  // ChatGPT-account auth is gpt-5.4, gpt-5.4-mini, gpt-5.5, plus the
  // gpt-5.6-{sol,terra,luna} models (plan-gated upstream, so they only
  // appear in the live catalog for accounts entitled to them).
  codex: /^(?:gpt-5\.5|gpt-5\.4(?:-mini)?|gpt-5\.6-(?:sol|terra|luna))$/,
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
  try {
    const models = await fetchOpenclawCatalog(surfaceProvider);
    if (models.length === 0) return null;
    const payload: CatalogResponse = {
      provider: surfaceProvider,
      models,
      defaultModelId: models[0].id,
      allowCustom: false,
      fetchedAt: Date.now(),
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

function transformOpenclawEntries(
  provider: string,
  entries: OpenclawListResponse["models"],
): CatalogModel[] {
  const allowed = ALLOWED_MODEL_RE_BY_PROVIDER[provider];
  const out: CatalogModel[] = [];
  for (const entry of entries) {
    if (typeof entry.key !== "string") continue;
    const idPrefix = `${provider}/`;
    const id = entry.key.startsWith(idPrefix)
      ? entry.key.slice(idPrefix.length)
      : entry.key;
    if (!id) continue;
    if (entry.tags?.includes("deprecated")) continue;
    if (DEPRECATED_MODEL_IDS.has(id)) continue;
    if (allowed && !allowed.test(id)) continue;
    out.push({
      id,
      label: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
      contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : 0,
      input: typeof entry.input === "string" ? entry.input : undefined,
    });
  }
  out.sort(compareCatalogModels);
  return out;
}

function isAllowedCatalogModel(provider: string, model: CatalogModel): boolean {
  if (!model.id) return false;
  const allowed = ALLOWED_MODEL_RE_BY_PROVIDER[provider];
  if (allowed && !allowed.test(model.id)) return false;
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

// Context-window lookup for static-catalog entries we know about but the
// live upstream enumeration didn't return. Values from each provider's
// official model docs. Used only as a fallback for `augmentWithStaticCatalog`;
// when the live catalog includes the same id its real contextWindow wins.
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

// Merge the curated static list from PROVIDER_CATALOGS into the live
// upstream models. Live entries take precedence (their contextWindow /
// input / label reflect what the gateway actually negotiated). Static
// entries with ids the live list doesn't include get appended — this
// covers the case where a provider's OAuth scope returns a single
// deprecated model (Anthropic Claude.ai consumer OAuth is the live
// example: the docs list claude-opus-5 / claude-sonnet-5 /
// claude-haiku-4-5 as current, but `openclaw models list --provider
// anthropic` on a Claude.ai-OAuth device only returns the deprecated
// claude-sonnet-4-20250514). The picker would otherwise force the
// user to type custom model ids by hand.
function augmentWithStaticCatalog(provider: string, live: CatalogModel[]): CatalogModel[] {
  if (!isCatalogProvider(provider)) return live;
  const staticEntry = PROVIDER_CATALOGS[provider];
  if (!staticEntry) return live;
  const liveIds = new Set(live.map((m) => m.id));
  const augmented: CatalogModel[] = [...live];
  for (const sm of staticEntry.models) {
    if (liveIds.has(sm.id)) continue;
    augmented.push({
      id: sm.id,
      label: sm.label,
      contextWindow: STATIC_MODEL_CONTEXT_WINDOWS[sm.id] ?? 200_000,
      hint: sm.hint,
    });
  }
  augmented.sort(compareCatalogModels);
  return augmented;
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
  let merged = sanitizeCatalogModels(provider, augmentWithStaticCatalog(provider, models));
  // Stamped HERE, on the merged list, not on the live one: the curated
  // entries `augmentWithStaticCatalog` appends exist precisely for the case
  // where the live enumeration came back thin, and an unstamped curated entry
  // (ANTHROPIC_MODELS carries claude-haiku-4-5, which the subscription
  // surface does not) would be offered as pickable in exactly the scenario
  // this stamp was built for.
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

function sanitizeCachedPayload(provider: string, cached: CatalogResponse): CatalogResponse {
  const next = buildPayload(provider, cached.models);
  return {
    ...next,
    fetchedAt: cached.fetchedAt,
    stale: cached.stale,
    warming: cached.warming,
  };
}

function fetchOpenclawCatalog(provider: string): Promise<CatalogModel[]> {
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
        finish(() => resolve(transformOpenclawEntries(provider, parsed.models ?? [])));
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
          resolve(transformOpenclawEntries(provider, parsed.models ?? []));
        } catch {
          reject(new Error(`openclaw produced non-JSON output: ${stdout.slice(0, 200)}`));
        }
      });
    });
  });
}

async function fetchOpenRouterCatalog(): Promise<CatalogModel[]> {
  const res = await fetch(OPENROUTER_API, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}`);
  }
  const data = (await res.json()) as OpenRouterListResponse;
  return transformOpenRouterEntries(data.data ?? []);
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

  // OpenRouter (REST) and ClawBox AI (static) never touch the CLI; every other
  // provider's catalog comes from `openclaw models list`. On an edition without
  // the binary (Hermes) that spawn is a guaranteed ENOENT, so skip it cleanly
  // rather than fork a missing binary for each provider on every boot warmup.
  // Hermes surfaces its own model list through the Hermes dashboard, not here.
  const usesOpenclawCli = provider !== "openrouter" && provider !== "clawai";
  if (usesOpenclawCli && openclawIsAbsent()) {
    console.log(`[catalog] skipping ${provider}: the openclaw CLI is not present on this edition`);
    return;
  }

  refreshing.add(provider);

  let fetcher: Promise<CatalogModel[]>;
  if (provider === "openrouter") {
    fetcher = fetchOpenRouterCatalog();
  } else if (provider === "clawai") {
    fetcher = Promise.resolve(CLAWAI_STATIC_MODELS);
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
    const payload = buildPayload(provider, models, surfaceIds);
    memCache.set(provider, payload);
    await writeDiskCache(provider, payload);
    console.log(
      `[catalog] refreshed ${provider}: ${models.length} models`
      + (surfaceIds ? ` (${surfaceIds.size} on the subscription surface)` : ""),
    );
  };

  fetcher
    .then(async (models) => {
      await publish(models, null);
      const surfaceIds = await surface;
      if (surfaceIds) await publish(models, surfaceIds);
    })
    .catch((err: unknown) => {
      console.error(`[catalog] refresh failed for ${provider}:`, err instanceof Error ? err.message : err);
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
  const isStale = ageMs > REFRESH_INTERVAL_MS;
  if (force || isStale || !cached) {
    refreshInBackground(provider);
  }

  if (cached) {
    const sanitized = sanitizeCachedPayload(provider, cached);
    memCache.set(provider, sanitized);
    const payload: CatalogResponse = isStale ? { ...sanitized, stale: true } : sanitized;
    return NextResponse.json(payload, { headers: noStore() });
  }

  // No cache anywhere yet. The client picker falls back to the static
  // catalog in src/lib/provider-models.ts when models[] is empty.
  const empty: CatalogResponse = {
    provider,
    models: [],
    defaultModelId: DEFAULT_MODEL_BY_PROVIDER[provider] ?? "",
    allowCustom: ALLOW_CUSTOM_BY_PROVIDER[provider] ?? true,
    fetchedAt: 0,
    warming: true,
  };
  return NextResponse.json(empty, { headers: noStore() });
}
