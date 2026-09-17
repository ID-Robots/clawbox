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

// The proxy serves Flash 4.1 through the existing V4 Flash and Pro aliases.
// Chat uses the Flash alias; keep the wire IDs and subscription tiers stable.
export const CLAWBOX_AI_CHAT_MODEL_LABEL = "Flash 4.1";

export const CLAWBOX_AI_PRO_MODEL_ID =
  process.env.CLAWBOX_AI_PRO_MODEL_ID?.trim() || "deepseek-v4-pro";

export type ClawboxAiTier = "flash" | "pro";

export const CLAWBOX_AI_DEFAULT_TIER: ClawboxAiTier = "flash";

export const CLAWBOX_AI_MODEL_BY_TIER: Record<ClawboxAiTier, string> = {
  flash: `${CLAWBOX_AI_PROVIDER}/${CLAWBOX_AI_FLASH_MODEL_ID}`,
  pro: `${CLAWBOX_AI_PROVIDER}/${CLAWBOX_AI_PRO_MODEL_ID}`,
};

/**
 * The same table, BARE — no `deepseek/` prefix.
 *
 * Both spellings are load-bearing on their own side: openclaw.json's
 * `agents.defaults.model.primary` takes the qualified ref, while Hermes'
 * `model.default` and the ClawBox AI proxy take the bare id (a prefixed slug
 * comes back "HTTP 400: Model not allowed"). One table so the two editions
 * cannot answer the tier question differently.
 */
export const CLAWBOX_AI_MODEL_ID_BY_TIER: Record<ClawboxAiTier, string> = {
  flash: CLAWBOX_AI_FLASH_MODEL_ID,
  pro: CLAWBOX_AI_PRO_MODEL_ID,
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
 * "The portal answered, and this account has no paid plan."
 *
 * The third thing a PLAN can be, beside the two paid tiers. It exists because
 * `mapPortalTier` and `mapPortalPlanTier` both answer `null` for an unpaid
 * account, and an absent stamp already means "the portal has never answered
 * for this box" — so without a positive word a CANCELLED subscription is
 * indistinguishable from a box nobody has asked about, and nothing can ever be
 * withdrawn from it (TASK-744).
 *
 * It is a value that AUTHORISES A DELETE, which is why it is written only for a
 * plan word this build positively recognises as unpaid. See
 * `mapPortalPlanVerdict`.
 */
export const CLAWBOX_AI_PLAN_UNPAID = "free";

/** What a PLAN can be: the two paid tiers, or positively unpaid. */
export type ClawboxAiPlanTier = ClawboxAiTier | typeof CLAWBOX_AI_PLAN_UNPAID;

/**
 * The plan vocabulary, and `null` for anything outside it.
 *
 * {@link normalizeClawboxAiTier}'s two values plus {@link CLAWBOX_AI_PLAN_UNPAID}.
 * A string outside the set is a store somebody edited or a build we have not
 * seen: not evidence of anything, and least of all of a downgrade.
 */
export function normalizeClawboxAiPlanTier(value: unknown): ClawboxAiPlanTier | null {
  const paid = normalizeClawboxAiTier(value);
  if (paid) return paid;
  return typeof value === "string" && value.trim().toLowerCase() === CLAWBOX_AI_PLAN_UNPAID
    ? CLAWBOX_AI_PLAN_UNPAID
    : null;
}

/**
 * Is `provider` the ClawBox AI proxy, under either of the two ids the product
 * spells it with?
 *
 * `deepseek` is what the OpenClaw gateway config registers it under (the proxy
 * forwards to DeepSeek), and `clawai` is what the UI normalises that to
 * (`normalizeProvider` in src/app/setup-api/chat/model/route.ts) as well as
 * Hermes' own custom-provider slug (src/lib/hermes-clawai.ts). BOTH reach the
 * chat header — the OpenClaw branch reads a provider id that may still carry
 * the wire spelling — so every surface that has to recognise ClawBox AI asks
 * here instead of re-typing the pair. Two hand-written copies of this test are
 * exactly how the header came to hide its model pill under one spelling and
 * keep showing it under the other.
 *
 * Says WHICH proxy, not which model and not who may run it: see
 * {@link isClawboxAiProModel} and {@link portalDeniesClawboxAiModel}.
 */
export function isClawboxAiProvider(provider: string | null | undefined): boolean {
  if (typeof provider !== "string") return false;
  const normalized = provider.trim().toLowerCase();
  return normalized === CLAWBOX_AI_PROVIDER || normalized === "clawai";
}

/**
 * True if `model` is a fully-qualified ClawBox AI Pro slug
 * (`clawai/deepseek-v4-pro` or `deepseek/deepseek-v4-pro`).
 *
 * Says WHICH model this is, and nothing about who may run it — that
 * question is answered by {@link portalDeniesClawboxAiModel} from the
 * portal's own entitlement list. The two used to be one check keyed on
 * the device-tier badge, which is a device DEFAULT, not an entitlement.
 */
export function isClawboxAiProModel(model: string | null | undefined): boolean {
  if (typeof model !== "string") return false;
  const idx = model.indexOf("/");
  if (idx <= 0) return false;
  const provider = model.slice(0, idx);
  const modelId = model.slice(idx + 1);
  if (modelId !== CLAWBOX_AI_PRO_MODEL_ID) return false;
  return isClawboxAiProvider(provider);
}

/**
 * The entitlement list out of whatever the portal (or our own status route)
 * put in that field: a non-empty list of trimmed ids, or null.
 *
 * ONE normaliser, called by the server that reads the portal and by the client
 * that reads the server, because an empty list and a null mean the same thing
 * downstream ("not answered") and two spellings of that rule is how this
 * codebase drifts.
 */
export function normalizeAllowedModelIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? ids : null;
}

/** Bare id of a model ref: `deepseek/deepseek-v4-pro` → `deepseek-v4-pro`. */
function bareModelId(ref: string): string {
  const slash = ref.lastIndexOf("/");
  return (slash >= 0 ? ref.slice(slash + 1) : ref).trim().toLowerCase();
}

/**
 * Is `ref` a fully-qualified model of the ClawBox AI proxy
 * (`clawai/…` or `deepseek/…`)?
 *
 * The prefix is required. A bare id says nothing about whose model it is, and
 * the portal's entitlement list governs ONLY ClawBox AI: matching an
 * `anthropic/claude-opus-5` primary against it would refuse every model the
 * owner brought their own key for.
 */
function isClawboxAiModelRef(ref: string): boolean {
  const idx = ref.indexOf("/");
  if (idx <= 0) return false;
  return isClawboxAiProvider(ref.slice(0, idx));
}

/** The translation keys a picker draws one ClawBox AI chat tier with. */
export interface ClawboxAiTierTextKeys {
  labelKey: string;
  hintKey: string;
}

/**
 * What a picker CALLS each chat tier, as translation KEYS.
 *
 * Keys rather than words, because this module is import-safe from the server
 * and from every client bundle, and the words belong to the locale: the chat
 * composer's model chip said "Max Tier" beside a Settings page that called the
 * same plan "Max-Tarif" (the UI sweep of 2026-09-07). The Max label is the
 * plan name Settings already uses (`ai.planNameMax`), so the two surfaces
 * cannot drift apart again; the Flash tier has no single plan behind it and
 * carries its own key.
 */
export const CLAWBOX_AI_TIER_TEXT_KEYS: Readonly<Record<ClawboxAiTier, ClawboxAiTierTextKeys>> = {
  flash: { labelKey: "ai.clawboxTierFlash", hintKey: "ai.clawboxTierFlashHint" },
  pro: { labelKey: "ai.planNameMax", hintKey: "ai.clawboxTierMaxHint" },
};

/**
 * The tier text keys for `model` — a bare id (`deepseek-v4-pro`, the shape a
 * catalogue row carries) or a ClawBox AI ref (`clawai/…`, `deepseek/…`) — and
 * null for anything else, including another provider's model that happens to
 * share the id. The caller keeps whatever label it already had for a null.
 */
export function clawboxAiTierTextKeys(model: string | null | undefined): ClawboxAiTierTextKeys | null {
  if (typeof model !== "string") return null;
  if (model.includes("/") && !isClawboxAiModelRef(model)) return null;
  const id = bareModelId(model);
  if (id === CLAWBOX_AI_FLASH_MODEL_ID.toLowerCase()) return CLAWBOX_AI_TIER_TEXT_KEYS.flash;
  if (id === CLAWBOX_AI_PRO_MODEL_ID.toLowerCase()) return CLAWBOX_AI_TIER_TEXT_KEYS.pro;
  return null;
}

/**
 * Does the portal POSITIVELY refuse `model` for this device's account?
 *
 * `allowedModels` is the list `GET /api/clawbox-ai/device-info` publishes for
 * the paired `claw_*` token — the portal's own answer to "what may this device
 * run", carried in the same response the tier badge is read from. Measured on
 * a Max box (2026-09-04):
 *
 *   {"tier":"max","deviceTier":"pro",
 *    "allowedModels":["deepseek-v4-flash","deepseek-v4-pro",…],
 *    "defaultModel":"deepseek-v4-pro", …}
 *
 * WHY NOT THE TIER BADGE. The badge (`clawai_tier`) comes from
 * `mapPortalTier`, which prefers the portal's `deviceTier` stamp — and that
 * stamp is deliberately a DEVICE DEFAULT: "a Max subscriber who runs Flash on
 * this device" is a state the configure route documents and keeps (TASK-481).
 * A default is the right thing to write as the primary model. It is the wrong
 * thing to VETO with: the old gate refused the Pro model, and rewrote the
 * box's primary back to Flash, whenever the badge was not exactly `"pro"` —
 * including when the status poll had simply not answered and the badge was
 * `null`. That undid an explicit pick (from this picker or from the Telegram
 * `/model` keyboard) on a Max box and told its owner to buy the plan he
 * already had. A default may be overridden by a pick; an entitlement may not,
 * and only the portal knows which is which.
 *
 * ONLY ClawBox AI refs are judged (`clawai/…`, `deepseek/…`). The list says
 * nothing about a provider the owner brought their own key for.
 *
 * FALSE ON ANY DOUBT, deliberately. An absent, non-array or empty list is "I
 * don't know" — an unreachable portal, a failed status poll — and an
 * unanswered question must never read as a refusal: that is how the box came
 * to rewrite its own model on a network blip. (A portal that answers the tier
 * but publishes no list is NOT one of those cases: the status route fills the
 * list from the badge there, so nothing that used to be refused becomes
 * allowed on an older portal.) The proxy is the last word either way, and it
 * speaks plainly — measured 2026-09-04 against the live proxy with a paired
 * token: an id outside the account's list answers
 * `400 {"error":{"message":"Model not allowed: …","code":"model_not_allowed"}}`,
 * not a silent downgrade.
 */
export function portalDeniesClawboxAiModel(
  model: string | null | undefined,
  allowedModels: readonly string[] | null | undefined,
): boolean {
  if (typeof model !== "string" || !isClawboxAiModelRef(model)) return false;
  if (!Array.isArray(allowedModels) || allowedModels.length === 0) return false;
  const wanted = bareModelId(model);
  if (!wanted) return false;
  return !allowedModels.some(
    (entry) => typeof entry === "string" && bareModelId(entry) === wanted,
  );
}

/* ---------------------------------------------------------------------------
 * ClawBox AI image generation
 * ------------------------------------------------------------------------ */

/**
 * OpenClaw provider id the image model is registered under.
 *
 * `litellm`, and it MUST NOT be `openai` any more. The id is not cosmetic: it
 * decides which provider entry the image credential lands on, and on the pinned
 * core an `openai` provider entry that carries an `apiKey` takes the ChatGPT
 * (Codex) subscription lane down with it.
 *
 * WHY `openai` IS NOW WRONG, measured against v2026.9.3. `prepareAgentRuntimeAuth`
 * (src/agents/runtime-plan/prepare-auth.ts) reads the provider entry before it
 * looks at any auth profile. A literal `models.providers.openai.apiKey` makes
 * `providerHasDirectMaterial` true, which makes `selectedConfiguredAuthMode`
 * default to `"api-key"` — with NO `auth: "api-key"` field anywhere in the
 * config — and that mode is handed to `selectProviderModelRouteAuth` as the
 * configured one. There it pins `configuredRequirement` to `"api-key"`, and the
 * candidate list is rebuilt keeping only profiles whose mode maps to that
 * requirement. An OAuth (subscription) profile maps to `"subscription"`, so the
 * ChatGPT sign-in is filtered out of its own provider and the inline key is sent
 * to api.openai.com instead. That is a 401 on every turn and a silent failover
 * to the fallback model. The same filter is why an explicit
 * `auth.order.openai: ["openai:chatgpt"]` answers "Explicit auth order for
 * openai has no usable profiles" rather than repairing it.
 *
 * Declaring `auth: "api-key"` is worse, not better: it sets
 * `providerBindingSuppressesProfiles`, which removes auth profiles from the
 * provider outright. There is no per-model credential to escape into either —
 * `ModelDefinitionSchema` is `.strict()` and has no `apiKey`. So on 9.3 the only
 * way an `openai` ChatGPT sign-in can own its own provider is for nothing else
 * to be written onto that provider's auth.
 *
 * WHY `litellm` IS THE NATIVE HOME. The core ships a generic OpenAI-compatible
 * image provider factory (`createOpenAiCompatibleImageGenerationProvider`) and
 * the bundled `litellm` plugin is the one instance of it built for "an
 * OpenAI-compatible gateway whose address you supply". It is enabled by default
 * (`extensions/litellm/openclaw.plugin.json`: `enabledByDefault: true`,
 * `contracts.imageGenerationProviders: ["litellm"]`), it resolves its bearer
 * per provider id (`resolveApiKeyForProvider({ provider: "litellm" })`), it
 * takes its endpoint from `models.providers.litellm.baseUrl`, and it posts
 * exactly `POST {baseUrl}/images/generations` — the shape the ClawBox AI proxy
 * serves. Its `models: [...]` list is metadata, not a gate: the factory passes
 * `req.model` straight through, so `gpt-image-1-mini` is accepted.
 *
 * It also arms itself. `collectConfiguredGenerationProviderIds` pulls the
 * provider id out of `agents.defaults.mediaModels.image`, so naming
 * `litellm/<id>` there is what enables the plugin at gateway start — the same
 * job the `imageGenerationModel` write has always done.
 *
 * `litellm` is a BUNDLED overlay id (`isBuiltInModelProviderOverlayId`), so the
 * entry does not have to declare `models[]` the way a custom provider id would
 * — and deliberately does not: a `models[]` row here would be a SECOND chat row
 * on this id, on top of the one the plugin ships (see the note below).
 *
 * WHY THIS ID AND NOT ANOTHER. It is the only bundled image-generation provider
 * on 2026.9.3 that is a generic OpenAI-compatible endpoint taking an explicit
 * `baseUrl`. Every other one registers an image provider with an API shape of
 * its own — `comfy` runs a ComfyUI workflow, `vydra` its own generation call,
 * `fal`, `openrouter`, `google`, `xai`, `deepinfra`, `minimax` and
 * `microsoft-foundry` each their own — and none of them posts
 * `{baseUrl}/images/generations` with `req.model` passed through, which is what
 * the ClawBox AI proxy serves. So there is no chat-free id to move to; the
 * residual below is the price of the only id that works.
 */
export const CLAWBOX_AI_IMAGE_PROVIDER = "litellm" as const;

/**
 * Where every box provisioned before this change put the image entry.
 *
 * Kept because the field is full of them: the migration has to RECOGNISE an
 * `openai/gpt-image-1-mini` slot and an `openai` image row as ours before it can
 * move them, and every ClawBox surface that refuses to treat the image model as
 * a chat model has to keep refusing the old ref — a box that has not rebooted
 * since the update still carries it in
 * `agents.defaults.mediaModels.image.primary`.
 */
export const CLAWBOX_AI_LEGACY_IMAGE_PROVIDER = "openai" as const;

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

/** The ref boxes provisioned before the `litellm` move still carry. */
export const CLAWBOX_AI_LEGACY_IMAGE_MODEL = `${CLAWBOX_AI_LEGACY_IMAGE_PROVIDER}/${CLAWBOX_AI_IMAGE_MODEL_ID}`;

/*
 * THE CHAT-PICKER EXPOSURE: STILL OPEN, ON A NEW PROVIDER ID.
 *
 * Until this build the image model was a `models.providers.openai.models[]` row
 * with a per-model `baseUrl`, and that row was offerable as a CHAT model by
 * OpenClaw's own surfaces whatever ClawBox did. Omitting `api` thinned it —
 * `appendConfiguredProviderRows` (dist/list.row-sources-Bw2O0JWp.js:377-381)
 * skips a configured row that declares none — but the gate is not a wall: it is
 * written `if (!replaceMode && !shouldListConfiguredProviderModel(…))`, so
 * `models.mode: "replace"` bypasses it entirely (and ClawBox writes that mode
 * whenever a local model is the primary), while `configuredKeys` from
 * `buildConfiguredModelCatalog` emits every `models.providers.*.models[]` row
 * regardless of `api` and a key in that set is exempt from the picker's hide
 * rule. Measured on 2026.8.1: `openclaw models list` printed
 * `openai/gpt-image-1-mini` and `config set agents.defaults.model.primary
 * openai/gpt-image-1-mini` was accepted. Nor was there a flag to close it — the
 * row schema is `.strict()` with no status/disabled field.
 *
 * The `litellm` entry writes no row of its own, but that does NOT close the
 * exposure — it moves it, and the move is lateral. The bundled plugin registers
 * a CHAT provider as well as an image one, from a single `register()`
 * (`extensions/litellm/index.ts` at v2026.9.3:
 * `api.registerProvider({ id: "litellm", catalog: …, staticCatalog: … })` AND
 * `api.registerImageGenerationProvider(…)`), and its chat catalog needs no row
 * from us because it ships its own: `buildLitellmProvider()` returns
 * `{ baseUrl, api: "openai-completions", models: [buildLitellmModelDefinition()] }`,
 * which is `claude-opus-4-6` / "Claude Opus 4.6" / 1M context / reasoning
 * (`extensions/litellm/onboard.ts`). The catalog's bearer is
 * `ctx.resolveProviderApiKey("litellm")` — the `claw_` portal token this build
 * writes at `models.providers.litellm.apiKey` — so once the plugin is armed
 * (naming `litellm/…` in `agents.defaults.mediaModels.image` is what arms it,
 * `collectConfiguredGenerationProviderIds`), `openclaw models list`, the
 * Control UI picker, `openclaw models set` and Telegram `/model` all offer
 * `litellm/claude-opus-4-6` with `Auth: yes`, and live discovery POSTs
 * `<baseUrl>/v1/models` with that token and registers whatever comes back as
 * further `litellm/*` chat rows.
 *
 * HARNESS FINDING, recorded rather than described as closed — the same way the
 * `openai` era's was. OpenClaw offers no flag that hides a provider from its own
 * chat pickers while leaving its image half registered: the row schema is
 * `.strict()` with no status/disabled field, a bundled plugin's catalog is
 * declared in the plugin rather than in config, and the plugin cannot be
 * disabled without disabling the image generation this entry exists for. So the
 * residual is REAL: a model picked from one of OpenClaw's OWN surfaces can
 * still point the box's chat at the ClawBox AI proxy asking for a model it does
 * not serve.
 *
 * What ClawBox can do, and now does, is refuse it on every surface of its own —
 * the chat dropdown's row builder and all three writers of
 * `agents.defaults.model.primary` — and refuse it by PROVIDER ID rather than by
 * this one image ref, because `litellm/claude-opus-4-6` and whatever discovery
 * turns up are the same hazard as `litellm/gpt-image-1-mini`: on this box that
 * id is the image lane, never a chat provider. The legacy `openai/…` ref stays
 * an exact-ref refusal, since `openai` IS a chat provider here.
 *
 * NOT VERIFIED ON A BOX. The command that settles the residual is
 * `openclaw models list --provider litellm --all --json` after the migration;
 * no box was available when this was written (the owner's OpenClaw box was in
 * factory state). The claims above are read from the core at v2026.9.3.
 *
 * The three predicates below are what those refusals are built from.
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

/**
 * Is `ref` the fully-qualified ClawBox AI image entry?
 *
 * BOTH spellings — `litellm/gpt-image-1-mini`, which this build writes, and
 * `openai/gpt-image-1-mini`, which every box provisioned before it still
 * carries. Each caller is a REFUSAL (keep this id out of a chat slot) or a
 * CLAIM (this slot is ours to move), and both have to go on recognising the old
 * ref: a box updates its code before it reboots its gateway, so the config is
 * the old shape for as long as it takes the migration to run — and a chat-model
 * write pinned to the legacy ref is exactly the failure these guards exist for.
 */
export function isClawboxAiImageModelRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  const normalized = ref.trim().toLowerCase();
  return (
    normalized === CLAWBOX_AI_IMAGE_MODEL.toLowerCase() ||
    normalized === CLAWBOX_AI_LEGACY_IMAGE_MODEL.toLowerCase()
  );
}

/**
 * Is `ref` on the provider id ClawBox parks the image entry under?
 *
 * ANY model on it — `litellm/claude-opus-4-6` from the bundled plugin's own
 * static catalog, anything its live discovery returns from
 * `<baseUrl>/v1/models`, the image id itself. On this box that provider entry
 * is the ClawBox AI image lane and nothing else: its `baseUrl` is the image
 * proxy and its `apiKey` is the portal token, so a chat turn addressed there
 * asks a picture endpoint for a conversation.
 *
 * Deliberately NOT applied to {@link CLAWBOX_AI_LEGACY_IMAGE_PROVIDER}
 * (`openai`), which is a real chat provider on this box — that one stays an
 * exact-ref question.
 */
export function isClawboxAiImageProviderRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  const prefix = `${CLAWBOX_AI_IMAGE_PROVIDER.toLowerCase()}/`;
  const normalized = ref.trim().toLowerCase();
  return normalized.startsWith(prefix) && normalized.length > prefix.length;
}

/**
 * Is `ref` one ClawBox refuses to write into a CHAT slot?
 *
 * The REFUSAL predicate, as against {@link isClawboxAiImageModelRef}, which is
 * the CLAIM one ("this slot is ours to move"). The two are different questions
 * and must stay apart: the migration may only claim a slot it recognises as its
 * own write, while a refusal has to cover every ref on the image lane's
 * provider id — see the note above `CLAWBOX_AI_PROXY_URLS`.
 */
export function isClawboxAiNonChatModelRef(ref: unknown): boolean {
  return isClawboxAiImageModelRef(ref) || isClawboxAiImageProviderRef(ref);
}

/**
 * Why a ref was refused, in the customer's terms.
 *
 * Two sentences, because the two cases have different facts: the image model
 * itself is "that is the picture model", while another row on the image lane's
 * provider id is "that provider is not a chat provider on this box". One place,
 * so the three writers and the picker cannot word the same refusal three ways.
 */
export function clawboxAiNonChatModelReason(ref: string): string {
  const modelId = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
  return isClawboxAiImageModelRef(ref)
    ? `${modelId} is the ClawBox AI image model, not a chat model.`
    : `${CLAWBOX_AI_IMAGE_PROVIDER} is this box's ClawBox AI image provider, not a chat provider.`;
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
