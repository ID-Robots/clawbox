/**
 * The contradiction judge's contract: the prompt that carries pairs of claim
 * texts to the Flash model and the tolerant reader of its answer. Pure, so the
 * pass, the deterministic stub and the tests share one shape.
 */

import { redactText } from "./redact";

export const JUDGE_VERDICTS = ["contradiction", "compatible", "unsure"] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];

export const JUDGE_PAIRS_MARKER = "PAIRS (JSON):";

export const JUDGE_SYSTEM_PROMPT = [
  "You check facts in a company wiki for contradictions.",
  "Each item is a pair of statements. Say whether they CONTRADICT: they cannot both be true about the same thing at the same time.",
  "Different invoices, different months, different products or different entities are NOT contradictions. A statement that is merely more specific is not one either.",
  'Answer with a JSON array only, one object per item: [{"i": <n>, "verdict": "contradiction" | "compatible" | "unsure", "why": "<at most 15 words>"}].',
  "No prose before or after the array, no code fence, and exactly one object for every item.",
  "Placeholders like [REDACTED:EMAIL] stand for removed values; never guess them.",
].join("\n");

export function buildJudgePrompt(items: ReadonlyArray<{ a: string; b: string }>): { system: string; user: string } {
  const payload = items.map((it, i) => ({ i, a: it.a, b: it.b }));
  return { system: JUDGE_SYSTEM_PROMPT, user: `${JUDGE_PAIRS_MARKER}\n${JSON.stringify(payload)}` };
}

/** The pairs a judge prompt carries (the stub reads them back). */
export function readJudgeItems(user: string): Array<{ i: number; a: string; b: string }> | null {
  const at = user.indexOf(JUDGE_PAIRS_MARKER);
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(user.slice(at + JUDGE_PAIRS_MARKER.length));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (x): x is { i: number; a: string; b: string } =>
        !!x && typeof x === "object" && Number.isInteger(x.i) && typeof x.a === "string" && typeof x.b === "string",
    );
  } catch {
    return null;
  }
}

/** The answer held no verdict at all: the whole call is worth asking again (smaller). */
export class JudgeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeParseError";
  }
}

export type JudgeAnswer = { verdict: JudgeVerdict; why: string };

/** The words a model has used for each verdict; anything else is no verdict. */
const VERDICT_WORDS: Readonly<Record<string, JudgeVerdict>> = {
  contradiction: "contradiction",
  contradicts: "contradiction",
  contradictory: "contradiction",
  compatible: "compatible",
  consistent: "compatible",
  unsure: "unsure",
  uncertain: "unsure",
  unclear: "unsure",
};

/** Objects tried at most: a long answer full of stray braces costs a bounded walk, not the call. */
const MAX_OBJECT_STARTS = 4_000;
/** Failed starts tolerated (an unbalanced `{` in prose, a truncated tail). */
const MAX_FAILED_STARTS = 64;

/**
 * Every top-level JSON object in `text`, in order, wherever it sits: inside
 * an array, a code fence, prose, one per line. Strings are walked with their
 * escapes, so a brace inside a `why` never ends an object early. An object
 * that does not close (a truncated answer) or does not parse is skipped and
 * the walk resumes just after its opening brace, so the complete objects
 * before and after it are still read.
 */
export function jsonObjectsIn(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let from = 0;
  let starts = 0;
  let failed = 0;
  while (starts < MAX_OBJECT_STARTS && failed < MAX_FAILED_STARTS) {
    const start = text.indexOf("{", from);
    if (start < 0) break;
    starts += 1;
    const end = closingBrace(text, start);
    if (end < 0) {
      failed += 1;
      from = start + 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      failed += 1;
      from = start + 1;
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>);
    from = end + 1;
  }
  return out;
}

function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The objects that may be verdicts: each one that names an index, and the
 * ones nested inside a wrapper that does not (`{"results": [...]}`).
 */
function verdictObjects(objects: readonly Record<string, unknown>[], depth = 0): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const o of objects) {
    if (readIndex(o) !== null || depth >= 3) {
      out.push(o);
      continue;
    }
    const nested: Record<string, unknown>[] = [];
    for (const v of Object.values(o)) {
      for (const x of Array.isArray(v) ? v : [v]) {
        if (x && typeof x === "object" && !Array.isArray(x)) nested.push(x as Record<string, unknown>);
      }
    }
    out.push(...verdictObjects(nested, depth + 1));
  }
  return out;
}

function readIndex(r: Record<string, unknown>): number | null {
  for (const key of ["i", "id", "index", "pair"]) {
    const v = r[key];
    if (typeof v === "number" && Number.isInteger(v)) return v;
    if (typeof v === "string" && /^\s*\d{1,6}\s*$/.test(v)) return Number(v);
  }
  return null;
}

function readVerdict(v: unknown): JudgeVerdict | null {
  if (typeof v !== "string") return null;
  return VERDICT_WORDS[v.trim().toLowerCase()] ?? null;
}

/**
 * The judge's answer read tolerantly: code fences, prose around the JSON,
 * trailing text, a truncated array and extra fields are all survived, and
 * every complete `{i, verdict}` object is taken wherever it sits. One verdict
 * per pair: a pair answered twice with DIFFERENT verdicts is dropped, as is
 * one with an unknown index or verdict — that pair alone fails and is asked
 * again next pass. Throws {@link JudgeParseError} only when the answer holds
 * no verdict at all, so the caller can ask again in a smaller call.
 */
export function parseJudgeResponse(text: string, count: number): Map<number, JudgeAnswer> {
  const out = new Map<number, JudgeAnswer>();
  const conflicted = new Set<number>();
  let readable = 0;
  for (const r of verdictObjects(jsonObjectsIn(text))) {
    const i = readIndex(r);
    const verdict = readVerdict(r.verdict);
    if (i === null || verdict === null) continue;
    if (i < 0 || i >= count) continue;
    readable += 1;
    if (conflicted.has(i)) continue;
    const prior = out.get(i);
    if (prior) {
      if (prior.verdict !== verdict) {
        out.delete(i);
        conflicted.add(i);
      }
      continue;
    }
    const why = typeof r.why === "string" ? redactText(r.why.replace(/\s+/g, " ").trim().slice(0, 200)).text : "";
    out.set(i, { verdict, why });
  }
  if (readable === 0) throw new JudgeParseError("the answer holds no verdict");
  return out;
}
