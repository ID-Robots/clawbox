/**
 * The title and body of the pull request the box opens for a run (TASK-1366).
 *
 * Pure, so everything that reaches GitHub can be pinned by a test: the runner
 * (./coding-agent) hands in the run's facts and the owner's setting, and gets
 * back text that has already been through `redactForPublishing`. The `gh` door
 * in ./coding-pr redacts once more, because it is the one place that calls
 * `gh pr create` and it must not depend on every caller remembering to.
 *
 * HOW MUCH OF THE TASK GOES IN — the owner's `coding_agent_pr_body_includes_task`:
 *   - "summary" (the default): a task that fits in PR_TASK_EXCERPT_CHARS goes
 *     in whole; a longer one becomes a one-line summary (its first line) and
 *     its first ~600 characters, quoted, with a line saying it was shortened.
 *     A brief that runs to pages is the box's input, not the reviewer's.
 *   - "full-redacted": the whole task, as every pull request carried it before
 *     this setting existed — redacted.
 *   - "none": no task at all. The title is still the task's first line,
 *     redacted: a pull request has to be called something.
 *
 * Redacted BEFORE it is cut, never after: a cut first could split a token or an
 * address so that the half that is left no longer matches its rule.
 */
import { redactForPublishing, type PublishRedactionOptions } from "./publish-redaction";
import { taskTitle } from "./task-title";

export const PR_BODY_TASK_MODES = ["summary", "full-redacted", "none"] as const;
export type PrBodyTaskMode = (typeof PR_BODY_TASK_MODES)[number];
export const DEFAULT_PR_BODY_TASK_MODE: PrBodyTaskMode = "summary";

export function isPrBodyTaskMode(value: unknown): value is PrBodyTaskMode {
  return typeof value === "string" && (PR_BODY_TASK_MODES as readonly string[]).includes(value);
}

/** A stored value as the runner reads it: absent or unknown is the default. */
export function prBodyTaskModeFrom(value: unknown): PrBodyTaskMode {
  return isPrBodyTaskMode(value) ? value : DEFAULT_PR_BODY_TASK_MODE;
}

/** How much of a long task the "summary" body quotes. */
export const PR_TASK_EXCERPT_CHARS = 600;
/** What a PR title holds; the same 72 the title always had. */
const PR_TITLE_CHARS = 72;
/** The one-line summary above a shortened task. */
const SUMMARY_LINE_CHARS = 120;
const PR_TITLE_FALLBACK = "ClawBox coding agent";

/** The task's first line, redacted, as a pull request title. */
export function pullRequestTitle(task: string, options: PublishRedactionOptions = {}): string {
  return taskTitle(redactForPublishing(task ?? "", options), PR_TITLE_CHARS) || PR_TITLE_FALLBACK;
}

/**
 * The first `max` characters of an already-redacted text, cut where a reader
 * would cut it: at the last whitespace when there is one in the final fifth (a
 * word cut in half reads as a typo), never through half a surrogate pair, and
 * never through a placeholder — a `<private-` left at the end reads as a broken
 * tag rather than as something taken out.
 */
function excerptOf(text: string, max: number): string {
  let cut = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.search(/\s\S*$/);
  if (space >= Math.floor(max * 0.8)) cut = cut.slice(0, space);
  cut = cut.replace(/<[a-z-]*$/, "");
  return `${cut.trimEnd()}…`;
}

/**
 * The "**Task**" block for one mode, as lines — empty for "none" and for a task
 * with nothing in it.
 *
 * The shortened task is QUOTED, line by line, so whatever Markdown the cut left
 * open — a code fence, a list — closes with the quote instead of swallowing
 * the run line and the summary under it.
 */
export function taskSection(task: string, mode: PrBodyTaskMode, options: PublishRedactionOptions = {}): string[] {
  if (mode === "none") return [];
  const redacted = redactForPublishing(task ?? "", options).trim();
  if (!redacted) return [];
  if (mode === "full-redacted" || redacted.length <= PR_TASK_EXCERPT_CHARS) return ["**Task**", redacted];
  const summary = taskTitle(redacted, SUMMARY_LINE_CHARS) || PR_TITLE_FALLBACK;
  const quoted = excerptOf(redacted, PR_TASK_EXCERPT_CHARS)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"));
  return [
    "**Task**",
    summary,
    "",
    ...quoted,
    "",
    `_Shortened to its first ${PR_TASK_EXCERPT_CHARS} characters; the full task stays on the device._`,
  ];
}

export interface PullRequestBodyInput {
  task: string;
  runId: string;
  commit: string | null;
  /** The review pass that looked at the work last, or null when none did. */
  reviewRunId: string | null;
  /** What the run said it did. Redacted, never shortened. */
  summary: string | null;
  taskMode: PrBodyTaskMode;
}

/**
 * The body, without the evidence block (the runner adds that, redacted, through
 * `withEvidenceSection` — its pictures are read from disk at the moment the
 * body is written).
 */
export function composePullRequestBody(input: PullRequestBodyInput, options: PublishRedactionOptions = {}): string {
  const task = taskSection(input.task, input.taskMode, options);
  const lines = [
    "Opened by the ClawBox coding agent.",
    ...(task.length > 0 ? ["", ...task] : []),
    "",
    `Run \`${input.runId}\`${input.commit ? ` · commit \`${input.commit}\`` : ""}`,
  ];
  if (input.reviewRunId) lines.push(`Reviewed by run \`${input.reviewRunId}\` (automatic review pass).`);
  const summary = input.summary ? redactForPublishing(input.summary, options).trim() : "";
  if (summary) lines.push("", "**Summary**", summary);
  // Once more over the whole: every piece above was redacted on its own, and
  // this is what makes that a property of the body rather than of each line.
  return redactForPublishing(lines.join("\n"), options);
}
