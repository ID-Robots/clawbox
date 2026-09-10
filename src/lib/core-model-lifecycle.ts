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
 *
 * KEYED ON THE CATALOGUE PROVIDER, with no inverse mapping, and that is a
 * decision rather than an oversight. ClawBox's own `clawai` catalogue is served
 * by deepseek models (`deepseek-v4-flash` and its siblings in
 * `provider-models.ts`) through the ClawBox AI proxy, and the core ships the
 * manifest under `deepseek` — so a `clawai` lookup finds no manifest and every
 * clawai row is answered "not retired". Adding the mapping would let a
 * lifecycle the core publishes about the DIRECT deepseek route decide what our
 * proxied plan offers, and those are not the same surface: what the proxy
 * accepts is our contract with the customer, not the upstream provider's. The
 * same asymmetry, for the same reason, is documented at `withoutRetiredModels`
 * for `codex` vs `openai` and pinned by `curated-defaults-offerable.test.ts`.
 */

/** What the harness treats as "do not offer this any more". */
const RETIRED_STATUSES: ReadonlySet<string> = new Set(["deprecated", "disabled"]);

/**
 * How long a manifest read stands before the file is re-stat'ed.
 *
 * The re-stat exists because the in-app OpenClaw update runs inside this server
 * (see `factsFor`), and that is a once-in-a-while event — while
 * `withoutRetiredModels` asks about every row of a payload, and the OpenRouter
 * catalogue is ~423 rows. One `statSync` per row per request is a blocking
 * syscall storm on a Jetson for a file that changes when someone taps Update.
 * Five seconds is far shorter than any update takes and turns the storm into
 * one stat per provider per five seconds.
 */
const STAT_FLOOR_MS = 5_000;

/**
 * The two hosts the manifest's `when.baseUrlHosts` names, and what each one
 * means when a model is SUPPRESSED on it. They are the core's own strings, read
 * out of the shipped manifest rather than chosen here:
 *
 *   * `api.openai.com` — suppressed on the PLATFORM route, i.e. reachable only
 *     through the ChatGPT account. `gpt-5.3-codex-spark` carries this on both
 *     measured cores, with the reason "available only through ChatGPT/Codex
 *     OAuth … OpenAI API-key auth cannot use this model."
 *   * `chatgpt.com` — suppressed on the CHATGPT route: retired FROM the
 *     subscription surface while it still runs on an API key. 2026.9.3 carries
 *     two ("GPT-5.4 has retired from the ChatGPT-account Codex route",
 *     `replacedBy: gpt-5.6-terra`; the same for `gpt-5.4-mini`).
 */
const PLATFORM_HOST = "api.openai.com";
const CHATGPT_HOST = "chatgpt.com";

/** What the installed core says about one provider's ChatGPT (Codex) route. */
export interface CoreChatgptRoute {
  /** The catalogue rows the manifest lists, in the order it lists them. */
  listed: ReadonlyArray<{ id: string; name?: string }>;
  /** Ids the manifest suppresses ON that route — retired from the surface. */
  offRoute: ReadonlySet<string>;
  /** Ids suppressed on the platform host: this route reaches them and no other. */
  subscriptionOnly: readonly string[];
}

interface ManifestFacts {
  /** Retired ids, indexed under BOTH the raw manifest id and its last segment. */
  retired: Set<string>;
  /**
   * The provider's ChatGPT-route facts, or null when this manifest cannot say —
   * absent, unparsable, or carrying no catalogue for the provider asked about.
   *
   * Null is UNKNOWN and never "the route is empty": the caller renders the
   * curated fallback for it, where an empty list would empty the picker.
   */
  chatgpt: CoreChatgptRoute | null;
}

interface CachedManifest extends ManifestFacts {
  /** The file this was read from, and what it looked like when it was read. */
  file: string;
  mtimeMs: number;
  size: number;
  /** When the file was last stat'ed, so a burst of lookups costs one syscall. */
  checkedAt: number;
}

const cache = new Map<string, CachedManifest>();

/**
 * A provider id that can only ever name a directory, never traverse out of one.
 *
 * The id reaches this module from a request query string by way of the catalogue
 * payload, and it is joined into a filesystem path below. Everything the core
 * ships is `[a-z0-9-]`, so anything else is not a provider we could have a
 * manifest for anyway — refusing here costs nothing and closes the class.
 */
const SAFE_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The two places the manifest lives, in the order `gateway-pre-start.sh`
 * resolves them: bundled in the core's `dist/extensions`, or beside the config
 * once OpenClaw 2 unbundled the provider into its own installed plugin. The
 * PATHS are that script's; the fallback RULE is not the same one — it falls
 * back on existence alone (`[ ! -f … ]`) and gives up outright on a manifest it
 * cannot parse, while this reads on to the next candidate.
 *
 * Exported because the manifest carries more than the lifecycle: its
 * `modelCatalog.suppressions` are how the core says a model runs on ONE auth
 * only, which is what `src/tests/unit/codex-surface-follows-core.test.ts` reads
 * to catch the ChatGPT list drifting behind a core bump. Where the manifest
 * lives is written down once.
 */
export function coreManifestPaths(provider: string): string[] {
  const bin = findOpenclawBin();
  const paths: string[] = [];
  // `typeof` as well as `isAbsolute`, because this is now read from a WRITE
  // GUARD and not only from the catalogue route: a suite that mocks
  // `openclaw-config` without this function gets `undefined` here, `path.join`
  // throws on it, and a model refusal that should be a 400 became a 500.
  if (typeof bin === "string" && path.isAbsolute(bin)) {
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
    if (Object.prototype.hasOwnProperty.call(providers, provider)) {
      return (providers as Record<string, unknown>)[provider];
    }
  }
  return manifest;
}

/**
 * The provider's ChatGPT-route catalogue, as the manifest states it.
 *
 * THREE facts, because the manifest states the surface in three pieces and two
 * of them are suppressions rather than rows:
 *
 *   * `modelCatalog.providers.<provider>.models[]` — what the core ships for the
 *     provider, in its own order (2026.9.3 lists `gpt-6-astra` first).
 *   * a suppression on {@link CHATGPT_HOST} — a row that is NOT on this route.
 *   * a suppression on {@link PLATFORM_HOST} — a model that is on this route
 *     ONLY, and is therefore missing from `models[]` entirely
 *     (`gpt-5.3-codex-spark` is in neither core's list).
 *
 * The suppressions sit at `modelCatalog.suppressions`, beside the provider
 * blocks rather than inside them, and each names its own `provider` — the
 * azure alias carries a `gpt-5.3-codex-spark` row of its own, which says nothing
 * about this provider's routes. So they are filtered by `provider`, and a
 * suppression with no `when.baseUrlHosts` is ignored: unconditional is not the
 * same claim as "off this route", and reading it as one would drop a model the
 * core still routes.
 *
 * Returns null when the manifest carries no catalogue for this provider at all.
 * An empty `models[]` with suppressions is still an answer; no block is not.
 */
function chatgptRouteFrom(manifest: unknown, provider: string): CoreChatgptRoute | null {
  const modelCatalog = (manifest as { modelCatalog?: unknown } | null)?.modelCatalog;
  const providers = (modelCatalog as { providers?: unknown } | null)?.providers;
  const block = providers && typeof providers === "object" && !Array.isArray(providers)
    && Object.prototype.hasOwnProperty.call(providers, provider)
    ? (providers as Record<string, unknown>)[provider]
    : null;
  const rows = (block as { models?: unknown } | null)?.models;
  if (!Array.isArray(rows)) return null;

  const listed: Array<{ id: string; name?: string }> = [];
  for (const row of rows as Array<{ id?: unknown; name?: unknown }>) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    listed.push(name ? { id, name } : { id });
  }

  const offRoute = new Set<string>();
  const subscriptionOnly: string[] = [];
  const suppressions = (modelCatalog as { suppressions?: unknown } | null)?.suppressions;
  if (Array.isArray(suppressions)) {
    for (const entry of suppressions as Array<{ provider?: unknown; model?: unknown; when?: { baseUrlHosts?: unknown } | null }>) {
      if (entry?.provider !== provider) continue;
      const model = typeof entry?.model === "string" ? entry.model.trim() : "";
      if (!model) continue;
      const hosts = entry?.when?.baseUrlHosts;
      if (!Array.isArray(hosts)) continue;
      const lower = hosts.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase());
      if (lower.includes(CHATGPT_HOST)) offRoute.add(model);
      else if (lower.includes(PLATFORM_HOST) && !subscriptionOnly.includes(model)) subscriptionOnly.push(model);
    }
  }
  return { listed, offRoute, subscriptionOnly };
}

function factsFor(provider: string): ManifestFacts {
  if (!SAFE_PROVIDER_RE.test(provider)) return { retired: new Set(), chatgpt: null };
  const cached = cache.get(provider);
  if (cached) {
    const now = Date.now();
    if (now - cached.checkedAt < STAT_FLOOR_MS) return cached;
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
        return cached;
      }
    } catch {
      // The file went away: fall through and look again.
    }
    cache.delete(provider);
  }
  // Set when a candidate EXISTED and could not be used — it would not open, or
  // would not read, or would not parse. The
  // answer that follows then comes from a lower-priority file, and caching it
  // would key the staleness check on that file alone (`cached.file` is the only
  // path re-stat'ed above), so the moment the better manifest became readable
  // again nothing would look at it: one bad read would pin the wrong source for
  // the life of the process. A candidate that is simply ABSENT is not that —
  // that is the ordinary shape of an OpenClaw 2 box, where the bundled path
  // never exists and the beside-config answer is the right one to cache.
  let degraded = false;
  for (const file of coreManifestPaths(provider)) {
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
    } catch (err) {
      // ENOENT is genuine ABSENCE — the ordinary OpenClaw 2 layout, where the
      // provider is unbundled and only the copy beside the config exists.
      // Anything else (EACCES after a bad chown, EIO on a failing eMMC, EMFILE
      // under load, ENOTDIR mid-upgrade) is a candidate that IS there and could
      // not be used, and treating it as absence caches the lower-priority
      // answer under a re-stat that only ever watches that lower-priority file.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") degraded = true;
      continue;
    }
    let stat: fsSync.Stats;
    let raw: string;
    try {
      stat = fsSync.fstatSync(fd);
      raw = fsSync.readFileSync(fd, "utf-8");
    } catch {
      degraded = true;
      continue;
    } finally {
      try {
        fsSync.closeSync(fd);
      } catch {
        // Already gone; nothing to release.
      }
    }
    const retired = new Set<string>();
    let chatgpt: CoreChatgptRoute | null = null;
    try {
      // ONE parse for both facts. They are read off the same bytes the stat
      // above describes, so a second read here would reintroduce exactly the
      // mid-upgrade window this function opens the file once to close.
      const manifest: unknown = JSON.parse(raw);
      collect(catalogueFor(manifest, provider), retired);
      chatgpt = chatgptRouteFrom(manifest, provider);
    } catch {
      // A manifest we cannot parse is a manifest we know nothing from — but the
      // NEXT candidate may still be readable, and giving up on the lookup threw
      // that away. What actually produces unparsable bytes here is a write in
      // PLACE: `gateway-pre-start.sh` rewrites this very file with python on
      // every gateway start to declare deepseek's xhigh effort, and a truncated
      // write (a full disk, a killed process) leaves the remains behind.
      // `npm install -g`'s rename is not one of those cases — a rename is
      // atomic, so a reader sees the whole old file or ENOENT, which the
      // `openSync` catch above has always carried to the next candidate.
      //
      // Nothing is cached: neither this file (the next boot may repair it) nor
      // the answer read past it (see `degraded`).
      degraded = true;
      continue;
    }
    if (!degraded) {
      cache.set(provider, { retired, chatgpt, file, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: Date.now() });
    }
    return { retired, chatgpt };
  }
  // Nothing found. Deliberately NOT cached: on a box with no core yet, or one
  // mid-upgrade, the answer is "ask again", not "there is nothing".
  return { retired: new Set(), chatgpt: null };
}

/**
 * Has the installed core retired this model? False on a box that cannot say —
 * including one with no core installed.
 *
 * `id` may be the bare id (`claude-opus-4-8`) or the fully-qualified one
 * (`z-ai/glm-5.1`); both forms are indexed.
 *
 * NO PRODUCTION CALLER TODAY, deliberately: the only consumer, the catalogue
 * route, holds a LIST and goes through `coreRetiredModels` so a payload of
 * hundreds of rows costs one lookup rather than hundreds. This is the
 * single-row form — what the cases in `core-model-lifecycle.test.ts` are
 * written against. It is not exactly the set test: it TRIMS the id first, while
 * `withoutRetiredModels` asks the set for the id its catalogue holds. So a
 * per-row caller may use either, but converting a loop from one to the other
 * changes the answer for a padded id.
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
  return factsFor(provider).retired;
}

/**
 * What the installed core says its ChatGPT (Codex) route carries for
 * `provider` — or null when this box cannot say.
 *
 * The same manifest, the same read, the same fail-open rule as the retirement
 * lookup above: a box with no core, an unreadable file or a manifest with no
 * catalogue for this provider answers null, and the caller renders its curated
 * fallback. What it must never do is answer "the route has no models".
 *
 * WHY THE MANIFEST and not the live Codex catalogue. The core builds the
 * route's real list per ACCOUNT from `chatgpt.com/backend-api/codex/models`,
 * and that list is the better answer — but on 2026.8.1 and 2026.9.3 alike
 * nothing publishes it in a form ClawBox can ask for. Measured on a box:
 * `models list --provider codex` answers `Unknown provider filter`; there is no
 * `--profile` scoping; the catalogue the core publishes under `openai` flips
 * WHOLESALE to the platform list as soon as any API key resolves first (an
 * inline `models.providers.openai.apiKey` counts), and a row carries no `api`,
 * `baseUrl` or profile field to tell the two apart — the JSON row keys are
 * `available, contextTokens, contextWindow, input, key, local, missing, name,
 * tags`. So an enumeration cannot be trusted to be the ChatGPT one, while this
 * file says which route each model is on without a credential, a network call
 * or a three-minute fork.
 */
export function coreChatgptRoute(provider: string): CoreChatgptRoute | null {
  if (!provider) return null;
  return factsFor(provider).chatgpt;
}

const EMPTY: ReadonlySet<string> = new Set();

/** Test seam: forget the manifests so the next call reads them again. */
export function resetCoreModelLifecycle(): void {
  cache.clear();
}
