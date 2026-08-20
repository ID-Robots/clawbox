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

/**
 * True if `model` is a fully-qualified ClawBox AI Pro slug
 * (`clawai/deepseek-v4-pro` or `deepseek/deepseek-v4-pro`).
 *
 * The Pro device-tier maps to the V4 Pro frontier weights, which the
 * portal gateway gates to Max subscribers (`user.tier === "max"`,
 * `deviceTier === "pro"`). Non-Max users picking it would silently
 * have their requests downgraded to flash by the gateway's live-tier
 * reconcile, so the device-side picker uses this helper to surface
 * an upgrade prompt instead.
 */
export function isClawboxAiProModel(model: string | null | undefined): boolean {
  if (typeof model !== "string") return false;
  const idx = model.indexOf("/");
  if (idx <= 0) return false;
  const provider = model.slice(0, idx);
  const modelId = model.slice(idx + 1);
  if (modelId !== CLAWBOX_AI_PRO_MODEL_ID) return false;
  return provider === CLAWBOX_AI_PROVIDER || provider === "clawai";
}

/* ---------------------------------------------------------------------------
 * ClawBox AI image generation
 * ------------------------------------------------------------------------ */

/**
 * OpenClaw provider id the image model is registered under.
 *
 * It has to be `openai`. OpenClaw has no built-in image providers at all
 * (`BUILTIN_IMAGE_GENERATION_PROVIDERS = []`); every one of them comes from a
 * bundled plugin declaring the `imageGenerationProviders` capability contract,
 * and the only one that both speaks the OpenAI-compatible
 * `POST {baseUrl}/images/generations` shape and honours a per-model `baseUrl`
 * override is `openai`. A ClawBox-specific provider id would simply not be an
 * image provider as far as the gateway is concerned.
 *
 * Reusing `openai` is safe for a user who also brings their own OpenAI key —
 * see `buildClawboxAiImageProviderModels` for why.
 */
export const CLAWBOX_AI_IMAGE_PROVIDER = "openai" as const;

/**
 * Image model advertised by the cloud proxy on every plan.
 *
 * Confirmed against production on 2026-08-20:
 * `GET https://clawbox.com/api/ai/images/generations` reports
 * `defaultModel: "gpt-image-1-mini"` and
 * `modelTiers: { "gpt-image-1-mini": ["free","pro","max"] }`.
 *
 * `gpt-image-2` exists too but is Max-only, so it is deliberately NOT the
 * device default: provisioning is tier-blind (it runs before we know what the
 * portal says the plan is) and stamping a Max-only id on a Free box would turn
 * every image request into a model-gate rejection. Env-overridable for the
 * same reason the chat slugs are — a staging proxy with a different alias map
 * should not need a code change. See [[task-380-model-allowlist]]: the proxy
 * matches the BARE id and answers 400 "Model not allowed" on a miss, so this
 * value must always name something production already allows.
 */
export const CLAWBOX_AI_IMAGE_MODEL_ID =
  process.env.CLAWBOX_AI_IMAGE_MODEL_ID?.trim() || "gpt-image-1-mini";

/** Fully-qualified ref written to `agents.defaults.imageGenerationModel.primary`. */
export const CLAWBOX_AI_IMAGE_MODEL = `${CLAWBOX_AI_IMAGE_PROVIDER}/${CLAWBOX_AI_IMAGE_MODEL_ID}`;

/**
 * `name` on the model entry. Not cosmetic: OpenClaw's config schema *requires*
 * `name` on every `models.providers.<p>.models[]` entry. Omitting it makes the
 * whole config invalid ("models.providers.openai.models.0.name: Invalid input")
 * and the gateway refuses to start — verified against OpenClaw 2026.7.1-2.
 */
export const CLAWBOX_AI_IMAGE_MODEL_LABEL = "ClawBox AI Images";

/**
 * Subscription plan names as the portal reports them in
 * `/api/clawbox-ai/device-info` → `tier`. Distinct from `ClawboxAiTier`, which
 * is the *device* tier (`flash` / `pro`) driving the chat model choice.
 */
export type ClawboxAiPlan = "free" | "pro" | "max";

/**
 * Images per calendar month included in each plan.
 *
 * Approved by Yanko on 2026-08-19 and enforced by the cloud proxy, which is
 * the only counter — the device deliberately does not keep one of its own.
 * Mirrors `monthlyImageLimits` from
 * `GET https://clawbox.com/api/ai/images/generations`, re-checked against
 * production on 2026-08-20. These numbers are shown to the user, so if the
 * cloud ever changes them this table has to move in the same release.
 */
export const CLAWBOX_AI_MONTHLY_IMAGE_LIMITS: Record<ClawboxAiPlan, number> = {
  free: 5,
  pro: 50,
  max: 200,
};

/** Human-facing plan name used in the images allowance copy. */
export const CLAWBOX_AI_PLAN_LABEL: Record<ClawboxAiPlan, string> = {
  free: "Free",
  pro: "Pro",
  max: "Max",
};

/** Narrows the portal's free-form `tier` string to a known plan, or null. */
export function normalizeClawboxAiPlan(value: unknown): ClawboxAiPlan | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "free" || normalized === "pro" || normalized === "max"
    ? normalized
    : null;
}

/**
 * Monthly image allowance for a plan, or `null` when the plan is unknown.
 *
 * `null` is load-bearing: when the portal is unreachable we genuinely do not
 * know which allowance applies, and showing a guessed number would be worse
 * than showing none. Callers must render nothing rather than a default.
 */
export function monthlyImageLimitForPlan(plan: ClawboxAiPlan | null): number | null {
  return plan ? CLAWBOX_AI_MONTHLY_IMAGE_LIMITS[plan] : null;
}
