import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fsp } from "fs";
import path from "path";
import { findOpenclawBin } from "@/lib/openclaw-config";
import { DATA_DIR } from "@/lib/config-store";
import { CATALOG_PROVIDERS, isCatalogProvider } from "@/lib/provider-models";

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
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  "openai-codex": "gpt-5.4",
  google: "gemini-2.5-flash",
  openrouter: "anthropic/claude-haiku-4.5",
};

// ClawBox AI catalog is hardcoded — Mike's gateway routes via DeepSeek
// upstream but the only end-user-pickable variants are the two device
// tiers (Flash + Pro), gated by subscription. Skipping the openclaw
// spawn for clawai also dodges the 3-min CLI execution time on Jetson.
const CLAWAI_STATIC_MODELS: CatalogModel[] = [
  {
    id: "deepseek-v4-flash",
    label: "Free/Pro Tier",
    contextWindow: 128_000,
    input: "text+image",
    hint: "Default. Faster.",
  },
  {
    id: "deepseek-v4-pro",
    label: "Max Tier",
    contextWindow: 128_000,
    input: "text+image",
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

// Per-provider allowlist regex. When set, only model ids matching the
// pattern survive the catalog filter. Used to curate noisy upstream
// catalogs down to a useful set without the picker exploding to 40+
// entries the user has to scroll past.
//
// openai (API-key auth): all 5.4 + 5.5 SKUs including -pro variants.
//   Pros require an API key and DO work on the api.openai.com path.
//
// openai-codex (ChatGPT-account auth): 5.4, 5.4-mini, 5.5 only — NO
//   -pro variants. Per developers.openai.com/codex/models, the Pro
//   models are API-key-only and the Codex/ChatGPT-account auth path
//   400s with "model not supported when using Codex with a ChatGPT
//   account" if you try gpt-5.4-pro or gpt-5.5-pro.
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
  // ChatGPT-account auth is exactly gpt-5.4, gpt-5.4-mini, gpt-5.5.
  "openai-codex": /^(?:gpt-5\.5|gpt-5\.4(?:-mini)?)$/,
};

// Newest-first ordering: bigger context generally means newer model on
// every catalog we ship today (claude 200k+, gpt-5 400k, gemini 1M).
// Fall back to alpha when contextWindow is unknown/equal so the list
// stays stable on re-fetch.
function compareCatalogModels(a: CatalogModel, b: CatalogModel): number {
  if (a.contextWindow !== b.contextWindow) return b.contextWindow - a.contextWindow;
  return a.label.localeCompare(b.label);
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

function buildPayload(provider: string, models: CatalogModel[]): CatalogResponse {
  const fallbackDefault = DEFAULT_MODEL_BY_PROVIDER[provider];
  const defaultModelId = models.find((m) => m.id === fallbackDefault)?.id
    ?? models[0]?.id
    ?? fallbackDefault
    ?? "";
  return {
    provider,
    models,
    defaultModelId,
    allowCustom: ALLOW_CUSTOM_BY_PROVIDER[provider] ?? true,
    fetchedAt: Date.now(),
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
// collapse to one fork.
function refreshInBackground(provider: string): void {
  if (refreshing.has(provider)) return;
  refreshing.add(provider);

  let fetcher: Promise<CatalogModel[]>;
  if (provider === "openrouter") {
    fetcher = fetchOpenRouterCatalog();
  } else if (provider === "clawai") {
    fetcher = Promise.resolve(CLAWAI_STATIC_MODELS);
  } else {
    fetcher = fetchOpenclawCatalog(provider);
  }

  fetcher
    .then(async (models) => {
      const payload = buildPayload(provider, models);
      memCache.set(provider, payload);
      await writeDiskCache(provider, payload);
      console.log(`[catalog] refreshed ${provider}: ${models.length} models`);
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
    const payload: CatalogResponse = isStale ? { ...cached, stale: true } : cached;
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
