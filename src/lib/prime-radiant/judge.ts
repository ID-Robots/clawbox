/**
 * The contradiction judge's contract: the prompt that carries pairs of claim
 * texts to the Flash model and the strict reader of its answer. Pure, so the
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

/** The judge's answer read strictly: verdicts by item index; anything malformed is simply absent. */
export function parseJudgeResponse(text: string, count: number): Map<number, { verdict: JudgeVerdict; why: string }> {
  const out = new Map<number, { verdict: JudgeVerdict; why: string }>();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const i = r.i;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= count || out.has(i)) continue;
    if (typeof r.verdict !== "string" || !(JUDGE_VERDICTS as readonly string[]).includes(r.verdict)) continue;
    const why = typeof r.why === "string" ? redactText(r.why.replace(/\s+/g, " ").trim().slice(0, 200)).text : "";
    out.set(i, { verdict: r.verdict as JudgeVerdict, why });
  }
  return out;
}
