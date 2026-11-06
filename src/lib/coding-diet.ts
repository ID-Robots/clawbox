/**
 * Two pure judgements about a coding run, shared by the runner and the tests
 * so each reads one rule:
 *
 * - `looksVisual`: does the run have a face? A run judged not visual holds
 *   neither the clawbox MCP server's browser family nor the media tools, and
 *   its brief has no browser block — decided ONCE per run at its first spawn
 *   (`decideRunVisual`) and frozen on its record (CodingRun.visual).
 * - `mentionsPullRequest`: the brief carries the auto-merge sentence only for
 *   a run that can open a pull request or was asked about one.
 *
 * What is left of the token diet (TASK-1749). Measured on a Jetson box
 * (DeepSeek through claude-ds, first-turn context): a full run 16,677 tokens;
 * without the appended brief 13,975 (the brief was ~2.7k); without the
 * browser and media tools 14,375 (~2.3k) — and every turn carries that again.
 * The diet's knobs (a full or lean brief, an always-delegate or lean helper
 * sentence, a context cap, always-on visual tools) were measured and deleted:
 * the lean brief, the lean helper sentence and the per-run visual decision
 * are the only behaviour now (docs/agents/coding-agent.md keeps the numbers).
 *
 * Pure: no fs, no config store.
 */

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
