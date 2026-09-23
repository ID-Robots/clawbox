/**
 * The team's REVIEWER (v1): a read-only run per finished task that answers a
 * verdict — accepted, or rejected with what is wrong — on the worker's
 * merged work. v0's reviewer was a rule (no refusals, no straying); the rule
 * is still applied first and a worker that broke it is rejected without a
 * model, and the model's verdict on a clean run is what the rule could not
 * see: whether the task was actually done.
 *
 * The parser is strict the way the planner's is: a verdict that is not what
 * the reviewer said is never repaired into one, and a garbled answer falls
 * back to the rule with an alert on the board — a review that was not done
 * is not an acceptance.
 */

import { MAX_TASK_CHARS } from "@/lib/coding-agent";

export interface Verdict {
  verdict: "accepted" | "rejected";
  notes: string;
}

export const REVIEWER_BRIEF = [
  "You are the REVIEWER of a small coding team working unattended in this folder. One worker has just finished the task quoted below and its work is already merged into this checkout.",
  "Read the changed files (listed) against the task: was it done as asked, does it build or run as the task's own verification says, did it break anything beside it? Change NOTHING: you may not edit, create, delete or run anything that writes.",
  'Answer with ONLY a JSON object, no prose before or after: {"verdict": "accepted" | "rejected", "notes": string}. Reject only for something concrete — a missing piece of the task, a broken build, a wrong file — and say in notes exactly what the next worker must fix; accept with notes empty or a one-line remark.',
  "Send NO team_message when your verdict is clear: the verdict itself is what the lead reads. Only when it turns on something you cannot settle — the work needs a sibling's output that is not there, or a decision only the owner can take — may you say so in one short team_message to the owner's assistant, never for progress or acknowledgements, and still answer with the JSON object.",
].join(" ");

/**
 * The one reviewer of a team the planner shaped with review `final`: every
 * task already passed the rule, and this run judges the merged result once,
 * as a whole, instead of a reviewer per task.
 */
export const FINAL_REVIEWER_BRIEF = [
  "You are the REVIEWER of a small coding team working unattended in this folder. Every task of the team is finished and merged into this checkout, and you review the merged result ONCE, as a whole.",
  "Read the files the tasks touched against the goal: is the goal met, does it build or run as the tasks' own verification says, did one task break another? Change NOTHING: you may not edit, create, delete or run anything that writes.",
  'Answer with ONLY a JSON object, no prose before or after: {"verdict": "accepted" | "rejected", "notes": string}. Reject only for something concrete — a part of the goal missing, a broken build, a task that undid another — and say in notes exactly what is wrong; accept with notes empty or a one-line remark.',
  "Send NO team_message when your verdict is clear: the verdict itself is what the team reads. Only when it turns on something you cannot settle — a task's output the goal needs that is not there, or a decision only the owner can take — may you say so in one short team_message to the owner's assistant, never for progress or acknowledgements, and still answer with the JSON object.",
].join(" ");

export const MAX_NOTES_CHARS = 2_000;
/** How many changed files the reviewer is told about by name; the rest are counted. */
export const MAX_REVIEW_FILES = 40;
/** How much of the goal the final reviewer is quoted; the board's digest takes the room after it. */
const FINAL_GOAL_CHARS = 1_200;

/** The reviewer's task text: the task, what changed, what the worker said — inside the run route's cap. */
export function reviewerTask(input: { taskId: string; description: string; files: string[]; report: string; goal: string }): string {
  const named = input.files.slice(0, MAX_REVIEW_FILES);
  const more = input.files.length - named.length;
  const text = [
    `Review task ${input.taskId}: ${input.description}`,
    `Team goal, for context: ${input.goal}`,
    input.files.length ? `Files the worker changed:\n${named.map((f) => `- ${f}`).join("\n")}${more > 0 ? `\n- … and ${more} more` : ""}` : "The worker's branch changed no files.",
    `The worker's report:\n${input.report.trim() || "(none)"}`,
  ].join("\n\n");
  return text.length > MAX_TASK_CHARS ? `${text.slice(0, MAX_TASK_CHARS - 1)}…` : text;
}

/**
 * The final reviewer's task text: the goal, where the work is, the files the
 * tasks were given, and the board — each task and what its worker reported —
 * inside the run route's cap. `digest` is built for the room this leaves
 * (`finalReviewRoom`).
 */
export function finalReviewerTask(input: { goal: string; branch: string | null; base: string | null; files: string[]; digest: string }): string {
  const text = [...finalReviewHead(input), `The board — every task, what its worker reported, the latest alerts:\n${input.digest.trim() || "(empty)"}`].join("\n\n");
  return text.length > MAX_TASK_CHARS ? `${text.slice(0, MAX_TASK_CHARS - 1)}…` : text;
}

/** How many characters the final reviewer's task text leaves for the board's digest. */
export function finalReviewRoom(input: { goal: string; branch: string | null; base: string | null; files: string[] }): number {
  const head = finalReviewHead(input).join("\n\n");
  return Math.max(0, MAX_TASK_CHARS - head.length - "\n\nThe board — every task, what its worker reported, the latest alerts:\n".length);
}

function finalReviewHead(input: { goal: string; branch: string | null; base: string | null; files: string[] }): string[] {
  const named = input.files.slice(0, MAX_REVIEW_FILES);
  const more = input.files.length - named.length;
  const goal = input.goal.length > FINAL_GOAL_CHARS ? `${input.goal.slice(0, FINAL_GOAL_CHARS - 1)}…` : input.goal;
  return [
    `Review the team's whole result for its goal: ${goal}`,
    input.branch ? `The merged work is on the team's branch ${input.branch}${input.base ? `, forked from ${input.base}` : ""}, checked out here.` : "The merged work is in this folder.",
    named.length ? `Files the tasks were given:\n${named.map((f) => `- ${f}`).join("\n")}${more > 0 ? `\n- … and ${more} more` : ""}` : "The tasks named no files.",
  ];
}

export function parseVerdict(text: string | null | undefined): { ok: true; verdict: Verdict } | { ok: false; reason: string } {
  if (!text || !text.trim()) return { ok: false, reason: "The reviewer answered nothing." };
  const candidate = extractObject(text);
  if (candidate === null) return { ok: false, reason: "The reviewer's answer holds no JSON object." };
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "The reviewer's answer is not valid JSON." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "The reviewer's answer is not a JSON object." };
  const obj = raw as Record<string, unknown>;
  if (obj.verdict !== "accepted" && obj.verdict !== "rejected") return { ok: false, reason: `The reviewer's verdict is not accepted or rejected (${JSON.stringify(obj.verdict)}).` };
  const notes = typeof obj.notes === "string" ? obj.notes.trim().slice(0, MAX_NOTES_CHARS) : "";
  if (obj.verdict === "rejected" && !notes) return { ok: false, reason: "The reviewer rejected the task without saying why." };
  return { ok: true, verdict: { verdict: obj.verdict, notes } };
}

/** The first `{…}` that parses as an object, fenced or bare, found in ONE string-aware pass. */
function extractObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const bodies = fenced ? [fenced[1], text] : [text];
  for (const body of bodies) {
    for (const [start, end] of bracePairs(body)) {
      const candidate = body.slice(start, end + 1);
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return candidate;
      } catch {
        // Not this one.
      }
    }
  }
  return null;
}

function bracePairs(text: string): Array<[number, number]> {
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
      if (top.ch === "{" && ch === "}") pairs.push([top.at, i]);
    }
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}
