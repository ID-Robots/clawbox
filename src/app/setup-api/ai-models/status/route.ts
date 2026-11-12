import { NextResponse } from "next/server";
import { readConfigStrict } from "@/lib/openclaw-config";
import { get as getConfigValue, set as setConfigValue } from "@/lib/config-store";
import {
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_PLAN_UNPAID,
  normalizeClawboxAiPlanTier,
  normalizeClawboxAiTier,
  type ClawboxAiPlanTier,
  type ClawboxAiTier,
} from "@/lib/clawbox-ai-models";
import { getActiveHarness } from "@/lib/harness";
import { hermesConfigGetMany, hermesConfigReadPending } from "@/lib/hermes-config-cache";
// Portal tier resolution lives in @/lib/clawbox-ai-portal-tier so the
// configure route can reach the same answer from the same cache (TASK-481).
import { clawaiTokenRejectedByPortal, fetchPortalTier } from "@/lib/clawbox-ai-portal-tier";
import { profileProviderId } from "@/lib/chatgpt-subscription";
// The portal's verdict on this box's credential, written where the ROOT boot
// script can read it: `scripts/gateway-pre-start.sh` decides on every gateway
// start whether to declare the agent's image path, and the pinned core has no
// back-off of its own to fall back on (TASK-727).
import {
  clearPersistedClawaiCredentialRefusal,
  persistClawaiCredentialRefusal,
} from "@/lib/clawai-credential-refusal";
// The portal's PLAN, written where the same two boot scripts can read it. The
// tier stamp beside it is a device DEFAULT and may not be refused on — see
// `clawai-plan-tier.ts` and TASK-744.
import { CLAWAI_PLAN_TIER_KEY, clawaiPlanGeneration, persistClawaiPlanTier } from "@/lib/clawai-plan-tier";
// A subscription linked for its plan alone, with no ClawBox AI chat credential
// (TASK-2501). Its plan unlocks the same paid features; see `buildStatusResponse`.
import { refreshSubscriptionLink } from "@/lib/subscription-link";

import { EXTERNAL_ENGINE_PROVIDER } from "@/lib/external-engine-shared";
export const dynamic = "force-dynamic";

const PROVIDER_LABELS: Record<string, string> = {
  clawai: "ClawBox AI",
  anthropic: "Anthropic Claude",
  openai: "OpenAI GPT",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  xai: "xAI Grok",
  ollama: "Ollama Local",
  llamacpp: "llama.cpp Local",
  // Hermes' id for the on-device model. Without an entry here the raw
  // "clawlocal" leaked into the UI as a provider name. Matches the wording in
  // lib/hermes-providers.ts so the same model isn't called two things.
  clawlocal: "Gemma 4 (on-device)",
  // The owner's external AI engine in the Local AI slot (TASK-2376).
  [EXTERNAL_ENGINE_PROVIDER]: "External engine",
};

const CLAWBOX_AI_TIER_CONFIG_KEY = "clawai_tier";
// Config-store key holding the ClawBox AI portal token on a Hermes device.
// `applyClawaiToHermes` writes it here; the OpenClaw path reads the same token
// from `models.providers.deepseek.apiKey` in openclaw.json instead.
const CLAWBOX_AI_TOKEN_CONFIG_KEY = "clawai_token";

/**
 * The entitlement list a device-info answer without `allowedModels` implies.
 *
 * Only the compatibility path uses this. A portal that publishes the real list
 * always wins, and a portal that could not be reached gets no list at all.
 *
 * The one model, on every plan (TASK-2261): ClawBox AI serves DeepSeek V4.1
 * Flash to Free, Pro and Max alike, so neither the device stamp nor the plan
 * can widen or narrow it.
 */
function allowedModelsForCompat(): string[] {
  return [CLAWBOX_AI_FLASH_MODEL_ID];
}

/** Max, then Pro, then Free, then "not known" — the internal names are off by one. */
const PLAN_RANK: Record<ClawboxAiPlanTier, number> = { pro: 3, flash: 2, free: 1 };

/**
 * The better of two plan answers, for a box that has both a ClawBox AI account
 * and a linked subscription: the owner pays for whichever covers more, and the
 * paid-plan gate (`@/lib/plan-entitlement`) unlocks on exactly that. A known
 * plan beats "not known".
 */
function strongerPlan(a: ClawboxAiPlanTier | null, b: ClawboxAiPlanTier | null): ClawboxAiPlanTier | null {
  const rank = (plan: ClawboxAiPlanTier | null) => (plan ? PLAN_RANK[plan] : 0);
  return rank(b) > rank(a) ? b : a;
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
  // Strict: `readConfig` answers `{}` to an unreadable or half-written file,
  // which reads as "no ClawBox AI profile" and so as the Free plan. A missing
  // file is still `{}`; any other failure throws to GET's "not known" answer.
  const config = await readConfigStrict();

  const profiles = config.auth?.profiles ?? {};
  const model = config.agents?.defaults?.model?.primary ?? null;

  const profileKeys = Object.keys(profiles);
  // Normalize both sides through normalizeProvider so the deepseek/clawai
  // alias collapses correctly. Without this, a primary model of
  // `clawai/deepseek-v4-flash` (canonical) would never match a profile
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
  if (primaryProviderHint === EXTERNAL_ENGINE_PROVIDER && !profileKeys.some((key) =>
    normalizeProvider(profileProviderId(key, profiles[key])) === EXTERNAL_ENGINE_PROVIDER)) {
    // The external AI engine (TASK-2376) authenticates with the key in its
    // provider block and files no auth profile: the primary names it, not
    // whichever unrelated profile happens to be first.
    provider = EXTERNAL_ENGINE_PROVIDER;
    mode = "api_key";
  } else if (activeKey) {
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
  // A read that timed out (or never reached the CLI) is "" too. That is not
  // "no ClawBox AI account": throw to GET's "not known" answer rather than let
  // it read as the Free plan.
  if (!hasClawaiProfile && hermesConfigReadPending("providers.clawai.base_url")) {
    throw new Error("hermes config read for providers.clawai.base_url did not complete");
  }

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
async function buildStatusResponse(state: ResolvedAiState, askedAtGeneration: number): Promise<NextResponse> {
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
  // The portal's own list of model ids this token may run. NULL MEANS "NOT
  // ANSWERED" — no token, portal unreachable, or a portal build that does not
  // publish the field — and no caller may read that as a refusal. It is
  // deliberately not backed by a local fallback the way the tier badge is: a
  // remembered entitlement is a guess, and a guess is what locked a Max owner
  // out of the model he pays for (TASK-691).
  let clawaiAllowedModels: string[] | null = null;
  // Did the portal REFUSE this device's credential? False until it says so, so
  // a box that has not asked yet — no token, portal never reached — never
  // accuses a credential that may be fine. See TASK-419: the answer used to be
  // thrown away, and the badge went on saying "Connected · Pro" while every
  // turn came back "HTTP 403: Invalid token".
  let clawaiTokenRejected = false;
  // The account's PLAN — what the owner pays for — as opposed to the tier
  // above, which is the MODEL the box defaults to. The two are not the same
  // fact: a Free sign-in stamps the box "flash" (Free and Pro run the same
  // model, see `uiTierToDeviceTier`), so the device tier cannot tell Free from
  // Pro, and a Max subscriber may run Flash. Read as the plan, that stamp put
  // the "Welcome to ClawBox Pro" celebration in front of Free accounts and
  // opened Pro-only screens to them. Everything that shows or gates on a PLAN
  // reads this field: `mapPortalPlanVerdict`'s words — "free", "flash" (the Pro
  // plan), "pro" (the Max plan) — or null for "not known". A box with no
  // ClawBox AI account pays for nothing, which is an answer.
  let clawaiPlan: ClawboxAiPlanTier | null = state.hasClawaiProfile ? null : CLAWBOX_AI_PLAN_UNPAID;
  // This poll recorded a different plan than the box had (see below).
  let clawaiPlanChanged = false;
  if (state.hasClawaiProfile) {
    clawaiAccountTier = localTier;
    // Ask the portal whenever a clawai token is paired, regardless
    // of whether we have a local tier yet. This is what makes
    // Free → Paid upgrades visible without forcing a re-login.
    // mapPortalTier now gates non-null returns on a paid plan, so
    // a bogus deviceTier stamp can no longer promote a Free user.
    if (state.clawaiToken) {
      // When this poll's question was ASKED. The answer can take up to the
      // portal fetch's four-second timeout, and a re-link plus a refusal of the
      // NEW credential can both land inside that window — see
      // `clearPersistedClawaiCredentialRefusal`.
      const askedAt = Date.now();
      // `askedAtGeneration` is the credential counter for the stamp writes
      // below. Same window and same hazard as `askedAt` above: the portal takes
      // up to four seconds and the box can be re-linked inside that time. Taken
      // by `GET` BEFORE the token was read — see there.
      const lookup = await fetchPortalTier(state.clawaiToken);
      if (lookup.source === "portal") {
        clawaiAccountTier = lookup.tier;
        clawaiPlan = lookup.planVerdict;
        // A portal that answered but published no list is not "unknown": it is
        // an older portal build, and there the badge IS all the entitlement
        // there has ever been. Fill the list from it so nothing that used to
        // be refused silently becomes allowed on such a deployment. Only the
        // portal-ANSWERED branch does this — an unreachable portal stays null,
        // which is the whole point of the change.
        clawaiAllowedModels = lookup.allowedModels
          ?? allowedModelsForCompat();
        accountTierSource = "portal";
        // Persist the portal-confirmed tier so the portal-unreachable
        // fallback reflects the last *confirmed* tier, not a stale
        // configure-time value (which flapped a Free badge to Pro and
        // re-fired the celebration). Write only on change to avoid churn.
        //
        // GUARDED THE SAME WAY as the plan below, and by the same snapshot. The
        // two stamps are read together by both boot scripts and one of them
        // deletes on the pair, so they have to describe the same ACCOUNT: an
        // unguarded badge write would land the RETIRED account's badge beside a
        // plan write that was correctly skipped, and the arm would then fall
        // back to a badge belonging to a token this box no longer holds.
        if (askedAtGeneration === clawaiPlanGeneration() && lookup.tier !== localTier) {
          await setConfigValue(CLAWBOX_AI_TIER_CONFIG_KEY, lookup.tier).catch(() => {});
        }
        // The PLAN, beside the badge and never instead of it. The two boot
        // scripts decide an ENTITLEMENT — whether this box may keep a cloud
        // voice at all, and one of them DELETES the definition when it may not
        // — and the badge above is a device DEFAULT that a Max subscriber is
        // allowed to have set to Flash. Only the portal-ANSWERED branch writes
        // it: the wizard's plan picker is a guess the account has not been
        // consulted about (TASK-481), and an `unreachable` verdict is the
        // not-knowing the key exists to keep distinguishable. `planVerdict`
        // rather than `planTier`, because that one answers `null` to a
        // genuinely unpaid account, to an ABSENT `tier` and to a plan word this
        // build has never seen alike — and only the first is a downgrade.
        const planChange = await persistClawaiPlanTier({ verdict: lookup.planVerdict }, askedAtGeneration);
        // A plan that MOVED (an upgrade on the portal while the box runs) is
        // followed here and now, not at the next restart: the cloud voice of a
        // Max plan is armed and the cloud defaults applied
        // (`@/lib/clawai-plan-follow`). Detached — it can restart the gateway,
        // and this answer is a badge poll — and asked once, by the poll that
        // recorded the change.
        if (planChange) {
          clawaiPlanChanged = true;
          void import("@/lib/clawai-plan-follow")
            .then(({ followClawaiPlanChange }) => followClawaiPlanChange(planChange))
            .catch((err: unknown) => {
              console.warn("[ai-models/status] could not follow the plan change:", err instanceof Error ? err.message : err);
            });
        }
        // The portal ANSWERED about the credential this box holds, so any
        // refusal recorded against it is over. Same poll, same store, same
        // "write only on change" discipline as the tier stamp above — the
        // helper reads before it writes.
        await clearPersistedClawaiCredentialRefusal(askedAt);
      } else {
        clawaiTokenRejected = lookup.rejected;
        // `rejected` is the PORTAL naming this credential as the reason, never
        // a bare 401/403 off the wire (see `portalRefusedTheToken`) — the same
        // bar `noteClawaiCredentialRefused` insists on.
        //
        // Persisted off `clawaiTokenRejectedByPortal()` rather than off
        // `lookup.rejected`, because those two are not the same fact.
        // `fetchPortalTier` hands the CALLER a verdict it deliberately did not
        // REMEMBER when a credential has been proven good since that lookup
        // was sent — the generation guard that exists so a delayed 403 for the
        // retired token cannot be read as a verdict on the one the box holds
        // now. Writing `lookup.rejected` to disk would defeat exactly that: a
        // re-link on the Settings page races the poll it is running, and the
        // box would stand its image path down at the very restart the re-link
        // triggers. The module's own guarded reader is the one that answers
        // "is a rejection ON RECORD for the credential this box holds".
        if (clawaiTokenRejectedByPortal()) await persistClawaiCredentialRefusal();
      }
    }
    // No verdict this poll — the portal was unreachable, refused the
    // credential, answered in words this build cannot read, or there is no
    // portal token to ask with: the plan the portal last reported for this
    // credential. The credential writers record or delete it together with
    // the credential, so it is never a previous account's. NEVER the device
    // stamp, which says "flash" for a Free account; with nothing on record the
    // plan is not known, and nothing may be celebrated or unlocked on it.
    clawaiPlan ??= normalizeClawboxAiPlanTier(
      await getConfigValue(CLAWAI_PLAN_TIER_KEY).catch(() => null),
    );
  }

  // A subscription linked for its PLAN alone (TASK-2501): the owner's account
  // is on this box without ClawBox AI being a chat model of it. Asked here,
  // on the poll every plan surface already reads, so an upgrade or a lapse on
  // the portal reaches the box the same way the ClawBox AI plan's does — the
  // lookup is cached for two minutes, so the paid gate's 5 s cadence costs the
  // portal nothing. Never throws, and never touches the ClawBox AI keys.
  const link = await refreshSubscriptionLink().catch(() => null);
  if (link) {
    // With no ClawBox AI account the link's plan IS the plan — not the
    // "pays for nothing" above, and "not known" while the portal has not
    // answered for it. With one, the better of the two: the paid-plan gate
    // unlocks on either, and the plan surfaces must say what the gate does.
    clawaiPlan = state.hasClawaiProfile ? strongerPlan(clawaiPlan, link.plan) : link.plan;
    if (link.changed) clawaiPlanChanged = true;
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
    // The PLAN the account pays for ("free" / "flash" = Pro / "pro" = Max), or
    // null when it is not known. The tiers above are MODEL defaults; the plan
    // badge, the tier celebration and the paid-plan screens read this.
    clawaiPlan,
    // True on the one answer whose poll recorded a CHANGED plan, so an open
    // page re-reads what follows the plan (Settings → Voice) at once.
    ...(clawaiPlanChanged ? { clawaiPlanChanged: true } : {}),
    // Model ids the portal says this account may run, or null when it did not
    // say. The picker gates on this, never on the tier badge above.
    clawaiAllowedModels,
    // Whether *any* clawai profile is configured. Distinguishes
    // "no ClawBox AI account at all" (false) from "Free user with
    // a paired clawai token" (true, clawaiAccountTier=null) — the
    // hook needs this to gate ClawKeep / Remote Desktop sign-in
    // prompts independently of paid-tier checks.
    clawaiConfigured: state.hasClawaiProfile,
    // The portal answered and refused this device's token. Deliberately NOT
    // folded into `connected` or `clawaiConfigured`: a rejected credential is
    // still a configured one, and the gates hanging off those two (ClawKeep,
    // Remote Desktop, the whole "has this box been linked" question) must not
    // flip on an auth error. This is the one field that says the credential
    // does not work, and the surfaces that claim health read it.
    clawaiTokenRejected,
    // A subscription is linked to this box for its plan alone (TASK-2501).
    // NOT folded into `clawaiConfigured`, which says ClawBox AI is a chat
    // model of this box; the login hook reads either as "an account is on
    // this box". Its plan is already in `clawaiPlan` above.
    subscriptionLinked: link !== null,
    // The portal refused the linked token on this poll: a re-link is due, and
    // its plan is forgotten meanwhile — unlike the ClawBox AI badge, the plan
    // is all a link is for (`refreshSubscriptionLink` says why).
    subscriptionLinkRejected: link?.rejected ?? false,
    tierSource,
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function GET() {
  try {
    // The credential counter, taken BEFORE the token is read. A sign-in bumps
    // it once the new token is in place, so a poll that read the previous
    // token always holds an older count and its tier and plan writes are
    // refused. Taken after the read, a bump landing between the two would be
    // in this poll's count and the previous account's profile would be
    // recorded over the new one's.
    const askedAtGeneration = clawaiPlanGeneration();
    // Resolve from whichever config the active harness actually uses. A Hermes
    // device has no OpenClaw config at all, so reading only openclaw.json there
    // reported "no ClawBox AI" for a signed-in box.
    const harness = await getActiveHarness();
    const state = harness === "hermes"
      ? await resolveHermesAiState()
      : await resolveOpenclawAiState();
    return await buildStatusResponse(state, askedAtGeneration);
  } catch {
    // The agent config could not be read (a half-written openclaw.json, a
    // Hermes read that timed out). The subscription link does not live there,
    // so it is still answered: a link-only box must not read as unlinked —
    // the paid gates dropping to their Connect card — for one bad read.
    const link = await refreshSubscriptionLink().catch(() => null);
    return NextResponse.json(
      {
        connected: false, provider: null, providerLabel: null, mode: null, model: null,
        // `clawaiPlan: null` is "not known", never Free: a failed read must not
        // tell a paying owner their plan just ended. The linked plan is a fact
        // this answer does have.
        clawaiTier: null, clawaiAccountTier: null, clawaiPlan: link?.plan ?? null, clawaiAllowedModels: null,
        clawaiConfigured: false, clawaiTokenRejected: false,
        subscriptionLinked: link !== null, subscriptionLinkRejected: link?.rejected ?? false, tierSource: "picker",
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
