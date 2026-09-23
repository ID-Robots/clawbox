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
 * because every task here becomes a worker with a shell.
 *
 * The same planner comes back as the team's LEAD while the team runs, when
 * the owner's `coding_team_dynamic` switch is on: after workers settle — one
 * turn for every task that settled since its last, and only when there is
 * something to decide (`leadShouldRun`) — one short read-only run may add a
 * task or retire one still pending. Its answer is read here too, as
 * strictly, and against the board as it stands.
 */

import { MAX_TASK_CHARS, MAX_TEAM_WORKERS } from "@/lib/coding-agent";
import {
  allComplete,
  boardDigest,
  isExhausted,
  MAX_DIGEST_CHARS,
  MAX_LEAD_ADDS,
  MAX_LEAD_RETIRES,
  MAX_RATIONALE_CHARS,
  MAX_TASK_DESCRIPTION_CHARS,
  MAX_TEAM_TASKS,
  REVIEW_MODES,
  type LogEntry,
  type ReviewMode,
  type TaskStatus,
  type TeamBoard,
  type TeamShape,
} from "@/lib/coding-team-board";

export interface PlannedTask {
  task_description: string;
  depends_on: string[];
  files_hint: string[];
}

/** How a task is written: the planner's rules, and the lead's when it adds one. */
const TASK_RULES = [
  "Each task_description must stand on its own: say what to build or change, in which files, and how the worker verifies it — it is the whole brief that worker gets.",
  `Each task_description must be at most ${MAX_TASK_DESCRIPTION_CHARS} characters. Keep shared context concise; describe disjoint file ownership for parallel work and add an integration task depending on the workers when needed.`,
  "A task that verifies, integrates or reviews the other tasks' output must list EVERY task it checks in depends_on — never fewer: its worker starts from the work merged so far, and a task it does not wait for may not be there yet.",
  "files_hint lists the files or folders the task should touch; the team watches for a worker straying outside it.",
  "When two tasks share a contract — an API shape, a schema, a module path — say in BOTH task_descriptions which task owns it, and that the other task's worker must ask that task's worker for it with team_message (to=\"sibling\") rather than invent it.",
];

export const PLANNER_BRIEF = [
  "You are the PLANNER of a small coding team working unattended in this folder. Your job is to split ONE goal into a few independent, concrete tasks that separate workers will carry out in parallel when independent, each in its own fresh session with no memory of yours.",
  "Read the folder first — map what exists, what the goal touches and what a worker would need to know — but change NOTHING: you may not edit, create, delete or run anything that writes.",
  `Answer with ONLY a JSON object, no prose before or after: {"shape": {"parallelism": 1 to ${MAX_TEAM_WORKERS}, "review": "each" | "final" | "none", "rationale": string}, "tasks": [at most ${MAX_TEAM_TASKS} objects {"task_description": string, "depends_on": ["t1", ...], "files_hint": ["path", ...]}]}.`,
  "Tasks are numbered t1, t2, … in the order you list them; depends_on names EARLIER tasks — listed before it — that a task must wait for. Prefer 2–5 tasks; one task is fine for a small goal.",
  ...TASK_RULES,
  `Size the team to the goal in shape: parallelism is how many workers may run side by side; review is "each" (a reviewer checks every task), "final" (one reviewer checks the merged result at the end) or "none" (only the automatic check that a worker was refused nothing and stayed inside its files); rationale says why in at most ${MAX_RATIONALE_CHARS} characters.`,
  'A one-file fix is ONE task with parallelism 1 and review "final". Tasks on independent files may run in parallel — parallelism up to the number of tasks that can run at once. A migration, or any chain where each step builds on the last, runs serially: parallelism 1, each task depending on the one before.',
  "If the goal cannot be planned as written — it names files or folders that are not there, or turns on a decision only the owner can take — say so in one short team_message to the lead or to the owner's assistant, never for progress or acknowledgements, and still answer with the JSON plan.",
].join(" ");

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

export interface PlanParse {
  ok: true;
  tasks: PlannedTask[];
  /** The team's shape as the planner gave it, or null — a bare array, or no shape: the default team. */
  shape: TeamShape | null;
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
 */
export function parsePlan(text: string | null | undefined): PlanParse | PlanFailure {
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
  let shape: TeamShape | null = null;
  let list: unknown = raw;
  if (!Array.isArray(raw)) {
    if (!isObject(raw)) return { ok: false, reason: "The planner's answer is not a JSON array." };
    list = raw.tasks;
    if (!Array.isArray(list)) return { ok: false, reason: 'The planner\'s answer has no "tasks" array.' };
    // `"shape": null` says what leaving it out says: the default team.
    if (raw.shape !== undefined && raw.shape !== null) {
      const read = parseShape(raw.shape);
      if (read.ok) shape = read.shape;
      else problems.push(...read.problems);
    }
  }
  const items = list as unknown[];
  if (items.length === 0) return { ok: false, reason: "The planner produced no tasks." };
  if (items.length > MAX_TEAM_TASKS) return { ok: false, reason: `The planner produced ${items.length} tasks; a team holds at most ${MAX_TEAM_TASKS}.` };
  // Every task is read before answering, and every fault this plan has is
  // named at once. Returning on the first one taught the planner about t1
  // alone: it would shorten t1, re-answer, and be told about t2 — spending a
  // whole planner run per fault against a budget of a few. A plan is still
  // never repaired here; the planner is simply shown the whole list to fix.
  const tasks = readTasks(items, 0, problems, (d, n, i) => {
    // Canonical ids only — t1, not t01: the board numbers tasks t1…t999 and
    // knows no other spelling, so a plan that said `t01` would post and
    // then never find its dependency.
    if (n === null || n > items.length || n === i + 1) return `Task t${i + 1} depends on ${d}, which is not another task in the plan.`;
    return null;
  });
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
  return { ok: true, tasks, shape };
}

/** Every dependency of a task (numbered from `t{offset + 1}`) on one listed after it, as the fault the planner or lead must fix. */
function forwardDependencies(tasks: PlannedTask[], offset: number): string[] {
  return tasks.flatMap((t, k) => t.depends_on
    .filter((d) => Number(d.slice(1)) > offset + k + 1)
    .map((d) => `Task t${offset + k + 1} depends on ${d}, which is listed after it; list a task after the tasks it waits for.`));
}

/** A planner's shape, every field checked; all its faults at once. */
function parseShape(raw: unknown): { ok: true; shape: TeamShape } | { ok: false; problems: string[] } {
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
      rationale = raw.rationale.trim();
      if (rationale.length > MAX_RATIONALE_CHARS) problems.push(`The shape's rationale has ${rationale.length} characters; the maximum is ${MAX_RATIONALE_CHARS}.`);
    }
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, shape: { parallelism: parallelism as number, review: review as ReviewMode, rationale } };
}

/**
 * Tasks as a plan (or the lead) listed them, numbered from `t{offset + 1}`,
 * with every fault pushed onto `problems`; only a task whose every field
 * checked out is returned, and the caller refuses the whole answer anyway
 * once anything was wrong. `checkDependency` says what is wrong with one
 * dependency (`n` is its number, null when the id is not canonical).
 */
function readTasks(items: unknown[], offset: number, problems: string[], checkDependency: (d: string, n: number | null, i: number) => string | null): PlannedTask[] {
  const tasks: PlannedTask[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>;
    const id = `t${offset + i + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`Task ${id} is not an object.`);
      continue;
    }
    const description = typeof item.task_description === "string" ? item.task_description.trim() : "";
    if (!description) problems.push(`Task ${id} has no task_description.`);
    // The overage is spelled out: "shorten this" left the planner guessing how
    // much, and a planner asked only to shorten has answered longer than before.
    else if (description.length > MAX_TASK_DESCRIPTION_CHARS) problems.push(`Task ${id}'s task_description has ${description.length} characters; the maximum is ${MAX_TASK_DESCRIPTION_CHARS}, so it must lose at least ${description.length - MAX_TASK_DESCRIPTION_CHARS} characters. Shorten this field without dropping its verification requirements.`);
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
    if (description && description.length <= MAX_TASK_DESCRIPTION_CHARS && validDepends && validHint) tasks.push({ task_description: description, depends_on, files_hint: (hint as string[]).map((f) => f.trim()).filter(Boolean).slice(0, 40) });
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
  `add: new tasks, each {"task_description": string, "depends_on": ["t1", ...], "files_hint": ["path", ...]}, for work the goal needs that no task on the board covers — say, something a finished task revealed. They are numbered after the board's last task in the order you list them, and may depend on any task on the board or on a new one listed before them. The lead adds at most ${MAX_LEAD_ADDS} tasks over the whole team, and a team holds at most ${MAX_TEAM_TASKS}.`,
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
 * the work could not be committed or merged. Read at the start of a line,
 * after any list or emphasis marks, as a whole word.
 */
const BLOCKER_LINE = /^(?:(?:BLOCKED|MISSING|[Cc]annot|[Cc]ould not|NOT COMMITTED|MERGE CONFLICT|MERGE FAILED)(?![\w-])|[Bb]locked:)/;
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
 * Every message a run sent the lead since its last turn (`board.lastLeadAt`),
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
}

/**
 * The lead's answer, read as strictly as a plan: `{ add, retire, note }`,
 * every field optional, `{}` meaning no change. Refused whole — never
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
  const tasks = readTasks(adds, base, problems, (d, n, i) => {
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
  return { ok: true, add: tasks, retire, note };
}

// ─── Reading JSON out of prose ───────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
