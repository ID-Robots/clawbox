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

/**
 * The BARE ids the ClawBox AI proxy serves as CHAT models, in the order a
 * picker should show them.
 *
 * BOTH, ON EVERY BOX, AND THE PROXY STILL GATES BY PLAN. `deepseek-v4-pro` is
 * Max-only (see `clawbox-ai-tiers.ts`, and the "Max plan only" note the wizard
 * picker carries), so a Free or Pro box that picks it gets a model-gate
 * rejection. Offering both anyway is the existing product behaviour, not a
 * choice invented here: `normalizeRow` seeds both regardless of tier and the
 * OpenClaw provider definition declares both for every tier. It is also the
 * only behaviour that stays TRUE — the portal can move a device's tier without
 * re-running any of these writers, so a list derived from the tier at link time
 * would lock an upgraded box out of the model it now pays for.
 *
 * What is genuinely worse on the Hermes side is that its own picker shows a
 * bare id with no plan label, where the ClawBox pickers say "Max plan only".
 * That is a gap to close in Hermes' row metadata, not a reason to hide a model
 * the account may already be entitled to.
 *
 * Deliberately excludes the image and vision ids: those exist so a picture can
 * be drawn or looked at, and offering them as something to talk to is a turn
 * the proxy answers with "Model not allowed".
 *
 * Lives beside the ids rather than being re-typed by each writer:
 * `applyClawaiToHermes` declares it in Hermes' own `providers.clawai.models`
 * (the block Hermes' `/model` picker and its dashboard both read), and
 * hermes-model-options.ts uses it as the cold-start floor for the same
 * provider. `CLAWAI_MODELS` and `CLAWAI_STATIC_MODELS` still spell the ids out
 * as literals beside their labels, so a staging box that sets
 * `CLAWBOX_AI_FLASH_MODEL_ID` will see them disagree — pre-existing, and worth
 * folding through here the next time that pair is touched.
 */
export const CLAWBOX_AI_CHAT_MODEL_IDS: readonly string[] = [
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_PRO_MODEL_ID,
];

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

/*
 * The ClawBox AI image entry is written WITHOUT an `api` field, and OpenClaw
 * 2026.8.1 still offers it as a chat model anyway. Both halves matter.
 *
 * Omitting `api` DOES thin the exposure — `appendConfiguredProviderRows`
 * (dist/list.row-sources-Bw2O0JWp.js:377-381) skips a configured row that
 * declares none — but that gate is not the wall it looks like:
 *
 *   - it is written `if (!replaceMode && !shouldListConfiguredProviderModel(…))`,
 *     so `models.mode: "replace"` bypasses it entirely — and ClawBox itself
 *     writes that mode whenever a local model is the primary
 *     (ai-models/configure/route.ts, the Ollama and llama.cpp branches);
 *   - `configuredKeys` is built by `buildConfiguredModelCatalog`
 *     (dist/model-selection-shared-DSwf-R8O.js:922-958), which emits every
 *     `models.providers.*.models[]` row regardless of `api`, and a key in that
 *     set is exempt from the picker's hide rule
 *     (dist/model-catalog-visibility-DdOTmrMO.js:41-43).
 *
 * Measured on 2026.8.1: on a paired box with a local primary,
 * `openclaw models list` prints `openai/gpt-image-1-mini`, and
 * `openclaw config set agents.defaults.model.primary openai/gpt-image-1-mini`
 * is accepted.
 *
 * And there is no flag that would close it. The config schema for a
 * `models.providers.<p>.models[]` row is `.strict()` with no
 * `status`/`deprecated`/`disabled` field (dist/zod-schema.core-BZltxHeB.js:269-303;
 * the CLI refuses the whole config with `Unrecognized key: "status"`), and the
 * hide rule exempts configured rows regardless. So OpenClaw's OWN surfaces —
 * its Control UI picker, Telegram `/model`, `openclaw models set` — remain able
 * to offer this id, and nothing ClawBox can write to the harness's config
 * changes that. That is a harness gap, recorded as a finding rather than
 * papered over with a ClawBox-side workaround.
 *
 * What ClawBox owns, it closes: the chat dropdown's row builder skips this id,
 * and all three write paths to `agents.defaults.model.primary` refuse it (the
 * chat POST at both guard sites, the configure route, the Local-only restore).
 * A stray `api` is still stripped by both writers — it matches beta, it costs
 * nothing, and it keeps the row out of the one path that does honour the gate
 * (`models.mode: "merge"`, the common case) — but it is a narrowing, not a
 * guarantee, and must not be described as one.
 *
 * The two predicates below are what those refusals are built from.
 */

/**
 * Every proxy URL ClawBox has ever written as the ClawBox AI endpoint, current
 * first.
 *
 * The two retired hosts are LEGACY values on purpose: a box paired before the
 * clawbox.com move still names one in its config, and recognising it is what
 * lets the retarget repair that row in place instead of appending a second one.
 * Do not "modernise" them — the boot migration carries the same warning above
 * its own copy of this list, and a unit test pins the two together.
 *
 * A staging box adds its own host at runtime from `CLAWBOX_AI_PROXY_URL` and
 * from the live `models.providers.deepseek.baseUrl` — the latter only when
 * that entry carries a `claw_` portal token, because `install.sh`'s
 * `CLAWBOX_AI_API_KEY` branch provisions a RAW DeepSeek key at
 * `api.deepseek.com` and that host must never count as ours. This list is only
 * the part that is the same on every box.
 *
 * The two runtime sets are therefore not identical: the route's carries the
 * env host as well, the boot migration's does not. That is one-directional on
 * purpose — the migration can only ever be the more conservative of the two,
 * declining to claim a row the route would claim, never the reverse.
 */
export const CLAWBOX_AI_PROXY_URLS: readonly string[] = [
  "https://clawbox.com/api/ai",
  "https://openclawhardware.dev/api/ai",
  "https://www.openclawhardware.dev/api/ai",
];

/**
 * Is `id` the bare ClawBox AI image model id (`gpt-image-1-mini`)?
 *
 * The one id every ClawBox surface has to keep out of a CHAT picker, and the
 * only one: this is a curation question about a single entry, not a licence to
 * apply the catalog route's noisy-upstream allowlist to rows the owner
 * configured themselves.
 */
export function isClawboxAiImageModelId(id: unknown): boolean {
  return typeof id === "string" && id.trim().toLowerCase() === CLAWBOX_AI_IMAGE_MODEL_ID.toLowerCase();
}

/** Is `ref` the fully-qualified ClawBox AI image entry (`openai/gpt-image-1-mini`)? */
export function isClawboxAiImageModelRef(ref: unknown): boolean {
  return typeof ref === "string" && ref.trim().toLowerCase() === CLAWBOX_AI_IMAGE_MODEL.toLowerCase();
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
 *
 * Since 2026-08-27 the PREFERRED id is DeepSeek's own multimodal model,
 * `deepseek-v4-flash-vision-exp` — vision from the same family the chat
 * tiers run on. The proxy's allowlist may trail its release, so nothing
 * writes this id unverified: every writer resolves through
 * `resolveVisionModelId()` (src/lib/clawbox-ai-vision.ts), which asks the
 * proxy and falls back to the previous vision model until the new one is
 * served. An env override skips the probe — the operator's word is final.
 */
export const CLAWBOX_AI_VISION_MODEL_ID =
  process.env.CLAWBOX_AI_VISION_MODEL_ID?.trim() || "deepseek-v4-flash-vision-exp";

/**
 * The vision model boxes ran before the DeepSeek one, and the fallback while
 * the proxy does not yet allow the new id. Boxes in the field name this in
 * `agents.defaults.imageModel` / `auxiliary.vision.model`; the writers treat
 * a slot naming either OUR id as ours to move, and any other value as the
 * owner's choice.
 */
export const CLAWBOX_AI_LEGACY_VISION_MODEL_ID = "gpt-5.6-luna";

/** `name` on the model entry. Required by OpenClaw's schema — see the image label. */
export const CLAWBOX_AI_VISION_MODEL_LABEL = "ClawBox AI Vision";

/** Fully-qualified ref for a vision id, as `agents.defaults.imageModel.primary` wants it. */
export function clawboxAiVisionModelRef(id: string): string {
  return `${CLAWBOX_AI_PROVIDER}/${id}`;
}

/** Fully-qualified ref of the PREFERRED id — resolve before writing it anywhere. */
export const CLAWBOX_AI_VISION_MODEL = clawboxAiVisionModelRef(CLAWBOX_AI_VISION_MODEL_ID);

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
