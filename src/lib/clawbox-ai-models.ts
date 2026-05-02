/**
 * Shared ClawBox AI model identifiers.
 *
 * These constants are the single source of truth for what model id is
 * advertised under each ClawBox AI tier. The configure route writes the
 * primary model based on these; the chat/model route falls back to them
 * when reading legacy installs that pre-date the explicit V4 alias rollout
 * and have no `models.providers.deepseek.models` entry.
 *
 * Keeping the values here (and importing them from both routes) prevents
 * the two paths from drifting on a half-applied rename — env-overridable
 * so a staging proxy with a different alias map can point them elsewhere
 * without code changes.
 *
 * Per the April 24 2026 DeepSeek refresh, the legacy `deepseek-chat` and
 * `deepseek-reasoner` aliases both resolve to V4 *Flash* on the upstream
 * proxy and retire on July 24 2026. The Pro tier therefore needs the new
 * explicit `deepseek-v4-pro` slug to actually route to the 1.6T frontier
 * weights instead of being silently downgraded.
 */
export const CLAWBOX_AI_PROVIDER = "deepseek" as const;

export const CLAWBOX_AI_FLASH_MODEL_ID =
  process.env.CLAWBOX_AI_FLASH_MODEL_ID?.trim() || "deepseek-v4-flash";

export const CLAWBOX_AI_PRO_MODEL_ID =
  process.env.CLAWBOX_AI_PRO_MODEL_ID?.trim() || "deepseek-v4-pro";

export type ClawboxAiTier = "flash" | "pro";

export const CLAWBOX_AI_DEFAULT_TIER: ClawboxAiTier = "flash";

export const CLAWBOX_AI_MODEL_BY_TIER: Record<ClawboxAiTier, string> = {
  flash: `${CLAWBOX_AI_PROVIDER}/${CLAWBOX_AI_FLASH_MODEL_ID}`,
  pro: `${CLAWBOX_AI_PROVIDER}/${CLAWBOX_AI_PRO_MODEL_ID}`,
};

// Device-tier badge label rendered in the chat header / Settings. Mirrors
// the subscription plan names ("Pro plan" / "Max plan") so users don't see
// a different word on the device than they paid for. Keep in sync with
// clawbox-website's authorize card.
export const CLAWBOX_AI_TIER_LABEL: Record<ClawboxAiTier, string> = {
  flash: "Pro",
  pro: "Max",
};

export function normalizeClawboxAiTier(value: unknown): ClawboxAiTier | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "flash" || normalized === "pro" ? normalized : null;
}
