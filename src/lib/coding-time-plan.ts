/**
 * The planning rules a budgeted run or team works by — what may fill spare
 * time, how an estimate is read, when a task is behind, what to cut when the
 * time is short, and whether the next item may start at all.
 *
 * Pure, like coding-time-budget.ts beside it: no fs, no clock of its own —
 * every check takes the caller's `now` (box time, server Date.now). The runner
 * and the team enforce these on the server; the prompts only explain them. One
 * set of rules, so what the planner is told and what the server lets through
 * cannot disagree.
 */
import {
  budgetStopReason,
  fitsBeforeCutoff,
  formatDuration,
  marginCutoffMs,
  MAX_BUDGET_MS,
  MINUTE_MS,
  parseDuration,
  type TimeBudget,
  type TimeRecord,
  type TimeRecordSummary,
} from "@/lib/coding-time-budget";

type Now = Date | number;

const nowMs = (now: Now): number => (typeof now === "number" ? now : now.getTime());

/** A positive, finite number of ms — what every estimate and need here must be to count. */
const isPositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ─── Extra work ──────────────────────────────────────────────────────────────

/**
 * What a run that finished early may spend the rest of its budget on — the
 * allowlist, and nothing beside it: more tests, fixes to what it built, the
 * edge cases it skipped, the docs for it, and checking it again.
 */
export const EXTRA_WORK_KINDS = ["tests", "fixes", "edge_cases", "docs", "verify"] as const;
export type ExtraWorkKind = (typeof EXTRA_WORK_KINDS)[number];

/** The most files one extra item may name: one item is one small step, not a sweep. */
export const MAX_EXTRA_FILES = 50;
/** The longest summary an extra claim keeps. */
export const MAX_EXTRA_SUMMARY_CHARS = 200;
/** Only this much of a line is read for a claim. */
const MAX_CLAIM_LINE_CHARS = 1_000;
/** What one extra item is planned to take: none starts unless this much is left before the safety margin. */
export const EXTRA_ITEM_ESTIMATE_MS = 5 * MINUTE_MS;
/** The most extra items one run or team does, however much time is left: spare time is bounded work, not a second task. */
export const MAX_EXTRA_ITEMS = 8;
/** The most scope entries an extra-work prompt lists; the server checks against all of them. */
const MAX_SCOPE_SHOWN = 30;
/** Where a repo keeps its tests and docs: extra work may add to them as well as to the task's own files. */
export const EXTRA_SCOPE_DIRS = ["test/", "tests/", "__tests__/", "spec/", "docs/"] as const;
/** A repo's own top-level notes, which "docs for the change" may touch. */
const EXTRA_SCOPE_ROOT_DOCS = ["README.md", "CHANGELOG.md"] as const;
/** A test or a doc file by its name: "app.test.ts", "app_spec.rb", "test_app.py", "NOTES.md". */
const TEST_OR_DOC_FILE_RE = /(?:[._-](?:test|spec)\.[A-Za-z0-9]+$|^test_[^/]+$|\.(?:md|mdx|rst|txt)$)/u;

/** "Edge cases", "edge-cases", "EDGE_CASES" → "edge_cases"; anything not on the allowlist → null. */
export function readExtraKind(raw: unknown): ExtraWorkKind | null {
  if (typeof raw !== "string") return null;
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (EXTRA_WORK_KINDS as readonly string[]).includes(k) ? (k as ExtraWorkKind) : null;
}

/**
 * A repo-relative path in one spelling — "./src//a.ts" is "src/a.ts" — or
 * null for one that is not inside the repo at all: absolute, a drive letter,
 * a `..` segment, a NUL. A trailing "/" (or "/**") is kept as "/": it names a
 * directory.
 */
function normalizeRepoPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim().replace(/\\/g, "/");
  if (!p || p.length > 500 || p.includes("\0")) return null;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const dir = /\/(?:\*\*)?$/.test(p);
  p = p.replace(/\/\*\*$/, "/");
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (!parts.length || parts.some((s) => s === "..")) return null;
  return parts.join("/") + (dir ? "/" : "");
}

/** "src/a/b.ts" → "src/a/"; a file at the top of the repo → "". */
function dirOf(file: string): string {
  const at = file.lastIndexOf("/");
  return at < 0 ? "" : file.slice(0, at + 1);
}

/**
 * The scope extra work stays inside, from the files the task itself changed:
 * each of those files, the folder each one is in (not the repo's top level —
 * that would be everything), the repo's usual test and doc folders, and its
 * top-level README and CHANGELOG. Repo-relative, in one spelling, no repeats;
 * a path outside the repo (absolute, `..`) adds nothing.
 */
export function extraWorkScope(touched: readonly unknown[]): string[] {
  const scope = new Set<string>();
  for (const raw of touched) {
    const file = normalizeRepoPath(raw);
    if (!file || file.endsWith("/")) continue;
    scope.add(file);
    const dir = dirOf(file);
    if (dir) scope.add(dir);
  }
  for (const dir of EXTRA_SCOPE_DIRS) scope.add(dir);
  for (const doc of EXTRA_SCOPE_ROOT_DOCS) scope.add(doc);
  return [...scope];
}

/**
 * May this extra item be done? Its kind must be on the allowlist
 * (EXTRA_WORK_KINDS) and every file it touches inside the task's scope — a
 * file named in `scopeFiles`, one under a directory named there with a
 * trailing "/", or a test or doc file beside a scoped file ("app.test.js" next
 * to "app.js"). An item touching no file (a "verify" pass) needs no scope.
 * Extra time is for the work that was asked for, never for new work.
 */
export function checkExtraItem(
  item: { kind: unknown; files?: readonly unknown[] | null },
  scopeFiles: readonly string[],
): { ok: true } | { ok: false; error: string } {
  const kind = readExtraKind(item?.kind);
  if (!kind) {
    const said = typeof item?.kind === "string" ? `"${item.kind.trim().slice(0, 40)}"` : "no kind";
    return { ok: false, error: `Extra work must be one of ${EXTRA_WORK_KINDS.join(", ")}; ${said} is not on that list.` };
  }
  const files = item.files ?? [];
  if (!Array.isArray(files)) return { ok: false, error: "An extra item's files must be a list of repo paths." };
  if (files.length > MAX_EXTRA_FILES) {
    return { ok: false, error: `An extra item may touch at most ${MAX_EXTRA_FILES} files; this one names ${files.length}. Split it into smaller steps.` };
  }
  const scope = scopeFiles.map(normalizeRepoPath).filter((p): p is string => p !== null);
  const besideScoped = (file: string) => {
    const name = file.slice(dirOf(file).length);
    return TEST_OR_DOC_FILE_RE.test(name) && scope.some((s) => !s.endsWith("/") && dirOf(s) === dirOf(file));
  };
  const inScope = (file: string) => scope.some((s) => (s.endsWith("/") ? file.startsWith(s) : file === s)) || besideScoped(file);
  for (const raw of files) {
    const file = normalizeRepoPath(raw);
    const shown = typeof raw === "string" ? raw.trim().slice(0, 120) : String(raw).slice(0, 40);
    if (file === null || file.endsWith("/")) return { ok: false, error: `"${shown}" is not a file inside the repository.` };
    if (!inScope(file)) return { ok: false, error: `"${shown}" is outside this task's files; extra work stays inside the task's own scope.` };
  }
  return { ok: true };
}

/**
 * What a line of the agent's output claims about spare time:
 *  - `extra`         `EXTRA: <kind> — <summary>`: one extra item it did
 *  - `nothing_left`  `NOTHING_LEFT` (optionally `— why`): nothing valuable is
 *                    left to do — a valid way to end early, not a failure
 *  - `invalid`       a line that starts like a claim but is not one; `error`
 *                    says what the line should look like
 */
export type ExtraClaim =
  | { type: "extra"; kind: ExtraWorkKind; summary: string }
  | { type: "nothing_left"; reason?: string }
  | { type: "invalid"; error: string };

/** A list bullet, a quote mark, or emphasis before the keyword: "- **EXTRA:** …". */
const CLAIM_LEAD_RE = /^(?:[-*•>]\s*|[`_]+)*/u;
/** Kind, then a separator: an em or en dash, a colon, or a hyphen with a space on each side. */
const EXTRA_CLAIM_RE = /^EXTRA[*_`]*\s*:[*_`]*\s*([A-Za-z][A-Za-z_-]*(?: [A-Za-z]+)?)\s*(?:—|–|:|\s--?\s)\s*(.*)$/u;
const EXTRA_HEAD_RE = /^EXTRA[*_`]*\s*:/u;
const NOTHING_LEFT_RE = /^NOTHING_LEFT[*_`]*(?:\s*(?:—|–|:|\s--?\s)\s*(.*)|[.!]?)$/u;

function cleanClaimText(text: string, max: number): string {
  return text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/[*_`]+$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Read one line for an extra-work claim. The keywords are upper case, at the
 * start of the line (after a bullet or emphasis), exactly as the prompt asks
 * for them — so a sentence that merely says "extra" or "nothing left" is
 * never one. Null for a line that is not a claim.
 */
export function parseExtraClaim(line: string): ExtraClaim | null {
  if (typeof line !== "string") return null;
  const text = line.slice(0, MAX_CLAIM_LINE_CHARS).trim().replace(CLAIM_LEAD_RE, "");
  const nothing = NOTHING_LEFT_RE.exec(text);
  if (nothing) {
    const reason = nothing[1] !== undefined ? cleanClaimText(nothing[1], MAX_EXTRA_SUMMARY_CHARS) : "";
    return reason ? { type: "nothing_left", reason } : { type: "nothing_left" };
  }
  if (!EXTRA_HEAD_RE.test(text)) return null;
  const usage = `Write an extra item as "EXTRA: <kind> — <summary>", with <kind> one of ${EXTRA_WORK_KINDS.join(", ")}.`;
  const m = EXTRA_CLAIM_RE.exec(text);
  if (!m) return { type: "invalid", error: usage };
  const kind = readExtraKind(m[1]);
  if (!kind) return { type: "invalid", error: `"${m[1].slice(0, 40)}" is not a kind of extra work. ${usage}` };
  const summary = cleanClaimText(m[2], MAX_EXTRA_SUMMARY_CHARS);
  if (!summary) return { type: "invalid", error: `The extra ${kind} item does not say what was done. ${usage}` };
  return { type: "extra", kind, summary };
}

/** The most lines of one reply read for a claim — from its end, where the prompt asks for it. */
const MAX_CLAIM_SCAN_LINES = 200;

/**
 * The claim a reply ends on: the LAST claim line in it (the prompt asks for
 * one, at the end) — or null when it makes none. A reply that names a claim
 * and then corrects it is read by its correction.
 */
export function lastExtraClaim(text: unknown): ExtraClaim | null {
  if (typeof text !== "string" || !text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < MAX_CLAIM_SCAN_LINES; i--, seen++) {
    const claim = parseExtraClaim(lines[i]);
    if (claim) return claim;
  }
  return null;
}

/** What each allowlisted kind means, in the words the prompt uses. */
const EXTRA_KIND_WORDS: Record<ExtraWorkKind, string> = {
  tests: "tests for the code this work changed",
  fixes: "lint, type or build fixes in that code",
  edge_cases: "edge cases and error handling in that code",
  docs: "docs for the change",
  verify: "re-running or verifying the real job (run it again, check its output)",
};

/**
 * The prompt for ONE extra item, in English like the rest of the brief: the
 * time to spare, the allowlist and nothing beside it, the scope, the items
 * already done (so none is done twice), and the one closing line the server
 * reads — `EXTRA: <kind> — <what>` or `NOTHING_LEFT — <why>`. The server
 * enforces all of it (lastExtraClaim, checkExtraItem, nextItemAllowed); the
 * prompt only explains.
 */
export function extraWorkPrompt(opts: {
  /** Time left before the safety margin, ms. */
  leftMs: number;
  /** When the margin begins, as the owner reads it ("Tue 14 Oct, 18:40"). */
  cutoff: string;
  scope: readonly string[];
  /** The extra items already done, oldest first. */
  done: readonly string[];
  /** Which extra item this is, from 1. */
  n: number;
}): string {
  const shown = opts.scope.slice(0, MAX_SCOPE_SHOWN);
  const more = opts.scope.length > shown.length ? ` (and ${opts.scope.length - shown.length} more)` : "";
  const scope = shown.length ? `${shown.join(", ")}${more}` : "the files this work already changed";
  const done = opts.done.length ? ` Already done, so not again: ${opts.done.map((d) => `"${d}"`).join("; ")}.` : "";
  return [
    `EXTRA WORK, item ${opts.n} of at most ${MAX_EXTRA_ITEMS}. The task is done and committed, and ${formatDuration(opts.leftMs)} are left before the safety margin at ${opts.cutoff}. ClawBox gives that spare time to ONE small extra item, from this list only:`,
    ...EXTRA_WORK_KINDS.map((k) => `- ${k}: ${EXTRA_KIND_WORDS[k]}`),
    `No new features, no unrelated refactors, and no file outside this task's scope: ${scope}. A test or doc file beside one of those files is in scope too. Keep the item small enough to finish in about ${formatDuration(EXTRA_ITEM_ESTIMATE_MS)}, and commit it as one commit whose message names it.${done}`,
    `End your reply with exactly one line: "EXTRA: <kind> — <what you did>", with <kind> one of ${EXTRA_WORK_KINDS.join(", ")}. If nothing on the list is worth doing, change nothing and end with "NOTHING_LEFT — <why>" instead: that is a good answer, not a failure.`,
  ].join("\n");
}

// ─── Estimates ───────────────────────────────────────────────────────────────

/** The smallest estimate this box keeps: one minute. */
export const MIN_ESTIMATE_MS = MINUTE_MS;
/** The largest: no single task is estimated beyond the longest budget there is. */
export const MAX_ESTIMATE_MS = MAX_BUDGET_MS;
/** A task is behind once it has taken more than this share over its estimate. */
export const ESTIMATE_OVERRUN_FRACTION = 0.25;
/** The longest estimate string read. */
const MAX_ESTIMATE_CHARS = 60;

const ESTIMATE_LEAD_RE = /^(?:~|≈|about\s+|around\s+|approx\.?\s+|approximately\s+|roughly\s+|ca\.?\s+|circa\s+)/iu;
const ESTIMATE_NUMBER_RE = /^\d{1,6}(?:[.,]\d{1,2})?$/u;
/** One "<number> <unit>" piece of a compound estimate: "1 h", "30 min", "2 days". */
const ESTIMATE_PART_RE = /(\d{1,6}(?:[.,]\d{1,2})?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)(?![A-Za-z])/giu;
/** What may stand between the pieces: spaces, a comma, "and". */
const ESTIMATE_GLUE_RE = /^(?:\s|,|and)*$/iu;

/**
 * A planner's estimate, as ms — or null. A number is minutes ("40", 40); a
 * string may name its unit ("90m", "1.5 hours", "1 h 30 min", "PT2H") and
 * start with "~" or "about". Rounded to whole minutes; under a minute is one.
 * Bounded: nothing, zero, a negative, or more than MAX_ESTIMATE_MS is no
 * estimate at all — never a clamp, which would invent one.
 */
export function parseEstimateMinutes(raw: unknown): number | null {
  let ms: number | null = null;
  if (typeof raw === "number") {
    ms = Number.isFinite(raw) && raw > 0 ? raw * MINUTE_MS : null;
  } else if (typeof raw === "string") {
    const text = raw.trim().replace(ESTIMATE_LEAD_RE, "").replace(/[.\s]+$/u, "").trim();
    if (!text || text.length > MAX_ESTIMATE_CHARS) return null;
    if (ESTIMATE_NUMBER_RE.test(text)) {
      ms = Number(text.replace(",", ".")) * MINUTE_MS;
    } else {
      ms = parseDuration(text) ?? compoundEstimate(text);
    }
  }
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const rounded = Math.max(MIN_ESTIMATE_MS, Math.round(ms / MINUTE_MS) * MINUTE_MS);
  return rounded > MAX_ESTIMATE_MS ? null : rounded;
}

/** "1 h 30 min", "2 hours and 15 minutes", "1d, 4h" → ms; null unless the pieces are the whole text. */
function compoundEstimate(text: string): number | null {
  let total = 0;
  let last = 0;
  let pieces = 0;
  for (const m of text.matchAll(ESTIMATE_PART_RE)) {
    if (!ESTIMATE_GLUE_RE.test(text.slice(last, m.index))) return null;
    const n = Number(m[1].replace(",", "."));
    const unit = m[2].toLowerCase();
    total += n * (unit.startsWith("d") ? 1440 : unit.startsWith("h") ? 60 : 1) * MINUTE_MS;
    last = (m.index ?? 0) + m[0].length;
    pieces++;
  }
  if (!pieces || !ESTIMATE_GLUE_RE.test(text.slice(last))) return null;
  return total;
}

/** Has the work taken more than 25% over its estimate? False without a usable estimate. */
export function isBehindEstimate(estimateMs: number | null | undefined, actualMs: number | null | undefined): boolean {
  if (!isPositive(estimateMs) || typeof actualMs !== "number" || !Number.isFinite(actualMs)) return false;
  return actualMs > estimateMs * (1 + ESTIMATE_OVERRUN_FRACTION);
}

// ─── Fitting the plan to the time ────────────────────────────────────────────

/**
 * What to cut to win back `needMs`: `tasks` are in priority order (most
 * important first), and the cut starts at the bottom — the least important
 * goes first, then the next, until the estimates cut add up to `needMs`.
 * Answers the ids, lowest priority first. A task with no estimate frees no
 * time anyone can count on, so it is passed over, never cut. When even every
 * estimated task is not enough, all of them are named: the caller compares.
 */
export function cutFromBottom(
  tasks: readonly { id: string; estimateMs: number | null | undefined }[],
  needMs: number,
): string[] {
  if (!isPositive(needMs)) return [];
  const cut: string[] = [];
  const seen = new Set<string>();
  let freed = 0;
  for (let i = tasks.length - 1; i >= 0 && freed < needMs; i--) {
    const t = tasks[i];
    if (!t || typeof t.id !== "string" || seen.has(t.id)) continue;
    seen.add(t.id);
    if (!isPositive(t.estimateMs)) continue;
    cut.push(t.id);
    freed += t.estimateMs;
  }
  return cut;
}

/**
 * Do the must-have tasks fit? Their estimates, summed, against the time left
 * before the safety margin (marginCutoffMs) — the deadline itself is for
 * committing and opening the pull request, not for work. `shortByMs` is how
 * much would have to go; 0 when it fits. Estimates that are not a positive
 * number count as nothing.
 */
export function mustHaveFits(
  budget: TimeBudget,
  now: Now,
  estimatesMs: readonly (number | null | undefined)[],
): { fits: boolean; availableMs: number; shortByMs: number; neededMs: number } {
  const availableMs = Math.max(0, marginCutoffMs(budget) - nowMs(now));
  const neededMs = estimatesMs.filter(isPositive).reduce((a, b) => a + b, 0);
  const shortByMs = Math.max(0, neededMs - availableMs);
  return { fits: shortByMs === 0, availableMs, shortByMs, neededMs };
}

/**
 * May the next item — a task, a step, an extra — start now? Not once the
 * budget is spent (the deadline is here: "time"; the budget's own spend
 * ceiling is reached: "cost" — budgetStopReason), and not once it can no
 * longer finish before the safety margin (fitsBeforeCutoff, with its estimate
 * when it has one: "time"). The item already under way is never cut off by
 * this; it only gates what starts next.
 */
export function nextItemAllowed(
  budget: TimeBudget,
  now: Now,
  tokensUsed: number,
  estimateMs?: number | null,
): { ok: true } | { ok: false; reason: "time" | "cost" } {
  const stop = budgetStopReason(budget, now, tokensUsed);
  if (stop) return { ok: false, reason: stop };
  if (!fitsBeforeCutoff(budget, now, estimateMs)) return { ok: false, reason: "time" };
  return { ok: true };
}

// ─── Calibration ─────────────────────────────────────────────────────────────
//
// How the estimates on this box have held, fed back into the next ones. Each
// budgeted run and team records what it estimated and what it took; the next
// plan reads the latest of those (coding-time-record.ts
// `currentEstimateCalibration`) and, when they ran consistently over or under,
// scales its new estimates by the median of took ÷ estimated before they are
// fitted to the time. The scaled estimate is what the work is planned, gated
// and re-planned with; the factor goes on the plan's record line, so the
// planner's own word can be read back (estimateMs ÷ calibration) and the next
// calibration measures the planner, not the previous calibration.

/** Fewer finished estimates than this say nothing about how estimates hold: no calibration. */
export const CALIBRATION_MIN_SAMPLES = 3;
/** The most finished estimates one calibration reads — the latest ones. */
export const CALIBRATION_MAX_SAMPLES = 40;
/**
 * The factor's bounds. A record lives in a folder its run can write, so one
 * wild overrun — or a forged record — can at most triple an estimate or halve
 * it, and the median of many keeps a few from moving it at all.
 */
export const CALIBRATION_MIN_FACTOR = 0.5;
export const CALIBRATION_MAX_FACTOR = 3;
/** Within this share of 1 the estimates held: nothing is scaled. */
export const CALIBRATION_TOLERANCE = 0.1;

/** One finished estimate: what the planner or the run said (uncalibrated), and the time it took. */
export interface EstimateSample {
  estimateMs: number;
  actualMs: number;
}

/** How past estimates held: the median of took ÷ estimated, and how many finished estimates it is the median of. */
export interface EstimateCalibration {
  factor: number;
  samples: number;
}

const clampFactor = (f: number): number => Math.min(CALIBRATION_MAX_FACTOR, Math.max(CALIBRATION_MIN_FACTOR, f));

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The factor a record's estimates were scaled by when it was planned — its latest plan line's — or 1. */
function recordedCalibration(records: readonly TimeRecord[]): number {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r?.kind === "plan") return isPositive(r.calibration) ? r.calibration : 1;
  }
  return 1;
}

/**
 * The finished estimates in one time record, each as the planner or the run
 * gave it (a calibrated estimate divided back by its factor). A team's: every
 * task with both an estimate and the time it took. A run's: its whole-work
 * estimate against the time it worked — only when the run was done and did
 * nothing else in that time (no extra work), or the pair would not be like
 * for like.
 */
export function estimateSamples(summary: Pick<TimeRecordSummary, "tasks" | "estimateMs" | "stopReason" | "extras" | "records">): EstimateSample[] {
  const scale = recordedCalibration(summary.records ?? []);
  const own = (ms: number) => ms / scale;
  const out: EstimateSample[] = [];
  for (const t of summary.tasks ?? []) {
    if (isPositive(t.estimateMs) && isTime(t.actualMs)) out.push({ estimateMs: own(t.estimateMs), actualMs: t.actualMs });
  }
  if (out.length || (summary.tasks ?? []).length) return out;
  if (summary.stopReason !== "done" || (summary.extras ?? []).length || !isPositive(summary.estimateMs)) return out;
  const records = summary.records ?? [];
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r?.kind === "finish" && !r.taskId && isTime(r.actualMs)) return [{ estimateMs: own(summary.estimateMs), actualMs: r.actualMs }];
  }
  return out;
}

/**
 * How past estimates held, from finished ones (latest first; past
 * CALIBRATION_MAX_SAMPLES the older ones are not read): the median of took ÷
 * estimated, each bounded, rounded to two places — or null with fewer than
 * CALIBRATION_MIN_SAMPLES.
 */
export function estimateCalibration(samples: readonly EstimateSample[]): EstimateCalibration | null {
  const ratios = samples
    .filter((s) => s && isPositive(s.estimateMs) && isTime(s.actualMs))
    .slice(0, CALIBRATION_MAX_SAMPLES)
    .map((s) => clampFactor(s.actualMs / s.estimateMs))
    .sort((a, b) => a - b);
  if (ratios.length < CALIBRATION_MIN_SAMPLES) return null;
  const mid = ratios.length >> 1;
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return { factor: clampFactor(Math.round(median * 100) / 100), samples: ratios.length };
}

/** Does this calibration scale anything — are past estimates off by more than CALIBRATION_TOLERANCE? */
export function calibrationApplies(cal: EstimateCalibration | null | undefined): cal is EstimateCalibration {
  // In hundredths, as the factor is kept: 0.9 is 10% off, though 1 - 0.9 is not quite 0.1 in floating point.
  return !!cal && isPositive(cal.factor) && Math.round(Math.abs(cal.factor - 1) * 100) >= Math.round(CALIBRATION_TOLERANCE * 100);
}

/**
 * An estimate as the work plans with it: scaled by the calibration when one
 * applies, rounded to whole minutes and kept inside the estimate bounds (at
 * least MIN_ESTIMATE_MS, at most MAX_ESTIMATE_MS) — else unchanged.
 */
export function calibrateEstimate(estimateMs: number, cal: EstimateCalibration | null | undefined): number {
  if (!isPositive(estimateMs) || !calibrationApplies(cal)) return estimateMs;
  const scaled = Math.round((estimateMs * cal.factor) / MINUTE_MS) * MINUTE_MS;
  return Math.min(MAX_ESTIMATE_MS, Math.max(MIN_ESTIMATE_MS, scaled));
}

/** "1.4×", "0.75×": a factor as the notes say it. */
const timesText = (factor: number): string => `${factor}×`;

/**
 * One English line for the log and the time record when a calibration
 * applies — how the estimates held and what that does to the new ones — or
 * null when none does.
 */
export function calibrationNote(cal: EstimateCalibration | null | undefined): string | null {
  if (!calibrationApplies(cal)) return null;
  return `Calibration: on this box, past estimates took ${timesText(cal.factor)} the time estimated (the median of ${plural(cal.samples, "finished estimate")}), so the estimates here are scaled by ${timesText(cal.factor)} before they are fitted to the time.`;
}

/**
 * The calibration as a brief says it to the planner or the run, or null when
 * none applies: what the box will do with its estimates, and that it should
 * not pad them itself — the box measures its own word, not a corrected one.
 */
export function calibrationBrief(cal: EstimateCalibration | null | undefined): string | null {
  if (!calibrationApplies(cal)) return null;
  return `ESTIMATE CALIBRATION: on this box, past estimates took ${timesText(cal.factor)} the time estimated (the median of ${plural(cal.samples, "finished estimate")}). ClawBox scales your estimates by ${timesText(cal.factor)} before it fits them to the time, so estimate as you normally would — do not add to them or cut them yourself.`;
}

// ─── Reporting ───────────────────────────────────────────────────────────────

/** "+24%", "-10%", "±0%": how far the time taken was from the estimate. */
function overrunPercent(estimateMs: number, actualMs: number): string {
  const pct = Math.round((actualMs / estimateMs - 1) * 100);
  return pct === 0 ? "±0%" : pct > 0 ? `+${pct}%` : `${pct}%`;
}

/**
 * How the estimates held, in one English line for the log, the report and the
 * timeline: "Estimates: 3 tasks, estimated 1 h 30 min, took 1 h 52 min (+24%)".
 * Counts the tasks that have both an estimate and a time taken; a run with
 * no per-task estimates is measured by its overall one, once it has stopped.
 */
export function estimateAccuracyLine(summary: Pick<TimeRecordSummary, "tasks" | "estimateMs" | "usedMs" | "finishedAt">): string {
  const tasks = summary.tasks ?? [];
  const estimated = tasks.filter((t) => isPositive(t.estimateMs));
  const paired = estimated.filter((t) => typeof t.actualMs === "number" && Number.isFinite(t.actualMs) && t.actualMs >= 0);
  if (paired.length) {
    const est = paired.reduce((a, t) => a + (t.estimateMs as number), 0);
    const took = paired.reduce((a, t) => a + (t.actualMs as number), 0);
    const open = estimated.length - paired.length;
    const rest = open ? `; ${open} more not finished` : "";
    return `Estimates: ${plural(paired.length, "task")}, estimated ${formatDuration(est)}, took ${formatDuration(took)} (${overrunPercent(est, took)})${rest}`;
  }
  if (estimated.length) {
    const est = estimated.reduce((a, t) => a + (t.estimateMs as number), 0);
    return `Estimates: ${plural(estimated.length, "task")}, estimated ${formatDuration(est)}; none finished yet`;
  }
  if (isPositive(summary.estimateMs)) {
    if (summary.finishedAt && typeof summary.usedMs === "number" && Number.isFinite(summary.usedMs)) {
      return `Estimates: the whole work, estimated ${formatDuration(summary.estimateMs)}, took ${formatDuration(summary.usedMs)} (${overrunPercent(summary.estimateMs, summary.usedMs)})`;
    }
    return `Estimates: the whole work, estimated ${formatDuration(summary.estimateMs)}; not finished yet`;
  }
  return "Estimates: none given";
}
