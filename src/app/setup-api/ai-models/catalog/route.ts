import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { findOpenclawBin } from "@/lib/openclaw-config";
import { CATALOG_PROVIDERS, isCatalogProvider } from "@/lib/provider-models";

export const dynamic = "force-dynamic";

// /setup-api/ai-models/catalog?provider=<id>
//
// Single source of truth for the AI-provider model dropdowns.
// Replaces the hand-curated arrays that used to live in
// src/lib/openrouter-models.ts and src/lib/provider-models.ts and rotted
// every time an upstream rename/deprecation shipped.
//
// Strategy:
// * For every provider OpenClaw has a built-in catalog for (anthropic,
//   openai, openai-codex, google, …), we shell out to
//   `openclaw models list --provider <p> --all --json`. That's the same
//   list the gateway will accept at chat time, so a user-pickable model
//   from the dropdown is by construction routeable.
// * For OpenRouter we hit OpenRouter's own /api/v1/models endpoint
//   directly. OpenClaw's `models list --provider openrouter` only
//   surfaces models that are already configured locally (~2 entries on
//   a fresh device), which is useless for picker UX. The live OpenRouter
//   catalog has 340+ models and we trim/sort for popularity ourselves.
//
// Both paths cache for `CACHE_TTL_MS` so reopening the picker doesn't
// re-fork openclaw or re-fetch from the network. Errors are *not*
// cached — a transient failure shouldn't stick a 500 in front of the
// user for the next 10 minutes.

const OPENCLAW_BIN = findOpenclawBin();
const COMMAND_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60_000;
const OPENROUTER_API = "https://openrouter.ai/api/v1/models";

interface CatalogModel {
  /** Provider-native id (no `<provider>/` prefix). For openrouter this
   * keeps the `<org>/<model>` shape since that *is* the openrouter slug. */
  id: string;
  /** Friendly display name from the upstream catalog. */
  label: string;
  /** Optional short hint for the dropdown row. */
  hint?: string;
  /** Context window in tokens (0 if unknown). Used for sorting / display. */
  contextWindow: number;
  /** Modalities (e.g. "text+image"). Optional, surfaced as a small badge. */
  input?: string;
}

interface CatalogResponse {
  provider: string;
  models: CatalogModel[];
  defaultModelId: string;
  /** Whether the user may type a model id outside this list. */
  allowCustom: boolean;
  /** ms since-epoch when this list was fetched (cache visibility for the UI). */
  fetchedAt: number;
}

interface CacheEntry {
  expiresAt: number;
  payload: CatalogResponse;
}

// Map from provider id → most recent successful payload.
const cache = new Map<string, CacheEntry>();
// In-flight builds keyed by provider so a thundering herd of concurrent
// cold-start requests (wizard + chat popup + status poll all mounting at
// once) collapses to a single child-process spawn / OpenRouter fetch.
// Cleared on settle.
const inFlight = new Map<string, Promise<CatalogResponse>>();

// Defaults applied when the upstream catalog doesn't ship a "preferred"
// signal. Picked to match the previous static-array defaults so existing
// auto-fill logic (configure route, chat-header summary) stays stable
// when the catalog is empty / network is down. Keys must be a subset of
// CATALOG_PROVIDERS — adding a provider there means seeding a default
// here too.
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5",
  "openai-codex": "gpt-5.4",
  google: "gemini-2.5-flash",
  openrouter: "anthropic/claude-haiku-4.5",
};

function noStore() {
  return { "Cache-Control": "no-store" } as const;
}

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: noStore() });
}

function runOpenclawJson<T>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME ?? "/home/clawbox" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`openclaw spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`openclaw exited ${code}: ${stderr.slice(-300).trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new Error(`openclaw produced non-JSON output: ${stdout.slice(0, 200)}`));
      }
    });
  });
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

async function fetchOpenclawCatalog(provider: string): Promise<CatalogModel[]> {
  // `--all` returns the full provider catalog (not just locally-configured
  // entries). Filter out anything tagged "deprecated" upstream so the UI
  // picker doesn't suggest models that 400 at chat time.
  const data = await runOpenclawJson<OpenclawListResponse>([
    "models", "list", "--provider", provider, "--all", "--json",
  ]);
  const out: CatalogModel[] = [];
  for (const entry of data.models ?? []) {
    if (typeof entry.key !== "string") continue;
    const idPrefix = `${provider}/`;
    const id = entry.key.startsWith(idPrefix)
      ? entry.key.slice(idPrefix.length)
      : entry.key;
    if (!id) continue;
    if (entry.tags?.includes("deprecated")) continue;
    out.push({
      id,
      label: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
      contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : 0,
      input: typeof entry.input === "string" ? entry.input : undefined,
    });
  }
  // Newest-first ordering: bigger context generally means newer model on
  // every catalog we ship today (claude 200k+, gpt-5 400k, gemini 1M).
  // Fall back to alpha when contextWindow is unknown / equal so the list
  // stays stable on re-fetch.
  out.sort((a, b) => {
    if (a.contextWindow !== b.contextWindow) return b.contextWindow - a.contextWindow;
    return a.label.localeCompare(b.label);
  });
  return out;
}

interface OpenRouterListResponse {
  data: Array<{
    id: string;
    name?: string;
    description?: string;
    context_length?: number;
    architecture?: { input_modalities?: string[] };
    /** OpenRouter sometimes flags retired models with this hint. */
    deprecated?: boolean;
  }>;
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
  const out: CatalogModel[] = [];
  for (const entry of data.data ?? []) {
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
  out.sort((a, b) => {
    if (a.contextWindow !== b.contextWindow) return b.contextWindow - a.contextWindow;
    return a.label.localeCompare(b.label);
  });
  return out;
}

async function buildCatalog(provider: string): Promise<CatalogResponse> {
  const models = provider === "openrouter"
    ? await fetchOpenRouterCatalog()
    : await fetchOpenclawCatalog(provider);

  // The "default" picked here just seeds the picker on first load —
  // user clicks override it. Prefer the historic default if it still
  // exists in the live catalog; otherwise use the first entry.
  const fallbackDefault = DEFAULT_MODEL_BY_PROVIDER[provider];
  const defaultModelId = models.find((m) => m.id === fallbackDefault)?.id
    ?? models[0]?.id
    ?? fallbackDefault
    ?? "";

  return {
    provider,
    models,
    defaultModelId,
    allowCustom: true,
    fetchedAt: Date.now(),
  };
}

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider")?.trim().toLowerCase() ?? "";
  if (!provider) {
    return fail("'provider' query parameter is required", 400);
  }
  if (!isCatalogProvider(provider)) {
    return fail(`Unknown provider: ${provider}. Supported: ${CATALOG_PROVIDERS.join(", ")}`, 400);
  }
  // `?refresh=1` skips the cache — useful from the configure route after
  // a save, when we want the freshly-saved provider's catalog reflected
  // in the next picker open without waiting for the TTL.
  const force = req.nextUrl.searchParams.get("refresh") === "1";

  const cached = cache.get(provider);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload, { headers: noStore() });
  }

  try {
    let inflight = inFlight.get(provider);
    if (!inflight) {
      inflight = buildCatalog(provider).finally(() => {
        inFlight.delete(provider);
      });
      inFlight.set(provider, inflight);
    }
    const payload = await inflight;
    cache.set(provider, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
    return NextResponse.json(payload, { headers: noStore() });
  } catch (err) {
    // Fall back to the last good cached payload if any — better to show
    // a slightly stale list than to break the picker on a transient
    // network blip / openclaw spawn failure.
    if (cached) {
      return NextResponse.json(
        { ...cached.payload, stale: true, error: err instanceof Error ? err.message : "fetch failed" },
        { headers: noStore() },
      );
    }
    return fail(err instanceof Error ? err.message : "Catalog fetch failed", 502);
  }
}
