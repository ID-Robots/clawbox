/**
 * The coding agent's EFFORT levels — pure TypeScript, no Node imports, so the
 * MCP server (`mcp/tools/coding-agent.ts`, which may not use the `@/` alias)
 * can offer the same list the routes validate against. `coding-agent.ts`
 * re-exports everything here under its old names.
 *
 * How hard Claude Code thinks per turn. The first five are the levels the
 * installed CLI accepts for `--effort` and the wrapper pins through
 * CLAUDE_DS_EFFORT — it warns and falls back to its default on anything
 * else, so the set is validated here rather than passed through.
 *
 * Higher is slower and costs more; on a Jetson the difference is felt.
 *
 * "ultracode" is not a thinking level but Claude Code's own mode on top of
 * one: xhigh effort plus a standing opt-in to orchestrate the work with its
 * Workflow tool (fan-out, adversarial verification). It was the default until
 * TASK-1749: its fan-outs multiply every run's tokens (an owner measured a job
 * at 20-30 million tokens that a single-agent tool did in ~500k), so the
 * default is now xhigh — the same thinking level without the standing
 * fan-out — and ultracode stays one tap away in the picker.
 * The wrapper requests it with `--effort ultracode` instead of the env pin
 * the fixed levels use, because a pinned CLAUDE_CODE_EFFORT_LEVEL blocks the
 * mode ("clear it and ultracode takes over"). Checked on this box: a -p run
 * under the flag reports "Ultracode is on" and carries the Workflow tool.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export type CodingEffort = (typeof EFFORT_LEVELS)[number];
/**
 * The levels the app offers, as opposed to the ones the CLI accepts.
 *
 * Measured on this box, same prompt, deepseek-v4-pro[1m], reasoning tokens:
 *
 *     low 82   medium 94   high 102   xhigh 139   max 414
 *
 * The effort does reach the model — the request carries
 * output_config {"effort": "..."} and it changes with the flag — but low,
 * medium and high land within noise of each other. Offering six buttons
 * where three do the same thing teaches a false model of the machine, so the
 * picker shows the three that measurably differ, plus ultracode. All six stay
 * valid for anyone setting the config key directly.
 *
 * These are also the levels a PER-REQUEST override may name — the run and
 * team routes' `effort`, the MCP tools' `effort` parameter (2026-10-30, the
 * Create card's Ultracode toggle): what the owner can pick in the app is what
 * the assistant can ask for on one run.
 */
export const OFFERED_EFFORT_LEVELS: readonly CodingEffort[] = ["low", "xhigh", "max", "ultracode"];
export const DEFAULT_EFFORT: CodingEffort = "xhigh";
/** The one level the wrapper cannot pin through the environment — see EFFORT_LEVELS. */
export const ULTRACODE_EFFORT: CodingEffort = "ultracode";

export function isEffort(value: unknown): value is CodingEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** One of OFFERED_EFFORT_LEVELS — what a request may name for one run or team. */
export function isOfferedEffort(value: unknown): value is CodingEffort {
  return typeof value === "string" && (OFFERED_EFFORT_LEVELS as readonly string[]).includes(value);
}

/** The sentence a refused per-request effort gets, wherever it arrives. */
export function effortRefusal(value: unknown): string {
  return `Unknown effort "${typeof value === "string" ? value : typeof value}". Use one of: ${OFFERED_EFFORT_LEVELS.join(", ")}.`;
}
