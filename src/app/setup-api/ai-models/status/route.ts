import { NextResponse } from "next/server";
import { readConfig } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "ClawBox AI",
  anthropic: "Anthropic Claude",
  openai: "OpenAI GPT",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  ollama: "Ollama Local",
  llamacpp: "llama.cpp Local",
};

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

    return NextResponse.json({
      connected: !!provider,
      provider,
      providerLabel: provider ? (PROVIDER_LABELS[provider] ?? provider) : null,
      mode,
      model,
    });
  } catch {
    return NextResponse.json({ connected: false, provider: null, providerLabel: null, mode: null, model: null });
  }
}
