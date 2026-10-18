/**
 * The coding agent's TOKEN DIET (TASK-1749): three independent knobs that cut
 * the fixed context every turn of a run re-sends.
 *
 * Measured on a Jetson box (DeepSeek through claude-ds, first-turn context):
 * a full ultracode run 16,677 tokens; without the appended brief 13,975 (the
 * brief is ~2.7k); without the clawbox MCP server's 13 browser and media tools
 * 14,375 (~2.3k). Every turn carries that again, so the per-turn fixed context
 * is the main cost of a run — and Claude Code's own MCP tool search does not
 * switch on through the proxy, so dropping tools has to be done here.
 *
 * - `brief`: "full" is today's HEADLESS_BRIEF; "lean" is LEAN_HEADLESS_BRIEF —
 *   every rule that prevents a real failure, said in as few words as possible,
 *   with the browser/visual sentences split into a block of their own.
 * - `helpers`: "always" is today's delegation sentence (explorer before every
 *   edit, tester after each batch, reviewer before the report); "lean" says to
 *   run the checks in the run's own shell and to use the helpers only where
 *   they pay for themselves.
 * - `visualTools`: "always" gives every run the browser and media tools, as
 *   today; "auto" gives them only to a run whose task or folder looks visual
 *   (`looksVisual`), decided ONCE per run and frozen on its record.
 *
 * Every default is today's behaviour, so a box that never set the diet sends a
 * byte-for-byte identical prompt (pinned by coding-diet.test.ts).
 *
 * Pure: no fs, no config store — the reader, the patch validator and the
 * heuristic, so the route, the runner and the tests read one rule.
 */

export const DIET_BRIEF_MODES = ["full", "lean"] as const;
export const DIET_HELPER_MODES = ["always", "lean"] as const;
export const DIET_VISUAL_TOOL_MODES = ["always", "auto"] as const;

export type DietBrief = (typeof DIET_BRIEF_MODES)[number];
export type DietHelpers = (typeof DIET_HELPER_MODES)[number];
export type DietVisualTools = (typeof DIET_VISUAL_TOOL_MODES)[number];

export interface CodingDiet {
  brief: DietBrief;
  helpers: DietHelpers;
  visualTools: DietVisualTools;
}

/** Today's behaviour on every knob. */
export const DEFAULT_DIET: Readonly<CodingDiet> = Object.freeze({ brief: "full", helpers: "always", visualTools: "always" });

const ALLOWED: { readonly [K in keyof CodingDiet]: readonly CodingDiet[K][] } = {
  brief: DIET_BRIEF_MODES,
  helpers: DIET_HELPER_MODES,
  visualTools: DIET_VISUAL_TOOL_MODES,
};

const DIET_KEYS = Object.keys(ALLOWED) as (keyof CodingDiet)[];

function pick<K extends keyof CodingDiet>(key: K, value: unknown): CodingDiet[K] {
  return (ALLOWED[key] as readonly unknown[]).includes(value) ? (value as CodingDiet[K]) : DEFAULT_DIET[key];
}

/**
 * A stored setting or a run record's frozen value, read strictly and never
 * thrown on: anything that is not an object is the default, and each field
 * this build does not recognise falls back to ITS default alone. A record
 * written before the field existed therefore reads as today's behaviour, which
 * is what keeps a resume's prompt the one its session was opened with.
 */
export function readDiet(raw: unknown): CodingDiet {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_DIET };
  const o = raw as Record<string, unknown>;
  return { brief: pick("brief", o.brief), helpers: pick("helpers", o.helpers), visualTools: pick("visualTools", o.visualTools) };
}

/** True when every knob is today's behaviour. */
export function isDefaultDiet(diet: CodingDiet): boolean {
  return DIET_KEYS.every((key) => diet[key] === DEFAULT_DIET[key]);
}

/** Why a patch was refused — stable, for the route's `code`. */
export type DietPatchRefusal = "diet_not_object" | "diet_unknown_key" | "diet_invalid_value";

export type DietPatchResult =
  | { ok: true; patch: Partial<CodingDiet> }
  | { ok: false; code: DietPatchRefusal; error: string };

/**
 * The enable route's `{ diet: { brief?, helpers?, visualTools? } }`, checked
 * WHOLE before anything is saved: an unknown key or a value this build does
 * not offer refuses the edit, never repairs it.
 */
export function validateDietPatch(raw: unknown): DietPatchResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "diet_not_object", error: "The diet must be an object: { brief?, helpers?, visualTools? }." };
  }
  const patch: Partial<CodingDiet> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(DIET_KEYS as string[]).includes(key)) {
      return { ok: false, code: "diet_unknown_key", error: `The diet has no setting "${key.slice(0, 40)}": use brief, helpers or visualTools.` };
    }
    const k = key as keyof CodingDiet;
    if (!(ALLOWED[k] as readonly unknown[]).includes(value)) {
      return { ok: false, code: "diet_invalid_value", error: `The diet's ${k} must be one of: ${ALLOWED[k].join(", ")}.` };
    }
    (patch as Record<string, unknown>)[k] = value;
  }
  return { ok: true, patch };
}

/** A validated patch merged over what is stored. */
export function mergeDiet(stored: unknown, patch: Partial<CodingDiet>): CodingDiet {
  return readDiet({ ...readDiet(stored), ...patch });
}

/**
 * Does the task text talk about a pull request? The lean brief carries the
 * auto-merge sentence only then (or when the box itself will open one).
 * "PR" is matched in capitals only, so the word "pr" in prose is not one.
 */
export function mentionsPullRequest(task: string): boolean {
  return /\bpull[\s-]*requests?\b/i.test(task) || /\bPRs?\b/.test(task) || /\bgh\s+pr\b/i.test(task);
}

/** Words in a task that name a surface someone LOOKS at. Whole words, any case. */
const VISUAL_WORDS = /\b(?:page|site|web|html|css|ui|screen|component|react|vue|svelte|frontend|browser|button|layout|responsive|style|game|canvas|picture|image|icon|logo|design)\b/i;

/** Top-level entries that mean the folder renders something. */
const VISUAL_FILE = /\.(?:html|css|jsx|tsx|vue|svelte)$/i;
const VISUAL_CONFIG = /^(?:vite|next)\.config\.[a-z0-9]+$/i;
const VISUAL_DIRS = new Set(["public", "src/components"]);

/**
 * Does this run have a face — something a browser or a picture would check?
 *
 * The task mentions a visual surface (VISUAL_WORDS), or the working folder's
 * top-level entries include a page, a stylesheet, a component, a front-end
 * build config, `public/` or `src/components`. Entries are names as
 * `folderEntries` lists them (folders with a trailing slash); a trailing slash
 * is optional here. Deliberately generous: a false yes costs today's tokens, a
 * false no costs a run the tools it needed.
 */
export function looksVisual(task: string, entries: readonly string[]): boolean {
  if (VISUAL_WORDS.test(task)) return true;
  return entries.some((entry) => {
    const name = entry.replace(/\/+$/, "");
    return VISUAL_FILE.test(name) || VISUAL_CONFIG.test(name) || VISUAL_DIRS.has(name.toLowerCase());
  });
}
