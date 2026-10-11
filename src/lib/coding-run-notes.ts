/**
 * A project's RUN NOTES: what earlier coding runs in this project learned, kept
 * where the next run reads it.
 *
 * WHY. Every run starts cold. The one that found out that `tsc` needs
 * `--max-old-space-size=6144` here, that the tests run with `bun run test` and
 * not `npm test`, that the dev server wants port 3100 — it spent turns on it,
 * and so did the run after it, and the one after that. A team paid for the
 * same discovery once per worker.
 *
 * WHERE. `<project>/.clawbox/run-notes.md` — beside the run worktrees and
 * OUTSIDE every one of them (a worktree is removed when its run settles, and a
 * file inside it would leave with it), in the project ROOT a worktree maps back
 * to (`worktreeProject`). `.clawbox/` is in the repository's `info/exclude`
 * (`excludeWorktrees`, the same line the worktrees are kept out of `git status`
 * by), so the notes are never committed by a run's `git add -A` and never
 * touch the project's own `.gitignore`.
 *
 * IN. Every run and every team role gets the notes in its system prompt
 * (`runNotesBlock`, through buildRunArgs), capped at MAX_RUN_NOTES_CHARS, and
 * every writing run the one sentence that says how to add to them
 * (`LESSON_CHANNEL_BRIEF`).
 *
 * OUT. A run PROPOSES a lesson by writing `{"lessons": ["…"]}` to
 * `run-notes.json` in its own evidence folder — a file it may already write,
 * so the channel needs no new permission and no tool. When the run settles,
 * `settleRunNotes` reads it, vets every lesson (`vetLesson`: one line, bounded,
 * no credential shape, no value the run was given as a secret, no e-mail
 * address, no link off the box) and merges what passes, deduplicated, while
 * the file stays under its cap. Refused lessons are dropped, never repaired:
 * a lesson half-scrubbed of a token is a lesson that still points at one.
 *
 * The OWNER reads, edits and clears the file on the project page
 * (`setup-api/coding-agent/run-notes`, `writeRunNotes`, `clearRunNotes`).
 */
import fs from "fs";
import path from "./runtime-path";
import { redactCredentialShapes } from "./incident-sanitize";
import { redactForRun } from "./secret-redact";
import { worktreeProject } from "./coding-worktree-paths";
import { excludeWorktrees } from "./coding-team-worktree";

/** Inside the project: the folder the worktrees already live in. */
export const RUN_NOTES_DIR = ".clawbox";
export const RUN_NOTES_FILE = "run-notes.md";
/** What a run writes in its evidence folder to propose lessons. */
export const LESSONS_FILE = "run-notes.json";
/** The whole file, and so the whole block a run's prompt carries. */
export const MAX_RUN_NOTES_CHARS = 4_000;
/** One lesson, on one line. */
export const MAX_LESSON_CHARS = 300;
/** Shorter than this is a word, not a lesson. */
export const MIN_LESSON_CHARS = 12;
/** Lessons one run may propose. */
export const MAX_LESSONS_PER_RUN = 5;
/** The proposal file is read only up to this size; a bigger one is refused whole. */
const MAX_PROPOSAL_BYTES = 16 * 1024;

export type LessonRefusal = "not_text" | "too_short" | "too_long" | "secret" | "personal" | "link" | "markup" | "duplicate" | "full" | "too_many";

export interface LessonVerdict {
  lesson: string;
  reason: LessonRefusal;
}

/** The notes file of the project `directory` belongs to — a worktree maps back to its project. */
export function runNotesPath(directory: string): string {
  return path.join(notesProjectDir(directory), RUN_NOTES_DIR, RUN_NOTES_FILE);
}

/** The project ROOT a folder belongs to: `<project>` for a run's or a worker's worktree, the folder itself otherwise. */
export function notesProjectDir(directory: string): string {
  return worktreeProject(directory) ?? directory;
}

/**
 * The notes as they stand, "" when there are none. Synchronous: the spawn path
 * that injects them is. Never throws — a run with unreadable notes runs
 * without them — and never answers more than the cap, whatever is on disk.
 */
export function readRunNotes(directory: string): string {
  try {
    if (!ownNotesDir(notesProjectDir(directory), { create: false })) return "";
    // A link could point the box's read at any file the web server can see,
    // and its text would travel into a run's prompt. Bounded: what is past the
    // cap is cut anyway, and a huge file must not be read whole on a spawn.
    const text = readOwnFile(runNotesPath(directory), MAX_RUN_NOTES_CHARS * 4);
    return text === null ? "" : clipNotes(text.replace(/\r\n/g, "\n").trim());
  } catch {
    return "";
  }
}

/**
 * A regular file's text, read through ONE descriptor opened without following
 * a link — the check and the read are the same file, never a name looked at
 * twice — and at most `maxBytes` of it. Null for a link, a non-file or no file.
 */
function readOwnFile(file: string, maxBytes: number, opts: { refuseLarger?: boolean } = {}): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (opts.refuseLarger && stat.size > maxBytes) return null;
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }
}

/**
 * Is `<project>/.clawbox` the project's own folder — a real directory, not a
 * link? A run in a folder project writes that project, and a `.clawbox` it
 * replaced with a link would point the web server's read and write of the
 * notes anywhere the server can reach. With `create`, a missing one is made.
 */
function ownNotesDir(project: string, opts: { create: boolean }): boolean {
  const dir = path.join(project, RUN_NOTES_DIR);
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
    if (!opts.create) return true;
    fs.mkdirSync(dir, { recursive: true });
    return fs.lstatSync(dir).isDirectory();
  }
}

/** Cut at the cap, at a line end where there is one, so a lesson is never half there. */
function clipNotes(text: string): string {
  if (text.length <= MAX_RUN_NOTES_CHARS) return text;
  const cut = text.slice(0, MAX_RUN_NOTES_CHARS);
  const nl = cut.lastIndexOf("\n");
  return (nl > MAX_RUN_NOTES_CHARS / 2 ? cut.slice(0, nl) : cut).trimEnd();
}

export class RunNotesError extends Error {
  constructor(readonly code: "too_long" | "secret" | "write_failed", message: string) {
    super(message);
    this.name = "RunNotesError";
  }
}

/**
 * The OWNER's edit, saved whole. Refused over the cap, and refused when it
 * holds a credential: the notes reach every run's prompt and every run's
 * record of it, which is what the project's secret store exists to avoid.
 */
export async function writeRunNotes(directory: string, text: string): Promise<string> {
  const notes = text.replace(/\r\n/g, "\n").trim();
  if (notes.length > MAX_RUN_NOTES_CHARS) {
    throw new RunNotesError("too_long", `Run notes are at most ${MAX_RUN_NOTES_CHARS} characters (${notes.length} given).`);
  }
  if (redactCredentialShapes(notes) !== notes) {
    throw new RunNotesError("secret", "These notes look like they hold a password or a token. Every run reads them; keep secrets in the project's secret store.");
  }
  await saveNotes(notesProjectDir(directory), notes);
  return notes;
}

/** The owner's Clear: the file goes. Nothing there is not an error. */
export function clearRunNotes(directory: string): void {
  try {
    if (!ownNotesDir(notesProjectDir(directory), { create: false })) {
      throw new Error(`${RUN_NOTES_DIR} in the project is not a folder of its own`);
    }
    fs.rmSync(runNotesPath(directory), { force: true });
  } catch (err) {
    throw new RunNotesError("write_failed", `Could not clear the run notes: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function saveNotes(project: string, notes: string): Promise<void> {
  const dir = path.join(project, RUN_NOTES_DIR);
  const file = path.join(dir, RUN_NOTES_FILE);
  try {
    if (!ownNotesDir(project, { create: true })) {
      throw new Error(`${RUN_NOTES_DIR} in the project is not a folder of its own`);
    }
    // `.clawbox/` out of `git status` BEFORE the file exists in it: a run that
    // ran `git add -A` in between would otherwise commit the notes.
    await excludeWorktrees(project);
    if (!notes) {
      fs.rmSync(file, { force: true });
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${notes}\n`, { mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (err) {
    throw new RunNotesError("write_failed", `Could not save the run notes: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * How a run proposes a lesson: ONE sentence of a writing run's brief, every
 * spawn, notes or none — the channel is how the notes get started. Not for a
 * read-only run, which cannot write its evidence folder. A sentence among the
 * brief's sentences rather than a block of its own, so a run in a project with
 * no notes has a system prompt of the same one-line shape it always had.
 */
export const LESSON_CHANNEL_BRIEF = `To leave a lesson for the next run in this project — a command that worked, a flag the build needed, a gotcha that cost you turns — write {"lessons": ["…"]} to $CLAWBOX_RUN_ARTIFACTS_DIR/${LESSONS_FILE} before your final message: at most ${MAX_LESSONS_PER_RUN} one-line lessons of at most ${MAX_LESSON_CHARS} characters, facts only, nothing already in the project's run notes. Never a secret, token, password, e-mail address or link — a lesson holding one is dropped.`;

/**
 * The block a run's system prompt carries: the notes, framed as facts about
 * the project rather than orders, delimited so the run can tell them from the
 * device's own words. Null when there are none.
 */
export function runNotesBlock(notes: string): string | null {
  const text = notes.trim();
  if (!text) return null;
  return [
    "Project run notes — what earlier runs in this project learned, kept by the owner. They are facts about this project (commands that work, flags the build needs, gotchas); your brief and your task come first.",
    "<run-notes>",
    clipNotes(text),
    "</run-notes>",
  ].join("\n");
}

/** A lesson as the dedup compares it: case, spacing, quoting and the closing full stop do not make it new. */
export function lessonKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"'*_]/g, "")
    .replace(/^[-•]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[.!;:,\s]+$/, "")
    .trim();
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** The notes' own delimiter: a lesson that closed it would speak outside the block. */
const DELIMITER_RE = /<\/?\s*run-notes/i;
/** A link off the box. Loopback is the run's own preview and stays. */
const LINK_RE = /\b(?:https?|ftp|wss?):\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$))/i;

/**
 * One proposed lesson, judged: the line to merge, or why not. `runId` names the
 * run whose injected secrets must not appear in it (secret-redact.ts's table,
 * which holds exactly what that run was handed).
 */
export function vetLesson(raw: unknown, runId: string | null = null): { ok: true; lesson: string } | { ok: false; refusal: LessonVerdict } {
  if (typeof raw !== "string") return { ok: false, refusal: { lesson: "", reason: "not_text" } };
  const lesson = raw.replace(/\s+/g, " ").replace(/^[-*•]\s+/, "").trim();
  const refuse = (reason: LessonRefusal) => ({ ok: false as const, refusal: { lesson: lesson.slice(0, MAX_LESSON_CHARS), reason } });
  if (lesson.length < MIN_LESSON_CHARS) return refuse("too_short");
  if (lesson.length > MAX_LESSON_CHARS) return refuse("too_long");
  // A value the run was given, or anything shaped like a credential: the
  // lesson goes whole. Its text is never quoted back with the secret in it.
  if ((runId && redactForRun(runId, lesson) !== lesson) || redactCredentialShapes(lesson) !== lesson) {
    return { ok: false, refusal: { lesson: "", reason: "secret" } };
  }
  if (DELIMITER_RE.test(lesson)) return refuse("markup");
  if (EMAIL_RE.test(lesson)) return refuse("personal");
  if (LINK_RE.test(lesson)) return refuse("link");
  return { ok: true, lesson };
}

/**
 * Lessons merged into the notes: each vetted one that is not there already, as
 * a `- ` line at the end, for as long as the file stays under its cap. Pure.
 */
export function mergeLessons(notes: string, proposed: readonly unknown[], runId: string | null = null): { notes: string; added: string[]; refused: LessonVerdict[] } {
  const refused: LessonVerdict[] = [];
  const added: string[] = [];
  const seen = new Set(notes.split("\n").map(lessonKey).filter(Boolean));
  let out = notes.trim();
  proposed.forEach((raw, i) => {
    if (i >= MAX_LESSONS_PER_RUN) {
      refused.push({ lesson: typeof raw === "string" ? raw.slice(0, MAX_LESSON_CHARS) : "", reason: "too_many" });
      return;
    }
    const vetted = vetLesson(raw, runId);
    if (!vetted.ok) {
      refused.push(vetted.refusal);
      return;
    }
    const key = lessonKey(vetted.lesson);
    if (seen.has(key)) {
      refused.push({ lesson: vetted.lesson, reason: "duplicate" });
      return;
    }
    const next = out ? `${out}\n- ${vetted.lesson}` : `- ${vetted.lesson}`;
    if (next.length > MAX_RUN_NOTES_CHARS) {
      refused.push({ lesson: vetted.lesson, reason: "full" });
      return;
    }
    out = next;
    seen.add(key);
    added.push(vetted.lesson);
  });
  return { notes: out, added, refused };
}

/**
 * The lessons in a run's proposal file: `{"lessons": [...]}` or a bare array.
 * Null when there is no file, or it is not one of those two shapes — a
 * malformed proposal proposes nothing.
 */
export function readLessonProposal(evidenceDir: string): unknown[] | null {
  const file = path.join(evidenceDir, LESSONS_FILE);
  try {
    const text = readOwnFile(file, MAX_PROPOSAL_BYTES, { refuseLarger: true });
    if (text === null) return null;
    const raw = JSON.parse(text) as unknown;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && Array.isArray((raw as { lessons?: unknown }).lessons)) {
      return (raw as { lessons: unknown[] }).lessons;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The settle step's half: a finished run's proposed lessons, vetted and merged
 * into its project's notes. Best effort and never throws — a lesson that
 * could not be saved costs the next run some turns, never this run its verdict.
 */
export async function settleRunNotes(run: { id: string; directory: string }, evidenceDir: string): Promise<{ added: string[]; refused: LessonVerdict[] }> {
  const proposed = readLessonProposal(evidenceDir);
  if (!proposed || proposed.length === 0) return { added: [], refused: [] };
  const project = notesProjectDir(run.directory);
  try {
    if (!fs.statSync(project).isDirectory()) return { added: [], refused: [] };
  } catch {
    return { added: [], refused: [] };
  }
  const merged = mergeLessons(readRunNotes(project), proposed, run.id);
  if (merged.added.length) {
    try {
      await saveNotes(project, merged.notes);
    } catch (err) {
      console.error(`[coding-agent] ${run.id}: could not save run notes:`, err instanceof Error ? err.message : err);
      return { added: [], refused: merged.refused };
    }
  }
  return merged;
}
