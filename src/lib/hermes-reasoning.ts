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
 * REVERSAL, recorded because the evidence for it was expensive.
 *
 * `clawlocal` used to be listed here as a provider with NO reasoning control,
 * and that was correct on its own terms: llama.cpp's OpenAI-compatible server
 * ignores `reasoning_effort` entirely, so all eight levels did the same nothing
 * and the honest UI was no control at all. That finding STILL HOLDS —
 * `reasoning_effort` is still inert.
 *
 * It was simply the wrong question. The backend does take a thinking switch; it
 * is spelled `chat_template_kwargs.enable_thinking`, and it works per request
 * on a running server. See LOCAL_REASONING_LEVELS below, and
 * src/lib/local-ai-thinking.ts for the translation.
 *
 * The "no control at all" shape therefore has no members today, and the empty
 * container that used to express it is gone rather than left as a branch that
 * can never be taken. A provider that genuinely has no dial can still be
 * expressed — return an empty level list from hermesReasoningLevelsFor; the
 * callers already treat that as "hide the control".
 */

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

/**
 * The level that means "don't think". Named rather than positional: every
 * caller needs to know which END of the pair it is holding, and deriving that
 * from a position (`levels[0]`, or the UI's `levels[levels.length - 1]`)
 * silently inverts the moment anyone reorders the array — labels would still
 * look right while the "much slower" hint attached to the fast option.
 */
const THINKING_OFF_LEVEL: HermesReasoningLevel = 'minimal';

/**
 * The on-device model's provider id. Mirrors HERMES_LOCAL_PROVIDER in
 * hermes-local-ai.ts, which cannot be imported here: that module pulls in the
 * Hermes CLI and the config store, and this one is bundled into the browser.
 */
export const HERMES_LOCAL_REASONING_PROVIDER = 'clawlocal';

/** Providers whose reasoning control is a two-state thinking switch. */
const BINARY_REASONING_CONTROL: ReadonlyMap<string, readonly HermesReasoningLevel[]> = new Map([
  [HERMES_LOCAL_REASONING_PROVIDER, LOCAL_REASONING_LEVELS],
]);

/** The two levels of a switch-style provider, or null for an effort scale. */
function binaryLevelsFor(provider: string | null | undefined): readonly HermesReasoningLevel[] | null {
  return BINARY_REASONING_CONTROL.get((provider || '').trim()) ?? null;
}

/** True when this provider's dial is a thinking switch rather than an effort scale. */
export function providerHasBinaryReasoning(provider: string | null | undefined): boolean {
  return binaryLevelsFor(provider) !== null;
}

/**
 * Whether this level means "think" on a two-state provider.
 *
 * The single definition of the switch's direction. The UI's cost hint and the
 * proxy's boolean must not each decide this for themselves — see
 * THINKING_OFF_LEVEL.
 */
export function isThinkingOnLevel(
  provider: string | null | undefined,
  level: HermesReasoningLevel,
): boolean {
  return binaryLevelsFor(provider) !== null && level !== THINKING_OFF_LEVEL;
}

/**
 * Labels for a two-state provider, or null when it uses the effort scale.
 *
 * `menu` is the open dropdown; `pill` is the closed trigger, where the header's
 * width budget binds (three labels share ~168px) and the brain glyph already
 * says which dial it is. "Minimal"/"Max" appear in neither — they are scale
 * points borrowed to carry a boolean, and a customer reading them would
 * reasonably expect a Medium to exist.
 */
const BINARY_LABELS = {
  menu: { off: 'Thinking off', on: 'Thinking on' },
  pill: { off: 'Off', on: 'On' },
} as const;

function binaryLabel(
  surface: keyof typeof BINARY_LABELS,
  provider: string | null | undefined,
  level: HermesReasoningLevel,
): string | null {
  if (!providerHasBinaryReasoning(provider)) return null;
  const labels = BINARY_LABELS[surface];
  return isThinkingOnLevel(provider, level) ? labels.on : labels.off;
}

/** The label a two-state provider shows for a level in the OPEN menu. */
export function binaryReasoningLabel(
  provider: string | null | undefined,
  level: HermesReasoningLevel,
): string | null {
  return binaryLabel('menu', provider, level);
}

/** The same value for the closed PILL, which has far less room. */
export function binaryReasoningTriggerLabel(
  provider: string | null | undefined,
  level: HermesReasoningLevel,
): string | null {
  return binaryLabel('pill', provider, level);
}

/**
 * The levels this provider will actually accept. Unknown provider → all.
 * EMPTY means the provider has no reasoning control and the UI should not
 * render the picker at all.
 */
export function hermesReasoningLevelsFor(provider: string | null | undefined): readonly HermesReasoningLevel[] {
  const id = (provider || '').trim();
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
  // Nothing at or below the requested level is allowed, so the walk found no
  // candidate — only reachable when the request sat BELOW everything on offer.
  // Land on the lowest allowed level, keeping the same "never silently raise
  // effort" rule as the walk itself: asking for `none` on a two-state provider
  // must give thinking OFF, not the far end of the switch.
  return allowed[0] ?? HERMES_REASONING_DEFAULT;
}
