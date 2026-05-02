import { NextResponse } from "next/server";
import { readConfig } from "@/lib/openclaw-config";
import { get as getConfigValue } from "@/lib/config-store";
import { normalizeClawboxAiTier, type ClawboxAiTier } from "@/lib/clawbox-ai-models";

export const dynamic = "force-dynamic";

const PROVIDER_LABELS: Record<string, string> = {
  clawai: "ClawBox AI",
  anthropic: "Anthropic Claude",
  openai: "OpenAI GPT",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  ollama: "Ollama Local",
  llamacpp: "llama.cpp Local",
};

const CLAWBOX_AI_TIER_CONFIG_KEY = "clawai_tier";

// Portal endpoint that maps a `claw_*` token to its current subscription
// state. Authoritative source for the device's tier badge — local config
// only ever stored the user's wizard *selection*, which can drift from
// what the portal actually grants (Free user pastes a token + clicks Max
// pill → local says "pro" but token entitles only Free).
const PORTAL_DEVICE_INFO_URL =
  process.env.CLAWBOX_AI_DEVICE_INFO_URL?.trim()
  || "https://openclawhardware.dev/api/clawbox-ai/device-info";

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

interface DeviceInfoResponse {
  tier?: string;
  deviceTier?: string | null;
}

type PortalLookup =
  | { source: "portal"; tier: ClawboxAiTier | null }
  | { source: "unreachable" };

interface PortalCacheEntry {
  tier: ClawboxAiTier | null;
  expiresAt: number;
}

const portalTierCache = new Map<string, PortalCacheEntry>();
const inFlightPortalLookups = new Map<string, Promise<PortalLookup>>();

/**
 * Writes a token's resolved tier into the in-memory cache, sweeping
 * expired entries and enforcing the size cap before insertion. Map
 * iteration order is insertion order, so the first key returned by
 * `keys()` is the oldest.
 *
 * @param token Portal token (`claw_*`) used as the cache key.
 * @param tier Resolved tier (or `null` for Free / no entitlement).
 * @param now Current epoch ms; used both for expiry comparison and to
 *   set the new entry's `expiresAt`.
 */
function rememberTier(token: string, tier: ClawboxAiTier | null, now: number) {
  for (const [key, entry] of portalTierCache) {
    if (entry.expiresAt <= now) portalTierCache.delete(key);
  }
  while (portalTierCache.size >= PORTAL_TIER_CACHE_MAX_ENTRIES) {
    const oldest = portalTierCache.keys().next().value;
    if (oldest === undefined) break;
    portalTierCache.delete(oldest);
  }
  portalTierCache.set(token, { tier, expiresAt: now + PORTAL_TIER_CACHE_TTL_MS });
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
  const stamped = normalizeClawboxAiTier(body.deviceTier);
  if (stamped) return stamped;
  const plan = (body.tier ?? "").trim().toLowerCase();
  if (plan === "max") return "pro";
  if (plan === "pro") return "flash";
  return null;
}

/**
 * Resolves a `claw_*` token's current tier against the portal, with
 * a short in-memory cache and concurrent-request de-duplication.
 *
 * Cache semantics:
 *   - 200 OK: parsed tier is cached for `PORTAL_TIER_CACHE_TTL_MS`.
 *   - 401 / 403: a definitive "no entitlement" verdict is also cached
 *     so we don't re-hammer the portal for invalid tokens.
 *   - 5xx / network error: cache untouched; caller falls back to the
 *     locally-stored picker selection so the badge doesn't flicker
 *     during transient portal outages.
 *
 * @param token The bearer token to look up.
 * @returns Either a definitive `{ source: "portal", tier }` answer or
 *   `{ source: "unreachable" }` when the portal couldn't respond.
 */
async function fetchPortalTier(token: string): Promise<PortalLookup> {
  const now = Date.now();
  const cached = portalTierCache.get(token);
  if (cached && cached.expiresAt > now) return { source: "portal", tier: cached.tier };

  const existing = inFlightPortalLookups.get(token);
  if (existing) return existing;

  const promise = (async (): Promise<PortalLookup> => {
    try {
      const res = await fetch(PORTAL_DEVICE_INFO_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PORTAL_FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = await res.json() as DeviceInfoResponse;
        const tier = mapPortalTier(body);
        rememberTier(token, tier, now);
        return { source: "portal", tier };
      }
      // 401/403 are definitive — the portal *did* answer, the token just
      // doesn't entitle anything. Cache so we don't re-hammer for the
      // TTL. 5xx and network errors leave the cache untouched and let
      // callers fall back to the locally-stored picker selection.
      if (res.status === 401 || res.status === 403) {
        rememberTier(token, null, now);
        return { source: "portal", tier: null };
      }
      return { source: "unreachable" };
    } catch {
      return { source: "unreachable" };
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
  portalTierCache.clear();
  inFlightPortalLookups.clear();
}

function normalizeProvider(provider: string | null): string | null {
  if (!provider) return null;
  const normalized = provider.trim().toLowerCase();
  if (normalized === "deepseek" || normalized === "clawai") return "clawai";
  if (normalized.startsWith("openai")) return "openai";
  if (normalized.startsWith("google")) return "google";
  if (normalized.startsWith("anthropic")) return "anthropic";
  if (normalized.startsWith("openrouter")) return "openrouter";
  if (normalized.startsWith("ollama")) return "ollama";
  if (normalized.startsWith("llamacpp")) return "llamacpp";
  return normalized;
}

export async function GET() {
  try {
    const config = await readConfig();

    const profiles = config.auth?.profiles ?? {};
    const model = config.agents?.defaults?.model?.primary ?? null;

    // Match the active profile against the primary model so legacy/fallback
    // profiles (e.g. ClawBox AI added as a fallback alongside the user's
    // chosen provider) don't get reported as the active one.
    const profileKeys = Object.keys(profiles);
    const primaryProviderHint = model ? model.split("/")[0] : null;
    let activeKey: string | undefined;
    if (primaryProviderHint) {
      activeKey = profileKeys.find((key) => {
        const entry = profiles[key];
        const entryProvider = entry?.provider ?? key.split(":")[0];
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
    const normalizedProvider = normalizeProvider(provider);

    let clawaiTier: ClawboxAiTier | null = null;
    let tierSource: "portal" | "picker" = "picker";
    if (normalizedProvider === "clawai") {
      // Default to the wizard's picker selection; the portal call below
      // overwrites both fields when it gets a definitive answer.
      // Falling back to the picker on transient portal outages keeps
      // the badge from blinking off during network blips.
      const localTier = normalizeClawboxAiTier(
        await getConfigValue(CLAWBOX_AI_TIER_CONFIG_KEY).catch(() => null),
      );
      clawaiTier = localTier;
      const token = config.models?.providers?.deepseek?.apiKey;
      if (typeof token === "string" && token.startsWith("claw_")) {
        const lookup = await fetchPortalTier(token);
        if (lookup.source === "portal") {
          // Treat the local picker selection as a ceiling: if the user
          // never authorised a paid tier locally (localTier === null),
          // refuse to render a paid badge even when the portal stamps
          // one. This is a defence against the portal upgrading Free
          // subscribers to flash/pro on the device-info response.
          // Tracked upstream — remove this guard once the portal gates
          // deviceTier stamping by subscription.
          clawaiTier = localTier === null ? null : lookup.tier;
          tierSource = "portal";
        }
      }
    }

    return NextResponse.json({
      connected: !!normalizedProvider,
      provider: normalizedProvider,
      providerLabel: normalizedProvider ? (PROVIDER_LABELS[normalizedProvider] ?? normalizedProvider) : null,
      mode,
      model,
      clawaiTier,
      tierSource,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { connected: false, provider: null, providerLabel: null, mode: null, model: null, clawaiTier: null, tierSource: "picker" },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
