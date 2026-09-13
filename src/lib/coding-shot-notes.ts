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

/** One line of prose: newlines folded, trimmed to what a body can hold. */
export function tidyNote(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
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
