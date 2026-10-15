#!/usr/bin/env node
// CLAUDE.md → docs/agents/: nothing is lost on the way.
//
// CLAUDE.md loads into every Claude Code session and agent that starts in this
// repository or one of its worktrees — the maintainers' and the teammates'
// (the box's own Coding Agent runs with `--setting-sources user` and does not
// read it) — so it is kept a short MAP, and the per-area notes live in
// docs/agents/<area>.md. The move out of the long
// form was made paragraph by paragraph, VERBATIM, and this is the proof:
//
//   node scripts/check-claude-md-no-loss.mjs <base-ref>
//
// splits `git show <base-ref>:CLAUDE.md` into its units — every paragraph,
// every top-level bullet with its continuation lines, every heading — and
// fails, naming each one, unless every unit appears verbatim, as whole lines,
// in this tree's CLAUDE.md or some docs/agents/*.md. A heading may change level (`###` in the
// long form, `##` in an area file); its text may not.
//
// It only has work to do while <base-ref>'s CLAUDE.md is still the LONG form
// (over MAP_MAX_BYTES, or a line over MAP_MAX_LINE). Once the base is the map
// itself, a unit missing from the head is an ordinary edit, not a lost note, so
// the check says so and passes. CI runs it on every pull request INTO BETA,
// against the PR's base, which is what makes a rebase of the move prove
// itself: a paragraph beta gained meanwhile must land somewhere before the PR
// is green. Not into main: main keeps the long form until a release carries
// the map there, and paragraphs beta has since edited would read as lost.
//
// The same two numbers are the forward guard (src/tests/unit/claude-md-map.test.ts).
//
// Exit 0 when nothing is missing (or there was nothing to verify), 1 when a
// unit is missing, 2 on a usage or git error.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The map's size cap, in bytes of UTF-8. */
export const MAP_MAX_BYTES = 40_000;
/** The longest line the map may carry, in characters. */
export const MAP_MAX_LINE = 600;
/** Where every note that is not map material goes. */
export const AGENT_DOCS_DIR = "docs/agents";

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM_RE = /^(?:[-*+]|\d+[.)])\s/;

/**
 * The units of a markdown text, in order, each with the 1-based line it starts on.
 *
 * A blank line ends a unit. A heading or an HTML comment line is a unit of its
 * own. A list item at column 0 starts a new unit; an indented line — a nested
 * item or a wrapped continuation — belongs to the unit above it, and so does a
 * column-0 line that is not a list item (a hard-wrapped paragraph).
 */
export function splitUnits(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const units = [];
  let current = null;
  const close = () => {
    if (current) units.push({ line: current.line, text: current.lines.join("\n"), heading: null });
    current = null;
  };
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") {
      close();
      return;
    }
    const heading = HEADING_RE.exec(raw);
    if (heading) {
      close();
      units.push({ line, text: raw, heading: heading[2] });
      return;
    }
    // A one-line HTML comment (the Next.js block's markers) is a unit of its
    // own. Plain string tests, not a tag regex: this splits lines, it filters
    // nothing, and a comment spread over lines is simply paragraph text here.
    if (raw.startsWith("<!--") && raw.trimEnd().endsWith("-->")) {
      close();
      units.push({ line, text: raw, heading: null });
      return;
    }
    if (current && !LIST_ITEM_RE.test(raw)) {
      current.lines.push(raw);
      return;
    }
    close();
    current = { line, lines: [raw] };
  });
  close();
  return units;
}

/** The heading texts of a markdown text, level dropped. */
function headingsOf(text) {
  const found = new Set();
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = HEADING_RE.exec(raw);
    if (heading) found.add(heading[2]);
  }
  return found;
}

/**
 * Whether `text` occurs in `doc` as WHOLE lines — starting a line and ending
 * one — so a bullet that survives only as the start of an edited line, or a
 * sentence quoted inside another paragraph, does not count as kept.
 */
function containsWholeLines(doc, text) {
  for (let at = doc.indexOf(text); at !== -1; at = doc.indexOf(text, at + 1)) {
    const end = at + text.length;
    if ((at === 0 || doc[at - 1] === "\n") && (end === doc.length || doc[end] === "\n")) return true;
  }
  return false;
}

/**
 * The units of `baseText` that appear nowhere in `docs` (the texts of the
 * map and the area files): a paragraph or bullet by its exact text, as whole
 * lines; a heading by its text, at any level.
 */
export function missingUnits(baseText, docs) {
  const texts = docs.map((doc) => doc.replace(/\r\n?/g, "\n"));
  const headings = new Set(texts.flatMap((doc) => [...headingsOf(doc)]));
  return splitUnits(baseText).filter((unit) =>
    unit.heading !== null
      ? !headings.has(unit.heading)
      : !texts.some((doc) => containsWholeLines(doc, unit.text)),
  );
}

/** Whether a CLAUDE.md is still the long form: over the cap, or a line over the limit. */
export function isLongForm(text) {
  return (
    Buffer.byteLength(text, "utf8") > MAP_MAX_BYTES ||
    text.split("\n").some((line) => line.length > MAP_MAX_LINE)
  );
}

/** CLAUDE.md and every docs/agents/*.md under `root`, as `{ file, text }`. */
export function readAgentDocs(root) {
  const dir = path.join(root, AGENT_DOCS_DIR);
  const areaFiles = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort()
    : [];
  return [
    "CLAUDE.md",
    ...areaFiles.map((name) => `${AGENT_DOCS_DIR}/${name}`),
  ].map((file) => ({ file, text: fs.readFileSync(path.join(root, file), "utf8") }));
}

function preview(text) {
  const first = text.split("\n")[0];
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}

function main(argv) {
  const [baseRef] = argv;
  // A ref that starts with "-" would reach git as an option.
  if (!baseRef || argv.length > 1 || baseRef.startsWith("-")) {
    console.error("usage: node scripts/check-claude-md-no-loss.mjs <base-ref>");
    return 2;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let baseText;
  try {
    baseText = execFileSync("git", ["show", `${baseRef}:CLAUDE.md`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.error(`check-claude-md-no-loss: cannot read CLAUDE.md at ${baseRef}: ${String(error.stderr || error.message).trim()}`);
    return 2;
  }
  const baseBytes = Buffer.byteLength(baseText, "utf8");
  if (!isLongForm(baseText)) {
    console.log(
      `check-claude-md-no-loss: CLAUDE.md at ${baseRef} is already the short map (${baseBytes} bytes, ` +
        `no line over ${MAP_MAX_LINE} characters) — nothing was moved out of it, so there is nothing to verify.`,
    );
    return 0;
  }
  const docs = readAgentDocs(root);
  const units = splitUnits(baseText);
  const missing = missingUnits(baseText, docs.map((doc) => doc.text));
  const headingCount = units.filter((unit) => unit.heading !== null).length;
  const summary =
    `${units.length} units (${units.length - headingCount} paragraphs/bullets, ${headingCount} headings, ` +
    `${baseBytes} bytes) in CLAUDE.md at ${baseRef}; searched ${docs.length} files ` +
    `(CLAUDE.md + ${docs.length - 1} under ${AGENT_DOCS_DIR}/, ` +
    `${docs.reduce((sum, doc) => sum + Buffer.byteLength(doc.text, "utf8"), 0)} bytes)`;
  if (missing.length === 0) {
    console.log(`check-claude-md-no-loss: OK — ${summary}; every unit appears verbatim.`);
    return 0;
  }
  console.error(`check-claude-md-no-loss: ${missing.length} of ${summary} appear nowhere:`);
  for (const unit of missing) {
    console.error(`  CLAUDE.md:${unit.line} (${unit.text.length} chars): ${preview(unit.text)}`);
  }
  console.error(
    `Move each one VERBATIM into ${AGENT_DOCS_DIR}/<area>.md (or keep it in CLAUDE.md if it is map material) — ` +
      "an edit to its text belongs in a later pull request.",
  );
  return 1;
}

// Run as a command, not imported. Both sides with symlinks resolved (the
// public-hygiene.mjs rule): Node resolves them for the module's own URL, and a
// path through a linked folder must not turn the check into a silent pass.
const invokedAs = (arg) => {
  try {
    return pathToFileURL(fs.realpathSync(path.resolve(arg))).href;
  } catch {
    return null;
  }
};
if (process.argv[1] && invokedAs(process.argv[1]) === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href) {
  process.exitCode = main(process.argv.slice(2));
}
