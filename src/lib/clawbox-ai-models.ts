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
 * Images per UTC DAY included in each plan.
 *
 * Daily, and these numbers, since TASK-485 (Yanko, 2026-08-22 19:34). They were
 * 5/50/200 per calendar MONTH, and a monthly cap failed in the worst way it
 * could: a customer who explored on the 2nd was locked out for twenty-eight
 * days with no recovery except waiting.
 *
 * The cloud proxy is the only counter — the device deliberately does not keep
 * one of its own. This table mirrors `dailyImageLimits` from
 * `GET https://clawbox.com/api/ai/images/generations`, and it is a FALLBACK
 * only: when the portal answers, `readImageAllowance` below prefers the live
 * `meters.images.limit` it sends, because a table compiled into a device is a
 * snapshot of what the cloud believed on release day. This one was already a
 * release behind reality for as long as it took to write TASK-485, and nothing
 * caught it because nothing rendered it.
 */
export const CLAWBOX_AI_DAILY_IMAGE_LIMITS: Record<ClawboxAiPlan, number> = {
  free: 1,
  pro: 5,
  max: 20,
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
 * Daily image allowance for a plan, or `null` when the plan is unknown.
 *
 * `null` is load-bearing: when the portal is unreachable we genuinely do not
 * know which allowance applies, and showing a guessed number would be worse
 * than showing none. Callers must render nothing rather than a default. There
 * is no "probably Free" — any default here is a guess at somebody's paid
 * subscription.
 */
export function dailyImageLimitForPlan(plan: ClawboxAiPlan | null): number | null {
  return plan ? CLAWBOX_AI_DAILY_IMAGE_LIMITS[plan] : null;
}

/**
 * What the AI Provider panel is allowed to say about image generation.
 *
 * `limit` is the day's allowance. `used` is present ONLY when the portal
 * actually reported it this cycle; the device has no counter of its own and
 * must never invent one, because a cached count rendered as live disagrees
 * with the cloud the moment the same account generates a picture from anywhere
 * else. So a panel with `used === null` says "20 images a day on Max" and one
 * with a number says "3 of 20 images today" — never "0 of 20" on a silence.
 */
export interface ClawboxAiImageAllowance {
  plan: ClawboxAiPlan;
  planLabel: string;
  /** Pictures per UTC day on this plan. Always a positive integer. */
  limit: number;
  /** Pictures spent today, or null when the portal did not report usage. */
  used: number | null;
  /** 0-100, or null whenever `used` is null. */
  percentUsed: number | null;
}

/**
 * Parse the `clawaiImages` block of `/setup-api/ai-models/status` into
 * something renderable, or null.
 *
 * REJECTS RATHER THAN DEFAULTS, deliberately and at every step. A missing
 * block, an unknown plan, a limit the portal could not resolve, a non-integer
 * or negative count — every one of those returns null and the caller renders
 * nothing. The alternative is a confidently wrong cap in front of an owner,
 * which is strictly worse than the silence this task started from: silence is
 * a gap, a wrong number is a support ticket and a refund conversation.
 *
 * `used` is dropped rather than the whole allowance when only the usage half
 * is unusable — knowing the ceiling is still worth showing.
 */
export function readImageAllowance(value: unknown): ClawboxAiImageAllowance | null {
  if (!value || typeof value !== "object") return null;
  const block = value as Record<string, unknown>;
  if (block.supported !== true) return null;

  const plan = normalizeClawboxAiPlan(block.plan);
  if (!plan) return null;

  // isSafeInteger, not isInteger: 2**53 passes isInteger and cannot represent an
  // exact count, so arithmetic on it silently loses. Nothing sane sends that,
  // but this function's whole contract is that it does not have to be sane.
  const limit = block.dailyLimit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) return null;

  const rawUsed = block.used;
  const used =
    typeof rawUsed === "number" && Number.isSafeInteger(rawUsed) && rawUsed >= 0
      ? rawUsed
      : null;

  return {
    plan,
    planLabel: CLAWBOX_AI_PLAN_LABEL[plan],
    limit,
    used,
    // Computed here rather than trusted from the wire: the panel decides
    // whether to warn off this number, and two sources for one percentage is
    // how a warning fires at a different point from the one it describes.
    // Capped at 100 so an over-limit day reads as full, not as 140%.
    percentUsed: used === null ? null : Math.min(100, Math.round((used / limit) * 100)),
  };
}

/* ---------------------------------------------------------------------------
 * ClawBox AI vision (image understanding)
 * ------------------------------------------------------------------------ */

/**
 * Model the device uses to *look at* an image the user attached in chat.
 *
 * Registered under `CLAWBOX_AI_PROVIDER` (`deepseek`) rather than `openai`,
 * even though the id is an OpenAI one, because that provider entry is really
 * "the ClawBox AI proxy": it already carries `api: "openai-completions"`, the
 * proxy `baseUrl` and the `claw_` subscription token, which is exactly the
 * transport a vision request needs. OpenClaw's `openai` provider defaults to
 * `openai-responses` (`dist/model-C3gzf-T3.js` on 2026.7.1), an API the proxy
 * does not speak, so an entry there would have to re-declare the api, the
 * baseUrl and the auth to end up in the same place.
 *
 * It cannot leak into the chat model picker: the device catalogue for
 * `clawai` is the hardcoded two-entry `CLAWAI_STATIC_MODELS` in
 * src/app/setup-api/ai-models/catalog/route.ts, not a read of
 * `models.providers.deepseek.models`.
 *
 * Env-overridable for the same reason the chat and image slugs are — the proxy
 * matches the BARE id against its allowlist, so this value must always name
 * something production already allows.
 */
export const CLAWBOX_AI_VISION_MODEL_ID =
  process.env.CLAWBOX_AI_VISION_MODEL_ID?.trim() || "gpt-5.6-luna";

/** `name` on the model entry. Required by OpenClaw's schema — see the image label. */
export const CLAWBOX_AI_VISION_MODEL_LABEL = "ClawBox AI Vision";

/** Fully-qualified ref written to `agents.defaults.imageModel.primary`. */
export const CLAWBOX_AI_VISION_MODEL = `${CLAWBOX_AI_PROVIDER}/${CLAWBOX_AI_VISION_MODEL_ID}`;

/**
 * Input modalities. `image` is the whole point of the entry: OpenClaw's
 * `resolveImageRuntime` (`dist/image-Bg-2ezSd.js:99` on 2026.7.1) refuses a
 * media-understanding model whose catalog entry does not advertise it, with
 * "Model does not support images".
 */
export const CLAWBOX_AI_VISION_INPUT_MODALITIES = ["text", "image"] as const;

/**
 * Completion-token ceiling the upstream actually enforces, measured against the
 * live proxy from a device on 2026-08-21: `max_tokens: 128000` is accepted,
 * `200000` and `400000` both come back 400 "max_tokens is too large … This
 * model supports at most 128000 completion tokens".
 *
 * 200,000 is not an arbitrary counter-example: it is the generic default a
 * configured provider entry falls through to when it omits the field, because
 * an entry in `models.providers` overrides OpenClaw's bundled catalog outright.
 * The media-understanding path in 2026.7.1 happens not to send `max_tokens` at
 * all — verified on a real box, the describe call succeeds with this field
 * removed — so this is a guard against any caller that does start sending it,
 * not the thing that makes vision work today.
 */
export const CLAWBOX_AI_VISION_MAX_TOKENS = 128_000;
