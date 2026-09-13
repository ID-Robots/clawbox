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
 * page the run opened, and a page can perfectly well DISPLAY the thing this has
 * to survive — so three things come off it before it is kept:
 *
 *  - CONTROL CHARACTERS. `\s` folds whitespace and leaves the rest, so an ANSI
 *    escape read off a page survived into a file the owner may well `cat` in the
 *    in-app terminal.
 *  - ANGLE BRACKETS, both of them, and not the comment markers they spell. The
 *    evidence block in a pull-request body is delimited by HTML comments
 *    (`EVIDENCE_BEGIN`/`EVIDENCE_END` in coding-review-visual.ts), so a
 *    description carrying one would split the block and make the next round's
 *    replacement rewrite the wrong span. Stripping the MARKERS cannot be done in
 *    one pass — removing `<!--` from `<!<!----->` leaves another one behind, and
 *    `--!>` closes a comment too — and a sanitiser that needs a fixpoint loop is
 *    a sanitiser with a bug waiting in it. With neither `<` nor `>` present no
 *    comment and no tag can be formed at all, which is complete by construction;
 *    a written description loses nothing a reader needs.
 *  - LENGTH. One line under a picture, not a transcript.
 */
export function tidyNote(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_CHARS);
}

/**
 * The most this file may be before it is read at all.
 *
 * `recordShotNote` cannot write more than MAX_SHOT_NOTES entries of a bounded
 * name and a bounded note — a few tens of kilobytes — but the run's own file
 * tools reach its evidence folder, so the file on disk is not only ours. This
 * read happens on the web server's thread while a pull-request body is built,
 * and `readFileSync` + `JSON.parse` of an arbitrarily large file is the whole
 * event loop. Four times the worst honest size, and past it the answer is "no
 * evidence" rather than a stall.
 */
export const MAX_NOTES_FILE_BYTES = 4 * MAX_SHOT_NOTES * (100 + MAX_NOTE_CHARS);

/**
 * The bytes of the note file, or null when there are too many of them.
 *
 * ONE open handle, never stat-then-read — the `vision/describe` route's rule,
 * and for its reason: the run whose folder this is can rewrite the file between
 * the two calls, so a size checked on the path says nothing about the size read
 * from it. At most MAX_NOTES_FILE_BYTES + 1 bytes ever enter this process, and
 * that one extra byte IS the verdict: it can only arrive from a file over the
 * ceiling.
 */
function readNotesFile(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(MAX_NOTES_FILE_BYTES + 1);
    let filled = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, filled, buffer.length - filled, null);
      if (read === 0) break;
      filled += read;
      if (filled >= buffer.length) return null;
    }
    return buffer.subarray(0, filled).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing left to do about a descriptor that will not close.
      }
    }
  }
}

/** Picture name → what it showed. `{}` for a run that captured nothing. */
export function readShotNotes(dir: string): Record<string, string> {
  const raw = readNotesFile(notesPath(dir));
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!SHOT_NAME_RE.test(name) || typeof value !== "string") continue;
      const note = tidyNote(value);
      if (!note) continue;
      out[name] = note;
      // The same ceiling the writer keeps, applied to a file the writer may not
      // have been the only author of.
      if (Object.keys(out).length >= MAX_SHOT_NOTES) break;
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
