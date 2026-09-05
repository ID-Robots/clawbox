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

export interface Verdict {
  verdict: "accepted" | "rejected";
  notes: string;
}

export const REVIEWER_BRIEF = [
  "You are the REVIEWER of a small coding team working unattended in this folder. One worker has just finished the task quoted below and its work is already merged into this checkout.",
  "Read the changed files (listed) against the task: was it done as asked, does it build or run as the task's own verification says, did it break anything beside it? Change NOTHING: you may not edit, create, delete or run anything that writes.",
  'Answer with ONLY a JSON object, no prose before or after: {"verdict": "accepted" | "rejected", "notes": string}. Reject only for something concrete — a missing piece of the task, a broken build, a wrong file — and say in notes exactly what the next worker must fix; accept with notes empty or a one-line remark.',
].join(" ");

export const MAX_NOTES_CHARS = 2_000;

/** The reviewer's task text: the task, what changed, what the worker said. */
export function reviewerTask(input: { taskId: string; description: string; files: string[]; report: string; goal: string }): string {
  return [
    `Review task ${input.taskId}: ${input.description}`,
    `Team goal, for context: ${input.goal}`,
    input.files.length ? `Files the worker changed:\n${input.files.map((f) => `- ${f}`).join("\n")}` : "The worker's branch changed no files.",
    `The worker's report:\n${input.report.trim() || "(none)"}`,
  ].join("\n\n");
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
