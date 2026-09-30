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
 * is not an acceptance. An answer with no JSON object at all is first asked
 * for once more, in the reviewer's own session (`REVIEWER_NUDGE`, TASK-1323).
 */

import { MAX_TASK_CHARS } from "@/lib/coding-agent";

export interface Verdict {
  verdict: "accepted" | "rejected";
  notes: string;
}

/**
 * The closing rule of both briefs. A headless run's answer is the text of its
 * LAST turn only, so a verdict written before a tool call, or followed by a
 * summary, is lost or buried — the "holds no JSON object" alerts of TASK-1323.
 */
const VERDICT_LAST =
  "The verdict object is the LAST thing you write, after your last tool call and any team_message: no summary, sign-off or other prose follows it.";

export const REVIEWER_BRIEF = [
  "You are the REVIEWER of a small coding team working unattended in this folder. One worker has just finished the task quoted below and its work is already merged into this checkout.",
  "Read the changed files (listed) against the task: was it done as asked, does it build or run as the task's own verification says, did it break anything beside it? Change NOTHING: you may not edit, create, delete or run anything that writes.",
  'Answer with ONLY a JSON object, no prose before or after: {"verdict": "accepted" | "rejected", "notes": string}. Reject only for something concrete — a missing piece of the task, a broken build, a wrong file — and say in notes exactly what the next worker must fix; accept with notes empty or a one-line remark.',
  "Send NO team_message when your verdict is clear: the verdict itself is what the lead reads. Only when it turns on something you cannot settle — the work needs a sibling's output that is not there, or a decision only the owner can take — may you say so in one short team_message to the owner's assistant, never for progress or acknowledgements, and still answer with the JSON object.",
  VERDICT_LAST,
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
  VERDICT_LAST,
].join(" ");

/**
 * What a reviewer whose answer carried no verdict object is asked, once, in
 * its own session: short and strict, so the second answer is the object.
 */
export const REVIEWER_NUDGE = 'Answer with the JSON verdict object only, nothing else: {"verdict": "accepted" | "rejected", "notes": string}.';

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
 * tasks were given, the project's own tests when the harness ran them green,
 * and the board — each task and what its worker reported — inside the run
 * route's cap. `digest` is built for the room this leaves
 * (`finalReviewRoom`).
 */
export function finalReviewerTask(input: { goal: string; branch: string | null; base: string | null; files: string[]; tests?: string | null; digest: string }): string {
  const text = [...finalReviewHead(input), `The board — every task, what its worker reported, the latest alerts:\n${input.digest.trim() || "(empty)"}`].join("\n\n");
  return text.length > MAX_TASK_CHARS ? `${text.slice(0, MAX_TASK_CHARS - 1)}…` : text;
}

/** How many characters the final reviewer's task text leaves for the board's digest. */
export function finalReviewRoom(input: { goal: string; branch: string | null; base: string | null; files: string[]; tests?: string | null }): number {
  const head = finalReviewHead(input).join("\n\n");
  return Math.max(0, MAX_TASK_CHARS - head.length - "\n\nThe board — every task, what its worker reported, the latest alerts:\n".length);
}

function finalReviewHead(input: { goal: string; branch: string | null; base: string | null; files: string[]; tests?: string | null }): string[] {
  const named = input.files.slice(0, MAX_REVIEW_FILES);
  const more = input.files.length - named.length;
  const goal = input.goal.length > FINAL_GOAL_CHARS ? `${input.goal.slice(0, FINAL_GOAL_CHARS - 1)}…` : input.goal;
  return [
    `Review the team's whole result for its goal: ${goal}`,
    input.branch ? `The merged work is on the team's branch ${input.branch}${input.base ? `, forked from ${input.base}` : ""}, checked out here.` : "The merged work is in this folder.",
    named.length ? `Files the tasks were given:\n${named.map((f) => `- ${f}`).join("\n")}${more > 0 ? `\n- … and ${more} more` : ""}` : "The tasks named no files.",
    // The reviewer may not run anything; the harness ran the project's own suite on this tree first (TASK-1321).
    ...(input.tests ? [`The harness ran the project's own tests on the merged result and they pass: ${input.tests}.`] : []),
  ];
}

/**
 * A reviewer's answer read as a verdict. `missing` marks the one failure a
 * re-ask can mend (TASK-1323): the answer carries no JSON object at all —
 * nothing, or prose only. An object that is there but wrong (an unknown
 * verdict, a rejection without a reason) is what the reviewer said, and is
 * not asked for again.
 */
export function parseVerdict(text: string | null | undefined): { ok: true; verdict: Verdict } | { ok: false; reason: string; missing?: true } {
  if (!text || !text.trim()) return { ok: false, reason: "The reviewer answered nothing.", missing: true };
  const candidate = extractObject(text);
  if (candidate === null) return { ok: false, reason: "The reviewer's answer holds no JSON object.", missing: true };
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

/** How much of a verdict-less answer the board quotes: enough to see why, inside an alert's one line. */
export const ANSWER_HEAD_CHARS = 200;

/** The start of an answer on one line, quoted — what a reviewer said instead of a verdict, for the board. */
export function answerHead(text: string | null | undefined): string {
  const flat = Array.from((text ?? "").replace(/\s+/g, " ").trim());
  return `"${flat.length > ANSWER_HEAD_CHARS ? `${flat.slice(0, ANSWER_HEAD_CHARS - 1).join("")}…` : flat.join("")}"`;
}

/**
 * The first `{…}` that parses as an object: in a fenced block first — those
 * tagged json before the rest — then anywhere in the answer.
 *
 * Every `{` is a candidate of its own, closed by a string-aware scan that
 * STARTS at it. One pass from the top of the answer read the prose too, and
 * a single stray quote there (a `5"`, a quote cut short) put the verdict
 * itself "inside a string", unseen. A scan gives up as soon as the text
 * cannot be JSON (`closingBrace`), and all the scans of one answer read at
 * most `MAX_SCAN_CHARS` between them — `resultText` is not capped the way
 * the summary is, and an answer past that is one with no object: re-asked.
 */
function extractObject(text: string): string | null {
  let budget = MAX_SCAN_CHARS;
  for (const body of [...fencedBodies(text), text]) {
    for (let start = body.indexOf("{"); start !== -1 && budget > 0; start = body.indexOf("{", start + 1)) {
      const [end, read] = closingBrace(body, start, Math.min(MAX_OBJECT_CHARS, budget));
      budget -= read;
      if (end === -1) continue;
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

/** The inside of every ``` fence, the json-tagged ones (any case) first. An unclosed fence is left to the whole-answer pass. */
function fencedBodies(text: string): string[] {
  const tagged: string[] = [];
  const other: string[] = [];
  for (const [, tag, body] of text.matchAll(/```([\w+-]*)([\s\S]*?)```/g)) {
    (/^json/i.test(tag) ? tagged : other).push(body);
  }
  return [...tagged, ...other];
}

/** The longest `{…}` taken for a verdict: many times one with notes at `MAX_NOTES_CHARS`. */
const MAX_OBJECT_CHARS = 16_000;
/** How many characters the scans of one answer read together: linear in practice, bounded when the answer is not. */
const MAX_SCAN_CHARS = 1_000_000;
/** What JSON allows outside a string: structure, numbers, and the letters of true, false and null. */
const BARE_JSON = new Set(" \t\r\n{}[]:,+-.0123456789eEtrufalsn");

/**
 * Where the `{` at `start` closes — or -1 at brackets that do not pair, a
 * line break inside a string, a character JSON cannot hold outside one (so a
 * `{` in prose or code is dropped within a few characters), or `max`
 * characters read first — and how many characters it read.
 */
function closingBrace(text: string, start: number, max: number): [end: number, read: number] {
  const open: string[] = [];
  let inString = false;
  const stop = Math.min(text.length, start + max);
  let i = start;
  for (; i < stop; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      else if (ch === "\n") return [-1, i - start + 1];
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") open.push(ch);
    else if (ch === "}" || ch === "]") {
      if (open.pop() !== (ch === "}" ? "{" : "[")) return [-1, i - start + 1];
      if (open.length === 0) return [i, i - start + 1];
    } else if (!BARE_JSON.has(ch)) return [-1, i - start + 1];
  }
  return [-1, Math.max(1, i - start)];
}
