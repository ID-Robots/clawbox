import { CLAWBOX_AI_MODEL_BY_TIER, CLAWBOX_AI_PRO_MODEL_ID } from "@/lib/clawbox-ai-models";
import type { OpenClawConfig } from "@/lib/openclaw-config";

/** Whether an explicit former-Pro permission is missing the equivalent Flash alias. */
export function needsClawboxAiFlashPolicyRepair(config: OpenClawConfig | null | undefined): boolean {
  const allow = config?.agents?.defaults?.modelPolicy?.allow;
  if (!Array.isArray(allow) || !allow.every((model) => typeof model === "string")) return false;
  return !allow.includes(CLAWBOX_AI_MODEL_BY_TIER.flash)
    && (allow.includes(CLAWBOX_AI_MODEL_BY_TIER.pro) || allow.includes(`clawai/${CLAWBOX_AI_PRO_MODEL_ID}`));
}
