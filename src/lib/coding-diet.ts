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
 * - `brief`: "full" is the original HEADLESS_BRIEF; "lean" is LEAN_HEADLESS_BRIEF —
 *   every rule that prevents a real failure, said in as few words as possible,
 *   with the browser/visual sentences split into a block of their own.
 * - `helpers`: "always" is the original delegation sentence (explorer before every
 *   edit, tester after each batch, reviewer before the report); "lean" says to
 *   run the checks in the run's own shell and to use the helpers only where
 *   they pay for themselves.
 * - `visualTools`: "always" gives every run the browser and media tools, as
 *   before the diet; "auto" gives them only to a run whose task or folder looks visual
 *   (`looksVisual`), decided ONCE per run and frozen on its record.
 *
 * Two baselines, never to be confused:
 * - DEFAULT_DIET (lean / lean / auto) is what the owner's SETTING reads as when
 *   nothing is stored — the defaults since TASK-1749's measurement on
 *   bench/diet (2026-10-18), so a new run on a box that never set the diet
 *   gets the lean brief, the lean helper sentence and the visual decision.
 * - LEGACY_DIET (full / always / always) is the behaviour before the diet
 *   existed: what a run RECORD without a `diet` field, and buildRunArgs or
 *   headlessBrief called without one, still mean — so a resume of a run started
 *   before the change keeps its prompt byte for byte (pinned by
 *   coding-agent-diet.test.ts).
 *
 * Pure: no fs, no config store — the reader, the patch validator and the
 * heuristic, so the route, the runner and the tests read one rule.
 */

export const DIET_BRIEF_MODES = ["full", "lean"] as const;
export const DIET_HELPER_MODES = ["always", "lean"] as const;
export const DIET_VISUAL_TOOL_MODES = ["always", "auto"] as const;
export const DIET_CONTEXT_MODES = ["full", "capped"] as const;

export type DietBrief = (typeof DIET_BRIEF_MODES)[number];
export type DietHelpers = (typeof DIET_HELPER_MODES)[number];
export type DietVisualTools = (typeof DIET_VISUAL_TOOL_MODES)[number];
export type DietContext = (typeof DIET_CONTEXT_MODES)[number];

export interface CodingDiet {
  brief: DietBrief;
  helpers: DietHelpers;
  visualTools: DietVisualTools;
  /**
   * "capped": Claude Code compacts the conversation once it nears
   * CONTEXT_CAP_WINDOW tokens. On a 1M-token model ("full") its automatic
   * compaction effectively never runs, so a long run re-sends a context of
   * 150–200k tokens on every turn.
   */
  context: DietContext;
}

/** The compaction window a "capped" run is given (CLAUDE_CODE_AUTO_COMPACT_WINDOW). */
export const CONTEXT_CAP_WINDOW = 128_000;

/**
 * The behaviour before the diet existed, on every knob: what a run record
 * written without a `diet` field — and a prompt built without one — means.
 */
export const LEGACY_DIET: Readonly<CodingDiet> = Object.freeze({ brief: "full", helpers: "always", visualTools: "always", context: "full" });

/**
 * The owner's setting when nothing is stored (TASK-1749): measured on
 * bench/diet (2026-10-18), the lean brief, the lean helper sentence and the
 * per-run visual decision did the same work for fewer tokens.
 */
export const DEFAULT_DIET: Readonly<CodingDiet> = Object.freeze({ brief: "lean", helpers: "lean", visualTools: "auto", context: "full" });

const ALLOWED: { readonly [K in keyof CodingDiet]: readonly CodingDiet[K][] } = {
  brief: DIET_BRIEF_MODES,
  helpers: DIET_HELPER_MODES,
  visualTools: DIET_VISUAL_TOOL_MODES,
  context: DIET_CONTEXT_MODES,
};

const DIET_KEYS = Object.keys(ALLOWED) as (keyof CodingDiet)[];

function pick<K extends keyof CodingDiet>(key: K, value: unknown, fallback: Readonly<CodingDiet>): CodingDiet[K] {
  return (ALLOWED[key] as readonly unknown[]).includes(value) ? (value as CodingDiet[K]) : fallback[key];
}

/**
 * A stored setting or a run record's frozen value, read strictly and never
 * thrown on: anything that is not an object is `fallback`, and each field this
 * build does not recognise falls back to ITS value in `fallback` alone.
 *
 * The fallback is explicit because the two callers mean different things: the
 * owner's stored SETTING falls back to DEFAULT_DIET (the lean defaults), a run
 * RECORD to LEGACY_DIET — a record written before the field existed was
 * started with the full prompt, and its resumes must keep it.
 */
export function readDiet(raw: unknown, fallback: Readonly<CodingDiet>): CodingDiet {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...fallback };
  const o = raw as Record<string, unknown>;
  return {
    brief: pick("brief", o.brief, fallback),
    helpers: pick("helpers", o.helpers, fallback),
    visualTools: pick("visualTools", o.visualTools, fallback),
    context: pick("context", o.context, fallback),
  };
}

/** True when every knob is at the setting's default (DEFAULT_DIET). */
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
    return { ok: false, code: "diet_not_object", error: "The diet must be an object: { brief?, helpers?, visualTools?, context? }." };
  }
  const patch: Partial<CodingDiet> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(DIET_KEYS as string[]).includes(key)) {
      return { ok: false, code: "diet_unknown_key", error: `The diet has no setting "${key.slice(0, 40)}": use brief, helpers, visualTools or context.` };
    }
    const k = key as keyof CodingDiet;
    if (!(ALLOWED[k] as readonly unknown[]).includes(value)) {
      return { ok: false, code: "diet_invalid_value", error: `The diet's ${k} must be one of: ${ALLOWED[k].join(", ")}.` };
    }
    (patch as Record<string, unknown>)[k] = value;
  }
  return { ok: true, patch };
}

/**
 * A validated patch merged over what is stored — or over DEFAULT_DIET when
 * nothing is, so a partial patch on a fresh box keeps the other knobs lean.
 */
export function mergeDiet(stored: unknown, patch: Partial<CodingDiet>): CodingDiet {
  return readDiet({ ...readDiet(stored, DEFAULT_DIET), ...patch }, DEFAULT_DIET);
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
const VISUAL_WORDS = /\b(?:page|site|web|website|webpage|homepage|landing|dashboard|widget|navbar|storefront|blog|portfolio|svg|animation|html|css|ui|screen|component|react|vue|svelte|frontend|browser|button|layout|responsive|style|game|canvas|picture|image|icon|logo|design)\b/i;

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
 * is optional here. Deliberately generous: a false yes costs the tools' tokens, a
 * false no costs a run the tools it needed.
 */
export function looksVisual(task: string, entries: readonly string[]): boolean {
  if (VISUAL_WORDS.test(task)) return true;
  return entries.some((entry) => {
    const name = entry.replace(/\/+$/, "");
    return VISUAL_FILE.test(name) || VISUAL_CONFIG.test(name) || VISUAL_DIRS.has(name.toLowerCase());
  });
}
