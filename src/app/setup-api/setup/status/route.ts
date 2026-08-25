import { NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import { inferConfiguredLocalModel, readConfig as readOpenClawConfig, type OpenClawConfig } from "@/lib/openclaw-config";
import { hasValidSession, readSetupGateFacts } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // The one genuinely public /setup-api route: /login and the desktop bootstrap
  // read it before a session exists, and it stays reachable through the
  // cloudflared tunnel. So an unauthenticated caller gets only what those
  // bootstraps need — the wizard's own progress. Which local model the box
  // runs, which cloud provider it is configured against and whether Telegram is
  // wired up are operational detail that was world-readable to anyone holding
  // the tunnel URL. TASK-446.
  const authenticated = await hasValidSession(request);

  try {
    const [config, openclawConfig] = await Promise.all([
      getAll(),
      readOpenClawConfig().catch(() => ({} as OpenClawConfig)),
    ]);
    const hasExplicitLocalAiFlag = Object.prototype.hasOwnProperty.call(config, "local_ai_configured");
    const inferredLocal = inferConfiguredLocalModel(openclawConfig);
    // Provider from the live OpenClaw primary model (e.g. "deepseek/..." →
    // "deepseek"), preferred over the ClawBox config store, which only
    // refreshes at configure-time and can drift when the model changes
    // elsewhere (#162). Local models (llamacpp/ollama) carry their own provider.
    const livePrimaryModel = typeof openclawConfig.agents?.defaults?.model?.primary === "string"
      ? openclawConfig.agents.defaults.model.primary
      : null;
    const liveCloudProvider = livePrimaryModel && !/^(llamacpp|ollama)\//i.test(livePrimaryModel)
      ? livePrimaryModel.split("/")[0]
      : null;
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
    // Steps 1-3 of the wizard run before a session can exist, so their state
    // stays public; everything below is step 4+ and is behind the same session
    // the wizard holds by then.
    //
    // The two flags the /login page navigates on come from the fail-CLOSED
    // reader so they can never contradict middleware's /setup gate. getAll()
    // fails open ({} on a corrupt config.json), which reported both flags
    // false while middleware kept /setup session-gated — sending /login into
    // an endless bounce against a wizard it could never reach.
    const gateFacts = readSetupGateFacts();
    const publicFields = {
      setup_complete: gateFacts.setupComplete,
      password_configured: gateFacts.passwordConfigured,
      update_completed: !!config.update_completed,
      wifi_configured: !!config.wifi_configured,
      setup_progress_step: Number.isInteger(setupProgressStep) && setupProgressStep > 0 ? setupProgressStep : null,
    };

    return NextResponse.json(authenticated ? {
      ...publicFields,
      local_ai_configured: localAiConfigured,
      local_ai_provider: localAiProvider,
      local_ai_model: localAiModel,
      ai_model_configured: !!config.ai_model_configured,
      ai_model_provider: liveCloudProvider || config.ai_model_provider || null,
      telegram_configured: !!config.telegram_bot_token,
    } : publicFields, {
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
