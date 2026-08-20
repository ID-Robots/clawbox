import { NextResponse } from "next/server";
import { readConfig } from "@/lib/openclaw-config";
import { get as getConfigValue, set as setConfigValue } from "@/lib/config-store";
import {
  normalizeClawboxAiTier,
  normalizeClawboxAiPlan,
  monthlyImageLimitForPlan,
  CLAWBOX_AI_IMAGE_MODEL_ID,
  CLAWBOX_AI_PLAN_LABEL,
  type ClawboxAiTier,
  type ClawboxAiPlan,
} from "@/lib/clawbox-ai-models";
import { getActiveHarness } from "@/lib/harness";
import { hermesConfigGetMany } from "@/lib/hermes-config-cache";

export const dynamic = "force-dynamic";

const PROVIDER_LABELS: Record<string, string> = {
  clawai: "ClawBox AI",
  anthropic: "Anthropic Claude",
  openai: "OpenAI GPT",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  ollama: "Ollama Local",
  llamacpp: "llama.cpp Local",
  // Hermes' id for the on-device model. Without an entry here the raw
  // "clawlocal" leaked into the UI as a provider name. Matches the wording in
  // lib/hermes-providers.ts so the same model isn't called two things.
  clawlocal: "Gemma 4 (on-device)",
};

const CLAWBOX_AI_TIER_CONFIG_KEY = "clawai_tier";
// Config-store key holding the ClawBox AI portal token on a Hermes device.
// `applyClawaiToHermes` writes it here; the OpenClaw path reads the same token
// from `models.providers.deepseek.apiKey` in openclaw.json instead.
const CLAWBOX_AI_TOKEN_CONFIG_KEY = "clawai_token";

// Portal endpoint that maps a `claw_*` token to its current subscription
// state. Authoritative source for the device's tier badge — local config
// only ever stored the user's wizard *selection*, which can drift from
// what the portal actually grants (Free user pastes a token + clicks Max
// pill → local says "pro" but token entitles only Free).
const PORTAL_DEVICE_INFO_URL =
  process.env.CLAWBOX_AI_DEVICE_INFO_URL?.trim()
  || "https://clawbox.com/api/clawbox-ai/device-info";

// 120s TTL > 30s poll cadence so most polls land on a warm cache. The
// portal's reconcile-tier already self-heals on its end inside its own
// 60s window, so 120s here is still bounded by Stripe truth on the
// far side.
const PORTAL_TIER_CACHE_TTL_MS = 120_000;
// 4s timeout — this fetch sits on the render path of the chat header
// and Settings card. Anything longer stacks behind the 30s poll cadence
// and stalls the badge update. On timeout we treat the portal as
// unreachable and fall back to the picker selection.
const PORTAL_FETCH_TIMEOUT_MS = 4_000;
// Bound for the in-memory token cache. A single device only has one
// active claw_ token at a time, so this only matters under factory-
// reset / multi-account dev churn — but a long-running process would
// otherwise leak entries forever.
const PORTAL_TIER_CACHE_MAX_ENTRIES = 64;
// Short negative-cache window for tokens whose last portal lookup
// resolved to `unreachable` (4xx auth failure, 5xx, or network
// error). With useClawboxLogin polling every 30s, this caps the
// per-device portal load during a sustained auth-failure or
// outage at ~1 request per 30s (down from 1-per-poll). Smaller
// than PORTAL_TIER_CACHE_TTL_MS because the positive cache is
// safe to hold longer; an unreachable verdict needs to clear
// quickly enough that recovery (token re-pair, portal recovers)
// shows up on the next poll, not minutes later.
const PORTAL_UNREACHABLE_TTL_MS = 30_000;

interface DeviceInfoResponse {
  tier?: string;
  deviceTier?: string | null;
}

type PortalLookup =
  | { source: "portal"; tier: ClawboxAiTier | null; plan: ClawboxAiPlan | null }
  | { source: "unreachable" };

interface PortalCacheEntry {
  tier: ClawboxAiTier | null;
  // Subscription plan behind the tier. Kept alongside `tier` because the two
  // are not interchangeable: `tier` collapses Free and "portal said something
  // we don't recognise" into the same `null`, and the image allowance has to
  // tell those apart (Free has a real 5-image allowance to show).
  plan: ClawboxAiPlan | null;
  expiresAt: number;
}

const portalTierCache = new Map<string, PortalCacheEntry>();
// token → epoch-ms timestamp when its unreachable verdict expires.
// Separate from portalTierCache because the value is "we tried and
// it failed, don't try again yet" rather than "the answer is null".
const portalUnreachableCache = new Map<string, number>();
const inFlightPortalLookups = new Map<string, Promise<PortalLookup>>();

/**
 * Writes a token's resolved tier into the in-memory cache, sweeping
 * expired entries and enforcing the size cap before insertion. Map
 * iteration order is insertion order, so the first key returned by
 * `keys()` is the oldest.
 *
 * @param token Portal token (`claw_*`) used as the cache key.
 * @param tier Resolved tier (or `null` for Free / no entitlement).
 * @param plan Resolved subscription plan (or `null` when unrecognised).
 * @param now Current epoch ms; used both for expiry comparison and to
 *   set the new entry's `expiresAt`.
 */
function rememberTier(
  token: string,
  tier: ClawboxAiTier | null,
  plan: ClawboxAiPlan | null,
  now: number,
) {
  for (const [key, entry] of portalTierCache) {
    if (entry.expiresAt <= now) portalTierCache.delete(key);
  }
  while (portalTierCache.size >= PORTAL_TIER_CACHE_MAX_ENTRIES) {
    const oldest = portalTierCache.keys().next().value;
    if (oldest === undefined) break;
    portalTierCache.delete(oldest);
  }
  portalTierCache.set(token, { tier, plan, expiresAt: now + PORTAL_TIER_CACHE_TTL_MS });
}

/**
 * Maps the portal's `device-info` response to the local `ClawboxAiTier`
 * enum the UI badges already understand. Prefers the device-pair stamp
 * (`deviceTier`) when present; otherwise translates the user's plan
 * name (`tier`) to its corresponding device-tier. The local enum is
 * `"flash"` (Pro plan / V4 Flash model) and `"pro"` (Max plan / V4 Pro
 * model); Free / unpaid resolves to `null` (no paid badge rendered).
 *
 * @param body Parsed JSON from `/api/clawbox-ai/device-info`.
 * @returns The badge-facing tier, or `null` for Free.
 */
function mapPortalTier(body: DeviceInfoResponse): ClawboxAiTier | null {
  const plan = (body.tier ?? "").trim().toLowerCase();
  // Subscription plan is the source of truth — a stale or bogus
  // deviceTier stamp on a Free account must never grant a paid badge.
  if (plan !== "pro" && plan !== "max") return null;
  // Paid: prefer the explicit device-pair stamp (lets Max subs run
  // flash); otherwise map plan → device tier.
  const stamped = normalizeClawboxAiTier(body.deviceTier);
  if (stamped) return stamped;
  return plan === "max" ? "pro" : "flash";
}

/**
 * Resolves a `claw_*` token's current tier against the portal, with
 * a short in-memory cache and concurrent-request de-duplication.
 *
 * Cache semantics:
 *   - 200 OK: parsed tier is cached for `PORTAL_TIER_CACHE_TTL_MS`.
 *   - Non-200 / network error: token is marked unreachable for
 *     `PORTAL_UNREACHABLE_TTL_MS` so we don't hit the portal every
 *     30 s status poll during a sustained auth failure or outage.
 *     A successful 200 clears the unreachable mark so recovery is
 *     responsive.
 *
 * 401/403 are deliberately treated the same as 5xx/network errors
 * (unreachable) rather than as a definitive "Free" verdict — see
 * the non-200 branch in the body for the rationale.
 *
 * @param token The bearer token to look up.
 * @returns Either a definitive `{ source: "portal", tier }` answer or
 *   `{ source: "unreachable" }` when the portal couldn't respond.
 */
async function fetchPortalTier(token: string): Promise<PortalLookup> {
  const now = Date.now();
  const cached = portalTierCache.get(token);
  if (cached && cached.expiresAt > now) {
    return { source: "portal", tier: cached.tier, plan: cached.plan };
  }

  const unreachableUntil = portalUnreachableCache.get(token);
  if (unreachableUntil !== undefined && unreachableUntil > now) {
    return { source: "unreachable" };
  }

  const existing = inFlightPortalLookups.get(token);
  if (existing) return existing;

  const promise = (async (): Promise<PortalLookup> => {
    const markUnreachable = (): PortalLookup => {
      portalUnreachableCache.set(token, now + PORTAL_UNREACHABLE_TTL_MS);
      return { source: "unreachable" };
    };
    try {
      const res = await fetch(PORTAL_DEVICE_INFO_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PORTAL_FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = await res.json() as DeviceInfoResponse;
        const tier = mapPortalTier(body);
        const plan = normalizeClawboxAiPlan(body.tier);
        rememberTier(token, tier, plan, now);
        portalUnreachableCache.delete(token);
        return { source: "portal", tier, plan };
      }
      // 401/403 is ambiguous: it can mean genuinely Free OR token
      // revoked / migrated / corrupted on a still-paid account. We
      // can't tell from the response alone, and treating it as
      // "Free" silently downgrades paid users with broken auth (and
      // fires the downgrade-celebration popup). Mark unreachable
      // instead so callers preserve localTier.
      return markUnreachable();
    } catch {
      return markUnreachable();
    }
  })();

  inFlightPortalLookups.set(token, promise);
  try {
    return await promise;
  } finally {
    inFlightPortalLookups.delete(token);
  }
}

/**
 * Test-only escape hatch — clears both the value cache and any
 * in-flight lookups so vitest's `beforeEach` can start each test from
 * a clean module-state. Not for production use.
 */
export function _resetPortalTierCache() {
  portalUnreachableCache.clear();
  portalTierCache.clear();
  inFlightPortalLookups.clear();
}

function normalizeProvider(provider: string | null): string | null {
  if (!provider) return null;
  const normalized = provider.trim().toLowerCase();
  if (normalized === "deepseek" || normalized === "clawai") return "clawai";
  // `codex` is the ChatGPT-subscription provider id (was `openai-codex`
  // on OpenClaw <=2026.5.x); collapse it under openai for the UI like the
  // openai* prefixes above.
  if (normalized.startsWith("openai") || normalized === "codex") return "openai";
  if (normalized.startsWith("google")) return "google";
  if (normalized.startsWith("anthropic")) return "anthropic";
  if (normalized.startsWith("openrouter")) return "openrouter";
  if (normalized.startsWith("ollama")) return "ollama";
  if (normalized.startsWith("llamacpp")) return "llamacpp";
  return normalized;
}

/**
 * The provider/model/ClawBox-AI facts the status response is built from,
 * resolved from whichever agent config the active harness actually uses.
 */
interface ResolvedAiState {
  /** Active chat provider in wire form (pre-normalization), or null. */
  provider: string | null;
  /** Auth mode of the active profile, when the config records one. */
  mode: string | null;
  /** Primary/default model id, or null. */
  model: string | null;
  /** True when a ClawBox AI profile is configured (independent of active provider). */
  hasClawaiProfile: boolean;
  /** The paired `claw_*` portal token, or null when none/not a portal token. */
  clawaiToken: string | null;
}

/**
 * OpenClaw path: read `~/.openclaw/openclaw.json`. The active profile is matched
 * against the primary model so a ClawBox AI fallback profile alongside the
 * user's chosen provider isn't reported as the active one.
 */
async function resolveOpenclawAiState(): Promise<ResolvedAiState> {
  const config = await readConfig();

  const profiles = config.auth?.profiles ?? {};
  const model = config.agents?.defaults?.model?.primary ?? null;

  const profileKeys = Object.keys(profiles);
  // Normalize both sides through normalizeProvider so the deepseek/clawai
  // alias collapses correctly. Without this, a primary model of
  // `clawai/deepseek-v4-pro` (canonical) would never match a profile
  // recorded under the wire-format `deepseek` provider, and we'd silently
  // fall back to profileKeys[0].
  const primaryProviderHint = normalizeProvider(model ? model.split("/")[0] : null);
  let activeKey: string | undefined;
  if (primaryProviderHint) {
    activeKey = profileKeys.find((key) => {
      const entry = profiles[key];
      const entryProvider = normalizeProvider(entry?.provider ?? key.split(":")[0]);
      return entryProvider === primaryProviderHint;
    });
  }
  activeKey ??= profileKeys[0];

  let provider: string | null = null;
  let mode: string | null = null;
  if (activeKey) {
    const entry = profiles[activeKey];
    provider = entry?.provider ?? activeKey.split(":")[0];
    mode = entry?.mode ?? null;
  }

  const clawaiTokenCandidate = config.models?.providers?.deepseek?.apiKey;
  const clawaiToken = typeof clawaiTokenCandidate === "string" && clawaiTokenCandidate.startsWith("claw_")
    ? clawaiTokenCandidate
    : null;
  const hasClawaiProfile = profileKeys.some((key) => {
    const entry = profiles[key];
    const entryProvider = normalizeProvider(entry?.provider ?? key.split(":")[0]);
    return entryProvider === "clawai";
  });

  return { provider, mode, model, hasClawaiProfile, clawaiToken };
}

/**
 * Hermes path: there is no OpenClaw config on a Hermes device, so resolve the
 * same facts from Hermes' own config (`~/.hermes/config.yaml`, read through the
 * mtime-memoised CLI helper) plus the config-store token. `applyClawaiToHermes`
 * writes `providers.clawai.*` when ClawBox AI is set up and points
 * `model.provider` at it, so those are the authoritative signals here — the
 * same ones `/setup-api/hermes/clawai` reads. Without this, the OpenClaw-only
 * read left `clawaiConfigured` false on a signed-in Hermes box and the Remote
 * Control panel kept prompting the user to sign in.
 */
async function resolveHermesAiState(): Promise<ResolvedAiState> {
  const cfg = await hermesConfigGetMany([
    "model.provider",
    "model.default",
    "providers.clawai.base_url",
  ]);
  const provider = cfg["model.provider"] || null;
  const model = cfg["model.default"] || null;
  // The provider block persists even when the user later switches the active
  // provider to something else, so its presence — not the active provider — is
  // what "a ClawBox AI account is configured" means.
  const hasClawaiProfile = Boolean(cfg["providers.clawai.base_url"]);

  const tokenRaw = await getConfigValue(CLAWBOX_AI_TOKEN_CONFIG_KEY).catch(() => null);
  const clawaiToken = typeof tokenRaw === "string" && tokenRaw.startsWith("claw_") ? tokenRaw : null;

  // Hermes has no per-profile "mode" concept the way OpenClaw's auth.profiles
  // does, so leave it null (the OpenClaw path filled it from the profile).
  return { provider, mode: null, model, hasClawaiProfile, clawaiToken };
}

/**
 * Build the status response from resolved AI state. Shared by both harness
 * paths so the ClawBox AI tier/portal-reconcile logic can never drift between
 * them.
 */
async function buildStatusResponse(state: ResolvedAiState): Promise<NextResponse> {
  const normalizedProvider = normalizeProvider(state.provider);

  // ClawBox AI account entitlement is independent of which provider is
  // currently driving the chat. A Max subscriber chatting via OpenAI
  // still has the paid plan that unlocks ClawKeep + Remote Desktop —
  // resolving the tier off the active profile alone (the old
  // behaviour) falsely blocks them.
  const localTier = normalizeClawboxAiTier(
    await getConfigValue(CLAWBOX_AI_TIER_CONFIG_KEY).catch(() => null),
  );

  let clawaiAccountTier: ClawboxAiTier | null = null;
  let accountTierSource: "portal" | "picker" = "picker";
  // Only ever set from a live portal answer. There is no local fallback on
  // purpose: the stored `clawai_tier` is a device tier, and inferring a plan
  // back out of it cannot distinguish Free from "we never asked", so a guess
  // here would put a wrong image allowance in front of the user.
  let clawaiPlan: ClawboxAiPlan | null = null;
  if (state.hasClawaiProfile) {
    clawaiAccountTier = localTier;
    // Ask the portal whenever a clawai token is paired, regardless
    // of whether we have a local tier yet. This is what makes
    // Free → Paid upgrades visible without forcing a re-login.
    // mapPortalTier now gates non-null returns on a paid plan, so
    // a bogus deviceTier stamp can no longer promote a Free user.
    if (state.clawaiToken) {
      const lookup = await fetchPortalTier(state.clawaiToken);
      if (lookup.source === "portal") {
        clawaiAccountTier = lookup.tier;
        clawaiPlan = lookup.plan;
        accountTierSource = "portal";
        // Persist the portal-confirmed tier so the portal-unreachable
        // fallback reflects the last *confirmed* tier, not a stale
        // configure-time value (which flapped a Free badge to Pro and
        // re-fired the celebration). Write only on change to avoid churn.
        if (lookup.tier !== localTier) {
          await setConfigValue(CLAWBOX_AI_TIER_CONFIG_KEY, lookup.tier).catch(() => {});
        }
      }
    }
  }

  // The badge-facing tier mirrors the account tier *only* when
  // ClawBox AI is the active chat provider. Switching to OpenAI in
  // the chat dropdown should hide the chat-header tier badge — the
  // user isn't currently chatting with ClawBox AI — without
  // demoting their account-level entitlement.
  const clawaiTier = normalizedProvider === "clawai" ? clawaiAccountTier : null;
  const tierSource = normalizedProvider === "clawai" ? accountTierSource : "picker";

  return NextResponse.json({
    connected: !!normalizedProvider,
    provider: normalizedProvider,
    providerLabel: normalizedProvider ? (PROVIDER_LABELS[normalizedProvider] ?? normalizedProvider) : null,
    mode: state.mode,
    model: state.model,
    clawaiTier,
    clawaiAccountTier,
    // Whether *any* clawai profile is configured. Distinguishes
    // "no ClawBox AI account at all" (false) from "Free user with
    // a paired clawai token" (true, clawaiAccountTier=null) — the
    // hook needs this to gate ClawKeep / Remote Desktop sign-in
    // prompts independently of paid-tier checks.
    clawaiConfigured: state.hasClawaiProfile,
    tierSource,
    // Monthly image allowance, so a user learns the cap exists *before* they
    // run into it rather than only from a failed request.
    //
    // What this is NOT: a usage counter. The cloud proxy is the only counter,
    // and it reports live usage in the `X-ClawBox-Images-*` response headers on
    // the images endpoint — which the gateway calls directly, so the device
    // never sees those headers and cannot honestly report `used`/`remaining`
    // here. Publishing a device-side count would mean either inventing a second
    // counter or serving a cached number as if it were live. Both are worse
    // than saying only what we actually know, which is the allowance.
    //
    // `monthlyLimit` is null whenever the portal did not answer this request
    // cycle. Callers must render nothing in that case; a default would be a
    // guess at the user's subscription.
    clawaiImages: {
      supported: state.hasClawaiProfile,
      model: CLAWBOX_AI_IMAGE_MODEL_ID,
      plan: clawaiPlan,
      planLabel: clawaiPlan ? CLAWBOX_AI_PLAN_LABEL[clawaiPlan] : null,
      monthlyLimit: monthlyImageLimitForPlan(clawaiPlan),
    },
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function GET() {
  try {
    // Resolve from whichever config the active harness actually uses. A Hermes
    // device has no OpenClaw config at all, so reading only openclaw.json there
    // reported "no ClawBox AI" for a signed-in box.
    const harness = await getActiveHarness();
    const state = harness === "hermes"
      ? await resolveHermesAiState()
      : await resolveOpenclawAiState();
    return await buildStatusResponse(state);
  } catch {
    return NextResponse.json(
      {
        connected: false, provider: null, providerLabel: null, mode: null, model: null,
        clawaiTier: null, clawaiAccountTier: null, clawaiConfigured: false, tierSource: "picker",
        clawaiImages: { supported: false, model: CLAWBOX_AI_IMAGE_MODEL_ID, plan: null, planLabel: null, monthlyLimit: null },
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
