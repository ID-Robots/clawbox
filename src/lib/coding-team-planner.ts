/**
 * The Planner of a coding team: what it is told, and how its answer is read.
 *
 * The planner is one read-only headless run (the coding agent's own runner,
 * with a brief that forbids edits) whose final message is the plan: a JSON
 * array of tasks, or — the form it is asked for — that array wrapped in an
 * object with the team's SHAPE beside it (how many workers side by side, how
 * the work is reviewed). This module owns that brief and the parser. The
 * parser is strict on purpose: a plan that is not valid JSON, or names a
 * dependency that is not in the plan, or asks for more tasks than a team
 * holds, or shapes the team in a way it cannot run, fails the team with the
 * reason — it is never "repaired" into something the planner did not say,
 * because every task here becomes a worker with a shell. Only text over its
 * length bound is cut, at a sentence end, and the cut is logged as a note.
 *
 * The same planner comes back as the team's LEAD while the team runs, when
 * the owner's `coding_team_dynamic` switch is on: after workers settle — one
 * turn for every task that settled since its last, and only when there is
 * something to decide (`leadShouldRun`) — one short read-only run may add a
 * task or retire one still pending. Its answer is read here too, as
 * strictly, and against the board as it stands.
 *
 * A team with a TIME BUDGET gets more of both (`plannerBrief`, `parsePlan`
 * with `timed`): the planner is told the deadline in the box's zone, the time
 * left and the cutoff, and answers an estimate per task, the tasks most
 * important first, its nice-to-haves marked, and a `time_plan` saying what it
 * left out. Those are read leniently — an estimate that cannot be read is no
 * estimate, never a refused plan — and `fitPlan` measures the plan against
 * the time before any work starts. Without a budget, nothing here changes.
 *
 * A task may be marked `"role": "bulk"` — token-heavy, not critical — so its
 * worker starts on the bulk role's model; the planner and the lead are told
 * what every role runs on and roughly what it costs (`teamModelsBrief`).
 */

import { MAX_TASK_CHARS, MAX_TEAM_WORKERS, type TeamRoleModelMap } from "@/lib/coding-agent";
import type { CodingProvider } from "@/lib/coding-provider";
import { MODEL_ROLES, type ModelRole } from "@/lib/coding-role-models";
import {
  allComplete,
  boardDigest,
  isExhausted,
  MAX_DIGEST_CHARS,
  MAX_LEAD_ADDS,
  MAX_LEAD_RETIRES,
  MAX_RATIONALE_CHARS,
  MAX_REPO_MAP_ITEMS,
  MAX_SKIP_TEXT_CHARS,
  MAX_TASK_DESCRIPTION_CHARS,
  MAX_TEAM_TASKS,
  normalizeRepoMap,
  REVIEW_MODES,
  type LogEntry,
  type RepoMap,
  type ReviewMode,
  type TaskRole,
  type TaskStatus,
  type TeamBoard,
  type TeamShape,
} from "@/lib/coding-team-board";
import {
  describeBudget,
  formatDuration,
  formatLocalDeadline,
  LONG_BUDGET_MS,
  marginCutoffMs,
  safeTimeZone,
  safetyMarginMs,
  type TimeBudget,
} from "@/lib/coding-time-budget";
import { calibrationBrief, cutFromBottom, mustHaveFits, parseEstimateMinutes, type EstimateCalibration } from "@/lib/coding-time-plan";

export interface PlannedTask {
  task_description: string;
  depends_on: string[];
  files_hint: string[];
  /**
   * A budgeted plan's only (`parsePlan` with `timed`), each absent otherwise:
   * the planner's `estimate_minutes` as ms (absent when it gave none that
   * could be read), the task's place in the list (1 = the most important),
   * and `optional: true` on a nice-to-have.
   */
  estimateMs?: number;
  priority?: number;
  optional?: boolean;
  /**
   * `bulk` when the planner (or the lead) said `"role": "bulk"`: its worker
   * starts on the bulk role's model. Absent for every other task — a worker's,
   * whatever else `role` said — so a plan without bulk work is what it was.
   */
  role?: TaskRole;
}

/** A budgeted plan's `time_plan`, read leniently: what the planner said about the plan and the time. */
export interface TimePlan {
  /** The whole plan's estimate, ms, or null when it gave none that could be read. */
  estimateMs: number | null;
  /** What the planner left out to fit the time, and why — one line each. */
  skipped: string[];
  /** The planner's word that the time cannot hold the goal, or null. */
  tooShort: string | null;
}

/** A time_plan names at most this many skipped items; the rest are dropped. */
export const MAX_TIME_PLAN_SKIPS = 12;

/** How a task is written: the planner's rules, and the lead's when it adds one. */
const TASK_RULES = [
  "Each task_description must stand on its own: say what to build or change, in which files, and how the worker verifies it — it is the whole brief that worker gets.",
  `Each task_description must be at most ${MAX_TASK_DESCRIPTION_CHARS} characters. Keep shared context concise; describe disjoint file ownership for parallel work and add an integration task depending on the workers when needed.`,
  "A task that verifies, integrates or reviews the other tasks' output must list EVERY task it checks in depends_on — never fewer: its worker starts from the work merged so far, and a task it does not wait for may not be there yet.",
  "files_hint lists the files or folders the task should touch; the team watches for a worker straying outside it.",
  "When two tasks share a contract — an API shape, a schema, a module path — say in BOTH task_descriptions which task owns it, and that the other task's worker must ask that task's worker for it with team_message (to=\"sibling\") rather than invent it.",
  'role is optional: "bulk" marks a task that is token-heavy and not critical — scraping, mass data, repetitive edits, long test runs — so its worker may run on a cheaper model; leave it out (or say "worker") for every other task, and always for the code the goal depends on.',
];

export const PLANNER_BRIEF = [
  "You are the PLANNER of a small coding team working unattended in this folder. Your job is to split ONE goal into a few independent, concrete tasks that separate workers will carry out in parallel when independent, each in its own fresh session with no memory of yours.",
  "Read the folder first — map what exists, what the goal touches and what a worker would need to know — but change NOTHING: you may not edit, create, delete or run anything that writes.",
  `Answer with ONLY a JSON object, no prose before or after: {"shape": {"parallelism": 1 to ${MAX_TEAM_WORKERS}, "review": "each" | "final" | "none", "rationale": string}, "repo_map": {"files": ["path — what it is", ...], "entry_points": [...], "test_commands": [...], "gotchas": [...]}, "tasks": [at most ${MAX_TEAM_TASKS} objects {"task_description": string, "depends_on": ["t1", ...], "files_hint": ["path", ...], "role": "worker" | "bulk"}]}. Each task_description is at most ${MAX_TASK_DESCRIPTION_CHARS} characters and the rationale at most ${MAX_RATIONALE_CHARS}; longer text is cut. If a task needs more than that, split it into two tasks.`,
  `repo_map is your compact map of the parts of the project the goal touches, written for the workers: the files that matter with a few words each, where the code starts (entry points), the exact commands that build and test it, and the gotchas you found — at most ${MAX_REPO_MAP_ITEMS} one-line entries per list. Every worker and reviewer is handed it instead of exploring the project again, so make it the map you would want to be given.`,
  "Tasks are numbered t1, t2, … in the order you list them; depends_on names EARLIER tasks — listed before it — that a task must wait for. Prefer 2–5 tasks only where the parts are truly independent. A plan of ONE task runs as a single ordinary run, the cheapest shape: a goal one session can do in one go is one task. Tasks that edit mostly the same files cannot run side by side and only add cost — make them one task.",
  ...TASK_RULES,
  `Size the team to the goal in shape: parallelism is how many workers may run side by side; review is "each" (a reviewer checks every task), "final" (one reviewer checks the merged result at the end) or "none" (only the automatic check that a worker was refused nothing and stayed inside its files); rationale says why in at most ${MAX_RATIONALE_CHARS} characters.`,
  'A one-file fix is ONE task with parallelism 1 and review "final". Tasks on independent files may run in parallel — parallelism up to the number of tasks that can run at once. A migration, or any chain where each step builds on the last, runs serially: parallelism 1, each task depending on the one before.',
  "If the goal cannot be planned as written — it names files or folders that are not there, or turns on a decision only the owner can take — say so in one short team_message to the lead or to the owner's assistant, never for progress or acknowledgements, and still answer with the JSON plan.",
].join(" ");

/**
 * Up to this much time before its cutoff, a budget is SHORT: the plan holds
 * only what the goal needs. Longer, the plan builds and tests its tools first
 * and gives a long-running job the rest of the time.
 */
export const SHORT_PLAN_MS = LONG_BUDGET_MS;

/**
 * The brief a team's planner works to: PLANNER_BRIEF exactly, for a team
 * without a budget. With one, the time follows it — the deadline in the box's
 * zone (`tz`, read on the server), the time left, and the safety-margin cutoff
 * after which no new task starts — and what the plan must then also say: an
 * estimate per task, the tasks most important first, the nice-to-haves
 * marked, and a time_plan. `now` is the box's clock. A `calibration` that
 * applies (past estimates on this box ran over or under) is said last: the
 * box scales the estimates by it, so the planner is asked not to.
 */
export function plannerBrief(budget: TimeBudget | null | undefined, now: number, tz: string, calibration: EstimateCalibration | null = null): string {
  if (!budget) return PLANNER_BRIEF;
  const calibrated = calibrationBrief(calibration);
  return `${PLANNER_BRIEF} ${timeBrief(budget, now, tz)}${calibrated ? ` ${calibrated}` : ""}`;
}

/** A provider as the briefs — and the team's own English lines — name it. */
const PROVIDER_WORDS: Readonly<Record<CodingProvider, string>> = {
  "clawbox-ai": "ClawBox AI",
  anthropic: "Anthropic",
};

export function providerWords(provider: CodingProvider): string {
  return PROVIDER_WORDS[provider] ?? provider;
}

/** A role as the briefs name it: the planner's line is the lead's too. */
const ROLE_WORDS: Readonly<Record<ModelRole, string>> = {
  planner: "planner (and the lead)",
  worker: "worker",
  reviewer: "reviewer",
  bulk: "bulk",
};

/** "~1x", "~20x", "~0.5x" — or the plain fact that nobody can say. */
function costWords(cost: number | null): string {
  if (cost === null || !Number.isFinite(cost) || cost <= 0) return "cost not known";
  return `~${Number(cost.toPrecision(2))}x`;
}

/**
 * What every role of the team starts on — model, provider and roughly what a
 * token costs there (`relativeModelCost`, the ClawBox AI flash tier = 1x) — one
 * line per role, for the planner's brief and the lead's: it weighs which tasks
 * to mark bulk by it. A role whose provider cannot run right now is marked
 * UNAVAILABLE with the reason; for bulk that means a bulk task runs as an
 * ordinary worker. Empty without a map (it could not be read): the brief is
 * then what it was before there were role models.
 */
export function teamModelsBrief(map: TeamRoleModelMap | null | undefined): string {
  if (!map) return "";
  const lines = MODEL_ROLES.filter((role) => map[role]).map((role) => {
    const r = map[role];
    const head = `- ${ROLE_WORDS[role]}: ${r.model ?? "the plan's own model"} on ${providerWords(r.provider)}, ${costWords(r.relativeCost)}`;
    if (!r.ready) {
      const why = r.problems.map((p) => p.trim()).filter(Boolean).join(" ") || "its provider is not ready.";
      return `${head} — UNAVAILABLE: ${why}${role === "bulk" ? " A task marked bulk runs as an ordinary worker until it is." : ""}`;
    }
    const worker = map.worker;
    const same = role === "bulk" && worker && worker.provider === r.provider && worker.model === r.model;
    return same ? `${head} — the workers' own model: marking a task bulk changes nothing on this box.` : head;
  });
  if (!lines.length) return "";
  return [
    "Team models — what each role's runs start on, and roughly what a token costs there (the ClawBox AI flash tier = 1x):",
    ...lines,
    'Mark a task "role": "bulk" only when it is token-heavy and not critical: its worker runs on the bulk line\'s model.',
  ].join("\n");
}

/** A role's brief with the team's models after it, when there is a map to say. */
export function withTeamModels(brief: string, map: TeamRoleModelMap | null | undefined): string {
  const models = teamModelsBrief(map);
  return models ? `${brief}\n\n${models}` : brief;
}

function timeBrief(budget: TimeBudget, now: number, tz: string): string {
  const zone = safeTimeZone(tz);
  const cutoff = marginCutoffMs(budget);
  const toCutoff = Math.max(0, cutoff - now);
  const at = `${formatLocalDeadline(cutoff, zone)} (${zone})`;
  return [
    `TIME BUDGET: this team works to a deadline — ${describeBudget(budget, now, zone)}.`,
    `No new task starts after the cutoff at ${at}: the last ${formatDuration(safetyMarginMs(budget))} before the deadline are kept for committing and the pull request.`,
    toCutoff > 0
      ? `That leaves ${formatDuration(toCutoff)} of work from now, this planning included; plan the work to end by the cutoff.`
      : "The cutoff has already passed: plan ONE small task, the most important step.",
    'With a budget your JSON says more. Every task also has "estimate_minutes" — a whole number, one worker\'s minutes for it, its checks included — and "optional": true when it is a nice-to-have rather than what the goal needs.',
    "List the tasks MOST IMPORTANT FIRST, still after the tasks they depend on: when the estimates do not fit the time, the team cuts from the bottom of the list, nice-to-haves first.",
    'At the top level add "time_plan": {"estimate_minutes": the whole plan\'s minutes, "skipped": ["what you left out — and why", ...], "too_short": null, or one sentence saying why the time cannot hold the goal}.',
    toCutoff <= SHORT_PLAN_MS
      ? "This is a SHORT budget: plan only what the goal needs to work. Leave out end-to-end suites, polish and nice-to-haves, and name each one in time_plan.skipped with why."
      : `This is a LONG budget. When the goal has a long-running job — scraping, crawling, a benchmark, a soak test, anything that runs "until" a time — build its tools first and test them in their own tasks, then ONE last task runs the job until the cutoff at ${at}: its description says to stop at the cutoff, and its estimate_minutes is the least time the job needs to be worth running — it runs on until the cutoff regardless. Time left over goes to extra checks, tests and fixes, so do not pad the estimates.`,
  ].join(" ");
}

/** How much of a planner's wrong answer is quoted back to it. */
const REPLAN_QUOTE_CHARS = 1_500;

/**
 * The second ask, when the planner's final message held no plan — a page of
 * prose about the tasks, a fenced list, a question. Seen on the box: a
 * 43-turn planner that wrote its plan as headings and never the array. The
 * folder is already read, so this run is asked for ONE thing: the plan.
 */
export function replanTask(goal: string, previous: string | null | undefined, reason: string): string {
  const quoted = (previous ?? "").trim();
  const text = [
    `Goal: ${goal}`,
    `Your previous answer to this goal was not a plan the team can read (${reason}).`,
    quoted ? `This is what you answered:\n${quoted.length > REPLAN_QUOTE_CHARS ? `${quoted.slice(0, REPLAN_QUOTE_CHARS - 1)}…` : quoted}` : "You answered nothing.",
    "Answer again with ONLY the JSON plan described in your brief — the object with its shape and its tasks array — no prose before or after it. Read the folder again only if you must.",
  ].join("\n\n");
  return text.length > MAX_TASK_CHARS ? `${text.slice(0, MAX_TASK_CHARS - 1)}…` : text;
}

/**
 * A field of a well-formed answer that was over its bound and was cut to it
 * rather than refusing the answer: a task's description, or the shape's
 * rationale (task_id null). `from` and `to` are its lengths before and after.
 */
export interface ClippedField {
  task_id: string | null;
  field: "task_description" | "rationale";
  from: number;
  to: number;
}

export interface PlanParse {
  ok: true;
  tasks: PlannedTask[];
  /** The team's shape as the planner gave it, or null — a bare array, or no shape: the default team. */
  shape: TeamShape | null;
  /**
   * The planner's map of what the goal touches, bounded, or null. Advice for
   * the workers rather than a contract: a map that is not usable is left out,
   * never a reason to refuse a plan whose tasks are fine.
   */
  repoMap: RepoMap | null;
  /** Every field cut to its bound; absent when nothing was. */
  clipped?: ClippedField[];
  /** A budgeted plan's `time_plan` (`timed`), its fields empty when the planner gave none; absent without a budget. */
  timePlan?: TimePlan;
}

/** The clips of one answer as ONE line for the team's log — a note, never an alert. */
export function clippedNote(clipped: readonly ClippedField[]): string {
  return clipped
    .map((c) => `${c.task_id ? `Task ${c.task_id}'s description` : "The shape's rationale"} was cut from ${c.from} to ${c.to} characters.`)
    .join(" ");
}

export interface PlanFailure {
  ok: false;
  reason: string;
}

/**
 * The plan in a planner's final message — fenced or bare, with anything
 * around it ignored: a JSON array of tasks, or `{"shape": {...}, "tasks":
 * [...]}`. A shape that is there but wrong refuses the plan like a bad task
 * does, with every fault named.
 *
 * `timed` (a team with a time budget) also reads each task's
 * `estimate_minutes` and `optional`, numbers the tasks' priority in the order
 * listed, and reads the `time_plan` — all leniently: what cannot be read is
 * left out, never a fault. Without it those fields are ignored, and the plan
 * is what it always was.
 */
export function parsePlan(text: string | null | undefined, opts: { timed?: boolean } = {}): PlanParse | PlanFailure {
  const timed = opts.timed === true;
  if (!text || !text.trim()) return { ok: false, reason: "The planner answered nothing." };
  const candidate = extractJson(text, (v) => Array.isArray(v) || (isObject(v) && ("tasks" in v || "shape" in v)));
  if (candidate === null) return { ok: false, reason: "The planner's answer holds no JSON array." };
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "The planner's answer is not valid JSON." };
  }
  const problems: string[] = [];
  const clipped: ClippedField[] = [];
  let shape: TeamShape | null = null;
  let repoMap: RepoMap | null = null;
  let timePlanRaw: unknown;
  let list: unknown = raw;
  if (!Array.isArray(raw)) {
    if (!isObject(raw)) return { ok: false, reason: "The planner's answer is not a JSON array." };
    list = raw.tasks;
    if (!Array.isArray(list)) return { ok: false, reason: 'The planner\'s answer has no "tasks" array.' };
    // `"shape": null` says what leaving it out says: the default team.
    if (raw.shape !== undefined && raw.shape !== null) {
      const read = parseShape(raw.shape, clipped);
      if (read.ok) shape = read.shape;
      else problems.push(...read.problems);
    }
    repoMap = normalizeRepoMap(raw.repo_map);
    timePlanRaw = raw.time_plan ?? raw.timePlan;
  }
  const items = list as unknown[];
  if (items.length === 0) return { ok: false, reason: "The planner produced no tasks." };
  if (items.length > MAX_TEAM_TASKS) return { ok: false, reason: `The planner produced ${items.length} tasks; a team holds at most ${MAX_TEAM_TASKS}.` };
  // Every task is read before answering, and every fault this plan has is
  // named at once. Returning on the first one taught the planner about t1
  // alone: it would shorten t1, re-answer, and be told about t2 — spending a
  // whole planner run per fault against a budget of a few. A plan is still
  // never repaired here; the planner is simply shown the whole list to fix.
  const tasks = readTasks(items, 0, problems, clipped, (d, n, i) => {
    // Canonical ids only — t1, not t01: the board numbers tasks t1…t999 and
    // knows no other spelling, so a plan that said `t01` would post and
    // then never find its dependency.
    if (n === null || n > items.length || n === i + 1) return `Task t${i + 1} depends on ${d}, which is not another task in the plan.`;
    return null;
  }, timed);
  if (problems.length) return { ok: false, reason: joinProblems(problems) };
  // A cycle is named as one first: it is the fault the planner must rethink,
  // not merely reorder.
  const cycle = dependencyCycle(tasks.map((t) => t.depends_on), 0);
  if (cycle) return { ok: false, reason: `Tasks ${cycle.join(" and ")} depend on each other.` };
  // The plan is posted in the order listed and the board takes a dependency
  // only on a task already on it, so a task that waits on one listed AFTER it
  // was refused at posting — after the planner's asks were spent — and the
  // team failed with no worker started. Refused here instead, where the
  // planner is asked again.
  const forward = forwardDependencies(tasks, 0);
  if (forward.length) return { ok: false, reason: joinProblems(forward) };
  return { ok: true, tasks, shape, repoMap, ...(clipped.length ? { clipped } : {}), ...(timed ? { timePlan: readTimePlan(timePlanRaw) } : {}) };
}

/** Words a planner may put in `too_short` that mean it is not. */
const NOT_TOO_SHORT = /^(?:null|none|no|false|n\/a|-)$/i;

/** A budgeted plan's `time_plan`, leniently: whatever of it can be read, the rest empty. */
function readTimePlan(raw: unknown): TimePlan {
  const o = isObject(raw) ? raw : {};
  const list = Array.isArray(o.skipped) ? o.skipped : o.skipped === undefined || o.skipped === null ? [] : [o.skipped];
  const skipped: string[] = [];
  for (const item of list) {
    const line = skipLine(item);
    if (!line || skipped.includes(line)) continue;
    skipped.push(line);
    if (skipped.length >= MAX_TIME_PLAN_SKIPS) break;
  }
  const short = o.too_short ?? o.tooShort;
  const said = typeof short === "string" ? clip(oneLine(short), MAX_SKIP_TEXT_CHARS) : "";
  const tooShort = said && !NOT_TOO_SHORT.test(said) ? said : short === true ? "(no reason given)" : null;
  return { estimateMs: parseEstimateMinutes(o.estimate_minutes ?? o.estimateMinutes ?? o.estimate), skipped, tooShort };
}

/** One skipped item as a line: a string, or `{what, why}` (or `item`/`task`/`name` and `reason`) — "" for anything else. */
function skipLine(item: unknown): string {
  if (typeof item === "string") return clip(oneLine(item), MAX_SKIP_TEXT_CHARS);
  if (!isObject(item)) return "";
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? oneLine(v) : "");
  const what = text(item.what) || text(item.item) || text(item.task) || text(item.name);
  const why = text(item.why) || text(item.reason);
  return what ? clip(why ? `${what} — ${why}` : what, MAX_SKIP_TEXT_CHARS) : "";
}

/** A task's `role` as a planner writes it: "bulk" in any case is bulk; anything else — none, "worker", a word it made up — is a worker's. */
export function readTaskRole(v: unknown): TaskRole {
  return typeof v === "string" && v.trim().toLowerCase() === "bulk" ? "bulk" : "worker";
}

/** "true" in the forms a planner writes it: true, "true", "yes". */
function readOptional(v: unknown): boolean {
  return v === true || (typeof v === "string" && /^(?:true|yes)$/i.test(v.trim()));
}

// ─── Fitting the plan to the time ────────────────────────────────────────────

/** A posted task as `fitPlan` reads it, in the plan's order (most important first). */
export interface FitTask {
  id: string;
  estimateMs?: number | null;
  optional?: boolean;
  dependsOn: readonly string[];
}

export interface PlanFit {
  /** Do the must-have tasks' estimates fit before the safety-margin cutoff (mustHaveFits)? */
  fits: boolean;
  /** …and the whole plan's, its nice-to-haves too? */
  allFit: boolean;
  /** Time left before the cutoff, ms. */
  availableMs: number;
  /** The must-have estimates summed, and the whole plan's, ms. */
  mustMs: number;
  totalMs: number;
  /** How far the must-haves are over the time, ms; 0 when they fit. */
  shortByMs: number;
  /** Tasks with no estimate: they count as nothing, and are never cut for time. */
  unestimated: string[];
  /** What will be skipped to fit, in the order cut: nice-to-haves before must-haves, each from the bottom of the plan; then every task that waits on one cut. */
  cut: string[];
  /** Of `cut`, the tasks cut only because they wait on a task that was. */
  dragged: string[];
}

const hasEstimate = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * A budgeted plan against its time, before any work starts. The must-haves'
 * estimates are summed against the time left before the cutoff
 * (mustHaveFits); when the whole plan does not fit, what goes is cut from the
 * bottom (cutFromBottom) — nice-to-haves first, then the must-haves, each
 * least important first — until the rest fits. The most important must-have,
 * and whatever it waits on, is never cut: the team always starts on
 * something, and the deadline stops it. A task that waits on a cut task could
 * never start, so it is cut too (`dragged`).
 */
export function fitPlan(tasks: readonly FitTask[], budget: TimeBudget, now: number): PlanFit {
  const must = tasks.filter((t) => !t.optional);
  const nice = tasks.filter((t) => t.optional);
  const mustFit = mustHaveFits(budget, now, must.map((t) => t.estimateMs));
  const all = mustHaveFits(budget, now, tasks.map((t) => t.estimateMs));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const kept = new Set<string>();
  const keep = (id: string): void => {
    const t = byId.get(id);
    if (!t || kept.has(id)) return;
    kept.add(id);
    t.dependsOn.forEach(keep);
  };
  const first = must[0] ?? tasks[0];
  if (first) keep(first.id);
  const cut = all.fits
    ? []
    : cutFromBottom([...must, ...nice].filter((t) => !kept.has(t.id)).map((t) => ({ id: t.id, estimateMs: t.estimateMs })), all.shortByMs);
  const gone = new Set(cut);
  const dragged: string[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const t of tasks) {
      if (gone.has(t.id) || !t.dependsOn.some((d) => gone.has(d))) continue;
      gone.add(t.id);
      dragged.push(t.id);
      grew = true;
    }
  }
  return {
    fits: mustFit.fits,
    allFit: all.fits,
    availableMs: all.availableMs,
    mustMs: mustFit.neededMs,
    totalMs: all.neededMs,
    shortByMs: mustFit.shortByMs,
    unestimated: tasks.filter((t) => !hasEstimate(t.estimateMs)).map((t) => t.id),
    cut: [...cut, ...dragged],
    dragged,
  };
}

/** "t3", "t3 and t4", "t3, t4 and t5". */
function idList(ids: readonly string[]): string {
  return ids.length <= 1 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

/**
 * The fit in one English line for the team's log and its time record: the
 * estimates against the time left before the cutoff (in the box's zone), and
 * what will be skipped. It says plainly when the must-have work does not fit.
 */
export function fitLine(fit: PlanFit, budget: TimeBudget, tz: string): string {
  const zone = safeTimeZone(tz);
  const left = `${formatDuration(fit.availableMs)} left before the cutoff at ${formatLocalDeadline(marginCutoffMs(budget), zone)} (${zone})`;
  const n = fit.unestimated.length;
  const unestimated = n ? ` ${idList(fit.unestimated)} gave no estimate and ${n === 1 ? "is" : "are"} not counted.` : "";
  const skipped = fit.cut.length ? `${idList(fit.cut)} will be skipped` : "";
  if (fit.totalMs === 0) return `Time plan: the planner gave no estimates; ${left}.`;
  if (fit.allFit) return `Time plan: the plan fits — estimated ${formatDuration(fit.totalMs)}, ${left}.${unestimated}`;
  if (fit.fits) {
    return `Time plan: the must-have tasks fit (estimated ${formatDuration(fit.mustMs)}, ${left}), but not every nice-to-have${skipped ? `: ${skipped}` : ""}.${unestimated}`;
  }
  return `Time plan: the must-have work does NOT fit — estimated ${formatDuration(fit.mustMs)}, ${left}: ${formatDuration(fit.shortByMs)} short. ${skipped ? `To fit, ${skipped}.` : "Nothing more can be cut: the team starts on its most important task and stops at the cutoff."}${unestimated}`;
}

/** Every dependency of a task (numbered from `t{offset + 1}`) on one listed after it, as the fault the planner or lead must fix. */
function forwardDependencies(tasks: PlannedTask[], offset: number): string[] {
  return tasks.flatMap((t, k) => t.depends_on
    .filter((d) => Number(d.slice(1)) > offset + k + 1)
    .map((d) => `Task t${offset + k + 1} depends on ${d}, which is listed after it; list a task after the tasks it waits for.`));
}

/** A planner's shape, every field checked; all its faults at once. A rationale over its bound is cut, onto `clipped`. */
function parseShape(raw: unknown, clipped: ClippedField[]): { ok: true; shape: TeamShape } | { ok: false; problems: string[] } {
  if (!isObject(raw)) return { ok: false, problems: ["The shape is not an object."] };
  const problems: string[] = [];
  const parallelism = raw.parallelism;
  if (typeof parallelism !== "number" || !Number.isInteger(parallelism) || parallelism < 1 || parallelism > MAX_TEAM_WORKERS) {
    problems.push(`The shape's parallelism is ${JSON.stringify(parallelism ?? null)}; it must be a whole number from 1 to ${MAX_TEAM_WORKERS}.`);
  }
  const review = raw.review;
  if (!(REVIEW_MODES as readonly unknown[]).includes(review)) {
    problems.push(`The shape's review is ${JSON.stringify(review ?? null)}; it must be ${REVIEW_MODES.map((m) => `"${m}"`).join(", ")}.`);
  }
  let rationale = "";
  if (raw.rationale !== undefined && raw.rationale !== null) {
    if (typeof raw.rationale !== "string") problems.push("The shape's rationale is not text.");
    else {
      const full = raw.rationale.trim();
      rationale = clipAtBoundary(full, MAX_RATIONALE_CHARS);
      if (rationale !== full) clipped.push({ task_id: null, field: "rationale", from: full.length, to: rationale.length });
    }
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, shape: { parallelism: parallelism as number, review: review as ReviewMode, rationale } };
}

/**
 * Tasks as a plan (or the lead) listed them, numbered from `t{offset + 1}`,
 * with every fault pushed onto `problems`; only a task whose every field
 * checked out is returned, and the caller refuses the whole answer anyway
 * once anything was wrong. A description over its bound is not a fault: it
 * is cut, onto `clipped`. `checkDependency` says what is wrong with one
 * dependency (`n` is its number, null when the id is not canonical).
 */
function readTasks(items: unknown[], offset: number, problems: string[], clipped: ClippedField[], checkDependency: (d: string, n: number | null, i: number) => string | null, timed = false): PlannedTask[] {
  const tasks: PlannedTask[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>;
    const id = `t${offset + i + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`Task ${id} is not an object.`);
      continue;
    }
    const full = typeof item.task_description === "string" ? item.task_description.trim() : "";
    // Cut, not refused: on the box a plan refused for ~300 characters too
    // many — and its re-ask, longer still — left a team with no task at all.
    const description = clipAtBoundary(full, MAX_TASK_DESCRIPTION_CHARS);
    if (!description) problems.push(`Task ${id} has no task_description.`);
    else if (description !== full) clipped.push({ task_id: id, field: "task_description", from: full.length, to: description.length });
    // No early exit on a bad field either: a task whose depends_on AND
    // files_hint are both malformed must report both, for the same reason the
    // plan reports every task — one fault per planner run is the bug.
    const depends = item.depends_on === undefined ? [] : item.depends_on;
    const validDepends = Array.isArray(depends) && depends.every((d) => typeof d === "string");
    if (!validDepends) problems.push(`Task ${id}'s depends_on is not a list of task ids.`);
    const depends_on = validDepends ? [...new Set(depends as string[])] : [];
    for (const d of depends_on) {
      const n = /^t([1-9][0-9]{0,2})$/.exec(d);
      const fault = checkDependency(d, n ? Number(n[1]) : null, offset + i);
      if (fault) problems.push(fault);
    }
    const hint = item.files_hint === undefined ? [] : item.files_hint;
    const validHint = Array.isArray(hint) && hint.every((f) => typeof f === "string");
    if (!validHint) problems.push(`Task ${id}'s files_hint is not a list of paths.`);
    if (!description || !validDepends || !validHint) continue;
    const task: PlannedTask = { task_description: description, depends_on, files_hint: (hint as string[]).map((f) => f.trim()).filter(Boolean).slice(0, 40) };
    if (timed) {
      // Lenient: an estimate that cannot be read is none, never a fault.
      const estimateMs = parseEstimateMinutes(item.estimate_minutes ?? item.estimateMinutes ?? item.estimate);
      if (estimateMs !== null) task.estimateMs = estimateMs;
      task.priority = offset + i + 1;
      if (readOptional(item.optional)) task.optional = true;
    }
    // Never a fault: a role it does not know is a worker's, like none at all.
    if (readTaskRole(item.role) === "bulk") task.role = "bulk";
    tasks.push(task);
  }
  return tasks;
}

/** How many faults are named before the rest are only counted. */
const MAX_REPORTED_PROBLEMS = 6;

/** Every fault in one sentence the planner can act on, without an unbounded wall of text. */
function joinProblems(problems: string[]): string {
  if (problems.length <= MAX_REPORTED_PROBLEMS) return problems.join(" ");
  const rest = problems.length - MAX_REPORTED_PROBLEMS;
  return `${problems.slice(0, MAX_REPORTED_PROBLEMS).join(" ")} …and ${rest} further ${rest === 1 ? "fault" : "faults"} in the same plan.`;
}

/**
 * The first cycle among tasks' dependencies as their ids, or null: a cycle
 * would wait forever. Task `i` is `t{offset + i + 1}`; a dependency outside
 * the list (a task already on the board, which cannot wait on a new one) is
 * no edge.
 */
function dependencyCycle(dependsOn: string[][], offset: number): string[] | null {
  const state = new Array<0 | 1 | 2>(dependsOn.length).fill(0);
  const stack: number[] = [];
  const visit = (i: number): string[] | null => {
    if (state[i] === 2) return null;
    if (state[i] === 1) {
      const from = stack.indexOf(i);
      return stack.slice(from).map((k) => `t${offset + k + 1}`);
    }
    state[i] = 1;
    stack.push(i);
    for (const d of dependsOn[i]) {
      const k = Number(d.slice(1)) - offset - 1;
      if (k < 0 || k >= dependsOn.length) continue;
      const found = visit(k);
      if (found) return found;
    }
    stack.pop();
    state[i] = 2;
    return null;
  };
  for (let i = 0; i < dependsOn.length; i++) {
    const found = visit(i);
    if (found) return found;
  }
  return null;
}

// ─── The lead ────────────────────────────────────────────────────────────────

/** The lead's one-line reason, as the log keeps it. */
export const MAX_LEAD_NOTE_CHARS = 300;

export const REPLAN_BRIEF = [
  "You are the LEAD of a small coding team working unattended in this folder: the planner that wrote the team's plan, back for a moment because one or more workers have just finished their tasks. You decide ONE thing: does the rest of the plan still fit the goal?",
  "Read what you need, but change NOTHING: you may not edit, create, delete or run anything that writes.",
  'Answer with ONLY a JSON object, no prose before or after: {"add": [task, ...], "retire": ["t4", ...], "note": string}. Every field is optional; {} means the plan stands, and that is the usual answer — change the plan only for a concrete reason.',
  `add: new tasks, each {"task_description": string, "depends_on": ["t1", ...], "files_hint": ["path", ...], "role": "worker" | "bulk"} with a task_description of at most ${MAX_TASK_DESCRIPTION_CHARS} characters (longer text is cut; if a task needs more than that, split it into two tasks), for work the goal needs that no task on the board covers — say, something a finished task revealed. They are numbered after the board's last task in the order you list them, and may depend on any task on the board or on a new one listed before them. The lead adds at most ${MAX_LEAD_ADDS} tasks over the whole team, and a team holds at most ${MAX_TEAM_TASKS}.`,
  `retire: tasks still PENDING that the goal no longer needs — a finished task already did that work, or it turned out to be unnecessary. At most ${MAX_LEAD_RETIRES} over the whole team; a task a worker has started cannot be retired.`,
  `note: why, in one line of at most ${MAX_LEAD_NOTE_CHARS} characters, for the team's log.`,
  "What the team's runs told the lead with team_message — a worker blocked on a missing file, a question only a new task can answer — is listed in full under \"Messages to the lead since your last turn:\", and older messages are among the latest lines of the board you are given: weigh them, and act on them only through add or retire.",
  ...TASK_RULES,
].join(" ");

/**
 * The board as the lead may judge it. A task a worker is being STARTED on
 * (the orchestrator dispatched it, its run is not up yet) still reads
 * `pending` on the board; the orchestrator marks it `in_progress` here, so
 * the lead cannot retire a task out from under the worker about to take it.
 */
export interface ReplanContext {
  tasks: ReadonlyArray<{ task_id: string; status: TaskStatus }>;
  /** Tasks the lead added so far, and retired so far, over the team's life. */
  added: number;
  retired: number;
}

export function replanContext(board: Pick<TeamBoard, "tasks">, starting: ReadonlySet<string> = new Set()): ReplanContext {
  return {
    tasks: board.tasks.map((t) => ({ task_id: t.task_id, status: t.status === "pending" && starting.has(t.task_id) ? "in_progress" : t.status })),
    added: board.tasks.filter((t) => t.origin === "lead").length,
    retired: board.tasks.filter((t) => t.status === "retired").length,
  };
}

/** How much the lead may still change: adds within both bounds, and retires with a pending task to spend them on. */
export function leadRoom(ctx: ReplanContext): { adds: number; retires: number; retirable: string[] } {
  const retirable = ctx.tasks.filter((t) => t.status === "pending").map((t) => t.task_id);
  return {
    adds: Math.max(0, Math.min(MAX_LEAD_ADDS - ctx.added, MAX_TEAM_TASKS - ctx.tasks.length)),
    retires: retirable.length ? Math.max(0, MAX_LEAD_RETIRES - ctx.retired) : 0,
    retirable,
  };
}

/**
 * A line of a worker's result that says it could not do its part: a
 * blocker in its own words, or the refusal the orchestrator appends when
 * the work could not be committed or merged, or never reached the branch.
 * Read at the start of a line, after any list or emphasis marks, as a whole
 * word.
 */
const BLOCKER_LINE = /^(?:(?:BLOCKED|MISSING|[Cc]annot|[Cc]ould not|NOT COMMITTED|NO CHANGE|MERGE CONFLICT|MERGE FAILED)(?![\w-])|[Bb]locked:)/;
/** What a report section with nothing in it says: "Could not finish: nothing." */
const NOTHING = /^(?:none|nothing|n\/a)\b/i;

const bare = (line: string) => line.replace(/^[\s>*_#-]+/, "");

function blockerLine(result: string | null): string | null {
  if (!result) return null;
  const lines = result.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = bare(lines[i]);
    if (!BLOCKER_LINE.test(line)) continue;
    // A worker's final message is asked for "anything you could not finish",
    // and one with nothing to say still writes the words: what the line says
    // after its colon — or, for a heading, on the next line — decides.
    const colon = line.indexOf(":");
    const after = colon < 0 ? "" : line.slice(colon + 1).replace(/^[\s*_]+/, "").trim();
    const heading = /^\s*#/.test(lines[i]) || (colon >= 0 && !after);
    const said = after || (heading ? bare(lines.slice(i + 1).find((l) => l.trim()) ?? "") : "");
    if (!NOTHING.test(said)) return line;
  }
  return null;
}

/** A `team_message` a run sent to the lead after `sinceTs`. */
function isMessageToLead(e: LogEntry, sinceTs: number): boolean {
  return e.type === "message" && e.payload?.to === "lead" && typeof e.payload.text === "string" && e.ts > sinceTs;
}

/**
 * Whether the lead is worth a run for `batch` — the tasks whose workers
 * settled since its last turn. An accepted, clean task with nothing said to
 * the lead leaves the plan as it was, and the lead's usual answer to it is
 * `{}`: ~10–45k tokens and a stall of every new worker, for nothing. It runs
 * when a task of the batch was rejected or failed; when a worker's result
 * names a blocker; when a run sent the lead a message after `sinceTs` (its
 * last turn, or 0: since the team started); or when nothing left can start
 * and the goal is not complete — a dependency chain broke, and only a new
 * task can mend it.
 */
export function leadShouldRun(board: TeamBoard, batch: readonly string[], sinceTs: number): { run: boolean; why: string } {
  const settled = board.tasks.filter((t) => batch.includes(t.task_id));
  const bad = settled.find((t) => t.status === "failed" || t.status === "rejected" || t.review?.verdict === "rejected");
  if (bad) return { run: true, why: `${bad.task_id} ${bad.status === "failed" ? "failed" : "was rejected"}` };
  for (const t of settled) {
    const line = blockerLine(t.result);
    if (line) return { run: true, why: `${t.task_id}'s result says: ${clip(line, 160)}` };
  }
  const message = board.log.find((e) => isMessageToLead(e, sinceTs));
  if (message) return { run: true, why: `${String(message.payload?.from)} sent the lead a message` };
  if (isExhausted(board) && !allComplete(board)) return { run: true, why: "nothing left can start, and the goal is not complete" };
  return { run: false, why: "every task settled clean and accepted; no blocker, no message to the lead" };
}

/** How much of a settled task's own result the lead is shown — alone; several share the room, never under the floor — and of the goal. */
const LEAD_RESULT_CHARS = 1_000;
const LEAD_MIN_RESULT_CHARS = 200;
const LEAD_GOAL_CHARS = 800;
/** The lead's inbox: each message whole up to here, the section as a whole up to MAX_LEAD_INBOX_CHARS, the newest kept. */
const LEAD_INBOX_MESSAGE_CHARS = 600;
export const MAX_LEAD_INBOX_CHARS = 2_000;
const INBOX_LABEL = "Messages to the lead since your last turn:";
const RESULT_LABEL = "Its worker's result:\n";

/**
 * Every message a run sent the lead since its last turn that gave a usable
 * answer (`board.lastLeadAt`),
 * oldest first, as `- <role> <run> (task tN): <text>` — the text whole up to
 * LEAD_INBOX_MESSAGE_CHARS, where the digest keeps a line of the last few
 * log entries. Over `maxChars` the OLDEST go, and a line says how many.
 */
function leadInbox(board: TeamBoard, maxChars: number): string {
  if (maxChars <= INBOX_LABEL.length + 1) return "";
  // `?? 0`: a board built before the inbox has no lastLeadAt, and every message is new to its lead.
  const since = board.lastLeadAt ?? 0;
  const lines = board.log
    .filter((e) => isMessageToLead(e, since))
    .map((e) => `- ${e.actor.kind} ${String(e.payload?.from)}${e.task_id ? ` (task ${e.task_id})` : ""}: ${clip(String(e.payload?.text).replace(/\s+/g, " ").trim(), LEAD_INBOX_MESSAGE_CHARS)}`);
  if (!lines.length) return clip(`${INBOX_LABEL} (none)`, maxChars);
  for (let dropped = 0; dropped < lines.length; dropped++) {
    const note = dropped ? [`(${dropped} older ${dropped === 1 ? "message" : "messages"} left out)`] : [];
    const text = [INBOX_LABEL, ...note, ...lines.slice(dropped)].join("\n");
    if (text.length <= maxChars) return text;
  }
  // Not even the newest fits whole: the newest, cut.
  return clip([INBOX_LABEL, lines[lines.length - 1]].join("\n"), maxChars);
}

/**
 * The lead's task text: every task of the batch that settled since its last
 * turn and how, each one's result, what it may still change, the goal, the
 * messages sent to the lead since its last turn, and the board's digest in
 * whatever room is left — all inside the run route's cap. One settled task's
 * result is shown as it always was; several share the room the rest leaves.
 */
export function leadTask(board: TeamBoard, settledTaskIds: readonly string[], ctx: ReplanContext): string {
  const room = leadRoom(ctx);
  const settled = settledTaskIds.map((id) => {
    const task = board.tasks.find((t) => t.task_id === id);
    const verdict = task?.review ? `, ${task.review.verdict}${task.review.verdict === "rejected" && task.review.notes ? `: ${clip(task.review.notes, 300)}` : ""}` : "";
    return {
      line: task ? `Task ${task.task_id} just settled (${task.status}${verdict}): ${clip(task.task_description, 400)}` : `Task ${id} just settled.`,
      result: task?.result?.trim() || "",
    };
  });
  const tail = [
    `What you may change: add ${room.adds} more task(s)${room.adds ? ` (numbered from t${ctx.tasks.length + 1})` : ""}; retire ${room.retires} more${room.retires ? ` — pending now: ${room.retirable.join(", ")}` : ""}. Answer with ONLY the JSON object your brief describes; {} if the plan stands.`,
    `Team goal: ${clip(board.goal, LEAD_GOAL_CHARS)}`,
  ];
  const inbox = leadInbox(board, MAX_LEAD_INBOX_CHARS);
  const fixed = [...settled.map((s) => `${s.line}\n\n${RESULT_LABEL}`), ...tail, inbox].join("\n\n").length;
  const each = Math.max(LEAD_MIN_RESULT_CHARS, Math.min(LEAD_RESULT_CHARS, Math.floor((MAX_TASK_CHARS - fixed) / Math.max(1, settled.length))));
  const head = [
    ...settled.flatMap((s) => [s.line, `${RESULT_LABEL}${s.result ? clip(s.result, each) : "(none)"}`]),
    ...tail,
  ].join("\n\n");
  // The inbox after the head, cut to the room the head leaves — oldest
  // messages first — so the final cut never takes the newest.
  const box = leadInbox(board, Math.min(MAX_LEAD_INBOX_CHARS, MAX_TASK_CHARS - head.length - 2));
  const withInbox = box ? `${head}\n\n${box}` : head;
  const label = "\n\nThe board (every other task, then the latest alerts and messages):\n";
  const digest = boardDigest(board, settledTaskIds, Math.min(MAX_DIGEST_CHARS, MAX_TASK_CHARS - withInbox.length - label.length));
  const text = digest ? `${withInbox}${label}${digest}` : withInbox;
  return clip(text, MAX_TASK_CHARS);
}

export interface Replan {
  ok: true;
  add: PlannedTask[];
  retire: string[];
  note: string;
  /** Every added task's description cut to its bound; absent when none was. */
  clipped?: ClippedField[];
}

/**
 * The lead's answer, read as strictly as a plan: `{ add, retire, note }`,
 * every field optional, `{}` meaning no change. An added task's description
 * over its bound is cut, as a plan's is. Refused whole — never
 * trimmed to the part that fits — when it breaks a bound: more adds than the
 * team has left, a board over MAX_TEAM_TASKS, more retires than are left, a
 * retirement of a task that is not pending, a dependency on nothing or on a
 * task that failed, new tasks that wait on each other in a cycle, or one
 * that waits on a new task listed after it.
 */
export function parseReplan(text: string | null | undefined, ctx: ReplanContext): Replan | PlanFailure {
  if (!text || !text.trim()) return { ok: false, reason: "The lead answered nothing." };
  const candidate = extractJson(text, isObject);
  if (candidate === null) return { ok: false, reason: "The lead's answer holds no JSON object." };
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "The lead's answer is not valid JSON." };
  }
  if (!isObject(raw)) return { ok: false, reason: "The lead's answer is not a JSON object." };
  const keys = Object.keys(raw);
  // `{}` is "no change"; an object that says NONE of the three is an answer
  // to some other question (a plan, a verdict) and not a no.
  if (keys.length > 0 && !keys.some((k) => k === "add" || k === "retire" || k === "note")) {
    return { ok: false, reason: `The lead's answer has none of add, retire or note (it has ${keys.slice(0, 4).join(", ")}).` };
  }
  const problems: string[] = [];
  const addRaw = raw.add ?? [];
  if (!Array.isArray(addRaw)) problems.push("add is not a list of tasks.");
  const adds: unknown[] = Array.isArray(addRaw) ? addRaw : [];
  const retireRaw = raw.retire ?? [];
  const validRetire = Array.isArray(retireRaw) && retireRaw.every((r) => typeof r === "string");
  if (!validRetire) problems.push("retire is not a list of task ids.");
  const retire = validRetire ? [...new Set((retireRaw as string[]).map((r) => r.trim()))] : [];
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== "string") problems.push("note is not text.");
  const note = typeof raw.note === "string" ? clip(raw.note.trim(), MAX_LEAD_NOTE_CHARS) : "";

  const leftToAdd = Math.max(0, MAX_LEAD_ADDS - ctx.added);
  if (adds.length > leftToAdd) problems.push(`It adds ${adds.length} task(s); the lead adds at most ${MAX_LEAD_ADDS} over the team and has ${leftToAdd} left.`);
  if (ctx.tasks.length + adds.length > MAX_TEAM_TASKS) problems.push(`It adds ${adds.length} task(s) to the board's ${ctx.tasks.length}; a team holds at most ${MAX_TEAM_TASKS}.`);
  const leftToRetire = Math.max(0, MAX_LEAD_RETIRES - ctx.retired);
  if (retire.length > leftToRetire) problems.push(`It retires ${retire.length} task(s); a team retires at most ${MAX_LEAD_RETIRES} and has ${leftToRetire} left.`);

  const onBoard = new Map(ctx.tasks.map((t) => [t.task_id, t]));
  for (const id of retire) {
    const t = onBoard.get(id);
    if (!t) problems.push(`It retires ${id}, which is not on the board.`);
    else if (t.status !== "pending") problems.push(`It retires ${id}, which is ${t.status}; only a pending task may be retired.`);
  }

  // New tasks are numbered after the board's last, in the order listed, and
  // may wait on anything on the board or on each other — but not on a task
  // that failed or was rejected for good: that wait would never end.
  const base = ctx.tasks.length;
  const clipped: ClippedField[] = [];
  const tasks = readTasks(adds, base, problems, clipped, (d, n, i) => {
    const id = `t${i + 1}`;
    if (n === null || n > base + adds.length || n === i + 1) return `Task ${id} depends on ${d}, which is not another task on the board or in this answer.`;
    if (n <= base) {
      const on = onBoard.get(d);
      if (on && (on.status === "failed" || on.status === "rejected")) return `Task ${id} depends on ${d}, which is ${on.status} and will never complete.`;
    }
    return null;
  });
  if (problems.length) return { ok: false, reason: joinProblems(problems) };
  const cycle = dependencyCycle(tasks.map((t) => t.depends_on), base);
  if (cycle) return { ok: false, reason: `Tasks ${cycle.join(" and ")} depend on each other.` };
  // New tasks are posted in the order listed, and the board takes a
  // dependency only on a task already on it: one that waits on a task listed
  // AFTER it would be refused half-way through the change.
  const forward = forwardDependencies(tasks, base);
  if (forward.length) return { ok: false, reason: joinProblems(forward) };
  return { ok: true, add: tasks, retire, note, ...(clipped.length ? { clipped } : {}) };
}

// ─── Reading JSON out of prose ───────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A sentence's end (its stop, and any closing quote or bracket, before a space) or a line break. */
const BOUNDARY = /[.!?]["')\]]*(?=\s)|\n/g;

/**
 * `text` within `max` characters, cut after the last sentence or before the
 * last line break inside the bound — or, when that would keep less than half
 * of it, cut hard and marked "…".
 */
function clipAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  // One character past the bound, so a stop right at it can see the space after it.
  const head = text.slice(0, max + 1);
  let cut = 0;
  BOUNDARY.lastIndex = 0;
  for (let m = BOUNDARY.exec(head); m; m = BOUNDARY.exec(head)) {
    const end = m[0] === "\n" ? m.index : m.index + m[0].length;
    if (end <= max) cut = end;
  }
  const kept = text.slice(0, cut).trimEnd();
  return kept.length >= max / 2 ? kept : clip(text, max);
}

/**
 * The first top-level JSON value in the text that parses and that `wanted`
 * accepts. A fenced block is tried first; otherwise every top-level `[`…`]`
 * and `{`…`}` is a candidate, paired in ONE string-aware pass over the text
 * (a stack of open brackets), so prose like "Plan [draft]:" or a "[note]"
 * after the plan does not swallow the real one the way first-`[` to last-`]`
 * did — and an unbalanced summary costs a single scan, not one per
 * candidate. Top-level only: a task object inside a plan that was cut short
 * is never taken for an answer.
 */
function extractJson(text: string, wanted: (value: unknown) => boolean): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const bodies = fenced ? [fenced[1], text] : [text];
  for (const body of bodies) {
    for (const [start, end] of bracketPairs(body)) {
      const candidate = body.slice(start, end + 1);
      try {
        if (wanted(JSON.parse(candidate))) return candidate;
      } catch {
        // Not this one; the next bracket may be the answer.
      }
    }
  }
  return null;
}

/** Every top-level `[` or `{` with the index of the bracket that closes it, in order, from one pass that skips strings. */
function bracketPairs(text: string): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const open: Array<{ at: number; ch: string }> = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") open.push({ at: i, ch });
    else if (ch === "]" || ch === "}") {
      const top = open.pop();
      if (!top) continue;
      if ((ch === "]") !== (top.ch === "[")) { open.length = 0; continue; }
      if (open.length === 0) pairs.push([top.at, i]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);
  return pairs;
}
