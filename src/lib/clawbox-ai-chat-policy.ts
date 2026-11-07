import { CLAWBOX_AI_CHAT_MODEL } from "@/lib/clawbox-ai-models";
import { isRetiredClawboxAiChatModel } from "@/lib/clawbox-ai-retired-models";
import type { OpenClawConfig } from "@/lib/openclaw-config";

/** Whether an explicit permission for a retired ClawBox AI chat id is missing the Flash one. */
export function needsClawboxAiFlashPolicyRepair(config: OpenClawConfig | null | undefined): boolean {
  const allow = config?.agents?.defaults?.modelPolicy?.allow;
  if (!Array.isArray(allow) || !allow.every((model) => typeof model === "string")) return false;
  return !allow.includes(CLAWBOX_AI_CHAT_MODEL)
    && allow.some((model) => isRetiredClawboxAiChatModel(model));
}
