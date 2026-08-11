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

/**
 * Providers with NO reasoning control at all — a different thing from a
 * provider that rejects some levels.
 *
 * Empty today. `clawlocal` used to be here, correctly: llama.cpp's
 * OpenAI-compatible server ignores `reasoning_effort` entirely, so all eight
 * levels did the same nothing and the honest UI was no control at all.
 *
 * That finding still holds — `reasoning_effort` is still inert — but it was the
 * wrong question. The backend DOES take a thinking switch; it is just spelled
 * `chat_template_kwargs.enable_thinking`, and it works per request on a running
 * server. See LOCAL_REASONING_LEVELS below and src/lib/local-ai-thinking.ts,
 * which does the translation.
 */
const NO_REASONING_CONTROL: ReadonlySet<string> = new Set<string>();

/**
 * The on-device model's thinking switch, expressed in the CLI's vocabulary.
 *
 * TWO states, not eight, and not a graded Low/Medium/High — because two is
 * what the backend actually has. VERIFIED against the shipped llama-server
 * (version 1 (db7d8b2)) with the server running `--reasoning off`:
 *
 *   chat_template_kwargs.enable_thinking=false →   0 reasoning chars,   4 tok,  207 ms
 *   chat_template_kwargs.enable_thinking=true  → 703 reasoning chars, 253 tok, 8416 ms
 *
 * Both directions work without restarting llama-server. The graded middle does
 * not exist: `--reasoning-budget` is a launch flag and is NOT honoured per
 * request (budget 64 → 371 reasoning chars, budget 0 → 518 — noise, not
 * enforcement). Offering Low/Medium/High would put back exactly the failure
 * this list was created to remove: settings that all do the same thing.
 *
 * `minimal` and `max` are chosen from HERMES_REASONING_LEVELS as the two ends
 * so the value reaching `hermes --reasoning` stays inside the CLI's own
 * vocabulary; the proxy maps them onto the boolean. `none` is deliberately not
 * the off value — it reads as "no reasoning at all" in other providers'
 * pickers, and this switch controls thinking, not the answer.
 */
export const LOCAL_REASONING_LEVELS: readonly HermesReasoningLevel[] = ['minimal', 'max'];

/** Providers whose reasoning control is a two-state thinking switch. */
const BINARY_REASONING_CONTROL: ReadonlyMap<string, readonly HermesReasoningLevel[]> = new Map([
  ['clawlocal', LOCAL_REASONING_LEVELS],
]);

/**
 * The label a two-state provider shows for a level in the OPEN menu, or null
 * when this provider uses the effort scale instead.
 *
 * "Minimal"/"Max" would be actively misleading here — they are scale points
 * borrowed to carry a boolean, and a customer reading them would reasonably
 * expect a Medium to exist.
 */
export function binaryReasoningLabel(
  provider: string | null | undefined,
  level: HermesReasoningLevel,
): string | null {
  const levels = BINARY_REASONING_CONTROL.get((provider || '').trim());
  if (!levels) return null;
  return level === levels[0] ? 'Thinking off' : 'Thinking on';
}

/**
 * The same value for the closed PILL, where the row's width budget is the
 * binding constraint (three labels share ~168px). The pill already carries the
 * brain glyph, so it does not need to repeat the word "Thinking" — the glyph
 * says which dial it is, and this says which way it is set.
 */
export function binaryReasoningTriggerLabel(
  provider: string | null | undefined,
  level: HermesReasoningLevel,
): string | null {
  const levels = BINARY_REASONING_CONTROL.get((provider || '').trim());
  if (!levels) return null;
  return level === levels[0] ? 'Off' : 'On';
}

/** True when this provider's dial is a thinking switch rather than an effort scale. */
export function providerHasBinaryReasoning(provider: string | null | undefined): boolean {
  return BINARY_REASONING_CONTROL.has((provider || '').trim());
}

/**
 * The levels this provider will actually accept. Unknown provider → all.
 * EMPTY means the provider has no reasoning control and the UI should not
 * render the picker at all.
 */
export function hermesReasoningLevelsFor(provider: string | null | undefined): readonly HermesReasoningLevel[] {
  const id = (provider || '').trim();
  if (NO_REASONING_CONTROL.has(id)) return [];
  const binary = BINARY_REASONING_CONTROL.get(id);
  if (binary) return binary;
  const blocked = UNSUPPORTED_BY_PROVIDER[id];
  if (!blocked || blocked.length === 0) return HERMES_REASONING_LEVELS;
  return HERMES_REASONING_LEVELS.filter((level) => !blocked.includes(level));
}

/** True when this provider exposes a reasoning-effort dial worth showing. */
export function providerHasReasoningControl(provider: string | null | undefined): boolean {
  return hermesReasoningLevelsFor(provider).length > 0;
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
