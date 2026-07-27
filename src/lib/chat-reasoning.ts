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
