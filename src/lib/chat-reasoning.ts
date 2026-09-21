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
// Every cloud provider defaults to `medium`. ClawBox AI (spelled `clawai` by
// the UI and `deepseek` by the gateway config — one provider, see
// `isClawboxAiProvider`) defaulted to `off` so simple prompts stayed fast; the
// owner's ruling of 2026-09-15 is Medium, so a fresh ClawBox AI session thinks
// before it answers and the owner turns it DOWN rather than up. Both legacy
// ClawBox AI model ids serve Flash 4.1 and share the same default.
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
  // ClawBox AI, in the gateway's spelling: Medium by default (2026-09-15);
  // low/medium/high are offered for parity and the gateway folds low/medium up
  // to DeepSeek's single reasoning tier.
  deepseek: { levels: UNIFORM_LEVELS, default: "medium" },
  // ClawBox AI routes via DeepSeek today — the same provider, the UI's
  // spelling (the chat/model route normalises `deepseek` to this), and so the
  // same default: a fresh ClawBox AI session runs at Medium.
  clawai: { levels: UNIFORM_LEVELS, default: "medium" },
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

// Keep the optional model argument for callers carrying the active pairing.
// The legacy ClawBox AI aliases no longer need different reasoning defaults.
// Claude models the gateway will not run without thinking: its contract
// (`requiresClaudeMandatoryAdaptiveThinking` in the core) refuses
// `thinkingLevel: "off"` for them — seen verbatim on a box:
//   thinkingLevel "off" is not supported for anthropic/claude-fable-5-1
//   (use minimal|low|medium|adaptive|high|xhigh|max)
// Offering "off" for these was a control the gateway could only refuse, and
// the chat's safe start value IS "off", so every fresh session hit it.
//
// Transcribed from the core's own predicate at v2026.9.3
// (`requiresClaudeMandatoryAdaptiveThinking`,
// `packages/llm-core/src/model-contracts/anthropic.ts`), which is
//   resolveClaudeFable5ModelIdentity(ref) !== undefined
//   || resolveClaudeMythos5ModelIdentity(ref) !== undefined
//   || /(?:^|-)claude-mythos-preview(?=$|[^a-z0-9])/.test(modelId)
// — the first two being `/(?:^|-)claude-fable-5(?=$|[^a-z0-9])/` and
// `/(?:^|-)claude-mythos-5(?=$|[^a-z0-9])/`. Three things the hand-written
// `/claude-(fable|mythos)-5/i` got wrong: it missed `claude-mythos-preview`
// altogether (a box pinned to it was offered "Off", started at `off`, and the
// gateway refused every fresh session), it had no LEADING boundary, and it had
// no TRAILING one — so `claude-fable-50` matched.
const CLAUDE_MANDATORY_THINKING_RE = /(?:^|-)claude-(?:fable-5|mythos-(?:5|preview))(?=$|[^a-z0-9])/i;
const MANDATORY_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high"];

function requiresMandatoryThinking(provider: string, model: string | null | undefined): boolean {
  if (!model) return false;
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return (provider === "anthropic" || model.startsWith("anthropic/")) && CLAUDE_MANDATORY_THINKING_RE.test(bare);
}

/**
 * What the GATEWAY says this model's thinking levels are, when it has been
 * asked.
 *
 * HARNESS-FIRST. The gateway publishes this natively: every row of a
 * `models.list` result carries `thinkingLevels: [{ id, label }]`, built from
 * `resolveEffectiveThinkingProfile` (`src/gateway/server-methods/models-list-result.ts`
 * at v2026.9.3, schema in `packages/gateway-protocol/src/schema/agents-models-skills.ts`).
 * `/setup-api/chat/model` now asks for it over the in-process socket, which
 * costs milliseconds — the constraint that justified the local table alone —
 * and hands it to the header as `thinkingLevels` on the active option.
 *
 * INTERSECTED with ClawBox's uniform ladder rather than adopted whole. The
 * product decision above is that the picker looks the same on every provider:
 * the gateway's list decides what is REFUSABLE, ClawBox's decides what is
 * OFFERED, and the answer is what both agree on. An empty intersection means
 * the model runs on levels ClawBox does not offer at all — the mandatory-
 * thinking case, among others — so the gateway's own first level is taken and
 * the ladder's default is clamped into it.
 *
 * Absent or unusable (an old core, a gateway that was down, the Hermes SKU),
 * the local table below answers exactly as it did.
 */
export function intersectWithLadder(
  ladder: ProviderReasoningConfig,
  gatewayLevels: readonly string[] | null | undefined,
): ProviderReasoningConfig {
  if (!Array.isArray(gatewayLevels) || gatewayLevels.length === 0) return ladder;
  const supported = gatewayLevels.filter(isThinkingLevel);
  if (supported.length === 0) return ladder;
  const levels = ladder.levels.filter((level) => supported.includes(level));
  if (levels.length === 0) {
    // Nothing in common: offer what the gateway will actually take, narrowed to
    // the ladder's own order so the control still reads left-to-right the way
    // every other provider's does.
    const ordered = UNIFORM_LEVELS.filter((level) => supported.includes(level));
    const only = ordered.length > 0 ? ordered : [supported[0]];
    return { levels: only, default: only.includes(ladder.default) ? ladder.default : only[0] };
  }
  return { levels, default: levels.includes(ladder.default) ? ladder.default : levels[0] };
}

export function getProviderReasoningConfig(
  provider: string | null | undefined,
  model?: string | null,
  gatewayLevels?: readonly string[] | null,
): ProviderReasoningConfig {
  if (!provider) return FALLBACK_REASONING_CONFIG;
  const ladder = requiresMandatoryThinking(provider, model)
    ? { levels: MANDATORY_THINKING_LEVELS, default: "medium" as ThinkingLevel }
    : REASONING_BY_PROVIDER[provider] ?? FALLBACK_REASONING_CONFIG;
  return intersectWithLadder(ladder, gatewayLevels);
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
  model?: string | null,
  gatewayLevels?: readonly string[] | null,
): ThinkingLevel | null {
  if (!provider) return null;
  const cfg = getProviderReasoningConfig(provider, model, gatewayLevels);
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
  // One level ("use off") or the whole menu ("use minimal|low|medium|…"):
  // the gateway words both. From a menu take the chat's own default when it
  // is offered, otherwise the first level it names.
  const match = /\(\s*use\s+([a-z|\s-]+?)\s*\)/i.exec(message);
  if (!match) return null;
  const offered = match[1]
    .split("|")
    .map((level) => level.trim().toLowerCase())
    .filter(isThinkingLevel);
  if (offered.length === 0) return null;
  return offered.includes("medium") ? "medium" : offered[0];
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
