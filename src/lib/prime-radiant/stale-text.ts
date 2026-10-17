/**
 * A page's TEXT after a verification: the claims in the frontmatter are
 * settled by verify.ts, and this keeps the body from saying otherwise.
 *
 *  - "## Key facts": a bullet that states a superseded claim's text becomes
 *    the verified text (on another page, with a link to the page that now
 *    holds the verified claim); the verified page lists its fact once.
 *  - prose: a paragraph that states a superseded value gets a `> **Stale:**`
 *    note under it naming the verified fact. Prose is never rewritten — a
 *    sentence is the owner's or the writer's, and a note says what changed
 *    without guessing at grammar. A note already under the paragraph is
 *    replaced, so a fact verified twice carries one note.
 *
 * A paragraph "states" a superseded claim when it holds the claim's text, or
 * every word and number the old text has and the verified one lacks (the
 * value that changed: "10" in "costs 10 EUR" → "costs 12 EUR") together with
 * more than half of the words the two share (what the fact is about). Only
 * those; a page that mentions the subject without the old value is left
 * alone.
 *
 * Pure.
 */

import { contentWords } from "./subject";

export interface SupersededFact {
  /** The text a claim had (or a retired claim carried) before the verification. */
  before: string;
  /** The verified text. */
  after: string;
}

export interface StaleTextResult {
  body: string;
  /** Key-facts bullets rewritten, added or dropped. */
  keyFacts: number;
  /** Prose paragraphs noted as stale. */
  stale: number;
}

export const STALE_NOTE_PREFIX = "> **Stale:**";
const KEY_FACTS = "key facts";
/** Sections whose lines are no prose to note: the facts list (rewritten instead) and the source list. */
const NOT_PROSE_SECTIONS: ReadonlySet<string> = new Set([KEY_FACTS, "sources"]);

const VERIFIED_ON_RE = /\s+\(verified on \[\[[^\]\n]+\]\]\)\s*$/;

/** Text compared: one space, lower case, no closing full stop, no "(verified on …)" this module added. */
function norm(text: string): string {
  return text.replace(VERIFIED_ON_RE, "").replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!;]+$/, "");
}

/** A wiki link to a vault page (`concepts/x.md` → `[[concepts/x]]`). */
function linkTo(page: string): string {
  return `[[${page.replace(/\.md$/, "")}]]`;
}

/** Quoted for a one-line note: no line breaks, no stray quote marks. */
function quoted(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim().replace(/"/g, "'")}"`;
}

interface Matcher {
  fact: SupersededFact;
  before: string;
  /** Words and numbers the old text has and the verified one lacks. */
  changed: Set<string>;
  /** Words both share. */
  shared: Set<string>;
}

function matcherFor(fact: SupersededFact): Matcher | null {
  const before = norm(fact.before);
  if (before === "" || before === norm(fact.after)) return null;
  const was = contentWords(fact.before);
  const now = contentWords(fact.after);
  return {
    fact,
    before,
    changed: new Set([...was].filter((w) => !now.has(w))),
    shared: new Set([...was].filter((w) => now.has(w))),
  };
}

function statesIt(paragraph: string, m: Matcher): boolean {
  if (norm(paragraph).includes(m.before)) return true;
  if (m.changed.size === 0 || m.shared.size === 0) return false;
  const words = contentWords(paragraph);
  for (const w of m.changed) if (!words.has(w)) return false;
  let common = 0;
  for (const w of m.shared) if (words.has(w)) common++;
  return common * 2 > m.shared.size;
}

const BULLET_RE = /^(\s*[-*+]\s+)(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

export interface ReconcileOptions {
  /** Note stale prose too (default true). False: only the Key facts list follows the claims (a claim's text edited by hand). */
  prose?: boolean;
}

/**
 * `body` with its Key facts and prose brought in line with `facts`. `page` is
 * the page the body is on, `verifiedOn` the page holding the verified claim.
 */
export function reconcileStaleText(
  body: string,
  facts: readonly SupersededFact[],
  page: string,
  verifiedOn: string,
  options: ReconcileOptions = {},
): StaleTextResult {
  const prose = options.prose !== false;
  const here = page === verifiedOn;
  // A verification reads every page: one that cannot state an old value (not its text, not every
  // changed word as a substring — a folded word is a prefix of its original) is passed over unread.
  const flat = here ? "" : body.replace(/\s+/g, " ").toLowerCase();
  const matchers = facts
    .map(matcherFor)
    .filter((m): m is Matcher => m !== null)
    .filter((m) => here || flat.includes(m.before) || (m.changed.size > 0 && [...m.changed].every((w) => flat.includes(w))));
  const result: StaleTextResult = { body, keyFacts: 0, stale: 0 };
  if (matchers.length === 0) return result;
  // A page written with CRLF keeps them: read line by line without the CR, written back with it.
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let section: string | null = null;
  let inFence = false;
  /** Where the Key facts list ends in `out`, once it has a bullet. */
  let factsEnd = -1;
  /** The Key facts bullets of the verified page, as compared. */
  const listed = new Set<string>();
  /** The prose paragraph being read (its lines are in `out` already). */
  let paragraph: string[] = [];
  /** The paragraph that closed last got a note from this pass: an older note under it saying the same goes. */
  let noted = false;
  /** How that note begins (`> **Stale:** this said "…";`): an older one about another fact stays. */
  let notedSaid = "";

  const note = (m: Matcher) =>
    `${STALE_NOTE_PREFIX} this said ${quoted(m.fact.before)}; the verified fact is ${quoted(m.fact.after)}${here ? "" : ` (${linkTo(verifiedOn)})`}`;

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ");
    paragraph = [];
    if (!prose) return;
    const m = matchers.find((x) => statesIt(text, x));
    noted = !!m;
    if (!m) return;
    notedSaid = `${STALE_NOTE_PREFIX} this said ${quoted(m.fact.before)};`;
    out.push("", note(m));
    result.stale++;
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      closeParagraph();
      noted = false;
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      closeParagraph();
      out.push(line);
      continue;
    }
    if (line.startsWith(STALE_NOTE_PREFIX) && paragraph.length === 0) {
      if (noted && line.startsWith(notedSaid)) {
        // Replaced by the note this pass just wrote above it: the blank lines between them go too.
        while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
        continue;
      }
      // An older note naming as verified what is superseded now names the new fact.
      const m = prose ? matchers.find((x) => line.includes(`the verified fact is ${quoted(x.fact.before)}`)) : undefined;
      if (m) {
        out.push(line.replace(`the verified fact is ${quoted(m.fact.before)}`, `the verified fact is ${quoted(m.fact.after)}`));
        result.stale++;
        continue;
      }
      out.push(line);
      continue;
    }
    noted = false;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      closeParagraph();
      noted = false;
      if (heading[1].length <= 2) section = heading[1].length === 2 ? heading[2].toLowerCase() : null;
      out.push(line);
      continue;
    }
    if (section === KEY_FACTS) {
      const bullet = BULLET_RE.exec(line);
      if (bullet) {
        const m = matchers.find((x) => norm(bullet[2]) === x.before);
        if (!m) {
          const key = norm(bullet[2]);
          // The verified text, listed already from a superseded bullet above it: this copy goes.
          if (here && listed.has(key) && matchers.some((x) => norm(x.fact.after) === key)) {
            factsEnd = out.length;
            continue;
          }
          if (here) listed.add(key);
          out.push(line);
        } else {
          const after = m.fact.after.replace(/\s+/g, " ").trim();
          result.keyFacts++;
          if (!here) out.push(`${bullet[1]}${after} (verified on ${linkTo(verifiedOn)})`);
          else if (!listed.has(norm(after))) {
            listed.add(norm(after));
            out.push(`${bullet[1]}${after}`);
          } // else: listed already, the old bullet goes
        }
        factsEnd = out.length;
        continue;
      }
    }
    if (section !== null && NOT_PROSE_SECTIONS.has(section)) {
      out.push(line);
      continue;
    }
    paragraph.push(line);
    out.push(line);
  }
  closeParagraph();

  // The verified page lists its fact in its Key facts, once.
  if (here && factsEnd >= 0) {
    const missing = [...new Set(matchers.map((m) => m.fact.after.replace(/\s+/g, " ").trim()))].filter((w) => !listed.has(norm(w)));
    if (missing.length > 0) {
      out.splice(factsEnd, 0, ...missing.map((w) => `- ${w}`));
      result.keyFacts += missing.length;
    }
  }
  result.body = out.join(eol);
  return result;
}
