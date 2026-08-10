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
