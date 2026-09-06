/**
 * What one line of a coding run's progress feed MEANS, for a card to draw.
 *
 * The run record's `progress` is written by the runner (coding-agent.ts,
 * pushProgress) in the vocabulary of the harness: a tool_use block becomes its
 * tool's name — "Write style.css", "$ node --check app.js",
 * "mcp__clawbox__browser_screenshot" — and a text block is the agent's own
 * sentence. The Coding Agent app can print that as-is; the chat card cannot.
 * "mcp__clawbox__browser_screenshot" on a chip in the owner's chat is the
 * harness leaking through, and the owner asked for it to be a good-looking
 * element instead. This module is the one place that translation lives, so the
 * card and its tests agree on it and the raw `mcp__` name can never be shown.
 *
 * Pure: a string in, a description out, nothing read from the device. The
 * English `label` is a fallback; a card with translations picks the locale's
 * word by `labelKey` and shows `detail` (a file name, a command) verbatim.
 */

export type ProgressKind = "tool" | "file" | "command" | "text";

/**
 * The translated label a chip wants. A card maps these through the labels it
 * is handed (see CodingAgentActivityPill) rather than translating here, which
 * keeps this module free of the i18n context and testable as a function.
 */
export type ProgressLabelKey =
  | "screenshot"
  | "lookingAtPage"
  | "openingPage"
  | "drivingPage"
  | "closingPage"
  | "write"
  | "edit"
  | "read"
  | "plan"
  // The runner's OWN sentences (RUNNER_STEP below). They used to reach the
  // timeline as the English the runner wrote, so a German run page read
  // "Started with deepseek-v4-pro[1m]" and "Thinking…" beside the translated
  // "Liest store.ts". A key each, so the surface can word them.
  | "started"
  | "startedWith"
  | "continuing"
  | "thinking"
  | "tokenLimit"
  | "subagentStarted"
  | "subagentFinished"
  | "subagentRefused"
  | "workflowStarted"
  | "workflowFinished"
  | "workflowRefused"
  | "reviewPass"
  | "resuming"
  | "startingFresh"
  | "noRepository"
  | "workingOnBranch"
  | "noPullRequest"
  | "committed"
  | "committedNewRepository"
  | "committedByRun"
  | "notCommitted"
  | "faviconCommitted"
  | "pullRequestOpened"
  | "merged"
  | "notMerged"
  | "onDesktop"
  | "notOnDesktop"
  | "providerSilent"
  | "paused"
  | "finished"
  | "stopRequested"
  | "pauseRequested"
  | "resumedByOwner"
  | "drafted"
  | "startedFromDraft"
  | "leftoverRunning"
  | "endedLeftovers"
  | "ownerEndedLeftovers"
  | "droppedSteps";

export interface ProgressDescription {
  kind: ProgressKind;
  /** English rendering of the step; the card prefers its own copy for `labelKey`. */
  label: string;
  /** A Material Symbols Rounded glyph name — the app ships the full font. */
  icon: string;
  /** The file, the command, the search pattern — shown after the label, never translated. */
  detail?: string;
  labelKey?: ProgressLabelKey;
  /**
   * The plan chip's numbers, for the card to say in the owner's language
   * ("3/7 erledigt"). Numbers rather than a `detail`, because a detail is
   * shown verbatim and the runner's "7 tasks, 3 done" is English.
   */
  counts?: { total: number; done: number };
  /**
   * What fills the placeholders of `labelKey`'s translation — a model name, a
   * sha, a branch. Separate from `detail` because a translated sentence puts
   * its values INSIDE the words ("Auf {branch} für…"), where a detail can only
   * follow them; `label` is the same sentence already filled in, in English,
   * for a surface with no translation for the key.
   */
  params?: Record<string, string | number>;
}

/**
 * The clawbox browser family a run can call (mcp/tools/browser.ts), grouped
 * the way the owner reads them: looking, opening, driving. `browser_open` and
 * `browser_navigate` both put a page on screen; click/type/keypress/scroll
 * are all "the run is working the page" — the difference between a click and
 * a keypress is noise at chat-card size.
 */
const BROWSER_TOOLS: Record<string, { labelKey: ProgressLabelKey; label: string; icon: string }> = {
  browser_screenshot: { labelKey: "screenshot", label: "Screenshot", icon: "photo_camera" },
  browser_view_local: { labelKey: "lookingAtPage", label: "Looking at the page", icon: "visibility" },
  browser_open: { labelKey: "openingPage", label: "Opening a page", icon: "open_in_browser" },
  browser_navigate: { labelKey: "openingPage", label: "Opening a page", icon: "open_in_browser" },
  browser_click: { labelKey: "drivingPage", label: "Driving the page", icon: "touch_app" },
  browser_type: { labelKey: "drivingPage", label: "Driving the page", icon: "touch_app" },
  browser_keypress: { labelKey: "drivingPage", label: "Driving the page", icon: "touch_app" },
  browser_scroll: { labelKey: "drivingPage", label: "Driving the page", icon: "touch_app" },
  browser_close: { labelKey: "closingPage", label: "Closing the page", icon: "close" },
};

/** The file tools the runner names by verb + path (Read is named the same way). */
const FILE_TOOLS: Record<string, { labelKey: ProgressLabelKey; label: string; icon: string }> = {
  Write: { labelKey: "write", label: "Writing", icon: "edit_document" },
  Edit: { labelKey: "edit", label: "Editing", icon: "edit" },
  NotebookEdit: { labelKey: "edit", label: "Editing", icon: "edit" },
  Read: { labelKey: "read", label: "Reading", icon: "description" },
};

/**
 * "Plan: 7 tasks, 3 done" — the runner's one-line note that the run rewrote
 * its TodoWrite list. The list itself is on the record (the card draws it as a
 * checklist); the chip only marks WHEN the plan changed. The two numbers are
 * lifted out as `counts` and the English words dropped: with them as a
 * `detail`, a German card read "Aufgaben 7 tasks, 3 done" — the one chip in
 * the wrong language.
 */
const PLAN_RE = /^Plan: (\d+) tasks?, (\d+) done$/;

/** A tool name as the harness reports it: `mcp__<server>__<tool>` or bare. */
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9-]+__([A-Za-z0-9_]+)$/;
const BARE_TOOL_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** Where every run's folder lives on the box; a command echoing it is all noise. */
const DEVICE_PREFIX = "/home/clawbox/clawbox/";
/** A chip's width, roughly — a longer command is cut with an ellipsis. */
const MAX_COMMAND_CHARS = 60;

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function shorten(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── The runner's own sentences ───────────────────────────────────────────────

/**
 * Every fixed line the runner (coding-agent.ts) writes into a run's progress
 * feed, written HERE so the reader below can never drift from the writer.
 *
 * They lived as English literals at their thirty-odd call sites, and the run
 * page drew them verbatim: a German desktop read "Started with
 * deepseek-v4-pro[1m]", "Thinking…" and "Committed as 4f21a…" beside chips
 * that were properly translated. A surface can only word a step in the
 * owner's language if it can tell WHICH step it is, and the only handle on a
 * line is its text — so a reworded sentence here would silently stop matching
 * and fall back to English, which is why the two halves are one module and
 * one test pins them together.
 *
 * The wording is frozen for a second reason: runs already on disk carry these
 * exact strings, and the reader has to go on recognising them.
 */
export const RUNNER_STEP = {
  thinking: "Thinking…",
  continuing: "Continuing after a background helper finished",
  tokenLimit: "Token limit reached",
  resuming: "Resuming the previous session",
  noRepository:
    "Not a git repository yet: the work is committed into a new one when the run settles, and there is no pull request to open.",
  merged: "Merged into the base branch",
  providerSilent: "The provider did not answer; starting over in a fresh session",
  paused: "Paused — resume to continue",
  stopRequested: "Stop requested",
  pauseRequested: "Pause requested",
  resumedByOwner: "Resumed by the owner",
  drafted: "Drafted — start it when ready",
  startedFromDraft: "Started from a draft",
  leftoverRunning:
    "Something this run started is still running — a server it left listening? The run's page can end it.",
  endedLeftovers: "Ended what the run had left running",
  ownerEndedLeftovers: "The owner ended what the run had left running",

  started: (model: string | null | undefined) => (model ? `Started with ${model}` : "Started"),
  reviewPass: (id: string) => `Automatic review pass of ${id}`,
  startingFresh: (id: string) => `Starting fresh: ${id} did not fail in a way a resume can fix`,
  workingOnBranch: (branch: string, base: string) => `Working on ${branch}, for a pull request into ${base}`,
  noPullRequest: (reason: string) => `No pull request: ${reason}`,
  committed: (sha: string, newRepository: boolean) => `Committed as ${sha}${newRepository ? " (new repository)" : ""}`,
  committedByRun: (sha: string) => `Committed by the run itself as ${sha}`,
  notCommitted: (reason: string) => `Not committed: ${reason}`,
  faviconCommitted: (sha: string) => `Added the generated favicon, committed as ${sha}`,
  // `base` is the run record's, which the type allows to be null; rendered the
  // way the template literal it replaced rendered it, so a record already on
  // disk still matches.
  pullRequestOpened: (num: number, base: string | null) => `Opened pull request #${num} into ${base}`,
  notMerged: (reason: string) => `Not merged: ${reason}`,
  onDesktop: (name: string, id: string, port: number) => `On the desktop as "${name}", served at /apps/${id}/ from port ${port}`,
  notOnDesktop: (port: number, reason: string) => `Not on the desktop yet: clawbox.json names port ${port}, but ${reason}`,
  finished: (status: string) => `Finished: ${status}`,
  /** A helper going out: the type in parentheses, its own description after a colon. */
  helperStarted: (opts: { workflow: boolean; type: string; what: string }) =>
    opts.workflow
      ? `Workflow started${opts.what ? `: ${opts.what}` : ""}`
      : `Sub-agent started${opts.type ? ` (${opts.type})` : ""}${opts.what ? `: ${opts.what}` : ""}`,
  /** A helper back: "sub-agent" is the untyped one, and naming its type twice reads as noise. */
  helperSettled: (opts: { workflow: boolean; type: string; refused: boolean }) => {
    const noun = opts.workflow ? "Workflow" : "Sub-agent";
    const kind = opts.workflow || opts.type === "sub-agent" ? "" : ` (${opts.type})`;
    return `${noun} ${opts.refused ? "refused" : "finished"}${kind}`;
  },
  /**
   * The one line that stands where a long run's middle steps were dropped.
   * It is a STEP in the feed rather than a flag on the record because the
   * record's `progress` is the only thing the surfaces are handed, and a gap
   * nothing marks is a run whose history quietly lies.
   */
  dropped: (count: number) => `… ${count} earlier steps are not kept`,
} as const;

/** One recognisable runner sentence: what it looks like, and what it means. */
interface RunnerPattern {
  re: RegExp;
  labelKey: ProgressLabelKey;
  icon: string;
  /** The translation's placeholders, filled from the captures. */
  params?: (m: RegExpExecArray) => Record<string, string | number>;
  /** A capture shown verbatim after the label — a type name, never a sentence. */
  detail?: (m: RegExpExecArray) => string | undefined;
}

/**
 * The reader for RUNNER_STEP. Ordered: nothing here overlaps, but a pattern
 * that could swallow another must come after it.
 */
const RUNNER_PATTERNS: RunnerPattern[] = [
  { re: /^Started$/, labelKey: "started", icon: "play_arrow" },
  // The model id, never a sentence: an agent text block that opens "Started
  // with a look at the tests" is the run's own words, not this step.
  { re: /^Started with (\S+)$/, labelKey: "startedWith", icon: "play_arrow", params: (m) => ({ model: m[1] }) },
  { re: /^Continuing after a background helper finished$/, labelKey: "continuing", icon: "sync" },
  { re: /^Thinking…$/, labelKey: "thinking", icon: "psychology" },
  { re: /^Token limit reached$/, labelKey: "tokenLimit", icon: "hourglass_disabled" },
  {
    re: /^Sub-agent started(?: \(([^)]*)\))?(?::\s*(.*))?$/,
    labelKey: "subagentStarted",
    icon: "group_add",
    detail: (m) => [m[1] ? `(${m[1]})` : "", m[2] ?? ""].filter(Boolean).join(" ") || undefined,
  },
  { re: /^Sub-agent finished(?: \(([^)]*)\))?$/, labelKey: "subagentFinished", icon: "group", detail: (m) => m[1] },
  { re: /^Sub-agent refused(?: \(([^)]*)\))?$/, labelKey: "subagentRefused", icon: "block", detail: (m) => m[1] },
  { re: /^Workflow started(?::\s*(.*))?$/, labelKey: "workflowStarted", icon: "account_tree", detail: (m) => m[1] || undefined },
  { re: /^Workflow finished$/, labelKey: "workflowFinished", icon: "account_tree" },
  { re: /^Workflow refused$/, labelKey: "workflowRefused", icon: "block" },
  { re: /^Automatic review pass of (\S+)$/, labelKey: "reviewPass", icon: "rate_review", params: (m) => ({ id: m[1] }) },
  { re: /^Resuming the previous session$/, labelKey: "resuming", icon: "history" },
  { re: /^Starting fresh: (\S+) did not fail in a way a resume can fix$/, labelKey: "startingFresh", icon: "restart_alt", params: (m) => ({ id: m[1] }) },
  { re: /^Not a git repository yet: .*$/, labelKey: "noRepository", icon: "folder_off" },
  { re: /^Working on (.+), for a pull request into (.+)$/, labelKey: "workingOnBranch", icon: "call_split", params: (m) => ({ branch: m[1], base: m[2] }) },
  { re: /^No pull request: (.+)$/, labelKey: "noPullRequest", icon: "block", params: (m) => ({ reason: m[1] }) },
  { re: /^Committed as (\S+) \(new repository\)$/, labelKey: "committedNewRepository", icon: "commit", params: (m) => ({ sha: m[1] }) },
  { re: /^Committed as (\S+)$/, labelKey: "committed", icon: "commit", params: (m) => ({ sha: m[1] }) },
  { re: /^Committed by the run itself as (\S+)$/, labelKey: "committedByRun", icon: "commit", params: (m) => ({ sha: m[1] }) },
  { re: /^Not committed: (.+)$/, labelKey: "notCommitted", icon: "error", params: (m) => ({ reason: m[1] }) },
  { re: /^Added the generated favicon, committed as (\S+)$/, labelKey: "faviconCommitted", icon: "commit", params: (m) => ({ sha: m[1] }) },
  { re: /^Opened pull request #(\d+) into (.+)$/, labelKey: "pullRequestOpened", icon: "merge", params: (m) => ({ number: Number(m[1]), base: m[2] }) },
  { re: /^Merged into the base branch$/, labelKey: "merged", icon: "merge" },
  { re: /^Not merged: (.+)$/, labelKey: "notMerged", icon: "error", params: (m) => ({ reason: m[1] }) },
  { re: /^On the desktop as "(.*)", served at \/apps\/(\S+)\/ from port (\d+)$/, labelKey: "onDesktop", icon: "desktop_windows", params: (m) => ({ name: m[1], id: m[2], port: Number(m[3]) }) },
  { re: /^Not on the desktop yet: clawbox\.json names port (\d+), but (.+)$/, labelKey: "notOnDesktop", icon: "error", params: (m) => ({ port: Number(m[1]), reason: m[2] }) },
  { re: /^The provider did not answer; starting over in a fresh session$/, labelKey: "providerSilent", icon: "sync_problem" },
  { re: /^Paused — resume to continue$/, labelKey: "paused", icon: "pause" },
  { re: /^Finished: (\w+)$/, labelKey: "finished", icon: "flag", params: (m) => ({ status: m[1] }) },
  { re: /^Stop requested$/, labelKey: "stopRequested", icon: "stop_circle" },
  { re: /^Pause requested$/, labelKey: "pauseRequested", icon: "pause_circle" },
  { re: /^Resumed by the owner$/, labelKey: "resumedByOwner", icon: "play_circle" },
  { re: /^Drafted — start it when ready$/, labelKey: "drafted", icon: "draft" },
  { re: /^Started from a draft$/, labelKey: "startedFromDraft", icon: "play_arrow" },
  { re: /^Something this run started is still running .*$/, labelKey: "leftoverRunning", icon: "dns" },
  { re: /^Ended what the run had left running$/, labelKey: "endedLeftovers", icon: "power_settings_new" },
  { re: /^The owner ended what the run had left running$/, labelKey: "ownerEndedLeftovers", icon: "power_settings_new" },
  { re: /^… (\d+) earlier steps are not kept$/, labelKey: "droppedSteps", icon: "more_horiz", params: (m) => ({ count: Number(m[1]) }) },
];

export function describeProgressLine(raw: string): ProgressDescription {
  const line = (raw ?? "").replace(/\s+/g, " ").trim();

  // "$ node --check …" — the runner's own prefix for a Bash tool_use.
  if (line.startsWith("$")) {
    const command = line.slice(1).trim().split(DEVICE_PREFIX).join("");
    return { kind: "command", label: shorten(command, MAX_COMMAND_CHARS), icon: "terminal" };
  }

  // "Write style.css" / "Edit src/app.js" / "Read index.html" / a bare "Write"
  // when the run passed no path (the runner writes the verb and nothing else).
  const fileMatch = /^(Write|Edit|NotebookEdit|Read)(?:\s+(.*))?$/.exec(line);
  if (fileMatch) {
    const tool = FILE_TOOLS[fileMatch[1]];
    const target = (fileMatch[2] ?? "").trim();
    return {
      kind: "file",
      label: tool.label,
      labelKey: tool.labelKey,
      icon: tool.icon,
      ...(target ? { detail: basename(target) } : {}),
    };
  }

  const plan = PLAN_RE.exec(line);
  if (plan) {
    return {
      kind: "tool",
      label: "Plan",
      labelKey: "plan",
      icon: "checklist",
      counts: { total: Number(plan[1]), done: Number(plan[2]) },
    };
  }

  // A tool called by name and nothing else: the MCP form the harness reports
  // ("mcp__clawbox__browser_screenshot") or the bare name.
  const mcp = MCP_TOOL_RE.exec(line);
  const toolName = mcp ? mcp[1] : BARE_TOOL_RE.test(line) ? line : null;
  if (toolName) {
    const known = BROWSER_TOOLS[toolName];
    if (known) return { kind: "tool", ...known };
    // Not one of ours — still never the raw mcp__ name; the tool's own words
    // with the underscores taken out is the most honest label left.
    return { kind: "tool", label: toolName.replace(/_/g, " "), icon: "extension" };
  }

  // The runner's own vocabulary, last: a sentence the agent happens to write
  // that reads like one of these is drawn the same way either way, while an
  // agent sentence that merely STARTS with "Read" must not become a file step
  // — which is why the file verbs above are anchored and these are too.
  for (const p of RUNNER_PATTERNS) {
    const m = p.re.exec(line);
    if (!m) continue;
    const detail = p.detail?.(m);
    return {
      // Not a kind of its own: `ProgressDescription["kind"]` picks the chip's
      // tone on three surfaces, and these have always been drawn as the run's
      // own words. Only the wording changes here, never the look.
      kind: "text",
      // The English the runner wrote, kept as the floor for a surface with no
      // translation for `labelKey` — a locale pack that predates the key, or
      // the chat card, which words only the tool chips.
      label: line,
      icon: p.icon,
      labelKey: p.labelKey,
      ...(p.params ? { params: p.params(m) } : {}),
      ...(detail ? { detail } : {}),
    };
  }

  return { kind: "text", label: line, icon: "notes" };
}

// ── How far along a run is, honestly ─────────────────────────────────────────

export interface RunProgressEstimate {
  /** 0..1, or null when there is nothing honest to draw. */
  fraction: number | null;
  /** Milliseconds the run likely still needs, or null when unknowable. */
  etaMs: number | null;
}

/**
 * A fraction and a remaining-time guess for a run card's progress bar.
 *
 * One basis: the run's own TodoWrite plan. The agent said what it intends to
 * do, and done-over-planned is real progress. A steps-over-ceiling fallback
 * was tried and withdrawn: the live event count measured ~7x the CLI's own
 * turn number (291 events vs 38 turns, run-5vt51ppv), so a bar drawn from it
 * lied. No plan, no bar.
 *
 * The ETA extrapolates elapsed time through the fraction and is suppressed
 * early (fraction < 0.1) where extrapolation is mostly noise. Pure: the
 * caller passes `now`, so a card can tick and a test can pin values.
 */
export function estimateRunProgress(
  run: {
    status: string;
    startedAt: number;
    todos?: { status?: string }[];
  },
  now: number,
): RunProgressEstimate {
  if (run.status !== "running") {
    return { fraction: run.status === "completed" ? 1 : null, etaMs: null };
  }
  const todos = run.todos ?? [];
  if (todos.length < 2) return { fraction: null, etaMs: null };
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.filter((t) => t.status === "in_progress").length;
  // Visible but never finished-looking while alive.
  const fraction = Math.min(0.97, Math.max(0.02, (done + active * 0.5) / todos.length));
  const elapsed = Math.max(0, now - run.startedAt);
  const etaMs = fraction >= 0.1 && elapsed > 30_000
    ? Math.round((elapsed * (1 - fraction)) / fraction)
    : null;
  return { fraction, etaMs };
}

/** "≈ 12 min left" material: a compact minutes/hours word, never seconds-precise. */
export function formatEta(etaMs: number): string {
  const min = Math.max(1, Math.round(etaMs / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}
