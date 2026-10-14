/**
 * The time record a budgeted run or team keeps — the server half of the
 * records coding-time-budget.ts describes. Two files in the owner's evidence
 * folder (data/coding-agent-artifacts/<run or team id>/):
 *
 *  - TIME_RECORD_LOG  (time-record.log): one line per record, on the box's
 *    wall clock, appended — what the owner reads;
 *  - TIME_RECORD_JSON (time-record.json): summarizeTimeRecords over every
 *    record, rewritten whole through a temp file and a rename — what a
 *    resumed run and the timeline read back.
 *
 * On disk rather than in the run record so it survives a restart, a history
 * trim of the record, and a queue: a resumed run loads it and carries on
 * against the same deadline.
 *
 * The folder is one the run itself may write into, so nothing in it is
 * trusted: no file is opened through a symlink or as anything but a regular
 * file, what is read back is read as strictly as readTimeBudget and
 * readTimeRecord read anything, and a file this box cannot read is set aside
 * (TIME_RECORD_CORRUPT_JSON) rather than trusted or thrown on.
 *
 * Never throws: a record is a convenience on top of the work, and no failure
 * to keep one may stop a run. Writes answer null and say why on the console.
 */
import fs from "fs";
import { randomBytes } from "crypto";
import path from "@/lib/runtime-path";
import { ensureOwnerArtifactsDir, ownerArtifactsDir, safeOwnerId } from "@/lib/coding-agent-artifacts";
import {
  formatTimeRecordLine,
  readTimeBudget,
  readTimeRecord,
  summarizeTimeRecords,
  TIME_RECORD_JSON,
  TIME_RECORD_LOG,
  type TimeBudget,
  type TimeRecord,
  type TimeRecordKind,
  type TimeRecordSummary,
} from "@/lib/coding-time-budget";
import { readOsTimeZone } from "@/lib/timezone";

/** The most records the JSON keeps; past it the oldest checkpoints go first (`trimRecords`). The log keeps them all. */
export const MAX_STORED_TIME_RECORDS = 1_000;
/** A time-record.json larger than this is not one this box wrote. */
export const MAX_TIME_RECORD_JSON_BYTES = 4 * 1024 * 1024;
/** The log stops taking checkpoints past this size; the budget and stop lines still go in. */
export const MAX_TIME_RECORD_LOG_BYTES = 2 * 1024 * 1024;
/** How many records an API payload carries by default — the latest ones. */
export const DEFAULT_PAYLOAD_RECORDS = 200;
/** Where an unreadable time-record.json is moved, so the next write starts clean without losing it. */
export const TIME_RECORD_CORRUPT_JSON = "time-record.corrupt.json";

/** What time-record.json holds that a resumed run needs: the budget and every record. */
export interface StoredTimeRecords {
  budget: TimeBudget;
  records: TimeRecord[];
}

/** The summary an API answers with: the latest `records` only, and how many older ones were left out. */
export interface TimeRecordPayload extends TimeRecordSummary {
  omittedRecords: number;
}

// ─── One writer per owner ────────────────────────────────────────────────────

/** Each owner's queue of writes: a write runs after the one before it, whether or not that one succeeded. */
const chains = new Map<string, Promise<unknown>>();

function oneWriterAtATime<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(ownerId) ?? Promise.resolve()).then(task, task);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(ownerId, tail);
  // The last write out takes its owner's entry with it: one map entry per run would never shrink.
  void tail.then(() => {
    if (chains.get(ownerId) === tail) chains.delete(ownerId);
  });
  return run;
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** The evidence folder must be a real folder: one replaced by a symlink would point the writes elsewhere. */
function assertRealDir(dir: string): void {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("the evidence folder is not a directory");
}

const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** A file's text, read from an open descriptor up to `max` bytes — null past it, whatever fstat said. */
function readBounded(fd: number, max: number): string | null {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  let total = 0;
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    total += n;
    if (total > max) return null;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** time-record.json's content read back, strictly — or null. A record line this box would not write is dropped; a bad budget is no record. */
function parseStored(raw: string): StoredTimeRecords | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const budget = readTimeBudget(o.budget);
  if (!budget || !Array.isArray(o.records)) return null;
  const records = o.records
    .slice(-MAX_STORED_TIME_RECORDS)
    .map(readTimeRecord)
    .filter((r): r is TimeRecord => r !== null);
  return { budget, records };
}

/**
 * What reading time-record.json found. `bad` is the file's own fault — not
 * JSON, not a record, too large, a link, not a regular file — and a writer
 * sets it aside. `unreadable` is the disk's (out of descriptors, an I/O
 * error): the file may be fine, so a writer leaves it alone and writes nothing.
 */
type StoredRead =
  | { state: "missing" }
  | { state: "bad" }
  | { state: "unreadable"; error: unknown }
  | { state: "ok"; stored: StoredTimeRecords };

function readStored(file: string): StoredRead {
  let fd: number;
  try {
    fd = fs.openSync(file, READ_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP is O_NOFOLLOW meeting a link.
    if (code === "ENOENT") return { state: "missing" };
    return code === "ELOOP" ? { state: "bad" } : { state: "unreadable", error: err };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_TIME_RECORD_JSON_BYTES) return { state: "bad" };
    const raw = readBounded(fd, MAX_TIME_RECORD_JSON_BYTES);
    const stored = raw === null ? null : parseStored(raw);
    return stored ? { state: "ok", stored } : { state: "bad" };
  } catch (err) {
    return { state: "unreadable", error: err };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A run's or team's time record, as time-record.json keeps it: the budget and
 * every record line, oldest first — or null when there is none, the id is not
 * a run or team id, or the file is not one this box can read (damaged, cut
 * short, swapped for a link). Never throws. What a resumed run reads to carry
 * on against the same deadline.
 */
export function loadTimeRecords(ownerId: string): StoredTimeRecords | null {
  const owner = safeOwnerId(ownerId);
  if (!owner) return null;
  try {
    const dir = ownerArtifactsDir(owner);
    assertRealDir(dir);
    const read = readStored(path.join(dir, TIME_RECORD_JSON));
    return read.state === "ok" ? read.stored : null;
  } catch {
    return null;
  }
}

/**
 * The time record for an API payload: summarized afresh at `now` (so time used
 * is live while the work goes on), with only the latest `maxRecords` record
 * lines — `omittedRecords` says how many older ones were left out. Null when
 * there is no record: a payload without a budget carries no key for one.
 */
export function readTimeRecordSummary(ownerId: string, now: Date | number, maxRecords: number = DEFAULT_PAYLOAD_RECORDS): TimeRecordPayload | null {
  const stored = loadTimeRecords(ownerId);
  if (!stored) return null;
  const summary = summarizeTimeRecords(stored.budget, stored.records, now);
  const keep = Number.isInteger(maxRecords) && maxRecords >= 0 ? Math.min(maxRecords, MAX_STORED_TIME_RECORDS) : DEFAULT_PAYLOAD_RECORDS;
  const records = keep > 0 ? summary.records.slice(-keep) : [];
  return { ...summary, records, omittedRecords: summary.records.length - records.length };
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/** The kinds a full JSON keeps longest: the budget, the plan, the estimates and the stop are what the summary is made of. */
const KEPT_KINDS: ReadonlySet<TimeRecordKind> = new Set(["budget", "plan", "estimate", "stop"]);

/**
 * Bring a record list down to `max`, oldest first within each pass: the
 * checkpoints (`note`) go first, then the task `start` lines, then any line
 * but the budget, plan, estimates and stop — and only then those. The log
 * still holds every line.
 */
function trimRecords(records: TimeRecord[], max: number): TimeRecord[] {
  let excess = records.length - max;
  if (excess <= 0) return records;
  const drop = new Set<number>();
  const pass = (droppable: (r: TimeRecord) => boolean) => {
    for (let i = 0; i < records.length && excess > 0; i++) {
      if (!drop.has(i) && droppable(records[i])) {
        drop.add(i);
        excess--;
      }
    }
  };
  pass((r) => r.kind === "note");
  pass((r) => r.kind === "start");
  pass((r) => !KEPT_KINDS.has(r.kind));
  pass(() => true);
  return records.filter((_, i) => !drop.has(i));
}

/**
 * Replace `name` in `dir` whole: written to a dotfile of its own (created
 * exclusively, so nothing planted under that name is followed), synced, and
 * renamed over the old one. A reader sees the old file or the new one, never
 * half of either; listings never show a dotfile.
 */
async function writeFileAtomic(dir: string, name: string, body: string): Promise<void> {
  const tmp = path.join(dir, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let placed = false;
  try {
    const fh = await fs.promises.open(tmp, "wx", 0o644);
    try {
      await fh.writeFile(body, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tmp, path.join(dir, name));
    placed = true;
  } finally {
    if (!placed) await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
  }
}

const LOG_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const LOG_FULL_LINE = `The log is full; later checkpoints are in ${TIME_RECORD_JSON} only.`;

/**
 * Append one line to the text log — a regular file opened without following
 * a link. Past MAX_TIME_RECORD_LOG_BYTES only the budget and stop lines go in,
 * and the line that fills it says so.
 */
async function appendLogLine(file: string, line: string, kind: TimeRecordKind): Promise<void> {
  const fh = await fs.promises.open(file, LOG_FLAGS, 0o644);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`${TIME_RECORD_LOG} is not a regular file`);
    const essential = kind === "budget" || kind === "stop";
    if (st.size >= MAX_TIME_RECORD_LOG_BYTES && !essential) return;
    const text = `${line}\n`;
    const fills = st.size < MAX_TIME_RECORD_LOG_BYTES && st.size + Buffer.byteLength(text) >= MAX_TIME_RECORD_LOG_BYTES;
    await fh.appendFile(fills ? `${text}${LOG_FULL_LINE}\n` : text, "utf8");
  } finally {
    await fh.close();
  }
}

/** Set an unreadable time-record.json aside — a link is only removed, never followed or kept. */
function setAsideBadJson(dir: string): void {
  const file = path.join(dir, TIME_RECORD_JSON);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
    else fs.renameSync(file, path.join(dir, TIME_RECORD_CORRUPT_JSON));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Add one record to a run's or team's time record: its line goes on the end of
 * time-record.log (on the box's wall clock, formatTimeRecordLine), and
 * time-record.json is rewritten — summarizeTimeRecords over the budget and
 * every record so far — through a temp file and a rename. One writer per owner
 * at a time, so two records landing together both survive.
 *
 * `budget` is the budget the work goes on with — normally the one it started
 * with; after a re-plan, the one it changed to. Both it and `record` are read
 * as strictly as a stored one (readTimeBudget, readTimeRecord): what is
 * written is exactly what a resume reads back.
 *
 * Answers the summary written, or null when nothing was: the id is not a run
 * or team id, the budget or record is not one, or the disk refused. Never
 * throws.
 */
export async function appendTimeRecord(ownerId: string, budget: TimeBudget, record: TimeRecord): Promise<TimeRecordSummary | null> {
  const owner = safeOwnerId(ownerId);
  const b = readTimeBudget(budget);
  const r = readTimeRecord(record);
  if (!owner || !b || !r) {
    const what = !owner ? "an owner that is not a run or team id" : !b ? "a budget that is not one" : "a record that is not one";
    console.warn(`[coding-agent] time record not written: ${what}`);
    return null;
  }
  const tz = await readOsTimeZone().catch(() => "UTC");
  return oneWriterAtATime(owner, async () => {
    try {
      const dir = ensureOwnerArtifactsDir(owner);
      assertRealDir(dir);
      const read = readStored(path.join(dir, TIME_RECORD_JSON));
      if (read.state === "unreadable") throw read.error;
      if (read.state === "bad") {
        console.warn(`[coding-agent] ${owner}: ${TIME_RECORD_JSON} was unreadable; set aside as ${TIME_RECORD_CORRUPT_JSON}`);
        setAsideBadJson(dir);
      }
      const prior = read.state === "ok" ? read.stored.records : [];
      const records = trimRecords([...prior, r], MAX_STORED_TIME_RECORDS);
      const summary = summarizeTimeRecords(b, records, Date.now());
      await writeFileAtomic(dir, TIME_RECORD_JSON, `${JSON.stringify(summary, null, 2)}\n`);
      // One line, whatever a task id carried: a control character must not start a line of its own.
      const line = formatTimeRecordLine(r, tz).replace(/\p{Cc}+/gu, " ");
      try {
        await appendLogLine(path.join(dir, TIME_RECORD_LOG), line, r.kind);
      } catch (err) {
        // The JSON — what a resume reads — is written; a log the run spoiled must not undo that.
        console.warn(`[coding-agent] ${owner}: could not append to ${TIME_RECORD_LOG}:`, err instanceof Error ? err.message : err);
      }
      return summary;
    } catch (err) {
      console.warn(`[coding-agent] ${owner}: could not write the time record:`, err instanceof Error ? err.message : err);
      return null;
    }
  });
}
