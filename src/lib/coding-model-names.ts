/**
 * A coding model's SHORT name, for the places that show one beside its
 * provider: the per-role choices in the Coding Agent settings, a run's first
 * step on its timeline, a teammate's row on a run's page.
 *
 * Short because the provider is always said beside it
 * (`CODING_PROVIDER_NAME_KEY`): "Opus 5.5" under "Anthropic", not "Claude Opus
 * 5.5". Product names, so they live here rather than in the locale tables —
 * they read the same in every language.
 *
 * PURE, like coding-provider.ts: the settings panel imports it.
 */
const NAMES: Readonly<Record<string, string>> = {
  "deepseek-v4-flash": "DeepSeek Flash",
  "deepseek-v4-pro": "DeepSeek Pro",
  "claude-opus-5-5": "Opus 5.5",
  "claude-fable-5-1": "Fable 5.1",
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5": "Sonnet 5",
};

/**
 * The short name of a model id, or the id itself for one this build has no
 * name for — a run recorded on a model added later still says what it ran on.
 * A context-window suffix the harness appends ("deepseek-v4-pro[1m]") is not
 * part of the model's name.
 */
export function codingModelName(id: string): string {
  const base = id.replace(/\[[^\]]*\]$/, "");
  return Object.prototype.hasOwnProperty.call(NAMES, base) ? NAMES[base] : id;
}
