import { NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import { inferConfiguredLocalModel, readConfig as readOpenClawConfig } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [config, openclawConfig] = await Promise.all([
      getAll(),
      readOpenClawConfig().catch(() => ({})),
    ]);
    const hasExplicitLocalAiFlag = Object.prototype.hasOwnProperty.call(config, "local_ai_configured");
    const inferredLocal = inferConfiguredLocalModel(openclawConfig);
    const localAiConfigured = hasExplicitLocalAiFlag ? !!config.local_ai_configured : !!inferredLocal;
    const localAiProvider = hasExplicitLocalAiFlag
      ? (config.local_ai_provider || null)
      : (config.local_ai_provider || inferredLocal?.provider || null);
    const localAiModel = hasExplicitLocalAiFlag
      ? (config.local_ai_model || null)
      : (config.local_ai_model || inferredLocal?.model || null);
    const setupProgressStep = typeof config.setup_progress_step === "number"
      ? config.setup_progress_step
      : Number(config.setup_progress_step ?? 0);
    return NextResponse.json({
      setup_complete: !!config.setup_complete,
      password_configured: !!config.password_configured,
      update_completed: !!config.update_completed,
      wifi_configured: !!config.wifi_configured,
      setup_progress_step: Number.isInteger(setupProgressStep) && setupProgressStep > 0 ? setupProgressStep : null,
      local_ai_configured: localAiConfigured,
      local_ai_provider: localAiProvider,
      local_ai_model: localAiModel,
      ai_model_configured: !!config.ai_model_configured,
      ai_model_provider: config.ai_model_provider || null,
      telegram_configured: !!config.telegram_bot_token,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }
}
