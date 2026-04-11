import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAll } from "@/lib/config-store";
import { inferConfiguredLocalModel, findOpenclawBin, readConfig, restartGateway, type OpenClawConfig } from "@/lib/openclaw-config";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";

export const dynamic = "force-dynamic";

const exec = promisify(execFile);
const PRIMARY_MODEL_KEY = "chat:primary-provider-model";

type ChatModelSource = "primary" | "local";

const PROVIDER_LABELS: Record<string, string> = {
  clawai: "ClawBox AI",
  anthropic: "Anthropic Claude",
  openai: "OpenAI GPT",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  ollama: "Ollama Local",
  llamacpp: "Gemma 4 Local",
  deepseek: "ClawBox AI",
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
  const primaryLabel = primaryModel
    ? labelForProvider(primaryProvider, "AI Provider")
    : null;

  const activeSource: ChatModelSource | null = activeModel
    ? (isLocalModel(activeModel) ? "local" : "primary")
    : null;
  const activeLabel = activeSource === "local"
    ? localLabel
    : activeSource === "primary"
      ? primaryLabel
      : null;

  return {
    activeSource,
    activeLabel,
    activeModel,
    primary: {
      available: !!primaryModel,
      label: primaryLabel,
      model: primaryModel,
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
    let body: { source?: ChatModelSource };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (body.source !== "primary" && body.source !== "local") {
      return NextResponse.json({ error: "Invalid chat model source" }, { status: 400 });
    }

    const state = await loadChatModelState();
    const targetModel = body.source === "primary" ? state.primary.model : state.local.model;
    if (!targetModel) {
      return NextResponse.json(
        { error: body.source === "primary" ? "AI provider is not configured" : "Local AI is not configured" },
        { status: 400 },
      );
    }

    if (state.activeModel === targetModel) {
      return NextResponse.json({
        ...state,
        activeSource: body.source,
        activeLabel: body.source === "primary" ? state.primary.label : state.local.label,
      });
    }

    if (!isLocalModel(state.activeModel) && state.activeModel) {
      await sqliteSet(PRIMARY_MODEL_KEY, state.activeModel);
    }

    const openclawBin = findOpenclawBin();
    await exec(openclawBin, ["config", "set", "agents.defaults.model.primary", targetModel], { timeout: 10000 });
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
