import fsSync from "fs";
import path from "path";
import { findOpenclawBin } from "@/lib/openclaw-config";

/**
 * Which models the INSTALLED core has retired.
 *
 * The picker's job is to offer what the box can usefully run, and the one
 * authority on that is the harness's own catalogue — not a list kept here. The
 * core publishes it per provider in `openclaw.plugin.json`, and every entry
 * carries a lifecycle:
 *
 *   { "id": "claude-opus-4-8", "status": "deprecated",
 *     "replacedBy": "claude-opus-5",
 *     "statusReason": "Still available by exact reference; use … for new setups." }
 *
 * WHY THIS FILE EXISTS AT ALL, given `models list --json` is right there.
 * Measured against the pinned core (2026.8.1) with an isolated `OPENCLAW_HOME`:
 *
 *   $ openclaw models list --provider anthropic --all --json
 *   … { "key": "anthropic/claude-opus-4-8", "name": "Claude Opus 4.8",
 *       "contextWindow": 1000000, "available": null, "tags": [] } …
 *
 * The row is enumerated and its lifecycle is NOT projected — `toModelRow`
 * builds `tags` from configured entries and aliases and never carries `status`.
 * So the catalogue route's own `entry.tags?.includes("deprecated")` guard could
 * never fire on this core: a filter that reads as deference to the harness,
 * deferring to nothing. The core DOES model the lifecycle internally and its
 * gateway `models.list` RPC projects it; ClawBox has no client for that RPC, so
 * reading the shipped manifest is the cheapest way to ask the same question —
 * and it is not a new trick here: `scripts/gateway-pre-start.sh` resolves the
 * same file for deepseek on every boot, from the same two places.
 *
 * THE PREDICATE IS THE CORE'S OWN, not an invention: `deprecated` OR `disabled`
 * — `catalog.filter(e => … e.status !== "deprecated" && e.status !== "disabled")`
 * in the installed core's own list probe.
 *
 * FAILS OPEN, everywhere. A box with no core, an unreadable manifest, a plugin
 * that ships none, a shape this does not recognise — all answer "not retired",
 * so the picker keeps offering exactly what it offers today. The failure this
 * must never have is the other one: a parse slip that empties a model list.
 */

/** What the harness treats as "do not offer this any more". */
const RETIRED_STATUSES: ReadonlySet<string> = new Set(["deprecated", "disabled"]);

/**
 * How long a manifest read stands before the file is re-stat'ed.
 *
 * The re-stat exists because the in-app OpenClaw update runs inside this server
 * (see `retiredFor`), and that is a once-in-a-while event — while
 * `withoutRetiredModels` asks about every row of a payload, and the OpenRouter
 * catalogue is ~423 rows. One `statSync` per row per request is a blocking
 * syscall storm on a Jetson for a file that changes when someone taps Update.
 * Five seconds is far shorter than any update takes and turns the storm into
 * one stat per provider per five seconds.
 */
const STAT_FLOOR_MS = 5_000;

interface CachedManifest {
  /** Retired ids, indexed under BOTH the raw manifest id and its last segment. */
  retired: Set<string>;
  /** The file this was read from, and what it looked like when it was read. */
  file: string;
  mtimeMs: number;
  size: number;
  /** When the file was last stat'ed, so a burst of lookups costs one syscall. */
  checkedAt: number;
}

const cache = new Map<string, CachedManifest>();

/**
 * The two places the manifest lives, in the order `gateway-pre-start.sh` tries
 * them: bundled in the core's `dist/extensions`, or beside the config once
 * OpenClaw 2 unbundled the provider into its own installed plugin.
 */
/**
 * A provider id that can only ever name a directory, never traverse out of one.
 *
 * The id reaches this module from a request query string by way of the catalogue
 * payload, and it is joined into a filesystem path below. Everything the core
 * ships is `[a-z0-9-]`, so anything else is not a provider we could have a
 * manifest for anyway — refusing here costs nothing and closes the class.
 */
const SAFE_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function manifestPaths(provider: string): string[] {
  const bin = findOpenclawBin();
  const paths: string[] = [];
  if (path.isAbsolute(bin)) {
    paths.push(path.join(
      path.dirname(bin), "..", "lib", "node_modules", "openclaw",
      "dist", "extensions", provider, "openclaw.plugin.json",
    ));
  }
  // `CLAWBOX_OPENCLAW_HOME` first, because that is the order every other reader
  // in this repo spells (`openclaw-config.ts`, `ai-models/configure`,
  // `gateway-proxy.ts`, `updater.ts`) and the one the test config neutralises.
  const openclawHome = process.env.CLAWBOX_OPENCLAW_HOME
    || process.env.OPENCLAW_HOME
    || path.join(process.env.HOME ?? "/home/clawbox", ".openclaw");
  paths.push(path.join(openclawHome, "extensions", provider, "openclaw.plugin.json"));
  return paths;
}

/**
 * Every retired `{id, status}` in one catalogue block.
 *
 * Walked rather than addressed by a fixed path: the shape has moved between
 * core generations (a provider block, a `modelCatalog`, per-auth-mode variants),
 * the ids are the same in all of them, and a path that went stale would
 * silently answer "nothing is retired" — the exact failure this file replaces.
 *
 * Indexed under the raw id AND its last segment, because both forms are real:
 * the anthropic and openai manifests carry bare ids while the nvidia one ships
 * slashed ones (`z-ai/glm-5.1`), and the caller holds whichever form its
 * catalogue uses.
 */
function collect(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const row = node as { id?: unknown; status?: unknown };
  if (typeof row.id === "string" && row.id.trim() && typeof row.status === "string") {
    if (RETIRED_STATUSES.has(row.status.trim().toLowerCase())) {
      const id = row.id.trim();
      out.add(id);
      const slash = id.lastIndexOf("/");
      if (slash > 0) out.add(id.slice(slash + 1));
    }
  }
  for (const value of Object.values(node as Record<string, unknown>)) collect(value, out);
}

/**
 * The block that belongs to THIS provider, when the manifest separates them.
 *
 * The anthropic manifest ships two catalogues under `modelCatalog.providers` —
 * `claude-cli` and `anthropic` — and they are genuinely different surfaces, not
 * copies (`provider-models.ts` documents `claude-cli` as the narrower one). A
 * flat walk would let a model retired on one route disappear from the other,
 * where the core still lists and routes it. So the provider's own block is read
 * when there is one, and the whole manifest only when there is not.
 */
function catalogueFor(manifest: unknown, provider: string): unknown {
  const modelCatalog = (manifest as { modelCatalog?: unknown } | null)?.modelCatalog;
  const providers = (modelCatalog as { providers?: unknown } | null)?.providers;
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    const own = (providers as Record<string, unknown>)[provider];
    if (own !== undefined) return own;
    return {};
  }
  const topLevelProviders = (manifest as { providers?: unknown } | null)?.providers;
  if (topLevelProviders && typeof topLevelProviders === "object" && !Array.isArray(topLevelProviders)) {
    const shared = (topLevelProviders as Record<string, unknown>)[provider];
    if (shared !== undefined) return shared;
  }
  return manifest;
}

function retiredFor(provider: string): Set<string> {
  if (!SAFE_PROVIDER_RE.test(provider)) return new Set();
  const cached = cache.get(provider);
  if (cached) {
    const now = Date.now();
    if (now - cached.checkedAt < STAT_FLOOR_MS) return cached.retired;
    // Re-stat rather than trust the process lifetime. The in-app OpenClaw-only
    // update (`openclaw_install` → `openclaw_patch` → `gateway_restart`) runs
    // INSIDE this server and deliberately does not touch ClawBox, so a core
    // upgrade can and does happen under a live process — and a manifest read
    // during `npm install -g`, while `dist/extensions` is half-renamed, would
    // otherwise pin "nothing is retired" for the rest of that process's life.
    try {
      const stat = fsSync.statSync(cached.file);
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
        cached.checkedAt = now;
        return cached.retired;
      }
    } catch {
      // The file went away: fall through and look again.
    }
    cache.delete(provider);
  }
  for (const file of manifestPaths(provider)) {
    // Opened ONCE and both stat and read taken from the descriptor. A
    // `statSync` followed by a `readFileSync` of the same path is two lookups
    // of a name that can change between them — and the whole point of the stat
    // is to decide whether the bytes that follow are still the ones it
    // described. `npm install -g openclaw@latest` renaming `dist/extensions`
    // underneath is exactly that window, and it is the window this module
    // exists to survive.
    let fd: number;
    try {
      fd = fsSync.openSync(file, "r");
    } catch {
      continue;
    }
    let stat: fsSync.Stats;
    let raw: string;
    try {
      stat = fsSync.fstatSync(fd);
      raw = fsSync.readFileSync(fd, "utf-8");
    } catch {
      continue;
    } finally {
      try {
        fsSync.closeSync(fd);
      } catch {
        // Already gone; nothing to release.
      }
    }
    const retired = new Set<string>();
    try {
      collect(catalogueFor(JSON.parse(raw), provider), retired);
    } catch {
      // A manifest we cannot parse is a manifest we know nothing from — and it
      // is NOT cached, so a half-written file is re-read rather than believed.
      return new Set();
    }
    cache.set(provider, { retired, file, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: Date.now() });
    return retired;
  }
  // Nothing found. Deliberately NOT cached: on a box with no core yet, or one
  // mid-upgrade, the answer is "ask again", not "there is nothing".
  return new Set();
}

/**
 * Has the installed core retired this model? False on a box that cannot say —
 * including one with no core installed.
 *
 * `id` may be the bare id (`claude-opus-4-8`) or the fully-qualified one
 * (`z-ai/glm-5.1`); both forms are indexed.
 */
export function coreModelRetired(provider: string, id: string): boolean {
  if (!provider || !id) return false;
  return coreRetiredModels(provider).has(id.trim());
}

/**
 * Every id the installed core has retired for this provider, in both the raw
 * and last-segment forms.
 *
 * For a caller with a LIST to filter: resolve the set once and test against it,
 * rather than asking per row. `withoutRetiredModels` filters payloads that run
 * to hundreds of rows.
 */
export function coreRetiredModels(provider: string): ReadonlySet<string> {
  if (!provider) return EMPTY;
  return retiredFor(provider);
}

const EMPTY: ReadonlySet<string> = new Set();

/** Test seam: forget the manifests so the next call reads them again. */
export function resetCoreModelLifecycle(): void {
  cache.clear();
}
