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

// Per-provider effort levels and defaults. Sourced from each upstream's
// official API docs. Showing the universal 8-level dropdown for every provider
// was misleading — `Max` doesn't exist on OpenAI, `Minimal` was dropped from
// gpt-5.4+, Google has `Adaptive` (thinking_budget=-1) where others have
// `Default`, etc. Per-provider config keeps the UI honest.
export interface ProviderReasoningConfig {
  levels: readonly ThinkingLevel[];
  default: ThinkingLevel;
}

export const REASONING_BY_PROVIDER: Record<string, ProviderReasoningConfig> = {
  openai: { levels: ["off", "low", "medium", "high", "xhigh"], default: "medium" },
  // ChatGPT-subscription provider, renamed from `openai-codex` in OpenClaw
  // 2026.6.x. Provider ids are normalized to `codex` before they reach here.
  codex: { levels: ["off", "low", "medium", "high", "xhigh"], default: "medium" },
  // Anthropic effort docs: `low | medium | high | max` on Opus 4.6+, Sonnet
  // 4.6, Opus 4.7, Mythos. Default per platform.claude.com is `high`. xhigh is
  // Opus-4.7-only; we omit until we add per-model gating.
  anthropic: { levels: ["low", "medium", "high", "max"], default: "high" },
  // Gemini 2.5 thinking_budget: 0=off (Flash/Lite only — Pro silently
  // ignores), -1=adaptive (auto). Picker stays provider-wide; Pro will fall
  // back to adaptive when user picks Off.
  google: { levels: ["off", "low", "medium", "high", "adaptive"], default: "adaptive" },
  // DeepSeek V4 docs accept low/medium/high/xhigh/max but compatibility layer
  // maps low+medium→high and xhigh→max upstream, so the user-facing useful
  // scale is just three.
  deepseek: { levels: ["low", "medium", "high"], default: "high" },
  // ClawBox AI routes via DeepSeek today.
  clawai: { levels: ["low", "medium", "high"], default: "high" },
  // OpenRouter normalizes per underlying model — surface the full set they
  // document at openrouter.ai/docs/guides/best-practices/reasoning-tokens.
  openrouter: { levels: ["off", "minimal", "low", "medium", "high", "xhigh"], default: "medium" },
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
