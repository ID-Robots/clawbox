/**
 * What a screenshot in a run's evidence folder actually SHOWED.
 *
 * The browser MCP layer already archives every capture as `shot-NNN.png` and
 * relays the vision model's description to the model — and then the words were
 * gone: they lived in the run's transcript and nowhere a human ever reads. The
 * pull request that ships the work could name the pictures but not say what was
 * in them, which is exactly the gap this item closes.
 *
 * So the description is written down beside the picture, in ONE dotfile rather
 * than a `.txt` per shot: the evidence listing is capped at MAX_ARTIFACTS and a
 * sidecar per screenshot would halve the history the owner can see, while a
 * dotfile is never listed at all (ARTIFACT_NAME_RE demands an alphanumeric
 * first character) and is still there for the pull-request body to read.
 *
 * A LEAF on purpose: node builtins only, no "@/" alias, because it is imported
 * by the stdio MCP process (mcp/lib/guard.ts) as well as by the web server.
 * Nothing here throws — a note that could not be written must never turn a good
 * screenshot into a failed tool call.
 */
import fs from "fs";
import path from "path";

/** Dotfile: never listed as an artifact, never served by the artifacts route. */
export const SHOT_NOTES_FILE = ".shot-notes.json";

/** A run that archives more than this is looping on screenshots, not verifying. */
export const MAX_SHOT_NOTES = 200;

/** One line under a picture in a pull request body, not a transcript. */
export const MAX_NOTE_CHARS = 400;

/** Image names only: the note file describes pictures, and nothing else. */
const SHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}\.(?:png|jpe?g|gif|webp)$/i;

function notesPath(dir: string): string {
  return path.join(dir, SHOT_NOTES_FILE);
}

/**
 * One line of prose, and the ONE barrier between the vision model's answer and
 * the two places this text ends up: a file on disk and a pull-request body.
 *
 * The description is network data — whatever the vision model made of whatever
 * page the run opened — so three things come off it before it is kept:
 *
 *  - CONTROL CHARACTERS. `\s` folds whitespace and leaves the rest, so an ANSI
 *    escape read off a page survived into a file the owner may well `cat` in the
 *    in-app terminal.
 *  - HTML COMMENT MARKERS. The evidence block in a pull-request body is delimited
 *    by comments (`EVIDENCE_BEGIN`/`EVIDENCE_END` in coding-review-visual.ts); a
 *    description of a page that happened to show one would have split the block
 *    and made the next round's replacement rewrite the wrong span.
 *  - LENGTH. One line under a picture, not a transcript.
 */
export function tidyNote(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<!--|-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_CHARS);
}

/** Picture name → what it showed. `{}` for a run that captured nothing. */
export function readShotNotes(dir: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(notesPath(dir), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!SHOT_NAME_RE.test(name) || typeof value !== "string") continue;
      const note = tidyNote(value);
      if (note) out[name] = note;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Record what one archived screenshot showed.
 *
 * Read-modify-write, because the whole map is one small file and the only
 * writer is the run's single MCP child — two runs have two folders. Written to
 * a temp name in the same directory and renamed into place, so a reader that
 * races the write sees the old map or the new one, never half of either.
 */
export function recordShotNote(dir: string, name: string, description: string): void {
  if (!SHOT_NAME_RE.test(name)) return;
  const note = tidyNote(description);
  if (!note) return;
  try {
    const notes = readShotNotes(dir);
    if (!(name in notes) && Object.keys(notes).length >= MAX_SHOT_NOTES) return;
    notes[name] = note;
    const tmp = path.join(dir, `${SHOT_NOTES_FILE}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(notes, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, notesPath(dir));
  } catch {
    // Evidence about evidence: never worth failing the capture that produced it.
  }
}
