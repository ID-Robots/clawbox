/**
 * Lessons from earlier verified runs: the box side of the training loop
 * (TASK-1348).
 *
 * WHERE THEY COME FROM. ID-Robots/clawbox-training-cluster runs this coding
 * agent on a cluster of lab Nanos, grades every run with an execution
 * verifier, and keeps what it learns in an experience store — one-line
 * imperative rules and a skill document per repository. Its dispatcher picks
 * the part of the store that fits a task (`scripts/query-store.mjs`: the top
 * rules and one repository skill) and hands it to
 * POST /setup-api/coding-agent/run as `experience`, exactly the JSON that
 * script prints:
 *
 *   { "rules": [ { "id": "R0002", "rule": "…", "applies": "clawbox/src/**\/*.tsx",
 *                  "evidence": "https://github.com/…", "score": 4.11 } ],
 *     "skill": "# Skill: ID-Robots/clawbox\n…" }
 *
 * WHAT THE BOX DOES WITH IT, AND NOTHING MORE. Reads it strictly, renders it
 * into one delimited block for the run's system prompt, and says what reached
 * the prompt so the run record can carry it. The box never reads the store
 * itself — not from disk, not from the network: the caller passes it.
 *
 * WHY STRICT. Every string here ends up in the instructions a model follows,
 * so a malformed request is refused at the door with a stable code rather than
 * repaired — the rule `readPipelineInput` and `readDeliverableInput` already
 * hold callers to. A rule is one line, so a line break inside one would let a
 * caller forge a line of the prompt the box never wrote; the skill is a
 * document, so it may break lines but may not carry other control characters.
 * Neither may carry the block's own delimiters, which is what keeps the
 * lessons inside the block they are introduced as.
 *
 * Pure on purpose — no `fs`, no `fetch` — so the route, `startRun` and the
 * tests read the field one way.
 */

/** At most this many rules: the dispatcher sends its top five; ten is the ceiling. */
export const MAX_EXPERIENCE_RULES = 10;
/** The whole rendered block, delimiters included, never exceeds this. */
export const EXPERIENCE_BLOCK_MAX_CHARS = 8_000;
/**
 * Per-field ceilings. Sized so that the most the rules can ever take — ten of
 * them at the longest the reader accepts — still fits the block with room to
 * spare (the unit test proves it), which is what lets the cap be met by
 * trimming the skill alone.
 */
export const MAX_EXPERIENCE_RULE_CHARS = 500;
export const MAX_EXPERIENCE_APPLIES_CHARS = 200;
export const MAX_EXPERIENCE_EVIDENCE_CHARS = 2_000;
/** A skill document longer than this is refused rather than truncated: it is a request that went wrong, not a long document. */
export const MAX_EXPERIENCE_SKILL_CHARS = 100_000;
/** A rule id: R for a rule, C for a candidate, and four digits. */
export const EXPERIENCE_RULE_ID = /^[RC]\d{4}$/;
/** What ends a skill document that had to be cut to fit. */
export const EXPERIENCE_TRUNCATED_MARKER = "…(truncated)";

export const EXPERIENCE_BLOCK_OPEN = "=== LESSONS FROM EARLIER RUNS ===";
export const EXPERIENCE_BLOCK_CLOSE = "=== END OF LESSONS ===";
export const EXPERIENCE_PREAMBLE =
  "Lessons from earlier verified runs on this repository. Follow a rule when its `applies` glob matches a file you touch; ignore it otherwise.";

/** One rule as it reaches the prompt. `evidence` and `score` are checked but never rendered. */
export interface ExperienceRule {
  id: string;
  rule: string;
  applies: string;
}

export interface ExperienceInput {
  rules: ExperienceRule[];
  /** The repository's skill document, or null when the caller sent none. */
  skill: string | null;
}

/** Why an `experience` field was refused, with a stable code beside the sentence. */
export type ExperienceInputRefusal =
  | "not_an_object"
  | "bad_rules"
  | "too_many_rules"
  | "bad_rule"
  | "bad_id"
  | "duplicate_id"
  | "bad_skill";

/**
 * What a caller sent: nothing, a refusal, or the lessons. A result rather than
 * a throw, the shape `readPipelineInput` answers in, so `startRun` decides how
 * a refusal travels.
 */
export type ExperienceInputResult =
  | null
  | { ok: false; code: ExperienceInputRefusal; error: string }
  | { ok: true; experience: ExperienceInput };

/**
 * What the run record carries about the block — the training cluster's metric
 * compares runs with and without the store on this.
 */
export interface RunExperience {
  /** The rules that reached the prompt, in the order they were rendered. */
  ruleIds: string[];
  /** Whether any of the skill document reached the prompt. */
  skill: boolean;
  /** The length of the rendered block, delimiters included. 0 when nothing was rendered. */
  chars: number;
}

export interface RenderedExperience {
  /** The block for the system prompt, or "" when the caller sent nothing to render. */
  text: string;
  record: RunExperience;
}

// A line break of any kind, and the rest of C0 and C1: inside a one-line field
// each of them is a way to start a line of the prompt the box never wrote.
const ONE_LINE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// The same, less the three a markdown document legitimately holds.
const DOCUMENT_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

function refuse(code: ExperienceInputRefusal, error: string): ExperienceInputResult {
  return { ok: false, code, error };
}

function carriesDelimiter(text: string): boolean {
  return text.includes(EXPERIENCE_BLOCK_OPEN) || text.includes(EXPERIENCE_BLOCK_CLOSE);
}

/** A required one-line string, trimmed, or null when it is not one. */
function oneLine(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > max || ONE_LINE_FORBIDDEN.test(value) || carriesDelimiter(value)) return null;
  return value;
}

/**
 * Read a caller's `experience` field.
 *
 * `undefined` and `null` mean the caller sent none — the run is started
 * exactly as it was before this field existed. Keys this reader does not know
 * are ignored rather than refused, so the dispatcher can grow the store's
 * output without every run failing; they never reach the prompt either way,
 * because only `id`, `rule`, `applies` and `skill` are rendered.
 */
export function readExperienceInput(raw: unknown): ExperienceInputResult {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return refuse("not_an_object", "Experience is an object: { rules: [...], skill?: string }.");
  }
  const value = raw as Record<string, unknown>;

  if (!Array.isArray(value.rules)) {
    return refuse("bad_rules", "Experience needs `rules`, a list of rules (it may be empty).");
  }
  if (value.rules.length > MAX_EXPERIENCE_RULES) {
    return refuse("too_many_rules", `Experience carries at most ${MAX_EXPERIENCE_RULES} rules.`);
  }

  const rules: ExperienceRule[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.rules.entries()) {
    const n = index + 1;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return refuse("bad_rule", `Rule ${n} is not an object.`);
    }
    const r = entry as Record<string, unknown>;
    // Exact, not trimmed: an id is a key the cluster joins on, and " R0002" is
    // a different key that would never match its own rule again.
    if (typeof r.id !== "string" || !EXPERIENCE_RULE_ID.test(r.id)) {
      return refuse("bad_id", `Rule ${n}: the id must be R or C followed by four digits, like R0002.`);
    }
    if (seen.has(r.id)) return refuse("duplicate_id", `Rule ${n}: ${r.id} appears twice.`);
    seen.add(r.id);
    const rule = oneLine(r.rule, MAX_EXPERIENCE_RULE_CHARS);
    if (rule === null) {
      return refuse("bad_rule", `Rule ${n} (${r.id}): the rule must be one line of text, at most ${MAX_EXPERIENCE_RULE_CHARS} characters.`);
    }
    const applies = oneLine(r.applies, MAX_EXPERIENCE_APPLIES_CHARS);
    if (applies === null) {
      return refuse("bad_rule", `Rule ${n} (${r.id}): applies must be a one-line glob, at most ${MAX_EXPERIENCE_APPLIES_CHARS} characters.`);
    }
    // Not rendered, but still a string or nothing: a field that is not what
    // the contract says is a sign the request is not what the caller thinks.
    if (r.evidence !== undefined && r.evidence !== null && oneLine(r.evidence, MAX_EXPERIENCE_EVIDENCE_CHARS) === null) {
      return refuse("bad_rule", `Rule ${n} (${r.id}): evidence must be one line of text, at most ${MAX_EXPERIENCE_EVIDENCE_CHARS} characters.`);
    }
    if (r.score !== undefined && r.score !== null && (typeof r.score !== "number" || !Number.isFinite(r.score))) {
      return refuse("bad_rule", `Rule ${n} (${r.id}): score must be a number.`);
    }
    rules.push({ id: r.id, rule, applies });
  }

  let skill: string | null = null;
  if (value.skill !== undefined && value.skill !== null) {
    if (typeof value.skill !== "string") return refuse("bad_skill", "The skill must be a markdown document (a string).");
    if (value.skill.length > MAX_EXPERIENCE_SKILL_CHARS) {
      return refuse("bad_skill", `The skill is too long: at most ${MAX_EXPERIENCE_SKILL_CHARS} characters.`);
    }
    if (DOCUMENT_FORBIDDEN.test(value.skill) || carriesDelimiter(value.skill)) {
      return refuse("bad_skill", "The skill may hold text, tabs and line breaks, and nothing else.");
    }
    skill = value.skill.replace(/\r\n?/g, "\n");
  }

  return { ok: true, experience: { rules, skill } };
}

/**
 * The longest run of WHOLE lines of `skill` that fits `budget` once the
 * truncation marker is added, or "" when not even the first line does.
 */
function fitSkill(skill: string, budget: number): string {
  if (skill.length <= budget) return skill;
  const room = budget - 1 - EXPERIENCE_TRUNCATED_MARKER.length;
  if (room <= 0) return "";
  // The last line break at or before `room`: everything before it is whole
  // lines and no longer than `room`.
  const cut = skill.lastIndexOf("\n", room);
  const kept = cut > 0 ? skill.slice(0, cut).trimEnd() : "";
  return kept ? `${kept}\n${EXPERIENCE_TRUNCATED_MARKER}` : "";
}

function headFor(rules: readonly ExperienceRule[]): string {
  return [
    EXPERIENCE_BLOCK_OPEN,
    EXPERIENCE_PREAMBLE,
    ...rules.map((r) => `- [${r.id}] ${r.rule} (applies: ${r.applies})`),
  ].join("\n");
}

/**
 * The block a run's system prompt carries, and what the record says about it.
 *
 * The rules first, in the caller's order (the dispatcher ranks them), then
 * the skill document. At most EXPERIENCE_BLOCK_MAX_CHARS in all, and the skill
 * gives way first: it is cut at a line boundary and marked, or left out when
 * not one line of it fits. The reader's per-field ceilings keep the rules
 * inside the cap on their own; dropping the lowest-ranked rule is the
 * backstop should those ceilings ever be raised past that.
 */
export function renderExperience(input: ExperienceInput): RenderedExperience {
  const skill = input.skill?.trim() ?? "";
  if (input.rules.length === 0 && !skill) return { text: "", record: { ruleIds: [], skill: false, chars: 0 } };

  const rules = [...input.rules];
  while (rules.length > 0 && headFor(rules).length + 1 + EXPERIENCE_BLOCK_CLOSE.length > EXPERIENCE_BLOCK_MAX_CHARS) rules.pop();
  const head = headFor(rules);
  // head, a blank line, the skill, the close: three line breaks between them.
  const kept = skill ? fitSkill(skill, EXPERIENCE_BLOCK_MAX_CHARS - head.length - EXPERIENCE_BLOCK_CLOSE.length - 3) : "";
  const text = kept ? [head, "", kept, EXPERIENCE_BLOCK_CLOSE].join("\n") : [head, EXPERIENCE_BLOCK_CLOSE].join("\n");
  return { text, record: { ruleIds: rules.map((r) => r.id), skill: kept !== "", chars: text.length } };
}
