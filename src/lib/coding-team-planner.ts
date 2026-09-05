/**
 * The Planner of a coding team: what it is told, and how its answer is read.
 *
 * The planner is one read-only headless run (the coding agent's own runner,
 * with a brief that forbids edits) whose final message must be a JSON array
 * of tasks. This module owns that brief and the parser. The parser is
 * strict on purpose: a plan that is not valid JSON, or names a dependency
 * that is not in the plan, or asks for more tasks than a team holds, fails
 * the team with the reason — it is never "repaired" into something the
 * planner did not say, because every task here becomes a worker with a
 * shell.
 */

import { MAX_TASK_CHARS } from "@/lib/coding-agent";
import { MAX_TASK_DESCRIPTION_CHARS, MAX_TEAM_TASKS } from "@/lib/coding-team-board";

export interface PlannedTask {
  task_description: string;
  depends_on: string[];
  files_hint: string[];
}

export const PLANNER_BRIEF = [
  "You are the PLANNER of a small coding team working unattended in this folder. Your job is to split ONE goal into a few independent, concrete tasks that separate workers will carry out one after another, each in its own fresh session with no memory of yours.",
  "Read the folder first — map what exists, what the goal touches and what a worker would need to know — but change NOTHING: you may not edit, create, delete or run anything that writes.",
  `Answer with ONLY a JSON array, no prose before or after, of at most ${MAX_TEAM_TASKS} objects: {"task_description": string, "depends_on": ["t1", ...], "files_hint": ["path", ...]}.`,
  "Tasks are numbered t1, t2, … in the order you list them; depends_on names earlier tasks a task must wait for. Each task_description must stand on its own: say what to build or change, in which files, and how the worker verifies it — it is the whole brief that worker gets. Prefer 2–5 tasks; one task is fine for a small goal.",
  "files_hint lists the files or folders the task should touch; the team watches for a worker straying outside it.",
].join(" ");

/** How much of a planner's wrong answer is quoted back to it. */
const REPLAN_QUOTE_CHARS = 1_500;

/**
 * The second ask, when the planner's final message held no plan — a page of
 * prose about the tasks, a fenced list, a question. Seen on the box: a
 * 43-turn planner that wrote its plan as headings and never the array. The
 * folder is already read, so this run is asked for ONE thing: the array.
 */
export function replanTask(goal: string, previous: string | null | undefined, reason: string): string {
  const quoted = (previous ?? "").trim();
  const text = [
    `Goal: ${goal}`,
    `Your previous answer to this goal was not a plan the team can read (${reason}).`,
    quoted ? `This is what you answered:\n${quoted.length > REPLAN_QUOTE_CHARS ? `${quoted.slice(0, REPLAN_QUOTE_CHARS - 1)}…` : quoted}` : "You answered nothing.",
    "Answer again with ONLY the JSON array of tasks described in your brief — no prose before or after it. Read the folder again only if you must.",
  ].join("\n\n");
  return text.length > MAX_TASK_CHARS ? `${text.slice(0, MAX_TASK_CHARS - 1)}…` : text;
}

export interface PlanParse {
  ok: true;
  tasks: PlannedTask[];
}

export interface PlanFailure {
  ok: false;
  reason: string;
}

/** The JSON array in a planner's final message — fenced or bare, with anything around it ignored. */
export function parsePlan(text: string | null | undefined): PlanParse | PlanFailure {
  if (!text || !text.trim()) return { ok: false, reason: "The planner answered nothing." };
  const candidate = extractArray(text);
  if (candidate === null) return { ok: false, reason: "The planner's answer holds no JSON array." };
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "The planner's answer is not valid JSON." };
  }
  if (!Array.isArray(raw)) return { ok: false, reason: "The planner's answer is not a JSON array." };
  if (raw.length === 0) return { ok: false, reason: "The planner produced no tasks." };
  if (raw.length > MAX_TEAM_TASKS) return { ok: false, reason: `The planner produced ${raw.length} tasks; a team holds at most ${MAX_TEAM_TASKS}.` };
  const tasks: PlannedTask[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    const id = `t${i + 1}`;
    if (!item || typeof item !== "object") return { ok: false, reason: `Task ${id} is not an object.` };
    const description = typeof item.task_description === "string" ? item.task_description.trim() : "";
    if (!description) return { ok: false, reason: `Task ${id} has no task_description.` };
    if (description.length > MAX_TASK_DESCRIPTION_CHARS) return { ok: false, reason: `Task ${id}'s description is too long.` };
    const depends = item.depends_on === undefined ? [] : item.depends_on;
    if (!Array.isArray(depends) || !depends.every((d) => typeof d === "string")) return { ok: false, reason: `Task ${id}'s depends_on is not a list of task ids.` };
    const depends_on = [...new Set(depends as string[])];
    for (const d of depends_on) {
      // Canonical ids only — t1, not t01: the board numbers tasks t1…t999 and
      // knows no other spelling, so a plan that said `t01` would post and
      // then never find its dependency.
      const n = /^t([1-9][0-9]{0,2})$/.exec(d);
      if (!n || Number(n[1]) >= i + 1) return { ok: false, reason: `Task ${id} depends on ${d}, which is not an earlier task.` };
    }
    const hint = item.files_hint === undefined ? [] : item.files_hint;
    if (!Array.isArray(hint) || !hint.every((f) => typeof f === "string")) return { ok: false, reason: `Task ${id}'s files_hint is not a list of paths.` };
    tasks.push({ task_description: description, depends_on, files_hint: (hint as string[]).map((f) => f.trim()).filter(Boolean).slice(0, 40) });
  }
  return { ok: true, tasks };
}

/**
 * The first JSON array in the text that parses. A fenced block is tried
 * first; otherwise every `[` is a candidate, paired with its `]` in ONE
 * string-aware pass over the text (a stack of open brackets), so prose like
 * "Plan [draft]:" or a "[note]" after the array does not swallow the real
 * one the way first-`[` to last-`]` did — and an unbalanced summary costs a
 * single scan, not one per candidate.
 */
function extractArray(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const bodies = fenced ? [fenced[1], text] : [text];
  for (const body of bodies) {
    for (const [start, end] of bracketPairs(body)) {
      const candidate = body.slice(start, end + 1);
      try {
        if (Array.isArray(JSON.parse(candidate))) return candidate;
      } catch {
        // Not this one; the next `[` may be the array.
      }
    }
  }
  return null;
}

/** Every `[` with the index of the `]` that closes it, in order of the `[`, from one pass that skips strings. */
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
      if (ch === "]") pairs.push([top.at, i]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);
  return pairs;
}
