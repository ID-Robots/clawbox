import { NextResponse } from "next/server";
import { readConfig } from "@/lib/openclaw-config";
import { get as getConfigValue, set as setConfigValue } from "@/lib/config-store";
import {
  normalizeClawboxAiTier,
  type ClawboxAiTier,
} from "@/lib/clawbox-ai-models";
import { getActiveHarness } from "@/lib/harness";
import { hermesConfigGetMany } from "@/lib/hermes-config-cache";
// Portal tier resolution lives in @/lib/clawbox-ai-portal-tier so the
// configure route can reach the same answer from the same cache (TASK-481).
import { fetchPortalTier } from "@/lib/clawbox-ai-portal-tier";
import { profileProviderId } from "@/lib/chatgpt-subscription";

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
      const entryProvider = normalizeProvider(profileProviderId(key, profiles[key]));
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
  const hasClawaiProfile = profileKeys.some(
    (key) => normalizeProvider(profileProviderId(key, profiles[key])) === "clawai",
  );

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
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
