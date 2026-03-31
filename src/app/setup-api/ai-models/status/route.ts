import { NextResponse } from "next/server";
import { readConfig } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "ClawAI",
  anthropic: "Anthropic Claude",
  openai: "OpenAI GPT",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  ollama: "Ollama Local",
};

export async function GET() {
  try {
    const config = await readConfig();

    const profiles = config.auth?.profiles ?? {};
    const model = config.agents?.defaults?.model?.primary ?? null;

    // Find the first connected provider
    const profileKeys = Object.keys(profiles);
    let provider: string | null = null;
    let mode: string | null = null;

    if (profileKeys.length > 0) {
      const first = profiles[profileKeys[0]];
      provider = first?.provider ?? profileKeys[0].split(":")[0];
      mode = first?.mode ?? null;
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
