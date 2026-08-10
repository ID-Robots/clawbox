// Hermes inference-provider registry — the single source of truth shared by the
// Hermes provider panel, /setup-api/hermes/models and /setup-api/hermes/chat, so
// a provider id can never mean one thing in the UI and another at the CLI.
//
// WHY a captured slug list instead of a hand-curated set: the previous
// ALLOWED_PROVIDERS in the models route was 10 hand-maintained ids that had
// already drifted (it contained "nous-api", which Hermes does not know — it is
// absent from CANONICAL_PROVIDERS, PROVIDER_REGISTRY and normalize_provider, so
// selecting it wrote a provider the agent could never resolve). These slugs are
// Hermes' own canonical registry, captured verbatim from the live dashboard
// (GET /api/model/options?include_unconfigured=true → 44 rows). The models route
// additionally unions in whatever slugs the live dashboard reports, so a
// user-defined custom provider keeps working without a code change here.

export const HERMES_CANONICAL_PROVIDER_SLUGS = [
  "nous", "fireworks", "openrouter", "moa", "novita", "lmstudio", "anthropic",
  "openai-codex", "openai-api", "alibaba", "xai-oauth", "xiaomi",
  "tencent-tokenhub", "nvidia", "copilot", "copilot-acp", "huggingface",
  "gemini", "vertex", "deepseek", "xai", "zai", "kimi-coding", "kimi-coding-cn",
  "stepfun", "minimax", "minimax-oauth", "minimax-cn", "ollama-cloud", "arcee",
  "gmi", "kilocode", "opencode-zen", "opencode-go", "bedrock", "azure-foundry",
  "ai-gateway", "qwen-oauth", "actual", "alibaba-coding-plan", "custom",
  "deepinfra", "upstage", "clawai",
] as const;

/** Pseudo-provider: "let Hermes pick from whatever credentials are present". */
export const HERMES_AUTO_PROVIDER = "auto";

/** ClawBox AI's Hermes custom-provider slug. */
export const CLAWAI_PROVIDER = "clawai";

// Charset guard for a slug that arrives from the live dashboard rather than the
// list above. Must not be able to look like a CLI flag or carry a separator.
export const HERMES_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

const STATIC_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  ...HERMES_CANONICAL_PROVIDER_SLUGS,
  HERMES_AUTO_PROVIDER,
]);

/**
 * Allowlist test for any value about to reach `hermes config set
 * model.provider` or `hermes --provider`. Synchronous and dependency-free on
 * purpose: the chat route must be able to reject a bad provider without a
 * dashboard round-trip.
 */
export function isHermesCliProvider(value: unknown): value is string {
  return typeof value === "string" && STATIC_ALLOWLIST.has(value);
}

/**
 * True for a slug the live dashboard reported that isn't in the static list
 * (a user-defined custom provider). Kept separate from `isHermesCliProvider`
 * so the strict, offline-safe check stays strict.
 */
export function isPlausibleHermesProviderId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && HERMES_PROVIDER_ID_RE.test(value);
}

// Charset guard for a model id that will be echoed back to `hermes -m` or
// `hermes config set model.default`. It lives HERE, next to the provider
// allowlist, rather than in hermes-model-options.ts, because the browser needs
// the identical rule and that module imports `fs/promises` (server-only).
// hermes-model-options.ts re-exports these as MODEL_ID_RE / isSafeModelId.
export const HERMES_MODEL_ID_RE = /^[A-Za-z0-9_./:-]+$/;

export function isSafeHermesModelId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && !value.startsWith("-")
    && HERMES_MODEL_ID_RE.test(value);
}

// Display names for the provider pills/rows. Hermes' own `name` field is fine
// for built-ins ("OpenRouter", "Mixture of Agents") but a user-defined provider
// reports its raw slug — ClawBox AI shows up as "clawai" — so the ids we ship
// get a curated label, and `pill` gets the compact form for the chat header,
// which is only ~130px wide when the panel is docked.
const PROVIDER_LABEL_OVERRIDES: Record<string, { label: string; pill: string }> = {
  clawai: { label: "ClawBox AI", pill: "ClawBox" },
  // The on-device model. Named for what it IS to the customer — the model
  // running on their box — not for the slug we register it under, and not for
  // the runtime hosting it, which they never chose and cannot change.
  clawlocal: { label: "Gemma 4 (on-device)", pill: "Gemma 4" },
  openrouter: { label: "OpenRouter", pill: "OpenRouter" },
  moa: { label: "Mixture of Agents", pill: "MoA" },
  anthropic: { label: "Anthropic", pill: "Claude" },
  "openai-codex": { label: "OpenAI Codex", pill: "Codex" },
  "openai-api": { label: "OpenAI", pill: "GPT" },
  gemini: { label: "Google Gemini", pill: "Gemini" },
  vertex: { label: "Google Vertex", pill: "Vertex" },
  zai: { label: "z.ai / GLM", pill: "GLM" },
  "kimi-coding": { label: "Kimi", pill: "Kimi" },
  copilot: { label: "GitHub Copilot", pill: "Copilot" },
  nous: { label: "Nous Portal", pill: "Nous" },
  deepseek: { label: "DeepSeek", pill: "DeepSeek" },
  ollama: { label: "Ollama", pill: "Ollama" },
  lmstudio: { label: "LM Studio", pill: "LM Studio" },
  [HERMES_AUTO_PROVIDER]: { label: "Auto", pill: "Auto" },
};

/** Full display name for a provider id (`name` = whatever Hermes reported). */
export function hermesProviderLabel(id: string, name?: string): string {
  return PROVIDER_LABEL_OVERRIDES[id]?.label || (name || "").trim() || id;
}

/** Compact display name for a narrow header pill. */
export function hermesProviderPillLabel(id: string, name?: string): string {
  return PROVIDER_LABEL_OVERRIDES[id]?.pill || hermesProviderLabel(id, name);
}

export interface HermesProviderDef {
  id: string;
  name: string;
  description: string;
  /** Accepts an API key via `hermes auth add`. */
  keyProvider?: boolean;
  /** Hermes OAuth-catalog id (from /api/providers/oauth) when this provider
   *  supports sign-in via Hermes' native PKCE / device-code flow. */
  oauthId?: string;
}

/**
 * Providers offered in the Hermes panel. A deliberate subset of the canonical
 * registry — the ones with a first-class ClawBox affordance (key field and/or
 * Hermes OAuth). Everything else stays reachable through Hermes' own dashboard.
 *
 * "nous-api" used to sit here as a second Nous row; it is NOT a Hermes provider
 * (verified on-device) and has been folded into the canonical `nous` row, whose
 * live auth_type is oauth_device_code.
 */
export const HERMES_PANEL_PROVIDERS: readonly HermesProviderDef[] = [
  { id: "openrouter", name: "OpenRouter", description: "300+ models behind one API key", keyProvider: true },
  { id: "anthropic", name: "Anthropic", description: "Claude — sign in or use an API key", keyProvider: true, oauthId: "anthropic" },
  { id: "openai-codex", name: "OpenAI", description: "Sign in with OpenAI (Codex)", oauthId: "openai-codex" },
  { id: "gemini", name: "Google Gemini", description: "Gemini models, direct", keyProvider: true },
  { id: "zai", name: "z.ai / GLM", description: "Zhipu GLM models", keyProvider: true },
  { id: "kimi-coding", name: "Kimi", description: "Moonshot Kimi (coding)", keyProvider: true },
  { id: "copilot", name: "GitHub Copilot", description: "Sign in with GitHub", oauthId: "copilot-acp" },
  { id: "nous", name: "Nous Portal", description: "Sign in with Nous", oauthId: "nous" },
];

// "auto" is deliberately NOT offered here. It is a per-invocation concept
// (`hermes` with no --provider = "resolve from whatever credentials exist"),
// not a persistable selection: writing `model.provider: auto` into config.yaml
// gives resolve_provider a value it cannot resolve, so it falls through to the
// env / credential-pool order and may end up running the previously-saved
// model id against a provider from a different namespace (this device's bare
// clawai `deepseek-v4-pro` against OpenRouter, which spells it
// `deepseek/deepseek-v4-pro`). It also silently erases a ClawBox AI selection.
// The chat route still ACCEPTS the slug — there it means "omit --provider",
// which is exactly right — and HERMES_AUTO_PROVIDER stays exported so a device
// already configured that way keeps being handled rather than rejected.
