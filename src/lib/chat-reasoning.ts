// Reasoning-effort vocabulary + per-provider configuration for the chat
// header's "Reasoning effort" picker. Extracted from ChatPopup so the gating
// (which providers offer which levels) is unit-testable without rendering the
// whole chat component.

// Reasoning effort levels accepted by the OpenClaw gateway. The wire
// vocabulary is broader than what any single upstream API supports — each
// provider only honors a subset, with the gateway translating (e.g. DeepSeek
// `xhigh`→`max`, Google `adaptive`→`thinking_budget=-1`).
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "adaptive";

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
  adaptive: "Adaptive",
};

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && value in THINKING_LEVEL_LABELS;
}

// Per-provider effort levels and defaults.
//
// Product decision (2026-07-23): the reasoning-effort picker is UNIFORM across
// every cloud provider — `Off / Low / Medium / High` — so the control looks and
// behaves the same no matter which model you pick. The OpenClaw gateway accepts
// this ladder for all of them (it normalizes/translates per provider; e.g.
// DeepSeek folds low/medium up to its single reasoning tier). Provider-specific
// extras (`xhigh`, `max`, `adaptive`, `minimal`) are intentionally dropped for
// consistency.
//
// Defaults differ on purpose: ClawBox AI / DeepSeek default to `off` so simple
// prompts stay fast and don't burn reasoning tokens (users opt in), while the
// reasoning-first cloud providers default to `medium`.
export interface ProviderReasoningConfig {
  levels: readonly ThinkingLevel[];
  default: ThinkingLevel;
}

const UNIFORM_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

export const REASONING_BY_PROVIDER: Record<string, ProviderReasoningConfig> = {
  openai: { levels: UNIFORM_LEVELS, default: "medium" },
  // ChatGPT-subscription provider, renamed from `openai-codex` in OpenClaw
  // 2026.6.x. Provider ids are normalized to `codex` before they reach here.
  codex: { levels: UNIFORM_LEVELS, default: "medium" },
  anthropic: { levels: UNIFORM_LEVELS, default: "medium" },
  google: { levels: UNIFORM_LEVELS, default: "medium" },
  // ClawBox AI/DeepSeek keeps `off` as its default so simple prompts stay fast;
  // low/medium/high are offered for parity but the gateway folds low/medium up
  // to DeepSeek's single reasoning tier.
  deepseek: { levels: UNIFORM_LEVELS, default: "off" },
  // ClawBox AI routes via DeepSeek today.
  clawai: { levels: UNIFORM_LEVELS, default: "off" },
  openrouter: { levels: UNIFORM_LEVELS, default: "medium" },
  // Local Gemma (llama.cpp) exposes no reasoning-effort control — the gateway
  // rejects any thinkingLevel other than `off` ("thinkingLevel … is not
  // supported for llamacpp/gemma… (use off)"). Declaring it off-only hides the
  // picker (the header only renders it when there's more than one level) and
  // keeps the wire value at `off`, which the gateway accepts.
  llamacpp: { levels: ["off"], default: "off" },
};

export const FALLBACK_REASONING_CONFIG: ProviderReasoningConfig = {
  levels: ["off", "low", "medium", "high"],
  default: "medium",
};

export function getProviderReasoningConfig(
  provider: string | null | undefined,
): ProviderReasoningConfig {
  if (!provider) return FALLBACK_REASONING_CONFIG;
  return REASONING_BY_PROVIDER[provider] ?? FALLBACK_REASONING_CONFIG;
}

// The single level that is always safe to send: every provider config includes
// `off`, and the gateway accepts it for models that expose no reasoning control
// at all (local llama.cpp/Gemma). Used as the wire value whenever the active
// provider is still unknown, so the picker can never push a speculative `high`
// at a model that would reject it.
export const SAFE_THINKING_LEVEL: ThinkingLevel = "off";

// Clamp a desired level to what the active provider actually supports, so the
// value pushed to the gateway is never one the model will reject.
//
// This is the last line of defence behind the picker's own gating: the picker
// only *offers* supported levels, but a level can still go stale across a model
// switch (a `high` chosen on DeepSeek carried into a local Gemma session before
// the header state has caught up). Routing every wire push through here means
// such a stale value is silently folded to the new provider's default (`off`
// for local Gemma) instead of reaching the gateway and erroring.
//
// When the provider is not yet known (`null` — the model catalog is still
// loading), returns `null` so the caller can hold the push until it knows what
// the active model supports, rather than guessing with the permissive fallback.
export function resolveWireThinkingLevel(
  provider: string | null | undefined,
  desired: ThinkingLevel,
): ThinkingLevel | null {
  if (!provider) return null;
  const cfg = getProviderReasoningConfig(provider);
  return cfg.levels.includes(desired) ? desired : cfg.default;
}

// The gateway rejects an unsupported effort with a message that also names the
// level it WILL accept, e.g.:
//
//   thinkingLevel "high" is not supported for llamacpp/gemma4-e2b-it-q4_0 (use off)
//
// That parenthetical is the backend telling us the model's real capability.
// Parse it so a client that still races into this error can silently retry with
// the level the backend itself asked for, instead of surfacing a red banner.
// Returns null when the message isn't this specific rejection (any other
// failure should keep its normal error handling).
export function parseUnsupportedThinkingLevelError(
  message: string | null | undefined,
): ThinkingLevel | null {
  if (typeof message !== "string") return null;
  if (!/thinkinglevel/i.test(message) || !/not supported/i.test(message)) return null;
  const match = /\(\s*use\s+([a-z-]+)\s*\)/i.exec(message);
  if (!match) return null;
  const suggested = match[1].toLowerCase();
  return isThinkingLevel(suggested) ? suggested : null;
}

export const PERSIST_KEY_PREFIX = "clawbox:chat:thinkingLevel";

export function readPersistedThinkingLevel(
  provider: string | null | undefined,
  cfg: ProviderReasoningConfig,
): ThinkingLevel {
  if (typeof window === "undefined" || !provider) return cfg.default;
  try {
    const raw = window.localStorage?.getItem(`${PERSIST_KEY_PREFIX}:${provider}`);
    if (raw && cfg.levels.includes(raw as ThinkingLevel)) return raw as ThinkingLevel;
  } catch {
    /* localStorage unavailable */
  }
  return cfg.default;
}
