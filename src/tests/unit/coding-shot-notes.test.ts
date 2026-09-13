/**
 * What an archived screenshot showed (src/lib/coding-shot-notes.ts).
 *
 * The file is a DOTFILE on purpose: the artifacts listing is capped, and a
 * `.txt` beside every picture would have halved the evidence an owner can see.
 * So the two facts pinned hardest here are that nothing it writes is ever
 * listed as an artifact, and that nothing it is handed can throw.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { MAX_NOTE_CHARS, MAX_SHOT_NOTES, readShotNotes, recordShotNote, SHOT_NOTES_FILE, tidyNote } from "@/lib/coding-shot-notes";
import { ARTIFACT_NAME_RE } from "@/lib/coding-agent-artifacts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-notes-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

it("is a dotfile, so the evidence listing never shows it", () => {
  expect(ARTIFACT_NAME_RE.test(SHOT_NOTES_FILE)).toBe(false);
});

it("answers {} for a folder that has none, and for a file that is not JSON", () => {
  expect(readShotNotes(dir)).toEqual({});
  fs.writeFileSync(path.join(dir, SHOT_NOTES_FILE), "not json at all");
  expect(readShotNotes(dir)).toEqual({});
  fs.writeFileSync(path.join(dir, SHOT_NOTES_FILE), "[1,2,3]");
  expect(readShotNotes(dir)).toEqual({});
});

it("records a picture's description as one line", () => {
  recordShotNote(dir, "shot-001.png", "  The confirm dialog,\n  with the button below the fold.  ");
  expect(readShotNotes(dir)).toEqual({ "shot-001.png": "The confirm dialog, with the button below the fold." });
  // 0600: the folder's own mode is the fence, but nothing here needs to be wider.
  expect(fs.statSync(path.join(dir, SHOT_NOTES_FILE)).mode & 0o777).toBe(0o600);
});

it("keeps the newest description for a name and leaves the others alone", () => {
  recordShotNote(dir, "shot-001.png", "empty state");
  recordShotNote(dir, "shot-002.png", "filled state");
  recordShotNote(dir, "shot-001.png", "empty state, corrected");
  expect(readShotNotes(dir)).toEqual({ "shot-001.png": "empty state, corrected", "shot-002.png": "filled state" });
});

it("takes picture names only, and nothing a traversal could ride on", () => {
  for (const name of ["report.md", "../escape.png", "sub/shot.png", ".hidden.png", "shot-001.PNG.txt"]) {
    recordShotNote(dir, name, "should not be recorded");
  }
  expect(readShotNotes(dir)).toEqual({});
  recordShotNote(dir, "shot-001.JPEG", "case does not matter");
  expect(readShotNotes(dir)["shot-001.JPEG"]).toBe("case does not matter");
});

it("drops an empty description rather than recording a blank line", () => {
  recordShotNote(dir, "shot-001.png", "   \n  ");
  expect(readShotNotes(dir)).toEqual({});
});

it("trims a description to what a pull request body can hold", () => {
  recordShotNote(dir, "shot-001.png", "x".repeat(MAX_NOTE_CHARS + 200));
  expect(readShotNotes(dir)["shot-001.png"]).toHaveLength(MAX_NOTE_CHARS);
  expect(tidyNote(" a \n b ")).toBe("a b");
});

it("stops growing at the cap, while still correcting names already in it", () => {
  for (let i = 0; i < MAX_SHOT_NOTES + 5; i += 1) recordShotNote(dir, `shot-${String(i).padStart(3, "0")}.png`, `state ${i}`);
  const notes = readShotNotes(dir);
  expect(Object.keys(notes)).toHaveLength(MAX_SHOT_NOTES);
  recordShotNote(dir, "shot-000.png", "state 0, corrected");
  expect(readShotNotes(dir)["shot-000.png"]).toBe("state 0, corrected");
});

it("never throws over a folder it cannot write", () => {
  expect(() => recordShotNote(path.join(dir, "gone"), "shot-001.png", "anything")).not.toThrow();
  expect(readShotNotes(path.join(dir, "gone"))).toEqual({});
});
