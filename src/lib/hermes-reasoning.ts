// Reasoning-effort vocabulary accepted by `hermes --reasoning`.
//
// VERIFIED on-device against `hermes --help`:
//   --reasoning LEVEL  Reasoning effort for this invocation: none, minimal,
//                      low, medium, high, xhigh, max, or ultra. Overrides
//                      agent.reasoning_effort in config.yaml for this run only.
//
// Deliberately NOT shared with src/lib/chat-reasoning.ts: that module is the
// OpenClaw GATEWAY's vocabulary (it has 'off' and 'adaptive', and no 'ultra').
// One union covering both would let the chat header offer a level the Hermes
// CLI rejects — and the reverse. Two backends, two vocabularies.

export const HERMES_REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export type HermesReasoningLevel = (typeof HERMES_REASONING_LEVELS)[number];

export const HERMES_REASONING_LABELS: Record<HermesReasoningLevel, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
  ultra: 'Ultra',
};

// Matches `agent.reasoning_effort: medium` on the device, so the picker's
// initial value is what an un-flagged `hermes -z` would already have used.
// (Only a floor: the real value is read from the device on mount.)
export const HERMES_REASONING_DEFAULT: HermesReasoningLevel = 'medium';

/**
 * Allowlist test for any value about to reach `hermes --reasoning`. Membership
 * in a literal union — so the result can never carry a leading "-", a shell
 * metacharacter, or anything else argv-hostile.
 */
export function isHermesReasoningLevel(value: unknown): value is HermesReasoningLevel {
  return typeof value === 'string'
    && (HERMES_REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * The CLI vocabulary is not the same as what a PROVIDER accepts: Hermes passes
 * the level through as `reasoning_effort`, and the upstream API is free to
 * reject a value it doesn't know.
 *
 * VERIFIED on-device against ClawBox AI (deepseek-v4-pro, the clawbox.com/api/ai
 * proxy) by sending all eight: none/minimal/low/medium/high/xhigh/max all
 * answered normally; `ultra` failed with
 *   HTTP 400: Failed to deserialize the JSON body into the target type:
 *   reasoning_effort: unknown …
 * so offering it in the picker is offering a guaranteed failed turn.
 *
 * Hermes itself sets the precedent — see `grok_supports_reasoning_effort` in
 * agent/model_metadata.py, which tracks exactly which Grok models accept the
 * parameter. Entries here are ONLY for levels we have actually observed being
 * rejected; we never guess a provider's capabilities.
 */
const UNSUPPORTED_BY_PROVIDER: Record<string, readonly HermesReasoningLevel[]> = {
  clawai: ['ultra'],
};

/** The levels this provider will actually accept. Unknown provider → all. */
export function hermesReasoningLevelsFor(provider: string | null | undefined): readonly HermesReasoningLevel[] {
  const blocked = UNSUPPORTED_BY_PROVIDER[(provider || '').trim()];
  if (!blocked || blocked.length === 0) return HERMES_REASONING_LEVELS;
  return HERMES_REASONING_LEVELS.filter((level) => !blocked.includes(level));
}

/** True when `provider` accepts `level`. */
export function isReasoningLevelAllowedFor(
  provider: string | null | undefined,
  level: HermesReasoningLevel,
): boolean {
  return hermesReasoningLevelsFor(provider).includes(level);
}

/**
 * Keep a chosen level valid when the provider changes: a user sitting on Ultra
 * who switches to ClawBox AI must land on the nearest level that provider
 * supports (Max), not silently send a request that 400s.
 */
export function clampReasoningForProvider(
  provider: string | null | undefined,
  level: HermesReasoningLevel,
): HermesReasoningLevel {
  const allowed = hermesReasoningLevelsFor(provider);
  if (allowed.includes(level)) return level;
  // Walk DOWN the canonical order to the closest supported level — dropping
  // effort is the safe direction; silently raising it is not.
  const index = HERMES_REASONING_LEVELS.indexOf(level);
  for (let i = index - 1; i >= 0; i--) {
    const candidate = HERMES_REASONING_LEVELS[i];
    if (allowed.includes(candidate)) return candidate;
  }
  return allowed[allowed.length - 1] ?? HERMES_REASONING_DEFAULT;
}
