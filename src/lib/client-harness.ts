/**
 * Client-side cache for `/setup-api/harness/active`.
 *
 * Five components independently fetched this route with `cache: "no-store"`, so
 * every mount paid a fresh round-trip — and several of them render a skeleton
 * until it lands. Re-opening Settings, or switching between its sections, made
 * that skeleton appear again each time even though the answer had not changed.
 *
 * The two fields have genuinely different lifetimes, so they are cached
 * differently:
 *
 * - `edition` is baked into a root-owned env file and only changes through an
 *   edition switch that restarts the services. It cannot change under a live
 *   page, so it is cached for the lifetime of the document.
 * - `active` CAN change while the page is open: on a dual box the Settings
 *   harness picker switches it. Today that picker reloads the document (a
 *   deliberate engine switch re-mounts the whole desktop), so the cache dies
 *   with the page — but it gets a short TTL anyway, plus an explicit
 *   `invalidateActiveHarness()`, so a future in-place switch cannot be served a
 *   stale harness.
 *
 * Concurrent callers share one in-flight request instead of firing five.
 */

export type HarnessInfo = {
  active: string;
  edition: string;
  /**
   * Whether anything on the device actually NAMED an edition, or `edition`
   * above is `readEditionSource()`'s own "openclaw" default (no lock file, no
   * `CLAWBOX_EDITION`, or a lock that could not be parsed).
   *
   * Cached with `edition` and for the same reason: both come from a root-owned
   * file that only an edition switch rewrites. A caller that must not guess —
   * anything that BRANDS the box — reads this before believing `active` either,
   * since on an unreadable lock that field traces back through
   * `lockedHarness()` to the very same file and can only echo "openclaw".
   *
   * False for a server that predates the field, which is the honest reading: it
   * did not say.
   */
  editionKnown: boolean;
};

const ACTIVE_TTL_MS = 5_000;

let editionCache: { value: string; known: boolean } | null = null;
let activeCache: { value: string; at: number } | null = null;
let inFlight: Promise<HarnessInfo | null> | null = null;

/** The edition if it is already known, else null. Never triggers a fetch. */
export function cachedEdition(): string | null {
  return editionCache?.value ?? null;
}

/** The active harness if a fresh value is cached, else null. Never fetches. */
export function cachedActiveHarness(): string | null {
  if (!activeCache) return null;
  return Date.now() - activeCache.at < ACTIVE_TTL_MS ? activeCache.value : null;
}

/** Drop the cached active harness — call after switching harnesses. */
export function invalidateActiveHarness(): void {
  activeCache = null;
}

/** Test seam: forget everything, including the immutable edition. */
export function resetHarnessCache(): void {
  editionCache = null;
  activeCache = null;
  inFlight = null;
}

/**
 * Resolve the harness info, serving cached values when they are still good.
 * Returns null if the request fails — callers keep their own fallbacks, which
 * differ (some default to openclaw, some to "unknown").
 */
export function fetchHarness(options?: {
  signal?: AbortSignal;
  /** Skip the `active` cache (the edition cache is always kept — it is immutable). */
  force?: boolean;
}): Promise<HarnessInfo | null> {
  const active = options?.force ? null : cachedActiveHarness();
  if (active !== null && editionCache !== null) {
    return Promise.resolve({ active, edition: editionCache.value, editionKnown: editionCache.known });
  }
  if (inFlight && !options?.force) return inFlight;

  const request = fetch("/setup-api/harness/active", {
    cache: "no-store",
    signal: options?.signal,
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: unknown) => {
      const data = (d ?? {}) as { active?: unknown; edition?: unknown; editionKnown?: unknown };
      if (typeof data.edition === "string") {
        editionCache = { value: data.edition, known: data.editionKnown === true };
      }
      if (typeof data.active === "string") activeCache = { value: data.active, at: Date.now() };
      if (typeof data.active !== "string" && typeof data.edition !== "string") return null;
      return {
        active: typeof data.active === "string" ? data.active : "",
        edition: typeof data.edition === "string" ? data.edition : "",
        editionKnown: data.editionKnown === true,
      };
    })
    .catch(() => null)
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });

  if (!options?.force) inFlight = request;
  return request;
}

/**
 * The device edition, for edition-aware UI and readiness checks.
 *
 * Served from the caches above, so callers can reach for it freely: once any
 * component has asked, it costs nothing for the rest of the document's life. A
 * device that cannot answer is treated as OpenClaw, the native product edition.
 *
 * Lives here rather than in a component because more than one screen has to
 * make the same "is there an OpenClaw gateway on this box?" decision, and two
 * copies of the fallback would eventually disagree.
 */
export async function resolveEdition(): Promise<string> {
  return cachedEdition() ?? (await fetchHarness())?.edition ?? "openclaw";
}
