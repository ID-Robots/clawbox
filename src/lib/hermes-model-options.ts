// Live, per-provider Hermes model catalogue (server-only).
//
// WHY the Hermes dashboard and not the on-disk catalog file:
//   ~/.hermes/cache/model_catalog.json is a CURATED MANIFEST hosted on the
//   Hermes docs site. It only ever carries `openrouter` and `nous` rows and
//   knows nothing about anthropic/gemini/zai/kimi — so the old route could
//   only ever show one global blob of ids and had to guess which provider they
//   belonged to. `GET /api/model/options` on the dashboard instead returns one
//   row PER PROVIDER, each with that provider's OWN live model ids (the server
//   hits the real /v1/models per provider behind its own SWR cache).
//
// WHY NOT vendor-prefix filtering of one shared list: providers do not share a
//   namespace. OpenRouter lists "anthropic/claude-opus-4.8" (dot) while the
//   direct Anthropic provider lists "claude-opus-4-8" (dash) — stripping the
//   prefix produces an id Anthropic rejects. Scoping therefore means "ask
//   Hermes for that provider's row", never "transform a string".
//
// WHY NOT `hermes model --refresh`: `hermes model` is the INTERACTIVE picker
//   ("Interactively select your inference provider and default model" per
//   --help); --refresh is a modifier on that TUI, not a standalone command, so
//   it can never be driven from a route.
//
// Verified on-device 2026-08-10: 44 provider rows, 0.35–0.6 s, HTTP 200 with
// ?refresh=true and no TTY — non-interactive and safe from a route handler.

import fs from "fs/promises";
import path from "path";
import { dashboardFetch } from "@/lib/hermes-dashboard-auth";
import { hermesConfigGet, invalidateHermesConfigCache } from "@/lib/hermes-config-cache";
import {
  hermesDashboardUnitState,
  type HermesDashboardUnitState,
} from "@/lib/hermes-dashboard-control";
import { get } from "@/lib/config-store";
import { CLAWBOX_AI_CHAT_MODEL_IDS } from "@/lib/clawbox-ai-models";
import {
  CLAWAI_PROVIDER,
  HERMES_AUTO_PROVIDER,
  HERMES_MODEL_ID_RE,
  isHermesCliProvider,
  isPlausibleHermesProviderId,
  isSafeHermesModelId,
} from "@/lib/hermes-providers";

const HERMES_HOME = process.env.HERMES_HOME
  || path.join(process.env.HOME || "/home/clawbox", ".hermes");
const CATALOG_PATH = path.join(HERMES_HOME, "cache", "model_catalog.json");

// Model ids are echoed back to `hermes config set` / `hermes -m`, so they get
// the same charset + no-leading-dash guard as every other CLI value. The rule
// itself lives in hermes-providers.ts (client-safe — this module imports `fs`
// and cannot be pulled into a component); re-exported here so existing server
// callers keep their import path and the two can never disagree.
export const MODEL_ID_RE = HERMES_MODEL_ID_RE;
export const isSafeModelId = isSafeHermesModelId;

/**
 * The ids we have *proven* route on this hardware — ClawBox AI's two tier
 * models (a vendor-prefixed slug gets HTTP 400 "Model not allowed" from the
 * proxy). Used twice:
 *   1. cold start — a factory device with no dashboard and no catalog on disk;
 *   2. to seed the ClawBox AI row (see normalizeRow), for a box whose Hermes
 *      config does not declare them yet.
 *
 * The SAME list `applyClawaiToHermes` writes into `providers.clawai.models`,
 * imported rather than re-typed: that block is what Hermes' own pickers read,
 * so a second spelling here would be the two surfaces disagreeing again.
 *
 * We deliberately do NOT ship guesses for providers we cannot query: the old
 * fallback listed OpenRouter slugs like "anthropic/claude-opus-4.8" which would
 * then be offered — and saved — under the direct Anthropic provider, i.e.
 * exactly the provider/model mismatch this module exists to stop.
 */
const COLD_START_MODELS: Record<string, readonly string[]> = {
  [CLAWAI_PROVIDER]: CLAWBOX_AI_CHAT_MODEL_IDS,
};

export type ModelOptionsSource = "dashboard" | "catalog-file" | "cold-start";

/**
 * How much a payload is worth, high to low. Used to stop a degraded read from
 * evicting a better cached one — see `load()`.
 *
 * `dashboard` is the live catalogue (47 providers on the QA box). `catalog-file`
 * is Hermes' on-disk manifest, which in practice holds 2. `cold-start` is the
 * hardcoded floor.
 */
const SOURCE_RANK: Record<ModelOptionsSource, number> = {
  dashboard: 3,
  "catalog-file": 2,
  "cold-start": 1,
};

export interface HermesModelOption {
  id: string;
  description: string;
  /** Hermes flagged this id as a featured/curated pick for its provider. */
  featured?: boolean;
  /** Present only when the provider row carried pricing (OpenRouter does). */
  pricing?: { input?: string; output?: string; free?: boolean };
}

export interface HermesProviderRow {
  id: string;
  name: string;
  /**
   * Hermes' `authenticated` flag, verbatim.
   *
   * It means "this provider has an API key set, or is a user-defined
   * endpoint" — credential PRESENCE, not a working credential. Hermes derives
   * it from `not is_skeleton`, never from a call to the provider. A row can be
   * `authenticated: true` and still 403 on every turn, which is exactly what
   * made a bogus user-defined provider look healthy in the picker. Prefer
   * `credentialPresent` when reading this; see `verified` for the other half.
   *
   * null when the source can't tell (the on-disk catalog carries no auth state).
   */
  authenticated: boolean | null;
  /**
   * Whether a credential was actually exercised against the provider:
   * `true`/`false` when something upstream probed it, `null` when nobody did.
   *
   * ClawBox performs no probe of its own, so this is `null` unless the Hermes
   * envelope carries it — but it is a distinct field so a consumer can no
   * longer read "has a key" as "works". TASK-446.
   */
  verified: boolean | null;
  /**
   * Whether the provider is one the OWNER defined (a custom OpenAI-compatible
   * endpoint) rather than one Hermes ships. `null` when the source could not
   * say — the same three-state rule the two fields above follow, and for the
   * same reason: this one decides whether the chat may resolve the dashboard's
   * `custom` KIND to a slug, and collapsing "not reported" into `false` blanks
   * the served label on the box's OWN provider from the second turn on. No
   * capture of a live `/api/model/options` row is held in this repo, so
   * "absent" is a shape we cannot rule out.
   */
  isUserDefined: boolean | null;
  source: string;
  total: number;
  models: HermesModelOption[];
  /** Hermes' own caveat for the row (e.g. moa's aggregator note). */
  warning?: string;
}

export interface ModelOptionsPayload {
  providers: HermesProviderRow[];
  /** The device's live selection, straight from Hermes — authoritative. */
  current: { provider: string; model: string };
  /** `agent.reasoning_effort` from config.yaml, when readable. */
  reasoning: string;
  fetchedAt: number;
  source: ModelOptionsSource;
  /** True when the payload did not come from the live dashboard. */
  stale: boolean;
  /**
   * Set when a live read failed and the caller is being served the previous,
   * better cached payload instead of the thin fallback. The client can say
   * "couldn't refresh" rather than silently rendering 2 providers where 47
   * were a moment ago.
   */
  degraded?: "dashboard-unreachable";
}

export interface ProviderScope {
  provider: string;
  authenticated: boolean | null;
  models: HermesModelOption[];
  /** Hermes' recommended landing model for this provider ("" when it has none). */
  defaultModel: string;
  /** The saved model IFF it belongs to `provider` — "" otherwise. This is the
   *  server-side guarantee that a foreign vendor's model is never even shown. */
  current: string;
  /** Set when the device's saved selection belongs to a DIFFERENT provider. */
  savedElsewhere: { provider: string; model: string } | null;
  warning?: string;
  source: ModelOptionsSource;
  stale: boolean;
  fetchedAt: number;
}

/**
 * What `/setup-api/hermes/models?provider=…` actually answers: a `ProviderScope`
 * plus the two DEVICE-WIDE facts a scoped reader would otherwise have to report
 * as unknown with the values one field away.
 *
 * Declared here, beside the scope it extends, because the MCP server reads this
 * shape too and a route rename is only protected if every declaration of it
 * moves together — the duplicate-type trap an earlier round of this PR
 * consolidated into `HermesDefaultSource`.
 *
 * `savedPair` is the pairing itself, and is deliberately NOT called `saved`
 * beside `savedElsewhere`: `current` is blank when the saved model is not in
 * this provider's list and `savedElsewhere` is null when it IS this provider,
 * so neither of them names the device default reliably and only this one does.
 */
export interface ScopedModelsReply extends ProviderScope {
  reasoning: string;
  savedPair: { provider: string; model: string };
}

// ── L1 cache (in-process, SWR) ───────────────────────────────────────────────
//
// Hermes already runs its own SWR under `/api/model/options` (1 h per-provider
// TTL, 7 d stale-serve, background refresh thread). This layer exists only to
// keep a burst of UI requests from fanning out into dashboard round-trips.

const FRESH_MS = 60_000;
const STALE_MS = 6 * 60 * 60 * 1000;
const DASHBOARD_TIMEOUT_MS = 8_000;
/** How often a DEGRADED payload may trigger a background re-ask. See the rule
 *  in `getModelOptions`; kept at the client's first retry step so a scheduled
 *  retry always lands on a real attempt. */
const DEGRADED_REFRESH_GAP_MS = 1_000;
// A click-spammer on "Refresh" must not fan out into 40 upstream /v1/models
// calls, so an explicit refresh is throttled per process.
const EXPLICIT_REFRESH_MIN_GAP_MS = 10_000;
/**
 * The BACKSTOP for "is the dashboard still coming up?", used wherever systemd
 * cannot say (see {@link probeStillOwed}).
 *
 * It is NOT up when this server is: `clawbox-setup` answers in 0 ms and
 * `clawbox-hermes-dashboard` needs another ~11-12 s — after every boot, and
 * again after every restart this app itself triggers. About twice that window.
 *
 * It also covers the largest slice of a NORMAL boot, not just the exotic cases:
 * the unit is `Type=simple`, so systemd reports `active/running` from the moment
 * `ExecStart` forks, and the seconds the dashboard then spends building its web
 * dist and binding :9119 are seconds no unit state describes.
 */
export const PROBE_GRACE_MS = 25_000;

/**
 * The other bound: how long a unit systemd reports as `activating` may be
 * called "checking".
 *
 * Tied to `TimeoutStartSec=300` in `config/clawbox-hermes-dashboard.service`,
 * because that is systemd's OWN deadline for the same question — past it
 * systemd kills the start and the unit goes `failed`, which this module already
 * reads as "nothing is coming". So the clock is a backstop for a transition we
 * might not see rather than a second opinion about a start systemd is still
 * running. `checking-retry-budget.test.ts` pins it to the shipped unit file so
 * the two cannot drift apart.
 *
 * Long, and that is the point: `ExecStartPre` re-provisions the dashboard's auth
 * on every start and a loaded Jetson can take a while over it. Waiting is
 * honest there; "Checking..." with a live poll behind it is what the owner
 * should see, and the poll flips to the truth the moment systemd gives up.
 */
export const UNIT_START_BUDGET_MS = 300_000;

/**
 * The longest any row can read `checking`, over EVERY branch — what the client
 * has to keep polling through, and the number that makes "checking always
 * resolves" a fact rather than a hope.
 *
 * The sum, not the larger: a unit may spend its whole start budget in
 * `ExecStartPre` and only then fork, and the socket clock starts there (see
 * {@link probeStillOwed}). Nothing can extend it further — the start budget runs
 * from the first unanswered read and is never renewed.
 */
export const MAX_CHECKING_WINDOW_MS = UNIT_START_BUDGET_MS + PROBE_GRACE_MS;

/** How long a systemd answer may be reused. One `systemctl` fork per second at
 *  worst, instead of one per request: two panels poll `/providers/status`
 *  independently and each re-asks while a row is checking, so the unmemoised
 *  read forked several times a second during exactly the window this feature
 *  exists for. The client's fastest retry step is 1 s, so a 1 s answer is never
 *  staler than the thing it is compared against. */
const UNIT_STATE_TTL_MS = 1_000;
let unitStateCached: HermesDashboardUnitState | null = null;
let unitStateAt = 0;
let unitStateInflight: Promise<HermesDashboardUnitState> | null = null;

async function cachedUnitState(): Promise<HermesDashboardUnitState> {
  if (unitStateCached && Date.now() - unitStateAt < UNIT_STATE_TTL_MS) return unitStateCached;
  // The PROMISE is shared, not just the value, so concurrent polls join one
  // fork instead of racing an empty cache — and the clock is stamped when the
  // answer LANDS, so a read that took the systemctl timeout is not born already
  // expired.
  unitStateInflight ??= hermesDashboardUnitState().finally(() => {
    unitStateInflight = null;
  });
  const state = await unitStateInflight;
  unitStateCached = state;
  unitStateAt = Date.now();
  return state;
}

/** When the live dashboard first failed to answer, or 0 while it is answering.
 *  Started by the first failure, cleared by the next success — never restarted
 *  by a later failure in the same outage, or the grace above would renew
 *  itself once a second and never expire. */
let firstUnansweredAt = 0;
/** When the unit was last SEEN to be starting, or 0.
 *  The socket-bind clock has to run from the moment the unit stopped starting,
 *  not from the first unanswered read: `Type=simple` reports `active/running`
 *  when ExecStart forks, so a start that spent a minute in `ExecStartPre` would
 *  otherwise arrive in `running` with its whole grace already spent and degrade
 *  a healthy boot on the last eleven seconds of it. Advanced ONLY while the
 *  start budget is still unspent (`probeStillOwed` checks the budget before it
 *  stamps, not after), so it can never exceed
 *  `firstUnansweredAt + `{@link UNIT_START_BUDGET_MS} — which is what makes
 *  {@link MAX_CHECKING_WINDOW_MS} a sum rather than an open end. */
let lastSeenStartingAt = 0;
/** Sequence of every dashboard read, and of the newest one that ANSWERED.
 *  Two reads overlap whenever an explicit refresh lands on top of a plain load
 *  (`load()` single-flights per mode, not across them), and they can settle out
 *  of order: an 8 s timeout from before the dashboard came up finishing after a
 *  refresh that just succeeded. Without this, that stale failure opens a debt
 *  against a box that is answering, and the panel says "Checking..." over a live
 *  dashboard until the next read clears it. */
let readSeq = 0;
let lastAnsweredSeq = 0;

/**
 * Is an answer from the dashboard still OWED, rather than overdue?
 *
 * The difference between "we have not been able to ask yet" and "we asked and
 * it is broken" — `/setup-api/providers/status` turns a true here into the row
 * state `checking` instead of `unknown` plus a degraded banner (TASK-663).
 *
 * TWO FACTS, AND BOTH ARE NEEDED. SYSTEMD says WHETHER the dashboard is still
 * starting — the unit that starts it is the thing that knows, and no clock
 * beside it can tell a slow `ExecStartPre` from a crash loop. A BUDGET says how
 * long we are willing to call that "checking" before degrading honestly: the
 * unit's own `TimeoutStartSec` where systemd is starting it, and
 * {@link PROBE_GRACE_MS} everywhere systemd's answer does not cover the wait —
 * a `Type=simple` unit already `running` while its socket is not up yet, and a
 * box whose systemd cannot be asked at all.
 *
 * Read at CALL time, never frozen into a payload. `getModelOptions` serves a
 * degraded payload from cache and refreshes behind the request, so a flag
 * stamped when the payload was BUILT reports the window as it stood a poll ago
 * — and the client's last retry would then be answered "still checking" by a
 * window that had already closed, leaving the panel spinning for good.
 */
export async function probeStillOwed(): Promise<boolean> {
  // Nothing has failed, so nothing is outstanding — including on a process that
  // has not asked yet, where there is nothing to wait for either.
  if (!firstUnansweredAt) return false;
  const unit = await cachedUnitState();
  // Failed, masked, or stopped and disabled (which is what an OpenClaw box does
  // to this unit): nothing is coming, so stop promising it and let the rows
  // degrade now rather than after a grace that means nothing here.
  if (unit === "down") return false;
  const now = Date.now();
  // BOUNDED IN EVERY BRANCH, which is the whole property. systemd's answer says
  // WHETHER the dashboard is still starting; the budget says how long we are
  // willing to call that "checking" before we degrade honestly. An unbounded
  // branch — any unbounded branch — turns "Checking..." into the same lie as the
  // degraded banner it replaces, pointing the other way.
  //
  // The start budget runs from the first UNANSWERED READ, because the question
  // the panel is asking is how long WE have been unable to answer it. The cost
  // is one case in the honest direction: a unit that starts fresh at the end of
  // a long outage is called degraded for the ~11 s until it answers, which is
  // exactly what a box that has been broken for ten minutes should say.
  if (unit === "starting") {
    // Checked BEFORE the latch is stamped, never after. A start we have already
    // given up on must not hand the socket clock below a fresh
    // `PROBE_GRACE_MS`: a unit that sits in `activating` for an hour would
    // otherwise buy back a `checking` window every time it finally forked, and
    // the panel would come back to "Checking..." long after it had honestly
    // degraded — the same unbounded window as before, reached from the far side
    // of the bound instead of through it.
    if (now - firstUnansweredAt >= UNIT_START_BUDGET_MS) return false;
    lastSeenStartingAt = now;
    return true;
  }
  // `running` (up, but a just-started process still has to bind its socket),
  // `restarting` (it died and systemd will start it again in RestartSec — this
  // app's own dashboard bounce and a crash loop look identical from one sample,
  // and this is the budget that serves both honestly), or `unknown`, where
  // systemd could not be asked at all. All three are the clock's, measured from
  // whichever came later: our first unanswered read, or the unit leaving the
  // start it was still in a moment ago.
  return now - Math.max(firstUnansweredAt, lastSeenStartingAt) < PROBE_GRACE_MS;
}

let cached: ModelOptionsPayload | null = null;
let inflight: Promise<ModelOptionsPayload> | null = null;
let inflightRefresh: Promise<ModelOptionsPayload> | null = null;
let lastExplicitRefreshAt = 0;
// Bumped on every invalidation. A load that STARTED before a config write must
// not be allowed to install its (pre-write) payload as the cache afterwards —
// clearing `cached` alone loses that race and resurrects the old selection for
// a full FRESH_MS.
let generation = 0;
// Memoised `/api/model/recommended-default` answers, keyed by provider and
// pinned to the payload they were computed for. Without this every provider
// click cost an uncached dashboard round-trip even on a warm catalogue — the
// exact thing the L1 cache exists to avoid.
const recommendedCache = new Map<string, { model: string; forFetchedAt: number }>();

/** Drop the cached payload. Call after anything that changes the device's
 *  model/provider selection or its credentials (a new API key flips a
 *  provider's `authenticated` flag and unlocks its model list). */
export function invalidateModelOptions(): void {
  cached = null;
  generation += 1;
  recommendedCache.clear();
  // The `hermes config get` memo keys on config.yaml's mtime, so a `config set`
  // already invalidates it. Clearing it here too costs nothing and means every
  // path that changes the selection drops both caches together — a stale
  // provider in the chat header is not worth being clever about.
  invalidateHermesConfigCache();
}

/** Hermes' id for the on-device model, mirrored from hermes-local-ai.ts. It is
 *  declared here rather than imported because that module imports this one. */
const HERMES_LOCAL_PROVIDER = "clawlocal";

/** The bare model id this device is configured to run locally, or "". Stored as
 *  "llamacpp/gemma4-e2b-it-q4_0"; Hermes addresses it without the prefix. */
async function configuredLocalModelId(): Promise<string> {
  try {
    const stored = await get("local_ai_model");
    if (typeof stored !== "string") return "";
    const bare = stored.split("/").pop() || "";
    return isSafeModelId(bare) ? bare : "";
  } catch {
    return "";
  }
}

// ── Dashboard shapes ─────────────────────────────────────────────────────────

interface DashboardProviderRow {
  slug?: unknown;
  name?: unknown;
  models?: unknown;
  total_models?: unknown;
  source?: unknown;
  authenticated?: unknown;
  verified?: unknown;
  is_user_defined?: unknown;
  warning?: unknown;
  featured_models?: unknown;
  pricing?: unknown;
}

interface DashboardEnvelope {
  providers?: unknown;
  model?: unknown;
  provider?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePricing(entry: unknown): HermesModelOption["pricing"] {
  if (!entry || typeof entry !== "object") return undefined;
  const p = entry as Record<string, unknown>;
  const input = asString(p.input);
  const output = asString(p.output);
  const free = typeof p.free === "boolean" ? p.free : undefined;
  if (!input && !output && free === undefined) return undefined;
  return { ...(input ? { input } : {}), ...(output ? { output } : {}), ...(free !== undefined ? { free } : {}) };
}

/** Hermes' virtual "Mixture of Agents" provider. */
const MOA_PROVIDER = "moa";
const HERMES_CONFIG_PATH = path.join(
  process.env.HERMES_HOME || path.join(process.env.HOME || "/home/clawbox", ".hermes"),
  "config.yaml",
);

let moaCache: { mtimeMs: number; configured: boolean } | null = null;

/**
 * True when `hermes moa configure` has actually filled in the aggregator's
 * slots. There is no API for this — the dashboard reports moa as authenticated
 * regardless, because a virtual provider has no credential to check — so the
 * only honest signal is whether a populated `moa:` block exists in config.yaml.
 * Cached by mtime: this is consulted on every catalogue build.
 */
export async function isMoaConfigured(): Promise<boolean> {
  try {
    const stat = await fs.stat(HERMES_CONFIG_PATH);
    if (moaCache && moaCache.mtimeMs === stat.mtimeMs) return moaCache.configured;
    const raw = await fs.readFile(HERMES_CONFIG_PATH, "utf8");
    // A top-level `moa:` key followed by at least one indented, non-comment
    // line. `moa:` on its own (or with only comments under it) is the shape
    // Hermes ships by default and means "not set up".
    const block = /(?:^|\n)moa:[ \t]*\n((?:[ \t]+.*\n|[ \t]*\n)*)/.exec(raw);
    const configured = Boolean(
      block && block[1].split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith("#")),
    );
    moaCache = { mtimeMs: stat.mtimeMs, configured };
    return configured;
  } catch {
    // No config yet (fresh device) → nothing is configured.
    return false;
  }
}

function normalizeRow(raw: DashboardProviderRow, localModelId: string): HermesProviderRow | null {
  const id = asString(raw.slug);
  if (!isPlausibleHermesProviderId(id)) return null;

  const featured = new Set(
    Array.isArray(raw.featured_models) ? raw.featured_models.filter((m): m is string => typeof m === "string") : [],
  );
  const pricingMap = raw.pricing && typeof raw.pricing === "object"
    ? (raw.pricing as Record<string, unknown>)
    : {};

  const seen = new Set<string>();
  const models: HermesModelOption[] = [];
  for (const entry of Array.isArray(raw.models) ? raw.models : []) {
    // The dashboard returns plain id strings; tolerate an object form in case a
    // future Hermes enriches the row.
    const modelId = typeof entry === "string"
      ? entry.trim()
      : asString((entry as { id?: unknown })?.id);
    if (!isSafeModelId(modelId) || seen.has(modelId)) continue;
    seen.add(modelId);
    const pricing = normalizePricing(pricingMap[modelId]);
    models.push({
      id: modelId,
      description: "",
      ...(featured.has(modelId) ? { featured: true } : {}),
      ...(pricing ? { pricing } : {}),
    });
  }

  // ClawBox AI is a CUSTOM provider, so Hermes reports what our own config
  // declares plus whatever `<base_url>/models` answers — and the proxy answers
  // that probe in a shape Hermes cannot read, so on a box whose
  // `providers.clawai.models` has not been written yet the row arrives EMPTY.
  // `applyClawaiToHermes` is what writes it, and `reconcileClawaiModelsWithHermes`
  // backfills a box linked before it did; this seed is the fallback for the
  // window in between, not the source of truth. On a declared box every id is
  // already in `seen` and the loop does nothing.
  //
  // Only ClawBox AI is seeded: these are ids we have PROVEN route on this
  // hardware. We never invent ids for a third-party provider — that is the
  // mismatch class this module exists to prevent.
  //
  // ONLY when the row is EMPTY, which is what "fallback" has to mean in code:
  // if Hermes ever reports a non-empty clawai list that differs from ours (a
  // renamed tier id, or the proxy starting to speak the OpenAI envelope with a
  // different set), topping it up would show the live ids PLUS two stale ones —
  // the provider/model mismatch this module exists to prevent.
  if (id === CLAWAI_PROVIDER && models.length === 0) {
    for (const known of COLD_START_MODELS[CLAWAI_PROVIDER] ?? []) {
      if (seen.has(known)) continue;
      seen.add(known);
      models.push({ id: known, description: "" });
    }
  }

  // The local model is the same shape of problem, for a different reason: it
  // runs on demand. When it is asleep — which is its normal resting state, and
  // the point of standby — nothing answers /v1/models, so the row arrives
  // authenticated with an empty list and the picker has nothing to offer. The
  // id is not a guess here: it is the model this device is configured to run,
  // read from our own config store by the caller.
  if (id === HERMES_LOCAL_PROVIDER && localModelId && !seen.has(localModelId)) {
    seen.add(localModelId);
    models.push({ id: localModelId, description: "on-device" });
  }

  const warning = asString(raw.warning);
  return {
    id,
    name: asString(raw.name) || id,
    authenticated: typeof raw.authenticated === "boolean" ? raw.authenticated : null,
    verified: typeof raw.verified === "boolean" ? raw.verified : null,
    isUserDefined: typeof raw.is_user_defined === "boolean" ? raw.is_user_defined : null,
    source: asString(raw.source) || "unknown",
    // `total_models` is the dashboard's count; after seeding it would understate
    // what we actually offer, so report the list we return.
    total: id === CLAWAI_PROVIDER || id === HERMES_LOCAL_PROVIDER
      ? models.length
      : (typeof raw.total_models === "number" ? raw.total_models : models.length),
    models,
    ...(warning ? { warning } : {}),
  };
}

// ── Sources, best → last resort ──────────────────────────────────────────────

async function fetchFromDashboard(refresh: boolean): Promise<ModelOptionsPayload | null> {
  const query = `?include_unconfigured=true${refresh ? "&refresh=true" : ""}`;
  let res: Response;
  try {
    res = await dashboardFetch(`/api/model/options${query}`, {
      signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS),
    });
  } catch {
    // Dashboard down / not yet logged in — fall through to the disk catalog.
    return null;
  }
  if (!res.ok) return null;

  let body: DashboardEnvelope;
  try {
    body = (await res.json()) as DashboardEnvelope;
  } catch {
    return null;
  }
  if (!Array.isArray(body.providers)) return null;

  const providers: HermesProviderRow[] = [];
  const moaReady = await isMoaConfigured();
  const localModelId = await configuredLocalModelId();
  for (const raw of body.providers) {
    const row = normalizeRow((raw ?? {}) as DashboardProviderRow, localModelId);
    if (!row) continue;
    // Mixture of Agents is a VIRTUAL provider: the dashboard always reports it
    // as authenticated with a single placeholder model called "default",
    // because there is no credential to check. But it does nothing until its
    // slots are filled in (`hermes moa configure`), so offering it in a picker
    // is offering a provider that cannot answer. Present it only once it is
    // actually set up; `authenticated: false` is the flag every consumer
    // already understands (the chat header filters it, the panel greys it, and
    // the pairing guard refuses it).
    if (row.id === MOA_PROVIDER && !moaReady) {
      providers.push({ ...row, authenticated: false });
      continue;
    }
    providers.push(row);
  }

  const currentProvider = asString(body.provider);
  const currentModel = asString(body.model);
  return {
    providers,
    current: {
      provider: isPlausibleHermesProviderId(currentProvider) ? currentProvider : "",
      model: isSafeModelId(currentModel) ? currentModel : "",
    },
    reasoning: "",
    fetchedAt: Date.now(),
    source: "dashboard",
    stale: false,
  };
}

interface DiskCatalog {
  providers?: Record<string, { models?: { id?: unknown; description?: unknown }[] }>;
}

async function readDiskCatalog(): Promise<HermesProviderRow[] | null> {
  let parsed: DiskCatalog;
  try {
    parsed = JSON.parse(await fs.readFile(CATALOG_PATH, "utf8")) as DiskCatalog;
  } catch {
    return null;
  }
  const rows: HermesProviderRow[] = [];
  for (const [slug, entry] of Object.entries(parsed.providers ?? {})) {
    if (!isPlausibleHermesProviderId(slug)) continue;
    const seen = new Set<string>();
    const models: HermesModelOption[] = [];
    for (const m of entry?.models ?? []) {
      const id = asString(m?.id);
      if (!isSafeModelId(id) || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, description: asString(m?.description) });
    }
    if (!models.length) continue;
    rows.push({
      id: slug,
      name: slug,
      // The manifest carries no credential state — say "unknown", never "yes".
      authenticated: null,
      verified: null,
      // Nor any notion of who defined the provider. Unknown, not "built-in".
      isUserDefined: null,
      source: "catalog-file",
      total: models.length,
      models,
    });
  }
  return rows.length ? rows : null;
}

/** Read the device's live selection straight from Hermes. Used when the
 *  dashboard couldn't answer — `hermes config get` is non-interactive and is
 *  the same store the dashboard reads, unlike the old config.yaml regex (whose
 *  `^\s*(?:default|model)\s*:` pattern matched the FIRST `model:` anywhere in
 *  the file, so it was order-dependent and wrong on some configs). */
export async function readCurrentFromCli(): Promise<{ provider: string; model: string; reasoning: string }> {
  // Three CLI spawns at ~600 ms each; memoised against config.yaml's mtime so
  // repeat reads (every chat open, every Settings visit) cost a stat.
  const [provider, model, reasoning] = await Promise.all([
    hermesConfigGet("model.provider"),
    hermesConfigGet("model.default"),
    hermesConfigGet("agent.reasoning_effort"),
  ]);
  return {
    provider: isPlausibleHermesProviderId(provider) ? provider : "",
    model: isSafeModelId(model) ? model : "",
    reasoning: /^[a-z]{2,10}$/.test(reasoning) ? reasoning : "",
  };
}

async function buildPayload(refresh: boolean): Promise<ModelOptionsPayload> {
  const seq = ++readSeq;
  // `agent.reasoning_effort` is not in the dashboard envelope, so it always
  // comes from the CLI. Run it alongside the dashboard call rather than after.
  const [dash, cli] = await Promise.all([
    fetchFromDashboard(refresh),
    readCurrentFromCli(),
  ]);

  // One live answer clears the debt; the first failure after an answer opens
  // it. See `probeStillOwed`, which is what reads this.
  //
  // ...unless a NEWER read has already answered, in which case this failure is
  // stale news about a dashboard that is demonstrably up, and opening a debt on
  // it would paint "Checking..." over a live box.
  if (dash) {
    firstUnansweredAt = 0;
    lastSeenStartingAt = 0;
    lastAnsweredSeq = seq;
  } else if (!firstUnansweredAt && lastAnsweredSeq < seq) {
    firstUnansweredAt = Date.now();
  }

  if (dash) {
    return {
      ...dash,
      reasoning: cli.reasoning,
      // The envelope is authoritative for the selection, but a cold dashboard
      // can omit it; the CLI read is the same store, so use it as the backstop.
      current: {
        provider: dash.current.provider || cli.provider,
        model: dash.current.model || cli.model,
      },
    };
  }

  const diskRows = await readDiskCatalog();
  if (diskRows) {
    return {
      providers: diskRows,
      current: { provider: cli.provider, model: cli.model },
      reasoning: cli.reasoning,
      fetchedAt: Date.now(),
      source: "catalog-file",
      stale: true,
    };
  }

  return {
    providers: Object.entries(COLD_START_MODELS).map(([id, ids]) => ({
      id,
      name: id,
      authenticated: null,
      verified: null,
      isUserDefined: true,
      source: "cold-start",
      total: ids.length,
      models: ids.map((mid) => ({ id: mid, description: "" })),
    })),
    current: { provider: cli.provider, model: cli.model },
    reasoning: cli.reasoning,
    fetchedAt: Date.now(),
    source: "cold-start",
    stale: true,
  };
}

/**
 * True when `next` is a worse answer than the `previous` one still in cache and
 * that cached answer has not aged out.
 *
 * Only downgrades are refused. An equal-or-better source always installs, so a
 * dashboard read that legitimately returns fewer providers (a key was removed)
 * still lands, and a stale-but-good cache still expires on its own schedule.
 */
function isDowngrade(next: ModelOptionsPayload, previous: ModelOptionsPayload): boolean {
  if (SOURCE_RANK[next.source] >= SOURCE_RANK[previous.source]) return false;
  return Date.now() - previous.fetchedAt < STALE_MS;
}

function load(refresh: boolean): Promise<ModelOptionsPayload> {
  // Single-flight PER MODE. Concurrent callers share one dashboard round-trip,
  // but an explicit refresh must never be satisfied by a plain in-flight load:
  // that request carries no `?refresh=true`, so Hermes' per-provider disk cache
  // would not be busted and the user's Refresh would silently no-op (while
  // still burning the 10 s throttle window). A plain load may join a refresh —
  // a refresh is a strict superset.
  const existing = refresh ? inflightRefresh : (inflightRefresh ?? inflight);
  if (existing) return existing;

  const gen = generation;
  const previous = cached;
  const run = buildPayload(refresh)
    .then((payload) => {
      // A dashboard timeout makes buildPayload fall back to the 2-provider disk
      // manifest. Installing that over a healthy 47-provider cache — which is
      // what used to happen, unconditionally — turns one transient 8 s timeout
      // into a device that has apparently lost 45 providers, and a `?refresh=1`
      // an anonymous caller could trigger into a catalogue-poisoning primitive.
      // Serve the better payload we already have and SAY that the refresh
      // failed. TASK-446.
      if (previous && isDowngrade(payload, previous)) {
        const kept: ModelOptionsPayload = { ...previous, degraded: "dashboard-unreachable" };
        if (gen === generation) cached = kept;
        return kept;
      }
      // A config write landed while we were reading, so this payload's
      // `current` is pre-write. Hand it to the caller that asked for it, but
      // never let it become the cache for everyone else.
      if (gen === generation) cached = payload;
      return payload;
    })
    .finally(() => {
      if (refresh) inflightRefresh = null;
      else inflight = null;
    });
  if (refresh) inflightRefresh = run;
  else inflight = run;
  return run;
}

/**
 * Serve the provider/model catalogue.
 *   live, fresh (<60 s)  → cached, no network
 *   live, stale (<6 h)   → cached instantly + background refresh (never awaited)
 *   fallback (`stale`)   → cached instantly + background refresh, once a second
 *   older / absent       → await a live fetch
 *   { refresh }          → await a live fetch that also busts Hermes'
 *                          per-provider disk cache (one per 10 s per process)
 */
export async function getModelOptions(opts: { refresh?: boolean } = {}): Promise<ModelOptionsPayload> {
  const now = Date.now();

  if (opts.refresh) {
    // Throttled: fall through to the plain path rather than returning here, so
    // a click-spammer is denied the EXPENSIVE upstream sweep without also being
    // handed a placeholder the rule below would have gone back for.
    if (now - lastExplicitRefreshAt >= EXPLICIT_REFRESH_MIN_GAP_MS || !cached) {
      lastExplicitRefreshAt = now;
      return load(true);
    }
  }

  if (cached) {
    const age = now - cached.fetchedAt;
    // A FALLBACK IS NOT AN ANSWER, so it does not earn an answer's freshness
    // window.
    //
    // It is Hermes' on-disk manifest (`openrouter` + `nous`, and nothing about
    // this device) or the cold-start floor, and it is served precisely because
    // the dashboard could not be reached. Holding it for `FRESH_MS` turned
    // every reboot's ~11-12 s window — `clawbox-setup` answers in 0 ms,
    // `clawbox-hermes-dashboard` needs another eleven seconds — into a full
    // MINUTE of a device that appeared to have two providers and no models,
    // for the chat header, the Settings panel and the MCP tools alike.
    // `isDowngrade` cannot help there: it compares against the previous CACHED
    // payload, and on a cold process there is none.
    //
    // Refreshed BEHIND the request rather than awaited, though. Awaiting was
    // tried and is wrong: it deletes the cache for as long as the box is
    // degraded, and every caller pays for that — the per-turn chat path
    // (hermes/chat), the OAuth device-code poll (twice per tick through
    // `readUsableProviderIds`), `provider-mcp-refresh` twice per credential
    // write under its 3 s deadline, and the deliberately session-less GET on
    // this route, which would then drive a dashboard round-trip per anonymous
    // request. `DASHBOARD_TIMEOUT_MS` does not bound that either: the login
    // `dashboardFetch` performs before its first attempt carries no signal. The
    // client re-asks on its own now (`degradedRetryDelayMs` in
    // useHermesModelOptions), so nothing has to block for recovery to happen —
    // the next poll finds what this refresh installed.
    //
    // The flag read here is `payload.stale` — "did not come from the live
    // dashboard" — and NOT the `degraded` marker: a payload the downgrade guard
    // KEPT is a live catalogue whose refresh failed, and holding on to that is
    // the whole point of the guard.
    if (cached.stale) {
      // One attempt per second at most, so a burst of readers cannot turn a
      // degraded box into a request loop against its own dashboard. Matched to
      // the client's first retry step, so a retry arriving on schedule always
      // triggers a real attempt rather than joining a throttled window.
      if (age >= DEGRADED_REFRESH_GAP_MS) void load(false).catch(() => {});
      return cached;
    }
    if (age < FRESH_MS) return cached;
    if (age < STALE_MS) {
      // Serve stale immediately; refresh behind the request. Failures here are
      // intentionally swallowed — the caller already has a usable payload.
      void load(false).catch(() => {});
      return cached;
    }
  }
  return load(false);
}

/**
 * The catalogue ONLY if this process already has it, and null otherwise. Never
 * fetches, never starts a background refresh.
 *
 * For a caller that would rather answer without the catalogue than wait for it:
 * a turn that has already been answered and is only deciding what to LABEL it
 * (`billedProviderFor` in the chat route). `getModelOptions` awaits a live fetch
 * on a cold process — a dashboard call plus three `hermes config get` spawns —
 * and doing that after the reply has streamed holds the `done` frame, and the
 * durable transcript write with it, for a check the same code waives whenever
 * the fetch fails. Absent is treated exactly like failed there.
 *
 * The same `STALE_MS` bound `getModelOptions` uses to stop serving from cache:
 * past it, this process's copy is not evidence about anything.
 */
export function cachedModelOptions(): ModelOptionsPayload | null {
  if (!cached) return null;
  return Date.now() - cached.fetchedAt < STALE_MS ? cached : null;
}

// ── Scoping (REQ 1) ──────────────────────────────────────────────────────────

/** Every provider id the device currently accepts: the static allowlist plus
 *  any user-defined slug the live dashboard reported. */
export function allowedProviderIds(payload: ModelOptionsPayload): Set<string> {
  const ids = new Set<string>([HERMES_AUTO_PROVIDER]);
  for (const row of payload.providers) ids.add(row.id);
  return ids;
}

export function isAllowedProvider(payload: ModelOptionsPayload, provider: string): boolean {
  return isHermesCliProvider(provider) || allowedProviderIds(payload).has(provider);
}

function rowFor(payload: ModelOptionsPayload, provider: string): HermesProviderRow | undefined {
  return payload.providers.find((p) => p.id === provider);
}

/**
 * Models "auto" may land on.
 *
 * This used to union EVERY authenticated row's ids, which re-opened the exact
 * cross-vendor mismatch this module exists to close: on this device that union
 * is OpenRouter's vendor-prefixed slugs ("anthropic/claude-opus-5") next to
 * clawai's BARE "deepseek-v4-pro" and moa's literal "default". `isPairAllowed`
 * blessed any member, so `{provider:"auto", model:"deepseek-v4-pro"}` was
 * persistable — and whichever concrete provider hermes then resolved "auto" to
 * could not serve the other namespace's id.
 *
 * Auto is therefore scoped to the ONE row the device is actually configured
 * for. That is the only provider we can name without guessing hermes'
 * resolution order, and it keeps the list inside a single namespace.
 */
function autoModels(payload: ModelOptionsPayload): HermesModelOption[] {
  const resolved = payload.current.provider;
  if (!resolved || resolved === HERMES_AUTO_PROVIDER) return [];
  const row = payload.providers.find((p) => p.id === resolved);
  if (!row || row.authenticated === false) return [];
  return row.models;
}

/** Hermes' own "sensible landing model" for a provider (mirrors
 *  pick_silent_default_model, which deliberately avoids the priciest
 *  flagship). Returns "" for a provider with no usable credentials. */
async function recommendedDefault(provider: string, forFetchedAt: number): Promise<string> {
  if (!isPlausibleHermesProviderId(provider)) return "";
  // Pinned to the payload it belongs to: the recommendation can only change
  // when the catalogue does, and `invalidateModelOptions` clears the map.
  const hit = recommendedCache.get(provider);
  if (hit && hit.forFetchedAt === forFetchedAt) return hit.model;
  try {
    const res = await dashboardFetch(
      `/api/model/recommended-default?provider=${encodeURIComponent(provider)}`,
      { signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS) },
    );
    if (!res.ok) return "";
    const body = (await res.json()) as { model?: unknown };
    const raw = asString(body.model);
    const model = isSafeModelId(raw) ? raw : "";
    recommendedCache.set(provider, { model, forFetchedAt });
    return model;
  } catch {
    // Don't cache a transient failure — the next click should retry.
    return "";
  }
}

/**
 * The REQ 1 contract. `current` is computed here, server-side, from
 * `payload.current.provider === provider` — so a client asking for Anthropic
 * physically cannot be handed the saved clawai `deepseek-v4-flash` id.
 */
export async function scopeFromPayload(
  payload: ModelOptionsPayload,
  provider: string,
): Promise<ProviderScope> {
  const row = rowFor(payload, provider);
  const models = provider === HERMES_AUTO_PROVIDER ? autoModels(payload) : (row?.models ?? []);
  const authenticated = provider === HERMES_AUTO_PROVIDER
    ? models.length > 0
    : (row?.authenticated ?? null);

  const saved = payload.current;
  const inScopeCurrent = saved.provider === provider && models.some((m) => m.id === saved.model)
    ? saved.model
    : "";

  let defaultModel = inScopeCurrent;
  if (!defaultModel && models.length) {
    const recommended = await recommendedDefault(provider, payload.fetchedAt);
    defaultModel = models.some((m) => m.id === recommended)
      ? recommended
      : (models.find((m) => m.featured)?.id ?? models[0].id);
  }

  return {
    provider,
    authenticated,
    models,
    defaultModel,
    current: inScopeCurrent,
    savedElsewhere: saved.provider && saved.provider !== provider
      ? { provider: saved.provider, model: saved.model }
      : null,
    ...(row?.warning ? { warning: row.warning } : {}),
    source: payload.source,
    stale: payload.stale,
    fetchedAt: payload.fetchedAt,
  };
}

/** Convenience wrapper for callers that don't already hold a payload. */
export async function getProviderScope(
  provider: string,
  opts: { refresh?: boolean } = {},
): Promise<ProviderScope> {
  return scopeFromPayload(await getModelOptions(opts), provider);
}

/**
 * True when the payload actually carries a model list for `provider`.
 *
 * A row with zero models means "we could not enumerate this provider" (a
 * credentialed provider whose /v1/models is unreachable, or a custom proxy that
 * exposes none), NOT "this provider serves nothing" — so a caller that would
 * otherwise reject an unlisted model must first ask this and skip the check.
 * Without it, one unenumerable provider would make chat impossible.
 */
export function providerHasModels(payload: ModelOptionsPayload, provider: string): boolean {
  if (provider === HERMES_AUTO_PROVIDER) return autoModels(payload).length > 0;
  return (rowFor(payload, provider)?.models.length ?? 0) > 0;
}

/**
 * True when we know enough about `provider` to JUDGE a pairing.
 *
 * A zero-model row has two very different causes and `providerHasModels` alone
 * cannot tell them apart:
 *   · `authenticated === false` — no credentials, so the provider serves
 *     NOTHING and any model paired with it is wrong. We must enforce.
 *   · `authenticated !== false` with an empty list — credentialed but its
 *     /v1/models could not be enumerated (unreachable endpoint, custom proxy
 *     that lists none). Rejecting here would make a legitimate pairing
 *     impossible, so we tolerate.
 * Gating on "has models" alone fails OPEN on every unauthenticated provider —
 * which is every direct provider on an un-onboarded device — and let
 * `{provider:"anthropic", model:"deepseek-v4-flash"}` be written to config.
 */
export function shouldEnforcePairing(payload: ModelOptionsPayload, provider: string): boolean {
  // A stale payload is not evidence about anything.
  if (payload.stale) return false;
  if (provider === HERMES_AUTO_PROVIDER) return autoModels(payload).length > 0;
  const row = rowFor(payload, provider);
  if (!row) return false;
  return row.authenticated === false || row.models.length > 0;
}

/** Server-side pairing check for POST bodies and for the chat route's
 *  --provider/-m combination. */
export function isPairAllowed(
  payload: ModelOptionsPayload,
  provider: string,
  model: string,
): boolean {
  if (provider === HERMES_AUTO_PROVIDER) {
    return autoModels(payload).some((m) => m.id === model);
  }
  return rowFor(payload, provider)?.models.some((m) => m.id === model) ?? false;
}
