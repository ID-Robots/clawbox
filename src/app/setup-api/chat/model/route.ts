import { NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import {
  inferConfiguredLocalModel,
  readConfig,
  restartGateway,
  runOpenclawConfigSet,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
  setProviderPlugins,
  type OpenClawConfig,
} from "@/lib/openclaw-config";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";
import {
  CLAWBOX_AI_MODEL_BY_TIER,
  CLAWBOX_AI_DEFAULT_TIER,
} from "@/lib/clawbox-ai-models";
import { OPENROUTER_DEFAULT_MODEL_ID } from "@/lib/openrouter-models";
import { isValidModelId, parseModelSlug } from "@/lib/provider-models";
import {
  isClaudeSubscriptionOnly,
  offSurfaceClaudeModelMessage,
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
  anthropic: "anthropic/claude-sonnet-4-6",
  openai: "openai/gpt-5.4",
  // Newest model on every ChatGPT tier including Free; gpt-5.6 is plan-gated.
  codex: "codex/gpt-5.5",
  google: "google/gemini-2.5-flash",
  openrouter: `openrouter/${OPENROUTER_DEFAULT_MODEL_ID}`,
};

// Models selectable while the device is on ChatGPT/Codex subscription auth.
// GPT-5.6 Sol/Terra/Luna are subscription-eligible — OpenClaw's ChatGPT route
// catalog carries all three, and `openai/gpt-5.6-sol` is the documented
// default for a fresh Codex OAuth setup. Keeping them out of this allowlist
// rejected them locally with "not supported with ChatGPT subscription auth"
// before the request ever reached OpenAI. GPT-5.6 is a limited preview, so
// per-account access still varies: let the pick through and surface the
// upstream access error instead of pre-rejecting it here. `-pro` tiers stay
// out — those remain API-key only.
const CODEX_SUPPORTED_MODEL_RE = /^(?:gpt-5\.6-(?:sol|terra|luna)|gpt-5\.5|gpt-5\.4(?:-mini)?)$/;
const OPENAI_PRO_MODEL_RE = /^gpt-5\.[45]-pro$/;

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
function subscriptionProvidersForUi(config: OpenClawConfig): string[] {
  // `normalizeProvider` goes IN, not around the outside. deepseek and clawai
  // are one provider under two names, so collapsing the alias after the
  // credentials are counted would read an OAuth profile written as `deepseek`
  // and an API key written as `clawai` as two separate providers, and report
  // the box subscription-only on a key it actually holds.
  return subscriptionOnlyProviders(config.auth?.profiles, normalizeProvider);
}

function hasOpenAiApiKeyProfile(config: OpenClawConfig): boolean {
  const profiles = config.auth?.profiles ?? {};
  return Object.values(profiles).some((entry) => {
    const provider = typeof entry?.provider === "string" ? entry.provider.trim().toLowerCase() : "";
    const mode = typeof entry?.mode === "string" ? entry.mode.trim().toLowerCase() : "";
    return provider === "openai" && (mode === "token" || mode === "api_key" || mode === "api-key");
  });
}

function hasCodexOauthProfile(config: OpenClawConfig): boolean {
  const profiles = config.auth?.profiles ?? {};
  return Object.values(profiles).some((entry) => {
    const provider = typeof entry?.provider === "string" ? entry.provider.trim().toLowerCase() : "";
    const mode = typeof entry?.mode === "string" ? entry.mode.trim().toLowerCase() : "";
    return provider === "codex" && mode === "oauth";
  });
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

async function loadChatModelState() {
  const [configStore, openclawConfig, storedPrimaryModel] = await Promise.all([
    getAll(),
    readConfig().catch(() => ({} as OpenClawConfig)),
    sqliteGet(PRIMARY_MODEL_KEY).catch(() => null),
  ]);

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
    ? normalizeProviderFromModel(activeModel)
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
    const provider = normalizeProvider(providerHint ?? normalizeProviderFromModel(trimmedModel));
    if (!provider) return;
    if (configuredPrimaryOptions.has(provider)) return;
    const label = labelForProvider(provider, "AI Provider");
    configuredPrimaryOptions.set(provider, {
      id: trimmedModel,
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

  const authProfiles = openclawConfig.auth?.profiles ?? {};
  const providerDefinitions = openclawConfig.models?.providers ?? {};
  for (const [profileKey, entry] of Object.entries(authProfiles)) {
    const rawProvider = typeof entry?.provider === "string" ? entry.provider : profileKey.split(":")[0];
    const provider = normalizeProvider(rawProvider);
    if (!provider || provider === "ollama" || provider === "llamacpp") continue;

    // Pick which model represents this provider in the dropdown:
    //  1. activeModel if it belongs to this provider (so the row's
    //     "model" field matches what the gateway is actually using).
    //  2. The first model in the openclaw provider definition.
    //  3. The hard-coded default for this provider.
    const providerDef = providerDefinitions[rawProvider];
    const definedModels = (providerDef?.models ?? []).filter((m): m is { id: string; name?: string } => typeof m?.id === "string" && m.id.trim().length > 0);

    let model: string | null = null;
    if (activeModel && normalizeProviderFromModel(activeModel) === provider) {
      model = activeModel;
    } else if (definedModels.length > 0) {
      model = `${rawProvider}/${definedModels[0].id}`;
    } else {
      model = defaultModelForProvider(rawProvider);
    }

    if (model) rememberPrimaryOption(model, rawProvider);
  }

  if (primaryProvider && primaryProvider !== "ollama" && primaryProvider !== "llamacpp") {
    const model = defaultModelForProvider(configStore.ai_model_provider as string);
    if (model) rememberPrimaryOption(model, primaryProvider);
  }

  // When Local-only mode is on, the cloud providers are intentionally
  // disabled — dropping them from the dropdown is the UX that matches
  // the toggle's promise ("Route everything to the local model.
  // Disables all cloud AI providers"). Without this the user can still
  // pick GPT/Claude/DeepSeek in the chat dropdown while Local-only is
  // lit up, and the chat then quietly talks to the cloud provider.
  const localOnlyMode = !!configStore.local_only_mode;
  const primaryOptions = localOnlyMode
    ? []
    : sortPrimaryOptions([...configuredPrimaryOptions.values()]);
  const localOption: ChatModelOption = localModel
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
      };

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

  const summaryPrimaryOption = primaryOptions.find((option) => option.model === primaryModel) ?? primaryOptions[0] ?? null;
  const primaryLabel = summaryPrimaryOption?.label ?? null;

  const activeSource: ChatModelSource | null = activeModel
    ? (isLocalModel(activeModel) ? "local" : "primary")
    : null;
  const activeOption = options.find((option) => option.model === activeModel) ?? null;
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
    },
    local: {
      available: !!localModel,
      label: localLabel,
      model: localModel,
    },
    subscriptionProviders: subscriptionProvidersForUi(openclawConfig),
  };
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
    let body: { source?: ChatModelSource; model?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const state = await loadChatModelState();
    let targetModel: string | null = null;
    let authConfig: OpenClawConfig | null | undefined;
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

    if (typeof body.model === "string" && body.model.trim()) {
      const requestedModel = body.model.trim();
      const targetOption = state.options.find((option) => option.model === requestedModel);
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
        let effectiveModel = requestedModel;
        let effectiveProvider = parsed.provider;
        let effectiveModelId = parsed.modelId;
        if (parsed.provider === "codex" && !CODEX_SUPPORTED_MODEL_RE.test(parsed.modelId)) {
          return NextResponse.json({
            error: `${parsed.modelId} is not supported with ChatGPT subscription auth. Use GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4, or GPT-5.4 Mini, or switch OpenAI to API-key mode for Pro/API-only models.`,
          }, { status: 400 });
        }
        if (parsed.provider === "openai") {
          const openclawConfig = await getAuthConfig();
          const hasOpenAiKey = !!openclawConfig && hasOpenAiApiKeyProfile(openclawConfig);
          const hasCodexOauth = !!openclawConfig && hasCodexOauthProfile(openclawConfig);
          if (!hasOpenAiKey && hasCodexOauth && CODEX_SUPPORTED_MODEL_RE.test(parsed.modelId)) {
            // Legacy/pre-hotfix UI state sometimes submits openai/gpt-5.5
            // even though the device is configured with ChatGPT subscription
            // auth. Sending that to api.openai.com 401s with "Missing bearer"
            // because there is no OpenAI API key. Route the same visible GPT
            // choice through Codex, which is the ChatGPT-account provider.
            effectiveProvider = "codex";
            effectiveModelId = parsed.modelId;
            effectiveModel = `codex/${parsed.modelId}`;
          } else if (!hasOpenAiKey) {
            return NextResponse.json({
              error: `${parsed.modelId} requires OpenAI API-key mode. ChatGPT subscription auth supports GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4, and GPT-5.4 Mini.`,
            }, { status: 400 });
          }
        }
        // Refuse BEFORE the openai-compat auto-extend below: that path writes
        // `models.providers.anthropic.models`, and a rejection that has
        // already had a side effect is not a rejection. Without this, an id
        // from a stale tab either pinned the box to a model that cannot route
        // or - when the providerDef was thin - drew a 409 "isn't fully
        // configured. Re-save it in Settings", the wrong next step for a box
        // whose settings are fine.
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
        const parsedProviderNormalized = normalizeProvider(effectiveProvider);
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

    const targetParsed = parseModelSlug(targetModel);
    if (targetParsed?.provider === "openai") {
      const openclawConfig = await getAuthConfig();
      const hasOpenAiKey = !!openclawConfig && hasOpenAiApiKeyProfile(openclawConfig);
      const hasCodexOauth = !!openclawConfig && hasCodexOauthProfile(openclawConfig);
      if (!hasOpenAiKey && hasCodexOauth && CODEX_SUPPORTED_MODEL_RE.test(targetParsed.modelId)) {
        targetModel = `codex/${targetParsed.modelId}`;
      } else if (!hasOpenAiKey) {
        return NextResponse.json({
          error: `${targetParsed.modelId} requires OpenAI API-key mode. ChatGPT subscription auth supports GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4, and GPT-5.4 Mini.`,
        }, { status: 400 });
      }
    }

    // Second site, on the RESOLVED target — the openai guard above is applied
    // twice for the same reason. An id that matched `state.options`, or one
    // restored by `{"source":"primary"}`, never went through the branch above.
    const targetOffSurface = await refuseOffSurfaceClaudeModel(
      targetParsed?.provider,
      targetParsed?.modelId ?? "",
      getAuthConfig,
      getSurfaceIds,
    );
    if (targetOffSurface) return targetOffSurface;

    if (state.activeModel === targetModel) {
      return NextResponse.json({
        ...state,
        activeSource: isLocalModel(targetModel) ? "local" : "primary",
        activeLabel: state.options.find((option) => option.model === targetModel)?.label ?? state.activeLabel,
        activeOptionId: state.options.find((option) => option.model === targetModel)?.id ?? state.activeOptionId,
      });
    }

    if (!isLocalModel(state.activeModel) && state.activeModel) {
      await sqliteSet(PRIMARY_MODEL_KEY, state.activeModel);
    }

    // 1. Update the agent-level default so any *future* session starts
    //    with the user's chosen model. runOpenclawConfigSet retries on
    //    transient ConfigMutationConflictError and uses a 30 s per-attempt
    //    timeout by default (CLI startup alone is ~10 s on Jetson Orin),
    //    so users switching chat models don't see a bogus failure when the
    //    gateway reloads concurrently with the write.
    await runOpenclawConfigSet(["agents.defaults.model.primary", targetModel]);

    // 1b. Codex turns only work through the Codex app-server harness, which is
    //     selected by agentRuntime. Without it core uses its generic HTTP
    //     responses transport, which posts to
    //     https://chatgpt.com/backend-api/responses — a browser endpoint
    //     Cloudflare managed-challenges — and every turn fails with "the
    //     provider returned an HTML error page". gateway-pre-start.sh sets this
    //     too, but a model change applies WITHOUT a restart, so picking Codex
    //     here has to arm the runtime immediately or the very next message
    //     fails until the box is rebooted.
    if (targetModel.toLowerCase().startsWith("codex/")) {
      await runOpenclawConfigSet([
        `agents.defaults.models.${targetModel}.agentRuntime.id`,
        "codex",
      ]);
    }

    // 2. Full sweep including sessions previously tagged
    //    `modelOverrideSource: "user"` — the dropdown click *is* the
    //    user's current pick, so prior tags shouldn't make repeat
    //    clicks no-op. The soft-sweep "parallel chats deliberately
    //    running different models" use case has no UI today.
    const parsed = parseFullyQualifiedModel(targetModel);
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
      // 3. Gate the anthropic plugin to only when the new primary actually
      //    needs it. Other plugins stay where they are.
      await setProviderPlugins(parsed.provider);
    }

    await restartGateway();

    const nextState = await loadChatModelState();
    return NextResponse.json(nextState, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to switch chat model" },
      { status: 500 },
    );
  }
}
