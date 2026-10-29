// ── Which models this ACCOUNT cannot run, and the newest one it can ─────────
//
// The catalogue says what a provider PUBLISHES; it cannot say what this
// account may call. xAI lists every Grok model to every key, and still answers
// one of them with a 429 stating a limit of 0/0 because the account's spend
// tier carries no quota for it (2026-10, on a box whose newer Grok 4.7 worked).
// A 404 for a model the provider dropped is the same fact in another shape.
//
// So the box writes down what a turn PROVED — "this model, on this account,
// answered with a zero limit / not found" — and every place that picks a model
// for the owner reads it: the catalog route leaves the row out of the picker
// and re-resolves the default, the follow-newest pass skips it, and the
// fallback never lands on it twice.
//
// A RECORD WITH AN EXPIRY, not a verdict. A zero quota ends when the owner adds
// credit, and nothing tells the box that happened; so a mark lasts a day, and
// any save of the provider's credential (src/app/setup-api/ai-models/configure)
// clears the provider's marks at once — re-saving the key is the obvious thing
// to do after topping up, and the next turn then asks again.
//
// Server-only: it reads ClawBox's config store and the catalog route's cache.

import { promises as fsp } from "fs";
import path from "@/lib/runtime-path";
import { DATA_DIR, getKnown, setMany } from "@/lib/config-store";
import { getProviderCatalog } from "@/lib/provider-models";
import { NEWEST_MODEL_PROVIDERS, followsNewestModel, newestModelId, type NewestModelCandidate } from "@/lib/provider-newest-model";

/** Config-store key: `{ <provider>: { <model id>: { reason, at } } }`. */
export const UNAVAILABLE_MODELS_KEY = "ai_model_unavailable";

/** How long a proven refusal keeps a model out of the picker and the fallback. */
export const UNAVAILABLE_TTL_MS = 24 * 60 * 60_000;

export type UnavailableReason = "zero_quota" | "not_found";

interface UnavailableEntry {
  reason: UnavailableReason;
  /** Epoch ms of the refusal that proved it. */
  at: number;
}

type UnavailableMap = Record<string, Record<string, UnavailableEntry>>;

/** The same slot shape the explicit-pick store keys by: a bounded, known property name. */
const SLOT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RESERVED = new Set(["constructor", "prototype", "__proto__"]);

const isSlot = (value: string): boolean => SLOT_RE.test(value) && !RESERVED.has(value);
const isModelId = (value: string): boolean => MODEL_ID_RE.test(value) && !RESERVED.has(value);

/** The stored map, tolerant of anything that is not one — the store is hand-editable JSON. */
export function unavailableMapFrom(raw: unknown): UnavailableMap {
  const out: UnavailableMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [provider, models] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSlot(provider) || !models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [model, entry] of Object.entries(models as Record<string, unknown>)) {
      const e = entry as Partial<UnavailableEntry> | null;
      if (!isModelId(model) || !e || typeof e !== "object") continue;
      if ((e.reason !== "zero_quota" && e.reason !== "not_found") || typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
      (out[provider] ??= {})[model] = { reason: e.reason, at: e.at };
    }
  }
  return out;
}

/** The ids still inside their expiry for `provider`. Pure, for the callers that already hold the map. */
export function unavailableIdsIn(map: UnavailableMap, provider: string, now: number = Date.now()): Set<string> {
  const models = Object.hasOwn(map, provider) ? map[provider] : {};
  return new Set(Object.entries(models).filter(([, e]) => now - e.at < UNAVAILABLE_TTL_MS).map(([id]) => id));
}

/**
 * The models this account was refused on, still inside their expiry.
 * FAIL-SOFT: an unreadable store is "nothing known", which is beta's behaviour.
 */
export async function readUnavailableModelIds(provider: string, now: number = Date.now()): Promise<Set<string>> {
  try {
    const { value } = await getKnown(UNAVAILABLE_MODELS_KEY);
    return unavailableIdsIn(unavailableMapFrom(value), provider.trim().toLowerCase(), now);
  } catch {
    return new Set();
  }
}

// Writes are read-modify-write on one key: serialised in-process, the same
// discipline src/lib/explicit-model-pick.ts keeps for the same reason.
let chain: Promise<void> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Write down that this account cannot run `modelId` on `provider`. Answers
 * whether this is NEWS — no live mark for it yet — which is what "tell the
 * owner once" keys on. Fail-soft: an unwritable store answers `true` and
 * records nothing, so the owner is still told.
 */
export function markModelUnavailable(
  provider: string,
  modelId: string,
  reason: UnavailableReason,
  now: number = Date.now(),
): Promise<boolean> {
  const slot = provider.trim().toLowerCase();
  const id = modelId.trim();
  if (!isSlot(slot) || !isModelId(id)) return Promise.resolve(false);
  return serialise(async () => {
    try {
      const { value, known } = await getKnown(UNAVAILABLE_MODELS_KEY);
      if (!known) return true;
      const map = unavailableMapFrom(value);
      const fresh = !unavailableIdsIn(map, slot, now).has(id);
      // Expired marks go on the way past: the map only ever holds what counts.
      const kept = Object.fromEntries(
        Object.entries(map[slot] ?? {}).filter(([, e]) => now - e.at < UNAVAILABLE_TTL_MS),
      );
      map[slot] = { ...kept, [id]: { reason, at: now } };
      await setMany({ [UNAVAILABLE_MODELS_KEY]: map });
      return fresh;
    } catch (err) {
      console.warn("[model-availability] could not record an unavailable model:", err instanceof Error ? err.message : err);
      return true;
    }
  });
}

/** Forget every mark for `provider` — its credential was just saved again. Fail-soft. */
export function forgetUnavailableModels(provider: string): Promise<void> {
  const slot = provider.trim().toLowerCase();
  if (!isSlot(slot)) return Promise.resolve();
  return serialise(async () => {
    try {
      const { value, known } = await getKnown(UNAVAILABLE_MODELS_KEY);
      if (!known) return;
      const map = unavailableMapFrom(value);
      if (!Object.hasOwn(map, slot)) return;
      delete map[slot];
      await setMany({ [UNAVAILABLE_MODELS_KEY]: map });
    } catch (err) {
      console.warn("[model-availability] could not clear unavailable models:", err instanceof Error ? err.message : err);
    }
  });
}

/** One row of the catalog route's cached enumeration, as much as a ranking needs. */
export interface CachedCatalogModel extends NewestModelCandidate {
  label: string;
}

/**
 * The catalog route's LIVE enumeration for `provider` off its disk cache, or
 * null when there is none (cold box, failed enumerations, an older build's
 * unmarked file). Read-only and spawn-free: enumerating is the catalog route's.
 */
export async function readLiveCatalogModels(provider: string): Promise<CachedCatalogModel[] | null> {
  try {
    const raw = await fsp.readFile(path.join(DATA_DIR, "catalog-cache", `${provider}.json`), "utf8");
    const parsed = JSON.parse(raw) as { source?: unknown; models?: unknown };
    if (parsed.source !== "live" || !Array.isArray(parsed.models)) return null;
    const rows: CachedCatalogModel[] = [];
    for (const m of parsed.models as Record<string, unknown>[]) {
      if (typeof m?.id !== "string" || !m.id) continue;
      rows.push({
        id: m.id,
        label: typeof m.label === "string" && m.label ? m.label : m.id,
        ...(m.isDefault === true ? { isDefault: true } : {}),
        ...(typeof m.createdAt === "number" ? { createdAt: m.createdAt } : {}),
      });
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/**
 * The models a choice for `provider` is made among: the box's live enumeration
 * when it has one, else the curated cold-start list — the same two sources, in
 * the same order, the picker itself falls through.
 */
export async function readChoosableModels(provider: string): Promise<CachedCatalogModel[]> {
  const live = await readLiveCatalogModels(provider);
  if (live) return live;
  return (getProviderCatalog(provider)?.models ?? []).map((m) => ({ id: m.id, label: m.label }));
}

/**
 * The newest model this account can run on `provider`, or null for a provider
 * that does not follow the newest model (its own fixed default applies).
 */
export async function readNewestModelId(provider: string): Promise<string | null> {
  if (!followsNewestModel(provider)) return null;
  const [models, unavailable] = await Promise.all([readChoosableModels(provider), readUnavailableModelIds(provider)]);
  // Every flagship refused is still an answer: the newest of them, so the
  // default names a real model and the next turn's refusal says why.
  return newestModelId(provider, models, unavailable) ?? newestModelId(provider, models);
}

/** `provider` → `provider/<newest id>` for every provider that follows the newest model. */
export async function readNewestModelRefs(): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  await Promise.all(NEWEST_MODEL_PROVIDERS.map(async (provider) => {
    const id = await readNewestModelId(provider).catch(() => null);
    if (id) refs.set(provider, `${provider}/${id}`);
  }));
  return refs;
}

/** A model's name as the picker shows it, for the sentences that name it. */
export async function readModelLabel(provider: string, modelId: string): Promise<string> {
  const models = await readChoosableModels(provider).catch(() => []);
  return models.find((m) => m.id === modelId)?.label
    ?? getProviderCatalog(provider)?.models.find((m) => m.id === modelId)?.label
    ?? modelId;
}
