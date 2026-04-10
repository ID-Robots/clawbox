import { NextResponse } from "next/server";
import { readConfig } from "@/lib/openclaw-config";

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

    return NextResponse.json({
      connected: !!normalizedProvider,
      provider: normalizedProvider,
      providerLabel: normalizedProvider ? (PROVIDER_LABELS[normalizedProvider] ?? normalizedProvider) : null,
      mode,
      model,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { connected: false, provider: null, providerLabel: null, mode: null, model: null },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
