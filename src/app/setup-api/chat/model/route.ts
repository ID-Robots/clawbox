import { NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import {
  GatewayNotReadyError,
  inferConfiguredLocalModel,
  readConfig,
  readConfigStrict,
  restartGateway,
  runOpenclawConfigSet,
  runOpenclawConfigSetBatch,
  runOpenclawConfigUnset,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
  setProviderPlugins,
  type OpenClawConfig,
} from "@/lib/openclaw-config";
import { enableProviderPluginOps, providerPluginSwitchedOnBy } from "@/lib/provider-plugin-ops";
import { notifyProviderSetChanged } from "@/app/setup-api/ai-models/catalog/route";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";
import {
  CLAWBOX_AI_MODEL_BY_TIER,
  CLAWBOX_AI_DEFAULT_TIER,
} from "@/lib/clawbox-ai-models";
import { OPENROUTER_DEFAULT_MODEL_ID } from "@/lib/openrouter-models";
import { ANTHROPIC_DEFAULT_MODEL_ID, isValidModelId, parseModelSlug } from "@/lib/provider-models";
import { DISABLED_PROVIDERS_KEY, normalizeProviderId, parseDisabledProviders } from "@/lib/provider-status";
import { isClawboxAiImageModelId, isClawboxAiImageModelRef } from "@/lib/clawbox-ai-models";
import {
  CHATGPT_AGENT_RUNTIME_ID,
  CHATGPT_DEFAULT_MODEL_ID,
  CHATGPT_PROVIDER,
  CHATGPT_UI_PROVIDER,
  canonicalChatgptModelRef,
  chatgptModelRef,
  chatgptRuntimeArmOp,
  chatgptRuntimeEntryPath,
  hasChatgptOauthProfile,
  hasLegacyChatgptProfile,
  isLegacyChatgptProvider,
  isLegacyCodexRef,
  isOauthProfile,
  profileProviderId,
} from "@/lib/chatgpt-subscription";
import type { AuthProfileEntries } from "@/lib/subscription-surface";
import {
  CODEX_SUPPORTED_MODEL_RE,
  chatgptSupportedModelsSentence,
  isClaudeSubscriptionOnly,
  isKeyModeProfile,
  offSurfaceClaudeModelMessage,
  offSurfaceCodexModelMessage,
  readSubscriptionSurfaceIds,
  subscriptionOnlyProviders,
} from "@/lib/subscription-surface";

export const dynamic = "force-dynamic";

const PRIMARY_MODEL_KEY = "chat:primary-provider-model";

type ChatModelSource = "primary" | "local";

interface ChatModelOption {
  id: string;
  label: string;
  model: string | null;
  provider: string | null;
  available: boolean;
  settingsSection: "ai" | "localAi";
  isLocal: boolean;
  /**
   * Present (and true) only when `available` is false BECAUSE the owner
   * switched the provider off in Settings — the credential is intact, and the
   * picker shows the row greyed with that reason rather than "not set up".
   */
  disabledByOwner?: true;
  /**
   * The ChatGPT sign-in on this box predates the installed OpenClaw and cannot
   * be routed until the owner signs in again (src/lib/chatgpt-subscription.ts).
   */
  reauthRequired?: true;
}

const PROVIDER_LABELS: Record<string, string> = {
  clawai: "ClawBox AI",
  anthropic: "Anthropic Claude",
  openai: "OpenAI GPT",
  codex: "OpenAI Codex",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  ollama: "Ollama Local",
  llamacpp: "Gemma 4 Local",
  deepseek: "ClawBox AI",
};

const PROVIDER_ORDER = ["clawai", "openai", "anthropic", "google", "openrouter"] as const;
// Providers ClawBox configures as explicit openai-completions entries (see
// ai-models/configure). Their `models.providers.<p>.models` list must contain
// the chosen id or the gateway silently falls back, so the chat-header switch
// below auto-extends that list when a freshly-picked model isn't seeded.
const OPENAI_COMPAT_PROVIDERS = new Set<string>(["openrouter", "google", "anthropic"]);
// Imported from `@/lib/clawbox-ai-models` so this fallback can't drift away
// from the configure route's tier→model mapping. Used only when a legacy
// install has no explicit `models.providers.deepseek.models` entry; new
// installs surface every tier directly via the provider definition.
const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  clawai: CLAWBOX_AI_MODEL_BY_TIER[CLAWBOX_AI_DEFAULT_TIER],
  deepseek: CLAWBOX_AI_MODEL_BY_TIER[CLAWBOX_AI_DEFAULT_TIER],
  anthropic: `anthropic/${ANTHROPIC_DEFAULT_MODEL_ID}`,
  openai: "openai/gpt-5.4",
  google: "google/gemini-2.5-flash",
  openrouter: `openrouter/${OPENROUTER_DEFAULT_MODEL_ID}`,
};

// CODEX_SUPPORTED_MODEL_RE moved to @/lib/subscription-surface: the wizard/
// Settings save resolves onto the same ChatGPT credential and has to apply the
// same allowlist, and a second copy of it there would be a copy that can
// drift. Which pick is on that credential is no longer readable from the
// namespace — both auth modes write `openai/<id>` — so both routes pass the
// answer in (src/lib/chatgpt-subscription.ts).

function isLocalModel(model: string | null | undefined): boolean {
  return !!model && (model.startsWith("llamacpp/") || model.startsWith("ollama/"));
}

function normalizeProvider(provider: unknown): string | null {
  if (typeof provider !== "string" || !provider.trim()) return null;
  const normalized = provider.trim().toLowerCase();
  if (normalized === "deepseek") return "clawai";
  return normalized;
}

function labelForProvider(provider: string | null, fallback: string): string {
  if (!provider) return fallback;
  return PROVIDER_LABELS[provider] ?? fallback;
}

function normalizeProviderFromModel(model: string | null | undefined): string | null {
  if (typeof model !== "string" || !model.trim()) return null;
  const [provider] = model.split("/", 1);
  return normalizeProvider(provider);
}

function defaultModelForProvider(provider: string | null): string | null {
  if (!provider) return null;
  const normalized = provider.trim().toLowerCase();
  // The ChatGPT subscription is written under `openai/` — see
  // src/lib/chatgpt-subscription.ts. Both retired ids (`codex`, and
  // `openai-codex` before 2026.6) resolve to the same row.
  if (isLegacyChatgptProvider(normalized)) {
    return chatgptModelRef(CHATGPT_DEFAULT_MODEL_ID);
  }
  return DEFAULT_PROVIDER_MODELS[normalized]
    ?? DEFAULT_PROVIDER_MODELS[normalizeProvider(provider) ?? ""]
    ?? null;
}

/**
 * Providers this box authenticates to by subscription only, normalized to the
 * ids the UI uses (deepseek → clawai) so the browser can match them against
 * the provider on its own header pill.
 *
 * The catalogue the pickers render is stamped with `availableOnSubscription`
 * per model, but that stamp is a property of the PROVIDER's plugin, not of
 * this device — nothing in it says whether this box is on a subscription. The
 * setup wizard knew because the customer was standing on the Subscription tab;
 * the chat header had no such context and so applied no rule at all. This is
 * that missing half, delivered on the state the header already refetches
 * whenever the provider changes.
 */
function subscriptionProvidersForUi(profiles: AuthProfileEntries): string[] {
  // `normalizeProvider` goes IN, not around the outside. deepseek and clawai
  // are one provider under two names, so collapsing the alias after the
  // credentials are counted would read an OAuth profile written as `deepseek`
  // and an API key written as `clawai` as two separate providers, and report
  // the box subscription-only on a key it actually holds.
  const providers = subscriptionOnlyProviders(profiles, normalizeProvider);
  // The `codex` ROW is subscription-routed whenever the sign-in exists — not
  // only when it is the box's ONLY OpenAI credential. A turn on that row goes
  // to the ChatGPT account, which refuses the `-pro` tiers, whatever else the
  // box holds; leaving the row out of this list on a box that also has an API
  // key offered those tiers as ordinary pickable rows and the turn then failed
  // upstream. The `openai` row keeps the subscription-only answer, because it
  // is the API key that routes it.
  if (hasChatgptOauthProfile(profiles) && !providers.includes(CHATGPT_UI_PROVIDER)) {
    return [...providers, CHATGPT_UI_PROVIDER].sort();
  }
  return providers;
}

function hasOpenAiApiKeyProfile(config: OpenClawConfig): boolean {
  return Object.entries(config.auth?.profiles ?? {}).some(
    ([key, entry]) => isKeyModeProfile(entry) && profileProviderId(key, entry) === CHATGPT_PROVIDER,
  );
}

/**
 * The OpenAI credential facts every routing decision in POST turns on, read
 * ONCE and before any branch a request-supplied value chooses. A check that
 * only runs on one side of a user-chosen condition reads as a check the user
 * can skip (CodeQL js/user-controlled-bypass), and it costs one config read
 * the request was going to make for any OpenAI pick anyway.
 */
interface OpenAiCredentials {
  /** An OpenAI API-key profile: `openai/*` is a keyed route on this box. */
  hasApiKey: boolean;
  /** A ChatGPT sign-in the core can route — see src/lib/chatgpt-subscription.ts. */
  hasChatgptSignIn: boolean;
  /** A ChatGPT sign-in filed the OpenClaw 1 way, which the core never consults. */
  hasStaleChatgptProfile: boolean;
}

async function readOpenAiCredentials(
  getConfig: () => Promise<OpenClawConfig | null>,
): Promise<OpenAiCredentials> {
  const config = await getConfig();
  const profiles = config?.auth?.profiles;
  return {
    hasApiKey: !!config && hasOpenAiApiKeyProfile(config),
    hasChatgptSignIn: hasChatgptOauthProfile(profiles),
    hasStaleChatgptProfile: hasLegacyChatgptProfile(profiles),
  };
}

/**
 * The 409 for a ChatGPT sign-in this core cannot use: filed the OpenClaw 1 way
 * (`codex:default`) on an OpenClaw 2 box, which never consults it for the
 * `openai/*` route the model now has to be written under. Re-signing in files
 * it where the core looks; nothing else does (doctor leaves a bare `codex:*`
 * id alone). Same shape as the other refusals so the popup can act on `kind`.
 */
function refuseStaleChatgptProfile(): NextResponse {
  return NextResponse.json(
    {
      error: "Your ChatGPT sign-in predates this OpenClaw version and cannot be used for chat any more. "
        + "Connect OpenAI again in Settings, then pick the model.",
      kind: "chatgpt_reauth_required",
      provider: CHATGPT_UI_PROVIDER,
    },
    { status: 409 },
  );
}

/**
 * Where a pick that names OpenAI goes, or null when it is not the
 * subscription's business (a keyed `openai/*` on an API-key box, any other
 * provider). Three things can say a pick belongs to the ChatGPT account, and
 * ALL THREE are needed because the namespace no longer says anything:
 *
 *   * `codex/<id>` — a stale tab or an old stored primary. OpenClaw 2 has no
 *     such namespace; the same model is `openai/<id>`.
 *   * `fromChatgptRow` — the picker sends the row the owner clicked. On a box
 *     holding BOTH OpenAI credentials the two rows offer the same reference,
 *     so this is the only thing that can tell them apart. Deriving it from
 *     "there is no API key" instead left the ChatGPT row on such a box with no
 *     runtime arm (every turn silently spending the API key), no ChatGPT
 *     surface refusal, and a header pill that flipped to OpenAI on the next
 *     GET.
 *   * no API key at all — then an `openai/<id>` can be nothing else (sending
 *     it to api.openai.com 401s "Missing bearer").
 *
 * All are written as `openai/<id>` with the Codex runtime armed on it; the
 * ChatGPT surface rule judges the id afterwards, on the reference that will be
 * written.
 *
 * Applied at every door the primary write has — the custom-model branch, an
 * id already in `state.options`, and {"source":"primary"} — with the facts
 * read up front, so no door reaches the write with the retired namespace.
 */
function resolveChatgptPick(
  ref: string,
  parsed: { provider: string; modelId: string },
  credentials: OpenAiCredentials,
  fromChatgptRow: boolean,
): { model: string } | { refusal: NextResponse } | null {
  const legacy = isLegacyCodexRef(ref);
  const openAiRef = parsed.provider === CHATGPT_PROVIDER;
  if (!legacy && !(openAiRef && (fromChatgptRow || !credentials.hasApiKey))) return null;
  if (!credentials.hasChatgptSignIn) {
    if (credentials.hasStaleChatgptProfile) return { refusal: refuseStaleChatgptProfile() };
    // No sign-in at all: a legacy ref falls to the provider-configured check,
    // a keyless `openai/*` pick is the API-key case the message names.
    if (legacy) return null;
    return { refusal: refuseKeylessOpenAiModel(parsed.modelId, credentials.hasApiKey) };
  }
  if (legacy) return { model: canonicalChatgptModelRef(ref) };
  if (CODEX_SUPPORTED_MODEL_RE.test(parsed.modelId)) return { model: chatgptModelRef(parsed.modelId) };
  return { refusal: refuseKeylessOpenAiModel(parsed.modelId, credentials.hasApiKey) };
}

function refuseKeylessOpenAiModel(modelId: string, hasApiKey: boolean): NextResponse {
  // The next step depends on what the box already holds. Telling an owner who
  // HAS an API key to "switch to API-key mode" names a lever they have already
  // pulled; the actionable step there is the other row, which routes this very
  // model. One sentence builder for the supported list, fed by the ChatGPT
  // catalogue — the hand-written copy here had already lost the GPT-5.6
  // generation the allowlist accepts.
  const nextStep = hasApiKey
    ? `Pick it on the ${PROVIDER_LABELS.openai} row instead, which routes it on this box's API key.`
    : `${modelId} requires OpenAI API-key mode.`;
  return NextResponse.json({
    error: `${nextStep} ChatGPT subscription auth supports ${chatgptSupportedModelsSentence()}.`,
  }, { status: 400 });
}

/** Is `agents.defaults.models[modelRef].agentRuntime.id` already `codex` in this config? */
function chatgptRuntimeArmed(config: OpenClawConfig | null, modelRef: string | null | undefined): boolean {
  if (!modelRef) return false;
  const models = (config?.agents?.defaults as { models?: Record<string, { agentRuntime?: { id?: unknown } }> } | undefined)?.models;
  return models?.[modelRef]?.agentRuntime?.id === CHATGPT_AGENT_RUNTIME_ID;
}

/**
 * Take the Codex runtime OFF `modelRef`, or return the sentence that says it is
 * still on.
 *
 * The arm was write-only: two routes added it and the only remover was
 * v1-gated, so on the pinned core nothing ever cleared it. That was harmless
 * while it could only sit on a `codex/<id>` key no other lane could name — but
 * the subscription and the API key now share `openai/<id>`, so an arm left
 * behind by an earlier ChatGPT pick keeps sending the SAME reference through
 * the ChatGPT account after the owner switches to the API-key row. Silently:
 * the box answers, on the wrong account, and the header pill flips back.
 *
 * `config unset`, not a `null` write. A batch entry takes only `value`/`ref`/
 * `provider` (the core's `parseBatchEntries` — no delete), and
 * `{"...agentRuntime": null}` is refused by the schema:
 * `Invalid input: expected object, received null`. Measured on 2026.8.1.
 * So it is its own spawn, and its failure is REPORTED rather than swallowed —
 * the box is still on the ChatGPT account and the owner has to know.
 */
async function disarmChatgptRuntime(modelRef: string): Promise<string | undefined> {
  try {
    await runOpenclawConfigUnset(chatgptRuntimeEntryPath(modelRef));
    return undefined;
  } catch (err) {
    console.error("[chat/model] failed to clear the Codex runtime entry:", err);
    return `Switched to ${modelRef}, but this box still routes it through your ChatGPT account — `
      + "clearing the Codex runtime setting failed. Chat may answer on the subscription instead of "
      + `the API key until you run 'openclaw config unset ${chatgptRuntimeEntryPath(modelRef)}' from the Terminal.`;
  }
}

/**
 * The 409 for a primary the core refused as a reference it cannot resolve —
 * `Cannot set model reference ... Unknown model` — or null for any other
 * failure. The core's sentence reads like a crash and ends in a CLI command;
 * the owner can act on which provider and which model.
 */
function refuseUnresolvableModel(model: string, err: unknown, chatgptRouted: boolean): NextResponse | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!/Cannot set model reference/i.test(message)) return null;
  const provider = chatgptRouted ? CHATGPT_UI_PROVIDER : normalizeProviderFromModel(model);
  const label = labelForProvider(provider, provider ?? "The provider");
  const modelId = parseModelSlug(model)?.modelId ?? model;
  return NextResponse.json(
    {
      error: `${label} does not list ${modelId} on this OpenClaw version, so it cannot be made the default. `
        + `Pick another model, or re-save ${label} in Settings to refresh its model list.`,
      kind: "model_unresolvable",
      model,
      provider,
    },
    { status: 409 },
  );
}

/**
 * Refuses a Claude model the box's subscription surface does not carry, or
 * null when the target is fine (or is not Claude, or the box is not on a
 * Claude subscription, or the surface could not be read).
 *
 * A thin wrapper over `offSurfaceClaudeModelMessage`, which owns the rule and
 * the wording. The rule is shared with the wizard/Settings save
 * (/setup-api/ai-models/configure), the OTHER write path to
 * `agents.defaults.model.primary` — a second copy of it there would be a copy
 * that can drift, and drift is how one path ended up guarded and the other not.
 *
 * A helper rather than an inline block because there are THREE ways a model id
 * becomes the target and only one of them is the custom-model branch: an id
 * already in `models.providers.anthropic.models` matches `state.options`
 * first, and `{"source":"primary"}` skips the branch entirely. That list is
 * exactly where the old unguarded auto-extend wrote, so a box already broken
 * by this defect could re-arm itself through either door. The OpenAI guard is
 * applied at both sites for the same reason.
 */
async function refuseOffSurfaceClaudeModel(
  provider: string | null | undefined,
  modelId: string,
  // Getters, not values: the provider check comes first, so a switch to any
  // other provider costs no openclaw.json read and no cache read at all. On a
  // Jetson neither is free, and both are the caller's per-request memo.
  getConfig: () => Promise<OpenClawConfig | null>,
  getSurfaceIds: () => Promise<Set<string> | null>,
): Promise<NextResponse | null> {
  const message = await offSurfaceClaudeModelMessage(
    provider,
    modelId,
    async () => {
      const config = await getConfig();
      // `normalizeProvider` goes IN, not around the outside — see
      // `subscriptionProvidersForUi` for why the alias has to collapse before
      // the credentials are counted.
      return !!config && isClaudeSubscriptionOnly(config.auth?.profiles, normalizeProvider);
    },
    getSurfaceIds,
  );
  if (!message) return null;
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Refuses a `codex/` model the ChatGPT subscription cannot run, or null when
 * the target is fine (or is not on the ChatGPT surface at all).
 *
 * A helper for the same reason `refuseOffSurfaceClaudeModel` is one: this rule
 * has to hold at BOTH guard sites. It used to be an inline block in the
 * custom-model branch only, which left the other two doors — an id that
 * matches `state.options`, and `{"source":"primary"}` — writing an
 * API-key-only id straight into `agents.defaults.model.primary` and then
 * arming `agentRuntime.id=codex` on top of it, over a response that says the
 * switch worked.
 */
function refuseUnsupportedCodexModel(
  provider: string | null | undefined,
  modelId: string,
  // OpenClaw 2 writes the subscription under `openai/`: the namespace no
  // longer says which route the id takes, so the caller that resolved the pick
  // says. Not OR-ed with `provider === "codex"` any more — that put the
  // retired test back under the flag that replaced it, and a caller that
  // forgot the flag would have got the old behaviour instead of an error.
  chatgptRouted: boolean,
): NextResponse | null {
  const message = offSurfaceCodexModelMessage(provider, modelId, chatgptRouted);
  if (!message) return null;
  return NextResponse.json({ error: message }, { status: 400 });
}

function sortPrimaryOptions(options: ChatModelOption[]) {
  return [...options].sort((a, b) => {
    const aRank = PROVIDER_ORDER.indexOf((a.provider ?? "") as typeof PROVIDER_ORDER[number]);
    const bRank = PROVIDER_ORDER.indexOf((b.provider ?? "") as typeof PROVIDER_ORDER[number]);
    const safeARank = aRank === -1 ? PROVIDER_ORDER.length : aRank;
    const safeBRank = bRank === -1 ? PROVIDER_ORDER.length : bRank;
    if (safeARank !== safeBRank) return safeARank - safeBRank;
    return a.label.localeCompare(b.label);
  });
}

/**
 * `preloaded` is the config POST has already read for its own routing facts,
 * so one request reads openclaw.json once; GET reads it here.
 */
async function loadChatModelState(preloaded?: OpenClawConfig) {
  const [configStore, openclawConfig, storedPrimaryModel] = await Promise.all([
    getAll(),
    preloaded ?? readConfig().catch(() => ({} as OpenClawConfig)),
    sqliteGet(PRIMARY_MODEL_KEY).catch(() => null),
  ]);
  const authProfiles = openclawConfig.auth?.profiles ?? {};
  // Subscription-only providers, computed ONCE: the row attribution below and
  // the `subscriptionProviders` the answer carries are the same walk of the
  // same profile map, and doing it twice per GET on a Jetson is a walk that
  // buys nothing.
  const subscriptionProviders = subscriptionProvidersForUi(authProfiles);
  // The ChatGPT subscription and the API key share the `openai` namespace, so
  // an `openai/<id>` is the subscription's when either the box has no other
  // OpenAI credential, or the model itself carries the Codex runtime arm —
  // the core's own key for "this reference belongs to the ChatGPT account"
  // (src/lib/chatgpt-subscription.ts). Without the second half, a dual-
  // credential box flipped its header pill from ChatGPT to OpenAI on the very
  // next poll after the owner picked ChatGPT.
  const chatgptSubscriptionOnly = hasChatgptOauthProfile(authProfiles) && !hasOpenAiApiKeyProfile(openclawConfig);
  const uiProviderForModel = (model: string | null | undefined): string | null => {
    const provider = normalizeProviderFromModel(model);
    if (provider !== CHATGPT_PROVIDER) return provider;
    return chatgptSubscriptionOnly || chatgptRuntimeArmed(openclawConfig, model)
      ? CHATGPT_UI_PROVIDER
      : provider;
  };

  const activeModel = typeof openclawConfig.agents?.defaults?.model?.primary === "string"
    ? openclawConfig.agents.defaults.model.primary
    : null;
  const inferredLocal = inferConfiguredLocalModel(openclawConfig);
  const localModel = typeof configStore.local_ai_model === "string"
    ? configStore.local_ai_model
    : inferredLocal?.model ?? null;
  const localProvider = normalizeProvider(
    typeof configStore.local_ai_provider === "string"
      ? configStore.local_ai_provider
      : inferredLocal?.provider ?? null,
  );
  const localLabel = localModel
    ? labelForProvider(localProvider, "Local AI")
    : null;

  let primaryModel = typeof storedPrimaryModel === "string" && storedPrimaryModel.trim()
    ? storedPrimaryModel
    : null;

  if (!isLocalModel(activeModel) && activeModel) {
    primaryModel = activeModel;
    if (storedPrimaryModel !== activeModel) {
      await sqliteSet(PRIMARY_MODEL_KEY, activeModel);
    }
  }

  // Prefer the live OpenClaw primary model's provider over the ClawBox config
  // store: the store only refreshes at configure-time, so it drifts when the
  // model changes elsewhere (#162). Fall back to the store for local/no-model.
  const primaryProvider = (!isLocalModel(activeModel) && activeModel
    ? uiProviderForModel(activeModel)
    : null) ?? normalizeProvider(configStore.ai_model_provider);
  // Keyed by *provider* (not by model id) so each provider gets ONE
  // row in the chat dropdown. Model variants (ClawBox AI Flash/Pro,
  // Claude Haiku/Sonnet/Opus, GPT-5.4 / -mini, etc.) are surfaced via
  // the secondary model picker in ChatPopup, not as independent rows.
  // The first call wins — subsequent rememberPrimaryOption calls for
  // a provider that already has an entry are no-ops, with the active
  // model taking priority via the call order in loadChatModelState.
  const configuredPrimaryOptions = new Map<string, ChatModelOption>();
  const rememberPrimaryOption = (
    model: string | null | undefined,
    providerHint?: string | null,
  ) => {
    const trimmedModel = typeof model === "string" ? model.trim() : "";
    if (!trimmedModel || isLocalModel(trimmedModel)) return;
    // The ClawBox AI image entry, written as the primary by an older build,
    // must not own the provider's row: the profile loop below then picks a
    // model the box can chat with instead. Only the image id — a remembered
    // chat model the curated list omits is still what the gateway runs.
    if (isClawboxAiImageModelRef(trimmedModel)) return;
    const provider = normalizeProvider(providerHint ?? uiProviderForModel(trimmedModel));
    if (!provider) return;
    if (configuredPrimaryOptions.has(provider)) return;
    const label = labelForProvider(provider, "AI Provider");
    // Two rows CAN carry the same model on a dual-credential box — the
    // `openai` row's first defined model can equal the armed ChatGPT one — and
    // `id` is the picker's React key as well as what POST echoes back. The
    // first row to claim a model keeps the bare id; a later one is qualified,
    // so no two rows collide.
    const claimed = [...configuredPrimaryOptions.values()].some((option) => option.id === trimmedModel);
    configuredPrimaryOptions.set(provider, {
      id: claimed ? `${provider}:${trimmedModel}` : trimmedModel,
      label,
      model: trimmedModel,
      provider,
      available: true,
      settingsSection: "ai",
      isLocal: false,
    });
  };

  rememberPrimaryOption(activeModel);
  rememberPrimaryOption(primaryModel);

  const providerDefinitions = openclawConfig.models?.providers ?? {};
  for (const [profileKey, entry] of Object.entries(authProfiles)) {
    const profileProvider = profileProviderId(profileKey, entry);
    const oauth = isOauthProfile(entry);
    // The ChatGPT sign-in is the `codex` row. It is filed under `openai`, so
    // an OAuth profile there is this row and not the API-key one; a sign-in
    // filed the OpenClaw 1 way is not a row the box can run — it is offered
    // below, greyed, once the loop is done.
    if (oauth && isLegacyChatgptProvider(profileProvider)) continue;
    const isChatgptSignIn = oauth && profileProvider === CHATGPT_PROVIDER;
    const rawProvider = isChatgptSignIn ? CHATGPT_UI_PROVIDER : profileProvider;
    const provider = normalizeProvider(rawProvider);
    if (!provider || provider === "ollama" || provider === "llamacpp") continue;

    // Pick which model represents this provider in the dropdown:
    //  1. activeModel if it belongs to this provider (so the row's
    //     "model" field matches what the gateway is actually using).
    //  2. The first model in the openclaw provider definition.
    //  3. The hard-coded default for this provider.
    const providerDef = providerDefinitions[rawProvider];
    // Minus the ClawBox AI image entry, and nothing else: `models.providers
    // .openai.models[]` carries it on every paired box, and on a box with an
    // OpenAI key it was the FIRST row — so the OpenAI dropdown row was
    // represented by an image model that fails on every chat turn.
    //
    // Deliberately NOT the catalog route's `ALLOWED_MODEL_RE_BY_PROVIDER`.
    // That list curates a noisy UPSTREAM catalog down for a picker; this list
    // is what the owner configured, which this route's own sibling
    // (`foreignOpenAiRoute` in ai-models/configure) treats as "the owner's own
    // work". Running it through the curation regex empties `models[]` for a
    // self-hosted openai-compatible endpoint and falls the row through to a
    // hard-coded default that endpoint does not serve.
    const definedModels = (providerDef?.models ?? []).filter(
      (m): m is { id: string; name?: string } =>
        typeof m?.id === "string" && m.id.trim().length > 0 && !isClawboxAiImageModelId(m.id),
    );

    let model: string | null = null;
    // `!isClawboxAiImageModelRef` matters here, not only in the filter above:
    // this branch wins whenever the primary belongs to this provider, so on
    // the very boxes the image guard exists for it took the image ref, handed
    // it to `rememberPrimaryOption`, and had it dropped there — leaving the
    // provider with no row until the hard-coded fallback far below invented
    // one. Treating an image-ref primary as "no active model for this
    // provider" is what lets the owner's configured rows be consulted.
    if (activeModel && !isClawboxAiImageModelRef(activeModel) && uiProviderForModel(activeModel) === provider) {
      model = activeModel;
    } else if (!isChatgptSignIn && definedModels.length > 0) {
      model = `${rawProvider}/${definedModels[0].id}`;
    } else {
      model = defaultModelForProvider(rawProvider);
    }

    if (model) rememberPrimaryOption(model, rawProvider);
  }

  // `primaryProvider`, not `configStore.ai_model_provider`: the store drifts
  // (the comment on `primaryProvider` above), and resolving the MODEL from the
  // drifting store while forcing the HINT to the live provider builds a row
  // labelled for one provider around another provider's default model.
  // POST /setup-api/providers/default reads `option.model` straight off this
  // row and writes it to `agents.defaults.model.primary`, so the mismatch is
  // not display-only.
  if (primaryProvider && primaryProvider !== "ollama" && primaryProvider !== "llamacpp") {
    const model = defaultModelForProvider(primaryProvider);
    if (model) rememberPrimaryOption(model, primaryProvider);
  }

  // A ChatGPT sign-in OpenClaw 2 cannot use (filed as `codex:default` by an
  // older ClawBox) gets its row greyed, with the reason — whether the row was
  // missing or was registered available above from a primary still written
  // as `codex/<id>` — rather than an available row whose pick the core then
  // refuses, and rather than vanishing, which reads as "never connected".
  if (hasLegacyChatgptProfile(authProfiles) && !hasChatgptOauthProfile(authProfiles)) {
    const existing = configuredPrimaryOptions.get(CHATGPT_UI_PROVIDER);
    const model = existing?.model ?? chatgptModelRef(CHATGPT_DEFAULT_MODEL_ID);
    configuredPrimaryOptions.set(CHATGPT_UI_PROVIDER, {
      id: existing?.id ?? model,
      label: labelForProvider(CHATGPT_UI_PROVIDER, "AI Provider"),
      model,
      provider: CHATGPT_UI_PROVIDER,
      available: false,
      reauthRequired: true,
      settingsSection: "ai",
      isLocal: false,
    });
  }

  // When Local-only mode is on, the cloud providers are intentionally
  // disabled — dropping them from the dropdown is the UX that matches
  // the toggle's promise ("Route everything to the local model.
  // Disables all cloud AI providers"). Without this the user can still
  // pick GPT/Claude/DeepSeek in the chat dropdown while Local-only is
  // lit up, and the chat then quietly talks to the cloud provider.
  const localOnlyMode = !!configStore.local_only_mode;

  // The owner's per-provider switch. A switched-off provider STAYS in the
  // list, greyed and carrying the reason, rather than vanishing: a row that
  // disappears reads as "not connected" and sends the owner to re-enter a key
  // that is fine. Matched on the canonical id the status strip uses, so the
  // `codex` and `openai` rows both follow the one "OpenAI" switch.
  const disabledProviders = parseDisabledProviders(configStore[DISABLED_PROVIDERS_KEY]);
  const applyOwnerSwitch = (option: ChatModelOption): ChatModelOption => {
    const canonical = normalizeProviderId(option.provider);
    return canonical && disabledProviders.has(canonical)
      ? { ...option, available: false, disabledByOwner: true }
      : option;
  };

  const primaryOptions = localOnlyMode
    ? []
    : sortPrimaryOptions([...configuredPrimaryOptions.values()]).map(applyOwnerSwitch);
  const localOption: ChatModelOption = applyOwnerSwitch(localModel
    ? {
        id: localModel,
        label: localLabel ?? "Local AI",
        model: localModel,
        provider: localProvider,
        available: true,
        settingsSection: "localAi",
        isLocal: true,
      }
    : {
        id: "__setup_local__",
        label: "Local AI",
        model: null,
        provider: null,
        available: false,
        settingsSection: "localAi",
        isLocal: true,
      });

  const options = primaryOptions.length > 0
    ? [...primaryOptions, localOption]
    : [{
        id: "__setup_ai__",
        label: "AI Provider",
        model: null,
        provider: null,
        available: false,
        settingsSection: "ai" as const,
        isLocal: false,
      }, localOption];

  // The "back to primary" target. The remembered primary wins while it is
  // still usable; a remembered provider the owner has since switched off gives
  // way to the first one that is not, so the gesture keeps working instead of
  // resolving to a model the switch below would refuse.
  const summaryPrimaryOption = primaryOptions.find((option) => option.model === primaryModel && option.available)
    ?? primaryOptions.find((option) => option.available)
    ?? primaryOptions[0]
    ?? null;
  const primaryLabel = summaryPrimaryOption?.label ?? null;

  const activeSource: ChatModelSource | null = activeModel
    ? (isLocalModel(activeModel) ? "local" : "primary")
    : null;
  // Resolved by ROW, not by model alone: on a dual-credential box the same
  // `openai/<id>` can sit on both rows, `sortPrimaryOptions` puts the ranked
  // `openai` one first, and the header then rendered the API-key row — with
  // its catalogue — for a model the box routes through the subscription.
  const activeUiProvider = uiProviderForModel(activeModel);
  const activeOption = options.find(
    (option) => option.model === activeModel
      && (!activeUiProvider || option.provider === activeUiProvider),
  ) ?? options.find((option) => option.model === activeModel) ?? null;
  const activeLabel = activeOption?.label ?? null;

  return {
    activeOptionId: activeOption?.id ?? null,
    activeSource,
    activeLabel,
    activeModel,
    options,
    primary: {
      available: !!summaryPrimaryOption?.available,
      label: primaryLabel,
      model: summaryPrimaryOption?.model ?? null,
      // The ROW the "back to primary" gesture resolves to. The model alone
      // cannot say whether an `openai/<id>` primary is the ChatGPT row or the
      // API-key one on a box that holds both.
      provider: summaryPrimaryOption?.provider ?? null,
    },
    local: {
      available: localOption.available,
      label: localLabel,
      model: localModel,
    },
    subscriptionProviders,
  };
}

/**
 * The 409 for a model on a provider the owner switched off, or null when the
 * model may be routed to. Decided from the option rows — the same rows the
 * picker greys out — so the refusal and the greying cannot disagree.
 */
function refuseDisabledProvider(
  state: Awaited<ReturnType<typeof loadChatModelState>>,
  model: string | null,
): NextResponse | null {
  const provider = normalizeProviderId(normalizeProviderFromModel(model));
  const switchedOff = !!provider && state.options.some(
    (option) => option.disabledByOwner && normalizeProviderId(option.provider) === provider,
  );
  if (!switchedOff) return null;
  return NextResponse.json(
    {
      error: `${labelForProvider(provider, provider)} is switched off. Switch it on in Settings first.`,
      kind: "provider_disabled",
      provider,
    },
    { status: 409 },
  );
}

export async function GET() {
  try {
    const state = await loadChatModelState();
    return NextResponse.json(state, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load chat model state" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: Request) {
  try {
    let body: { source?: ChatModelSource; model?: string; provider?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // One read of openclaw.json for the request: the state below and every
    // credential fact the routing turns on come from the same snapshot.
    const preloadedConfig = await readConfig().catch(() => null);
    const state = await loadChatModelState(preloadedConfig ?? {});
    // Set wherever a pick is resolved onto the ChatGPT subscription: that
    // route is written under `openai/`, so the namespace cannot say so and
    // the runtime arm below has to be told.
    let chatgptRouted = false;

    // Refuse a switched-off provider BEFORE anything below runs: the
    // openai-compat branch writes `models.providers.<p>.models` on its way to
    // an answer, and a refusal that has already had a side effect is not a
    // refusal. Both entry points are covered — an explicit model, and the
    // "back to primary / local" gesture that resolves to one.
    const requestedModel = typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : body.source === "primary" ? state.primary.model
        : body.source === "local" ? state.local.model
          : null;
    const disabledRefusal = refuseDisabledProvider(state, requestedModel);
    if (disabledRefusal) return disabledRefusal;

    // Which ROW the pick was made on, as the picker's own id. The ChatGPT
    // subscription and the OpenAI API key are both `openai/<id>` on OpenClaw
    // 2, so the reference cannot say which credential the owner chose: on a
    // box holding both, the two rows offer the same model and only the click
    // knows. Absent (an older tab, a script) it falls back to the credential
    // facts below, which is the single-credential answer and still right there.
    const pickedUiProvider = normalizeProvider(body.provider)
      ?? (body.source === "primary" ? state.primary.provider : null);
    const pickedChatgptRow = pickedUiProvider === CHATGPT_UI_PROVIDER;

    let targetModel: string | null = null;
    let authConfig: OpenClawConfig | null | undefined = preloadedConfig;
    const getAuthConfig = async () => {
      if (authConfig === undefined) {
        authConfig = await readConfig().catch(() => null);
      }
      return authConfig;
    };
    // ONE snapshot of the Claude subscription surface for this request. The
    // two guard sites straddle the auto-extend's config write, and the catalog
    // route refreshes that cache on its own schedule: read it twice and a
    // refresh landing in between lets the first guard allow, the write happen,
    // and the second guard refuse — a failure reported over an operation that
    // already succeeded. Memoised per request, both guards agree, and a
    // refusal always lands at the first site, before any write.
    //
    // Per REQUEST, not per process: a module-level memo would pin the guard to
    // whatever the surface looked like after the last restart.
    let surfaceIds: Set<string> | null | undefined;
    const getSurfaceIds = async () => {
      if (surfaceIds === undefined) {
        surfaceIds = await readSubscriptionSurfaceIds("anthropic");
      }
      return surfaceIds;
    };
    const openAiCredentials = await readOpenAiCredentials(getAuthConfig);

    if (typeof body.model === "string" && body.model.trim()) {
      const requestedModel = body.model.trim();
      // Matched on the row too, when the picker named one: two rows can carry
      // the same `openai/<id>` on a dual-credential box, and taking the first
      // match sent a ChatGPT pick down the API-key path.
      const targetOption = state.options.find((option) =>
        option.model === requestedModel
        && (!pickedUiProvider || option.provider === pickedUiProvider));
      if (targetOption?.available && targetOption.model) {
        targetModel = targetOption.model;
      } else {
        // Power-user path: accept any valid <provider>/<modelId> as long
        // as that provider has a configured auth profile. This backs
        // both the chat popup's inline model switcher and custom
        // model IDs entered in the wizard/Settings. Without this escape
        // hatch the curated-list dropdown would be the only reachable
        // surface and newer/region-specific models would be unavailable.
        const parsed = parseModelSlug(requestedModel);
        if (!parsed || !isValidModelId(parsed.provider, parsed.modelId)) {
          return NextResponse.json({ error: "Invalid model identifier" }, { status: 400 });
        }
        // The door the picker does not stand in front of: the ClawBox AI
        // image entry is a valid-SHAPED `openai/*` id on every paired box, and
        // written as the primary it fails every chat turn. Only that id — this
        // door deliberately takes chat ids the curated list omits.
        if (isClawboxAiImageModelRef(requestedModel)) {
          return NextResponse.json(
            { error: `${parsed.modelId} is the ClawBox AI image model, not a chat model.` },
            { status: 400 },
          );
        }
        let effectiveModel = requestedModel;
        let effectiveProvider = parsed.provider;
        const effectiveModelId = parsed.modelId;
        const chatgptPick = resolveChatgptPick(requestedModel, parsed, openAiCredentials, pickedChatgptRow);
        if (chatgptPick && "refusal" in chatgptPick) return chatgptPick.refusal;
        if (chatgptPick) {
          chatgptRouted = true;
          effectiveProvider = CHATGPT_PROVIDER;
          effectiveModel = chatgptPick.model;
        }
        // Both surface rules judge the EFFECTIVE id — the one this request
        // will actually write — not the one that arrived: the openai block
        // above can move the pick into the `codex/` namespace, where a
        // different catalogue applies.
        //
        // And both refuse BEFORE the openai-compat auto-extend below: that
        // path writes `models.providers.anthropic.models`, and a rejection
        // that has already had a side effect is not a rejection. Without this,
        // an id from a stale tab either pinned the box to a model that cannot
        // route or - when the providerDef was thin - drew a 409 "isn't fully
        // configured. Re-save it in Settings", the wrong next step for a box
        // whose settings are fine.
        const unsupportedCodex = refuseUnsupportedCodexModel(effectiveProvider, effectiveModelId, chatgptRouted);
        if (unsupportedCodex) return unsupportedCodex;
        const offSurface = await refuseOffSurfaceClaudeModel(
          effectiveProvider,
          effectiveModelId,
          getAuthConfig,
          getSurfaceIds,
        );
        if (offSurface) return offSurface;
        // Normalize the parsed provider so the deepseek/clawai alias
        // comparison works — option.provider was set via normalizeProvider
        // (deepseek → clawai), so a raw `parsed.provider === "deepseek"`
        // would never match a `"clawai"` option even though they refer
        // to the same auth profile.
        // The ChatGPT subscription is the `codex` row whatever namespace the
        // core wants it written under.
        const parsedProviderNormalized = chatgptRouted ? CHATGPT_UI_PROVIDER : normalizeProvider(effectiveProvider);
        const providerConfigured = state.options.some(
          (option) => option.provider === parsedProviderNormalized && option.available,
        );
        if (!providerConfigured) {
          return NextResponse.json({ error: "Selected AI provider is not configured" }, { status: 400 });
        }
        // OpenAI-compat providers (OPENAI_COMPAT_PROVIDERS: openrouter, google,
        // anthropic — ClawBox routes them through their OpenAI-compatible
        // endpoints, see ai-models/configure) need the chosen model listed in
        // `models.providers.<p>.models`, otherwise the gateway silently falls
        // back with no error the user can see. The chat header pulls from the
        // live catalog, so instead of forcing a "Re-save in Settings" round trip
        // on every fresh pick we auto-extend the configured list. clawai/openai/
        // codex use OpenClaw's built-in catalogs, so they don't need this.
        if (OPENAI_COMPAT_PROVIDERS.has(effectiveProvider)) {
          const providerId = effectiveProvider;
          let openclawConfig: OpenClawConfig;
          try {
            openclawConfig = await readConfig();
          } catch (err) {
            // Don't fall back to an empty config: existingModels would be [] and
            // we'd overwrite models.providers.<p>.models with ONLY the new id,
            // dropping every other configured model. Fail loud instead.
            console.error(`[chat/model] readConfig failed during ${providerId} auto-extend:`, err);
            return NextResponse.json(
              { error: `Could not read the model configuration to register ${requestedModel}. Please try again.` },
              { status: 500 },
            );
          }
          const providerDef = openclawConfig.models?.providers?.[providerId] as
            | { models?: { id?: string; name?: string }[]; apiKey?: string; baseUrl?: string; api?: string }
            | undefined;
          // A SUBSCRIPTION box has no `models.providers.<p>` entry at all, and
          // that is the fixed state, not a broken one: the openai-compat
          // override is an API-key construction, and writing an OAuth token
          // into it made every Anthropic turn 429 (see ai-models/configure).
          // Routing belongs to the native plugin, whose own catalog resolves
          // any id — the same reason clawai/openai/codex skip this block
          // entirely. Without this the 409 below would fire on every model
          // switch such a box makes, because there is correctly nothing to
          // extend. An entry that EXISTS but is half-written still 409s.
          const nativeSubscriptionRouting =
            !providerDef
            && subscriptionOnlyProviders(openclawConfig.auth?.profiles, normalizeProvider)
              .includes(providerId);
          if (!nativeSubscriptionRouting) {
            // The reroute (ai-models/configure) writes baseUrl + api + apiKey
            // alongside models. If the endpoint, api type, or inline key is
            // missing (legacy or half-written state), appending only `.models`
            // would leave a provider that can't authenticate — make the user
            // re-save rather than switch the primary onto an incomplete provider.
            if (!providerDef?.apiKey || !providerDef?.baseUrl || !providerDef?.api) {
              return NextResponse.json(
                { error: `${labelForProvider(providerId, providerId)} isn't fully configured. Re-save it in Settings, then pick the model again.` },
                { status: 409 },
              );
            }
            const existingModels = providerDef.models ?? [];
            const configuredIds = existingModels
              .map((m) => m?.id)
              .filter((id): id is string => typeof id === "string" && id.length > 0);
            // Append whenever the requested slug isn't already there — even for a
            // freshly-configured provider whose seed providerDef has only the
            // user's chosen default (the earlier `length > 0` guard silently fell
            // back to local on the first switch after a clean setup).
            if (!configuredIds.includes(effectiveModelId)) {
              // Emit only `id`+`name`; OpenClaw looks the rest (contextWindow,
              // modalities, cost) up from its bundled provider catalog by id.
              const nextModels = [
                ...existingModels,
                { id: effectiveModelId, name: effectiveModelId },
              ];
              try {
                await runOpenclawConfigSet([
                  `models.providers.${providerId}.models`,
                  JSON.stringify(nextModels),
                  "--json",
                ]);
              } catch (err) {
                console.error(`[chat/model] auto-extend ${providerId} providerDef failed:`, err);
                return NextResponse.json(
                  {
                    error: `Could not register ${requestedModel} with the ${labelForProvider(providerId, providerId)} provider. Re-save it in Settings to refresh the model list.`,
                  },
                  { status: 502 },
                );
              }
              // A row added to this array IS the provider's catalogue changing:
              // "configured providers in openclaw.json override the plugin's
              // modelCatalog entirely" (ai-models/configure), so what
              // `openclaw models list --provider <p>` answers for a compat
              // provider is exactly this list. Counted here rather than beside
              // the write above, because only the branch that actually
              // appended reaches this line — a pick already in the list writes
              // nothing and must announce nothing.
              notifyProviderSetChanged(providerId);
            }
          }
        }
        targetModel = effectiveModel;
      }
    } else {
      if (body.source !== "primary" && body.source !== "local") {
        return NextResponse.json({ error: "Invalid chat model source" }, { status: 400 });
      }

      targetModel = body.source === "primary" ? state.primary.model : state.local.model;
    }

    if (!targetModel) {
      return NextResponse.json(
        { error: body.source === "primary" ? "AI provider is not configured" : "Local AI is not configured" },
        { status: 400 },
      );
    }

    // The other two doors — an id already in `state.options`, and a pick
    // restored through {"source":"primary"} — get the same rule as the
    // custom-model branch, on the resolved target.
    const targetParsed = parseModelSlug(targetModel);
    const targetChatgptPick = targetParsed
      ? resolveChatgptPick(targetModel, targetParsed, openAiCredentials, pickedChatgptRow || chatgptRouted)
      : null;
    if (targetChatgptPick && "refusal" in targetChatgptPick) return targetChatgptPick.refusal;
    if (targetChatgptPick) {
      chatgptRouted = true;
      targetModel = targetChatgptPick.model;
    }

    // Second site, on the RESOLVED target — the openai guard above is applied
    // twice for the same reason. An id that matched `state.options`, or one
    // restored by `{"source":"primary"}`, never went through the branch above.
    //
    // Re-parsed rather than reusing `targetParsed`: the openai block above can
    // rewrite `targetModel` into the `codex/` namespace, and each rule has to
    // judge the id on the namespace it will actually be WRITTEN under, not the
    // one it arrived in. (No id survives that remap that the codex rule then
    // refuses — the remap itself tests the allowlist — but a guard that only
    // holds because of a condition two blocks away is a guard waiting to
    // break.)
    const resolvedParsed = parseModelSlug(targetModel);
    const targetUnsupportedCodex = refuseUnsupportedCodexModel(
      resolvedParsed?.provider,
      resolvedParsed?.modelId ?? "",
      chatgptRouted,
    );
    if (targetUnsupportedCodex) return targetUnsupportedCodex;
    // The image rule, at the SECOND guard site too — the same reason the codex
    // and Claude rules are repeated here. Its first site sits inside the
    // power-user `else` branch, so a matched option or `{"source":"primary"}`
    // reaches the write below without passing it. Unreachable today only
    // because `rememberPrimaryOption` and the `models[]` filter keep the ref
    // out of `state.options`, which is exactly the "guard that holds because
    // of a condition two functions away" this block was written to avoid.
    if (isClawboxAiImageModelRef(targetModel)) {
      return NextResponse.json(
        { error: `${resolvedParsed?.modelId ?? targetModel} is the ClawBox AI image model, not a chat model.` },
        { status: 400 },
      );
    }
    const targetOffSurface = await refuseOffSurfaceClaudeModel(
      resolvedParsed?.provider,
      resolvedParsed?.modelId ?? "",
      getAuthConfig,
      getSurfaceIds,
    );
    if (targetOffSurface) return targetOffSurface;

    if (state.activeModel === targetModel) {
      // Already the primary — but a ChatGPT pick can arrive as `codex/<id>`
      // and remap onto a primary that IS `openai/<id>` already, on a box whose
      // Codex runtime entry is missing (written by an older ClawBox, or lost).
      // That entry is the only thing that keeps the turn on the ChatGPT
      // account, and this route was its only repair short of a reboot; a
      // no-op answer here left every turn failing. One write, only when the
      // entry is absent — a same-model pick on an armed box stays free.
      //
      //     Two-sided, and that is the fix for the mirror defect: the same
      //     model picked from the OpenAI API-key row on a box where an earlier
      //     ChatGPT pick armed it has to have the arm REMOVED, or the turn
      //     keeps going to the subscription over a click that said otherwise.
      //     The branch is entered whenever the arm disagrees with the pick, so
      //     a same-model pick is free only when they already agree.
      let sameModelWarning: string | undefined;
      const armed = chatgptRuntimeArmed(preloadedConfig, targetModel);
      const wrote = chatgptRouted !== armed;
      if (chatgptRouted && !armed) {
        await runOpenclawConfigSet(chatgptRuntimeArmOp(targetModel));
      } else if (!chatgptRouted && armed) {
        sameModelWarning = await disarmChatgptRuntime(targetModel);
      }
      // Re-read after a write, never before it: `state` was loaded from the
      // config as it was, where the arm this branch just removed still says
      // the model belongs to the ChatGPT row. Answering with that would tell
      // the owner they are on the subscription in the same response that took
      // them off it. A branch that wrote nothing keeps the snapshot it has.
      const settledState = wrote ? await loadChatModelState() : state;
      const sameModelOption = settledState.options.find((option) =>
        option.model === targetModel
        && (!pickedUiProvider || option.provider === pickedUiProvider));
      return NextResponse.json({
        ...settledState,
        activeSource: isLocalModel(targetModel) ? "local" : "primary",
        activeLabel: sameModelOption?.label ?? settledState.activeLabel,
        activeOptionId: sameModelOption?.id ?? settledState.activeOptionId,
        ...(sameModelWarning ? { warning: sameModelWarning } : {}),
      });
    }

    if (!isLocalModel(state.activeModel) && state.activeModel) {
      await sqliteSet(PRIMARY_MODEL_KEY, state.activeModel);
    }

    const parsed = parseFullyQualifiedModel(targetModel);

    // 1. Update the agent-level default so any *future* session starts
    //    with the user's chosen model — in ONE batch with the plugin enable
    //    the new primary needs, ahead of it. OpenClaw 2 validates the
    //    reference against the enabled plugins' catalogs, after applying the
    //    whole batch to one snapshot: the enable in the same spawn is what
    //    lets a switch back to Claude validate on a box whose plugin an
    //    earlier gate switched off, and a refused batch leaves the flag as it
    //    was (src/lib/provider-plugin-ops.ts). The batch retries on transient
    //    ConfigMutationConflictError with a 30 s per-attempt timeout (CLI
    //    startup alone is ~10 s on Jetson Orin), so users switching chat
    //    models don't see a bogus failure when the gateway reloads
    //    concurrently with the write.
    //
    // 1b. The Codex runtime arm rides in the SAME batch. Codex turns only work
    //     through the Codex app-server harness, which `agentRuntime` selects:
    //     without it core uses its generic HTTP responses transport, which
    //     posts to https://chatgpt.com/backend-api/responses — a browser
    //     endpoint Cloudflare managed-challenges — and every turn fails with
    //     "the provider returned an HTML error page". gateway-pre-start.sh sets
    //     it too, but a model change applies WITHOUT a restart, so the pick has
    //     to arm it immediately or the very next message fails until the box is
    //     rebooted. In the batch rather than a second spawn: one CLI cold start
    //     instead of two on a Jetson, and atomic with the primary it describes —
    //     the reference is `openai/<id>` for both OpenAI lanes and this entry
    //     is the ONLY thing that says the turn belongs to the ChatGPT account.
    const armOps = chatgptRouted && !chatgptRuntimeArmed(preloadedConfig, targetModel)
      ? [chatgptRuntimeArmOp(targetModel)]
      : [];
    // The plugin flag as it stands at the last moment before the batch, for the
    // ON half below. Not `preloadedConfig`: that was read at the top of the
    // handler, and the auto-extend between here and there is its own ~10 s CLI
    // spawn on a Jetson — a provider save landing in that window switches the
    // flag off through its own gate, and a stale "it was already on" reading
    // would swallow the switch-on this batch then performs. A file read, not a
    // spawn, next to writes that cost seconds.
    //
    // STRICT and `null` on failure, for the reason the OFF half reads strictly:
    // the decision is about ABSENCE, and plain `readConfig` answers `{}` to an
    // EACCES exactly as it does to a box with no config at all. An absent flag
    // IS enabled, so `{}` must stay silent; "could not read" must not.
    const configBeforeBatch = await readConfigStrict().catch(() => null);
    try {
      await runOpenclawConfigSetBatch([
        ...enableProviderPluginOps([targetModel]),
        ["agents.defaults.model.primary", targetModel],
        ...armOps,
      ]);
    } catch (err) {
      // OpenClaw 2 validates the reference against the catalogs it can see and
      // refuses with a sentence written for a terminal. The owner gets the
      // provider, the model and a next step instead. Wrapping the BATCH, not a
      // bare primary write: the plugin enable rides in it and must stay there
      // (#589), and the refusal it can draw is still the catalog's.
      const unresolvable = refuseUnresolvableModel(targetModel, err, chatgptRouted);
      if (unresolvable) return unresolvable;
      throw err;
    }

    // 1b. The ON half of the plugin gate, counted. The batch above is the only
    //     thing that switches a plugin back on, and a provider whose plugin is
    //     off enumerates NOTHING — so this is the same provider-set change as
    //     the OFF half below, in the other direction, and the catalogue was
    //     told about neither. Worse than a one-off staleness: an enumeration
    //     that comes back empty is recorded as a failed refresh, and that wait
    //     DOUBLES up to the six-hour refresh interval, so a provider whose
    //     plugin has been off for a while is not even re-asked for six hours
    //     after the pick that made it listable. Counting the change is what
    //     drops that wait back to the floor.
    //
    //     After the batch, never before it: a refused batch changed no flag
    //     (it is applied to one snapshot and validated as a whole), and
    //     announcing a change that did not happen would spend a ~3-minute
    //     `openclaw models list` on a Jetson for nothing.
    //
    //     One request CAN announce the same provider twice — the auto-extend
    //     above, then this — which costs one superseded ~3-minute fork in the
    //     narrow case where both fire. Deliberately not deferred into a single
    //     flush at the end: this handler has several exits that leave a
    //     completed write behind (the 502, the 409, the same-model return), and
    //     a flush that misses one of them trades a bounded cost for six hours
    //     of a catalogue that says `source: "live"` about a box that moved.
    //     Each announcement therefore sits at the write it describes.
    const pluginSwitchedOn = providerPluginSwitchedOnBy([targetModel], configBeforeBatch);
    if (pluginSwitchedOn) notifyProviderSetChanged(pluginSwitchedOn);

    // 1c. The other side of the arm: a pick that is NOT the subscription's, on
    //     a reference an earlier ChatGPT pick armed, has to clear it — a
    //     separate spawn because a batch has no delete (see
    //     `disarmChatgptRuntime`). Its failure is carried in the answer.
    let disarmWarning: string | undefined;
    if (!chatgptRouted && chatgptRuntimeArmed(preloadedConfig, targetModel)) {
      disarmWarning = await disarmChatgptRuntime(targetModel);
    }

    // 2. Full sweep including sessions previously tagged
    //    `modelOverrideSource: "user"` — the dropdown click *is* the
    //    user's current pick, so prior tags shouldn't make repeat
    //    clicks no-op. The soft-sweep "parallel chats deliberately
    //    running different models" use case has no UI today.
    if (parsed) {
      try {
        await applyModelOverrideToAllAgentSessions(
          {
            provider: parsed.provider,
            modelId: parsed.modelId,
            source: "user",
          },
          { skipUserTagged: false },
        );
      } catch (err) {
        // Non-fatal: the default change (step 1) still takes effect
        // for brand-new sessions. Worst case the user has to /reset
        // the open chat. Log and continue.
        console.error("[chat/model] Failed to sweep session overrides:", err);
      }
      // 3. The OFF half of the gate: switch the anthropic plugin off only
      //    when nothing on the box could use it — the primary is elsewhere
      //    AND no usable Anthropic credential remains (see setProviderPlugins).
      //    Other plugins stay where they are.
      const flippedProvider = await setProviderPlugins(parsed.provider);
      // A flipped plugin IS a provider-set change: switching anthropic off is
      // precisely what empties `openclaw models list --provider anthropic`.
      // Neither this route nor ChatPopup emitted anything for it, and the
      // catalogue hook deliberately ignores the model-SELECTION event, so the
      // enumeration taken while the plugin was on stood as `source: "live"` for
      // six hours. `setProviderPlugins` returns the id it changed, or null when
      // it changed nothing, so this cannot announce a change that did not
      // happen. It is also the path `POST /setup-api/providers/default`
      // delegates to on OpenClaw, so counting it here covers that route too.
      if (flippedProvider) notifyProviderSetChanged(flippedProvider);
    }

    // The model is already written; the restart is only what makes it live. So
    // NO restart failure is a failed switch — the outer catch's 500 "Failed to
    // switch chat model" would be a false failure over a change that IS on
    // disk, whether the gateway never came back or the unit was masked by an
    // update in flight. Both answer 502 with the new state, and the warning
    // says which, because the owner's next step differs: wait, or find out why
    // the service refused.
    let gatewayWarning: string | undefined;
    try {
      await restartGateway();
    } catch (err) {
      gatewayWarning = err instanceof GatewayNotReadyError
        ? "Saved, but the gateway did not come back — the new model applies once it is serving again."
        : "Saved, but the gateway could not be restarted — the new model applies at its next restart.";
      console.error("[chat/model] gateway restart failed after the model switch:", err);
    }

    const nextState = await loadChatModelState();
    const warning = [disarmWarning, gatewayWarning].filter(Boolean).join(" ");
    return NextResponse.json(
      { ...nextState, ...(warning ? { warning } : {}) },
      { status: gatewayWarning ? 502 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to switch chat model" },
      { status: 500 },
    );
  }
}
