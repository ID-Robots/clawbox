import { NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import {
  inferConfiguredLocalModel,
  readConfig,
  restartGateway,
  runOpenclawConfigSet,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
  type OpenClawConfig,
} from "@/lib/openclaw-config";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";

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
  "openai-codex": "OpenAI Codex",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  ollama: "Ollama Local",
  llamacpp: "Gemma 4 Local",
  deepseek: "ClawBox AI",
};

const PROVIDER_ORDER = ["clawai", "openai", "anthropic", "google", "openrouter"] as const;
const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  // Match the configure route's CLAWBOX_AI_FLASH_MODEL_ID — used only
  // when no explicit `models.providers.deepseek.models` entry exists
  // (legacy installs that were configured before the V4 alias swap).
  clawai: "deepseek/deepseek-v4-flash",
  deepseek: "deepseek/deepseek-v4-flash",
  anthropic: "anthropic/claude-sonnet-4-6",
  openai: "openai/gpt-5.4",
  "openai-codex": "openai-codex/gpt-5.4",
  google: "google/gemini-2.0-flash",
  openrouter: "openrouter/moonshotai/kimi-k2-0905",
};

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

  const primaryProvider = normalizeProvider(configStore.ai_model_provider);
  // Keyed by *model id* (e.g. "deepseek/deepseek-v4-pro") rather than
  // by provider so a single provider can surface multiple options —
  // e.g. ClawBox AI Flash vs Pro both belong to the `deepseek`
  // provider but are independent rows in the chat dropdown.
  const configuredPrimaryOptions = new Map<string, ChatModelOption>();
  const rememberPrimaryOption = (
    model: string | null | undefined,
    providerHint?: string | null,
    labelOverride?: string | null,
  ) => {
    const trimmedModel = typeof model === "string" ? model.trim() : "";
    if (!trimmedModel || isLocalModel(trimmedModel)) return;
    const provider = normalizeProvider(providerHint ?? normalizeProviderFromModel(trimmedModel));
    if (!provider) return;
    const trimmedLabelOverride = labelOverride?.trim();
    const existing = configuredPrimaryOptions.get(trimmedModel);
    // Allow callers that know the canonical model name (provider
    // definition rows) to upgrade a placeholder option that an earlier
    // pass had to fall back on labelForProvider for. Without this the
    // first entry from `activeModel`/`primaryModel` would lock the
    // dropdown row to the bare "ClawBox AI" label even after the
    // provider definition told us it's actually "ClawBox AI Pro".
    if (existing && !trimmedLabelOverride) return;
    const label = trimmedLabelOverride || labelForProvider(provider, "AI Provider");
    configuredPrimaryOptions.set(trimmedModel, {
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

    // Prefer enumerating every model registered under this provider's
    // `models.providers.<provider>.models` block so multi-model
    // providers (ClawBox AI Flash + Pro, future tier expansions, etc.)
    // surface every variant in the chat dropdown. Fall back to the
    // single hard-coded default when the provider definition has no
    // explicit models list.
    const providerDef = providerDefinitions[rawProvider];
    const definedModels = (providerDef?.models ?? []).filter((m): m is { id: string; name?: string } => typeof m?.id === "string" && m.id.trim().length > 0);

    if (definedModels.length > 0) {
      for (const def of definedModels) {
        const fullyQualified = `${rawProvider}/${def.id}`;
        rememberPrimaryOption(fullyQualified, rawProvider, def.name);
      }
      continue;
    }

    const model = defaultModelForProvider(rawProvider);
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

    if (typeof body.model === "string" && body.model.trim()) {
      const requestedModel = body.model.trim();
      const targetOption = state.options.find((option) => option.model === requestedModel);
      if (!targetOption?.available || !targetOption.model) {
        return NextResponse.json({ error: "Selected AI provider is not configured" }, { status: 400 });
      }
      targetModel = targetOption.model;
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

    // 2. Sweep every existing session's per-session override to the
    //    same model, tagged `source: "user"` so OpenClaw's per-turn
    //    model resolver returns early and leaves the override alone
    //    on each subsequent message. Without this step, changing the
    //    chat model dropdown only affected newly-opened sessions —
    //    the currently-open chat pane kept routing to whatever
    //    provider its `modelOverrideSource: "auto"` entry had picked,
    //    making the UI dropdown feel broken. (NB: "manual" *looks*
    //    like the right string but isn't recognised anywhere in the
    //    OpenClaw dist; only "user" is sticky. See the docstring on
    //    `applyModelOverrideToAllAgentSessions`.)
    const parsed = parseFullyQualifiedModel(targetModel);
    if (parsed) {
      try {
        await applyModelOverrideToAllAgentSessions({
          provider: parsed.provider,
          modelId: parsed.modelId,
          source: "user",
        });
      } catch (err) {
        // Non-fatal: the default change (step 1) still takes effect
        // for brand-new sessions. Worst case the user has to /reset
        // the open chat. Log and continue.
        console.error("[chat/model] Failed to sweep session overrides:", err);
      }
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
