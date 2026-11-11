/**
 * The RAW log of an update run: every byte the steps printed, in order, as the
 * owner would have seen it running them by hand (TASK-2428).
 *
 * The update screen's step list says WHICH step runs and the line it is on.
 * This is the rest: install.sh's own output for every root step, the npm, pip,
 * apt and build output underneath it, ANSI colours and `\r` progress bars
 * included, and the git and build commands the web server runs itself. One
 * file per run under `data/update-logs/`, the last {@link UPDATE_LOG_KEEP}
 * kept, read back by `/setup-api/update/log` from a byte offset.
 *
 * WHERE THE BYTES COME FROM. A root step runs in its own systemd instance
 * (root-step-journal.ts), whose stdout and stderr go to the journal. That is
 * the only copy there is, and `journalctl -o cat` gives it back byte for byte:
 * the escape sequences and carriage returns that the default output replaces
 * with "[N blob data]" are written as they were sent (measured, systemd 249
 * and 255). Nothing about the step changes — it is not re-plumbed through a
 * tee, it is read. The read is bounded the way every other reader of a step's
 * journal is bounded, by the moment the step was dispatched, and then
 * continued from journald's own CURSOR, so no entry is read twice and none is
 * skipped however often the journal is polled.
 *
 * ACROSS A RESTART. The rebuild step replaces the web server that is following
 * it, and the box may reboot. Every write is followed by a record of what the
 * file now holds and how far each followed unit has been read
 * (`<run>.json`), so the process that continues the update truncates the log
 * to the last recorded size — dropping a chunk whose cursor never reached the
 * disk — and reads each unit on from its recorded cursor. Readers are only
 * ever sent RECORDED bytes (`updateLogInfo`), so what a truncate drops is
 * nothing anybody has seen, and the stream a reader resumes is the one it had.
 *
 * REDACTED BEFORE IT IS WRITTEN, with the update logs' own rule
 * (`redactCredentialShapes`, which the gateway pre-start log uses), line by
 * line, so no token or password reaches the disk or a reader.
 *
 * NEVER IN THE UPDATE'S WAY. Every export here swallows its own failures: a
 * full disk, an unreadable journal or a missing `journalctl` costs the log, not
 * the update. A root step that returns waits for the journal read already in
 * flight and one more (each bounded, normally milliseconds), so its last lines
 * sit above the step's result; what journald stores later still is read in the
 * background and written under a "(continued)" line naming the unit.
 *
 * SERVER ONLY: spawns journalctl.
 */
import { spawn as nodeSpawn } from "child_process";
import fs from "fs";
import { StringDecoder } from "string_decoder";
import path, { untraced } from "./runtime-path";
import { redactCredentialShapes } from "./incident-sanitize";
import { rootStepJournalArgs, rootStepUnit } from "./root-step-journal";

/** How many runs' logs are kept; the oldest beyond this are removed when a run starts. */
export const UPDATE_LOG_KEEP = 5;
/** A log is cut here: past it, only the step results and the run's last line are written. */
export const UPDATE_LOG_MAX_BYTES = 32 * 1024 * 1024;
/** How often a followed unit's journal is read while the step runs. */
export const UPDATE_LOG_POLL_MS = 1_000;
/** How long a unit is still read after its step returned, for lines journald had not stored yet. */
export const UPDATE_LOG_LINGER_MS = 3_000;
const JOURNAL_READ_TIMEOUT_MS = 15_000;
const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const JOURNAL_TAIL_BYTES = 8 * 1024;
/** How long an open waits for the units an earlier process followed (the update goes on after it). */
const REOPEN_DRAIN_MS = 2_000;
/** How long a returning root step waits for its last journal lines (the rest come in the background). */
const FINISH_WAIT_MS = 2_000;

/** `work`, or nothing once `ms` have passed — whichever is first. Never rejects. */
function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = deps.setTimer(() => resolve(undefined), ms);
    work.then(
      (value) => { deps.clearTimer(timer); resolve(value); },
      () => { deps.clearTimer(timer); resolve(undefined); },
    );
  });
}

/** How long a streamed command's whole lines wait to be written together. */
const STREAM_BATCH_MS = 250;
const STREAM_BATCH_BYTES = 64 * 1024;
/** Streamed output queued for the log past which the command is paused, and where it goes on. */
const STREAM_PENDING_MAX = 1024 * 1024;
const STREAM_PENDING_RESUME = 256 * 1024;
/** Reads that fail in a row, with a cursor, before the follow moves on to the unit's newest entry. */
const CURSOR_FAILURES_BEFORE_SKIP = 3;

/**
 * `20261111T093015123Z-a1b2` (to the millisecond): sortable by start time, and
 * nothing a path can be built from. The milliseconds are optional only so the
 * logs of the first builds of this (to the second) are still listed and pruned.
 */
export const UPDATE_LOG_ID_RE = /^\d{8}T\d{6}(?:\d{3})?Z-[0-9a-f]{4,8}$/;

const ESC = "\x1b[";
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const CYAN = `${ESC}1;36m`;
const GREEN = `${ESC}1;32m`;
const RED = `${ESC}1;31m`;
const YELLOW = `${ESC}1;33m`;

/** One unit whose journal goes into the log, as a restarted server needs it to read on. */
export interface FollowRecord {
  /** install.sh's step name; the unit is `rootStepUnit(step)`. */
  step: string;
  /** When it was dispatched: the journal window, until a cursor exists. */
  sinceMs: number;
  /** journald's cursor of the last entry written to the log, or null before the first. */
  cursor: string | null;
  /** Read to the end and let go. */
  done: boolean;
}

/** `<run>.json` beside `<run>.log`. */
export interface UpdateLogMeta {
  id: string;
  startedAt: string;
  /** What the run is: "update" (the full one) or "openclaw" (the core-only flow). */
  flow: string;
  /**
   * 1 for the first run this box logged, one more for each after: the order
   * runs were started in, whatever the wall clock did between them.
   */
  seq?: number;
  /** Bytes of the log every follow cursor below accounts for. */
  size: number;
  finished: boolean;
  outcome?: "completed" | "failed";
  follows: FollowRecord[];
}

export interface UpdateLogInfo {
  id: string;
  size: number;
  finished: boolean;
  outcome?: "completed" | "failed";
  startedAt: string;
}

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { stdio: ["ignore", "pipe", "pipe"] },
) => {
  stdout?: NodeJS.ReadableStream | null;
  on: (event: "close" | "error", listener: (arg?: unknown) => void) => unknown;
  kill?: (signal?: NodeJS.Signals) => boolean;
} | undefined;

interface Deps {
  spawn: SpawnLike;
  /** The most one journal read keeps (tests make it small). */
  journalMaxBytes: number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const realDeps: Deps = {
  spawn: (command, args, options) => nodeSpawn(command, args as string[], options),
  journalMaxBytes: JOURNAL_MAX_BYTES,
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
let deps: Deps = realDeps;

/** Work in flight (journal reads, streamed command output), so tests can wait for quiet. */
const inFlight = new Set<Promise<unknown>>();
function track<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work)).catch(() => {});
  return work;
}

/** Test seam: the journal reader, the clock and the timers. Pass nothing to restore. */
export function setUpdateLogDepsForTests(overrides?: Partial<Deps>): void {
  deps = overrides ? { ...realDeps, ...overrides } : realDeps;
}

/** `data/update-logs` under the install, resolved when asked (the tests move the root). */
export function updateLogDir(): string {
  const root = process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
  return untraced(path.join(root, "data", "update-logs"));
}

function logPath(id: string): string {
  return untraced(path.join(updateLogDir(), `${id}.log`));
}

function metaPath(id: string): string {
  return untraced(path.join(updateLogDir(), `${id}.json`));
}

/**
 * `data/update-logs/latest`: the id of the run started last. Kept apart from
 * the ids' own order, which is a wall-clock stamp — a box without an RTC can
 * have its clock stepped back between two runs, and the newer run's id then
 * sorts first.
 */
function latestPointerPath(): string {
  return untraced(path.join(updateLogDir(), "latest"));
}

async function readLatestPointer(): Promise<string | null> {
  try {
    const id = fs.readFileSync(latestPointerPath(), "utf8").trim();
    return UPDATE_LOG_ID_RE.test(id) && fs.existsSync(logPath(id)) ? id : null;
  } catch {
    return null;
  }
}

function writeLatestPointer(id: string): void {
  const tmp = untraced(`${latestPointerPath()}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${id}\n`, { mode: 0o600 });
  fs.renameSync(tmp, latestPointerPath());
}

/** The run started last: the pointer, or (no pointer yet) the newest id. */
async function latestRunId(): Promise<string | null> {
  return (await readLatestPointer()) ?? (await listRunIds())[0] ?? null;
}

/** Redacted a line at a time, so a rule never sees half a credential. */
export function redactUpdateLogText(text: string): string {
  if (!text) return "";
  return text.split("\n").map((line) => (line ? redactCredentialShapes(line) : line)).join("\n");
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19) + "Z";
}

function newRunId(ms: number): string {
  const stamp = new Date(ms).toISOString().replace(/[-:.]/g, "");
  const tail = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${stamp}-${tail}`;
}

/**
 * One journal read: everything the unit wrote after `cursor` (or since the
 * dispatch, before there is one), and the cursor of the last entry. Null when
 * the journal could not be read at all — never a throw.
 */
function readJournal(step: string, sinceMs: number, cursor: string | null): Promise<{ text: string; cursor: string | null } | null> {
  const args = cursor
    ? ["-u", rootStepUnit(step), "--after-cursor", cursor, "--no-pager", "-o", "cat"]
    : rootStepJournalArgs(step, { sinceMs });
  return runJournalctl(args);
}

/** The cursor of the unit's newest entry (the text is not wanted), or null. */
async function newestCursor(step: string): Promise<string | null> {
  const got = await runJournalctl(["-u", rootStepUnit(step), "-n", "1", "--no-pager", "-o", "cat"]);
  return got?.cursor ?? null;
}

function runJournalctl(args: readonly string[]): Promise<{ text: string; cursor: string | null } | null> {
  // -q: no "-- No entries --" or boot banner in the output; the cursor line is
  // printed all the same, and only when there was an entry to point at.
  const argv = ["-q", ...args, "--show-cursor"];
  return new Promise((resolve) => {
    let child: ReturnType<SpawnLike>;
    try {
      child = deps.spawn("/usr/bin/journalctl", argv, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    if (!child || !child.stdout || typeof child.on !== "function") {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    // The last bytes, always: past the cap they still carry the cursor line,
    // so a read too big to keep moves the follow on instead of stalling it.
    let tail = Buffer.alloc(0);
    let settled = false;
    const done = (value: { text: string; cursor: string | null } | null) => {
      if (settled) return;
      settled = true;
      deps.clearTimer(timer);
      resolve(value);
    };
    const timer = deps.setTimer(() => {
      try { child?.kill?.("SIGKILL"); } catch { /* gone */ }
      done(null);
    }, JOURNAL_READ_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      tail = Buffer.concat([tail, buf]);
      if (tail.length > JOURNAL_TAIL_BYTES) tail = tail.subarray(tail.length - JOURNAL_TAIL_BYTES);
      if (bytes < deps.journalMaxBytes) chunks.push(buf.subarray(0, deps.journalMaxBytes - bytes));
      bytes += buf.length;
    });
    child.on("error", () => done(null));
    child.on("close", (code) => {
      if (code !== 0 && code !== null && code !== undefined) {
        done(null);
        return;
      }
      if (bytes <= deps.journalMaxBytes) {
        done(splitCursor(Buffer.concat(chunks).toString("utf8")));
        return;
      }
      const kept = Buffer.concat(chunks).toString("utf8");
      const whole = kept.slice(0, kept.lastIndexOf("\n") + 1);
      done({
        text: `${whole}${YELLOW}[${bytes - Buffer.byteLength(whole)} more bytes of this unit's output came in one read; they are in its journal]${RESET}\n`,
        cursor: splitCursor(tail.toString("utf8")).cursor,
      });
    });
  });
}

/** journalctl's `--show-cursor` line is the LAST line, and only when an entry was shown. */
export function splitCursor(output: string): { text: string; cursor: string | null } {
  const match = /(^|\n)-- cursor: (\S+)\n?$/.exec(output);
  if (!match) return { text: output, cursor: null };
  return { text: output.slice(0, match.index + match[1].length), cursor: match[2] };
}

/** The `$ journalctl …` line that says where the next lines come from, as one would type it. */
function journalCommand(step: string, sinceMs: number): string {
  return `journalctl -u ${rootStepUnit(step)} --since @${(sinceMs / 1000).toFixed(3)} -o cat`;
}

/**
 * `systemctl show <unit> -p ActiveState --value`, or null when it could not be
 * asked. A unit that is gone answers "inactive" (systemd collects it as it
 * exits), which is the answer wanted.
 */
function unitActiveState(step: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<SpawnLike>;
    try {
      child = deps.spawn(
        "/usr/bin/systemctl",
        ["show", rootStepUnit(step), "-p", "ActiveState", "--value"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      resolve(null);
      return;
    }
    if (!child || !child.stdout || typeof child.on !== "function") {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      deps.clearTimer(timer);
      resolve(value);
    };
    const timer = deps.setTimer(() => {
      try { child?.kill?.("SIGKILL"); } catch { /* gone */ }
      done(null);
    }, JOURNAL_READ_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer | string) => { out += String(chunk); });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? out.trim() || null : null));
  });
}

class JournalFollow {
  private stopped = false;
  private polling: Promise<boolean> | null = null;
  private timer: unknown = null;
  /** The journal answered at least once: the box can be followed at all. */
  private readable = false;
  /** Read on until the unit itself has stopped (a step that outran its wait, or one a restart interrupted). */
  private untilSettled = false;
  /** Lines of this unit are in the log already: a header for more of them says "(continued)". */
  wrote: boolean;
  /** Reads with a cursor that failed in a row. */
  private failures = 0;

  constructor(private readonly log: RunLog, readonly record: FollowRecord) {
    this.wrote = record.cursor !== null;
  }

  /** Read now, then every {@link UPDATE_LOG_POLL_MS} until finished. */
  start(): void {
    void this.pollOnce().then(() => {
      if (this.readable) this.schedule(UPDATE_LOG_POLL_MS);
      else this.stopped = true;
    });
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = deps.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    const wrote = await this.pollOnce();
    if (this.stopped) return;
    if (this.untilSettled && !wrote) {
      const state = await unitActiveState(this.record.step);
      if (this.stopped) return;
      if (state === "inactive" || state === "failed") {
        await this.close();
        return;
      }
    }
    this.schedule(UPDATE_LOG_POLL_MS);
  }

  /** Keep reading until the unit has stopped, then let go. */
  settleThenFinish(): void {
    this.untilSettled = true;
  }

  /** One read, never two at once; resolves with whether it wrote anything. */
  pollOnce(): Promise<boolean> {
    if (this.polling) return this.polling;
    const reading = (async () => {
      if (this.record.done) return false;
      const got = await readJournal(this.record.step, this.record.sinceMs, this.record.cursor);
      if (!got) {
        // A cursor journald no longer knows (the journal was rotated or
        // vacuumed under it), or reads that keep timing out: the follow moves
        // on from the unit's newest entry rather than asking the same thing
        // for the rest of the update.
        if (this.record.cursor && ++this.failures >= CURSOR_FAILURES_BEFORE_SKIP) {
          const newest = await newestCursor(this.record.step);
          if (newest && !this.record.done) {
            this.failures = 0;
            await this.log.writeFromFollow(
              this,
              `${YELLOW}[the journal could not be read on from where the log stopped; continuing from its newest entry]${RESET}\n`,
              newest,
            );
          }
        }
        return false;
      }
      this.failures = 0;
      this.readable = true;
      if (!got.cursor || this.record.done) return false;
      await this.log.writeFromFollow(this, got.text, got.cursor);
      return true;
    })().catch(() => false).finally(() => {
      this.polling = null;
    });
    this.polling = reading;
    return track(reading);
  }

  /**
   * The step returned: read what is there now, then once more after
   * {@link UPDATE_LOG_LINGER_MS} for the lines journald had not stored yet —
   * in the background, so the step is not kept waiting for them.
   */
  async finish(): Promise<void> {
    if (this.stopped && this.record.done) return;
    this.halt();
    // A read already in flight may have started before the step's last line:
    // it is waited for, and then the journal is read once more — for at most
    // FINISH_WAIT_MS of the step's time; past that, the rest is written in the
    // background as it comes.
    const drain = track((async () => {
      if (this.polling) await this.polling;
      await this.pollOnce();
      if (!this.readable || this.record.done) {
        void this.log.markDone(this);
        return;
      }
      this.timer = deps.setTimer(() => {
        this.timer = null;
        void this.pollOnce().then(() => this.log.markDone(this));
      }, UPDATE_LOG_LINGER_MS);
    })().catch(() => {}));
    await within(drain, FINISH_WAIT_MS);
  }

  /** The run is ending: one last read, now, and done. */
  async close(): Promise<void> {
    this.halt();
    if (this.polling) await this.polling;
    await this.pollOnce();
    await this.log.markDone(this);
  }

  /** Stop reading without a word on disk: what a process that dies leaves behind (tests). */
  async abandon(): Promise<void> {
    this.halt();
    if (this.polling) await this.polling;
  }

  private halt(): void {
    this.stopped = true;
    if (this.timer !== null) {
      deps.clearTimer(this.timer);
      this.timer = null;
    }
  }
}

/** The log of the run this process is writing. */
class RunLog {
  private queue: Promise<void> = Promise.resolve();
  private follows: JournalFollow[] = [];
  /** Who wrote last: a follow that writes after somebody else says where its lines come from again. */
  private lastWriter: JournalFollow | "runner" | null = null;
  private capped = false;

  constructor(readonly meta: UpdateLogMeta) {}

  /** Serialised: every write lands, and is recorded, in the order it was asked for. */
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.queue.then(job, job).catch(() => {});
    this.queue = next;
    return next;
  }

  private async append(text: string, opts: { force?: boolean } = {}): Promise<void> {
    if (!text) return;
    let out = text;
    if (this.meta.size + Buffer.byteLength(out) > UPDATE_LOG_MAX_BYTES && !opts.force) {
      if (this.capped) return;
      this.capped = true;
      out = `\r\n${YELLOW}[the log reached ${UPDATE_LOG_MAX_BYTES / (1024 * 1024)} MiB: further output is in the journal]${RESET}\r\n`;
    }
    try {
      await fs.promises.appendFile(logPath(this.meta.id), out, { mode: 0o600 });
    } catch (err) {
      // Half a write must not stay in front of the next one: the record
      // below would then point into the middle of it after a restart.
      await fs.promises.truncate(logPath(this.meta.id), this.meta.size).catch(() => {});
      throw err;
    }
    this.meta.size += Buffer.byteLength(out);
  }

  private async commit(): Promise<void> {
    const file = metaPath(this.meta.id);
    const tmp = untraced(`${file}.${process.pid}.tmp`);
    await fs.promises.writeFile(tmp, JSON.stringify(this.meta), { mode: 0o600 });
    await fs.promises.rename(tmp, file);
  }

  /** A line (or lines) the runner writes itself: headers, results, command output. */
  write(text: string, opts: { force?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      await this.append(text, opts);
      this.lastWriter = "runner";
      await this.commit();
    });
  }

  writeFromFollow(follow: JournalFollow, raw: string, cursor: string): Promise<void> {
    return this.enqueue(async () => {
      if (follow.record.done) return;
      let text = redactUpdateLogText(raw);
      if (text && this.lastWriter !== follow) {
        const again = follow.wrote ? " (continued)" : "";
        text = `${DIM}$ ${journalCommand(follow.record.step, follow.record.sinceMs)}${again}${RESET}\n${text}`;
      }
      // The bytes and the cursor that accounts for them, recorded together:
      // a restart between the two finds the old cursor and the old size.
      await this.append(text);
      follow.record.cursor = cursor;
      if (text) {
        this.lastWriter = follow;
        follow.wrote = true;
      }
      await this.commit();
    });
  }

  markDone(follow: JournalFollow): Promise<void> {
    return this.enqueue(async () => {
      if (follow.record.done) return;
      follow.record.done = true;
      this.follows = this.follows.filter((f) => f !== follow);
      await this.commit();
    });
  }

  follow(step: string, sinceMs: number, cursor: string | null = null): JournalFollow {
    const record: FollowRecord = { step, sinceMs, cursor, done: false };
    this.meta.follows = this.meta.follows.filter((f) => !f.done);
    this.meta.follows.push(record);
    const follow = new JournalFollow(this, record);
    this.follows.push(follow);
    void this.enqueue(() => this.commit());
    follow.start();
    return follow;
  }

  activeFollows(step?: string): JournalFollow[] {
    return this.follows.filter((f) => step === undefined || f.record.step === step);
  }

  async close(outcome: "completed" | "failed", error: string | undefined): Promise<void> {
    await Promise.all(this.follows.map((f) => f.close()));
    const tone = outcome === "completed" ? GREEN : RED;
    const said = outcome === "completed" ? "Update finished" : "Update failed";
    const why = error ? `: ${redactUpdateLogText(error)}` : "";
    await this.enqueue(async () => {
      // Finished whatever the disk says to the last line: a run that ended is
      // never followed as live again.
      this.meta.finished = true;
      this.meta.outcome = outcome;
      this.lastWriter = "runner";
      try {
        await this.append(`\n${tone}=== ${said}${why}${RESET} ${DIM}(${clock(deps.now())})${RESET}\n`, { force: true });
      } finally {
        await this.commit();
      }
    });
  }

  /** Every write asked for so far has landed. */
  flushed(): Promise<void> {
    return this.queue;
  }
}

let current: RunLog | null = null;
/** Closes, one after the other (each writes its run's last line). */
let closing: Promise<void> = Promise.resolve();
/** Runs being closed in this process: an open never goes on with one. */
const closingIds = new Set<string>();
/** Opens, one after the other. */
let opening: Promise<void> = Promise.resolve();

async function readMeta(id: string): Promise<UpdateLogMeta | null> {
  return readMetaSync(id);
}

function readMetaSync(id: string): UpdateLogMeta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), "utf8")) as UpdateLogMeta;
    if (!meta || meta.id !== id || typeof meta.size !== "number" || !Array.isArray(meta.follows)) return null;
    return meta;
  } catch {
    return null;
  }
}

/** Run ids on disk, newest first. */
async function listRunIds(): Promise<string[]> {
  return listRunIdsSync();
}

function listRunIdsSync(): string[] {
  try {
    const names = fs.readdirSync(updateLogDir());
    return names
      .filter((n) => n.endsWith(".log"))
      .map((n) => n.slice(0, -4))
      .filter((id) => UPDATE_LOG_ID_RE.test(id))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Every run on disk with its sequence number (0 for a record without one). */
function runsBySeq(): { id: string; seq: number }[] {
  return listRunIdsSync()
    .map((id) => ({ id, seq: readMetaSync(id)?.seq ?? 0 }))
    // Started last first: by sequence, the id (start time) only between equals.
    .sort((a, b) => b.seq - a.seq || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

async function prune(keep: string): Promise<void> {
  // In the order the runs were STARTED (their sequence), not by their ids'
  // wall-clock stamps, which a clock stepped back would reorder.
  const stale = runsBySeq().map((r) => r.id).filter((id) => id !== keep).slice(UPDATE_LOG_KEEP - 1);
  await Promise.all(stale.flatMap((id) => [
    fs.promises.rm(logPath(id), { force: true }),
    fs.promises.rm(metaPath(id), { force: true }),
  ])).catch(() => {});
}

export interface OpenUpdateLogOptions {
  /** A new run, from step 1: always a new file. Otherwise the newest unfinished one goes on. */
  fresh: boolean;
  /** Only go on with an unfinished log; never start one (null when there is none). */
  resumeOnly?: boolean;
  flow: string;
  /** What the run's first line says it is. */
  title: string;
}

/**
 * Start writing this run's log, or go on writing the one an earlier process
 * left unfinished (the second half of an update, after the rebuild restarted
 * the web server). Answers the run id, or null when no log can be written.
 */
export function openUpdateLog(opts: OpenUpdateLogOptions): Promise<string | null> {
  // One open at a time: two at once could both find no run and both start one.
  const next = opening.then(() => openNow(opts), () => openNow(opts));
  opening = next.then(() => undefined, () => undefined);
  return next;
}

async function openNow(opts: OpenUpdateLogOptions): Promise<string | null> {
  // The update never waits on the log's own bookkeeping: a close in flight
  // (its last journal reads) finishes in the background, and its run is
  // simply not one this open may go on with.
  try {
    if (current && !current.meta.finished) {
      if (!opts.fresh) return current.meta.id;
      void closeUpdateLog("failed", "a new update started before this one finished");
    }
    current = null;
    fs.mkdirSync(updateLogDir(), { recursive: true, mode: 0o700 });
    const latest = await latestRunId();
    const last = latest && !closingIds.has(latest) ? await readMeta(latest) : null;
    if (last && !last.finished) {
      if (!opts.fresh) {
        current = await reopen(last, opts.title);
        return last.id;
      }
      // A run whose server died without a word, and is not being continued:
      // its log says so and stops being followed — in the background.
      closingIds.add(last.id);
      void track((async () => {
        const stale = await reopen(last, "This update did not finish");
        await stale.close("failed", undefined);
      })().catch(() => {}).finally(() => closingIds.delete(last.id)));
    }
    if (opts.resumeOnly) return null;
    const startedMs = deps.now();
    const meta: UpdateLogMeta = {
      id: newRunId(startedMs),
      startedAt: new Date(startedMs).toISOString(),
      flow: opts.flow,
      seq: Math.max(0, ...runsBySeq().map((r) => r.seq)) + 1,
      size: 0,
      finished: false,
      follows: [],
    };
    // The file exists from the first moment, so the pointer below never
    // names a run a reader cannot find yet.
    fs.writeFileSync(logPath(meta.id), "", { flag: "a", mode: 0o600 });
    fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta), { mode: 0o600 });
    current = new RunLog(meta);
    void current.write(`${BOLD}=== ${redactUpdateLogText(opts.title)}${RESET} ${DIM}(started ${meta.startedAt})${RESET}\n`, { force: true });
    writeLatestPointer(meta.id);
    // Tracked like any other background log I/O, so a settled log is a pruned one.
    void track(prune(meta.id));
    return meta.id;
  } catch {
    current = null;
    return null;
  }
}

async function reopen(meta: UpdateLogMeta, title: string): Promise<RunLog> {
  // Whatever was written after the last record is written again from the
  // recorded cursor. No reader was sent those bytes (updateLogInfo serves the
  // recorded size only), so nothing anybody has seen changes.
  try {
    const { size } = fs.statSync(logPath(meta.id));
    if (size > meta.size) fs.truncateSync(logPath(meta.id), meta.size);
    else meta.size = size;
  } catch {
    meta.size = 0;
  }
  const log = new RunLog(meta);
  const pending = meta.follows.filter((f) => !f.done);
  meta.follows = [];
  // What the units this server was following said while it was down, first.
  // A unit still running (the rebuild restarts the services before it ends)
  // is read on until it has stopped.
  // Read, briefly: what the journal no longer holds back after REOPEN_DRAIN_MS
  // still comes, under a "(continued)" line, while the update goes on.
  for (const record of pending) {
    const follow = log.follow(record.step, record.sinceMs, record.cursor);
    follow.settleThenFinish();
    await within(follow.pollOnce(), REOPEN_DRAIN_MS);
  }
  void log.write(`\n${CYAN}=== ${redactUpdateLogText(title)}${RESET} ${DIM}(${clock(deps.now())})${RESET}\n`, { force: true });
  return log;
}

/** The run being written, if any. */
export function currentUpdateLogId(): string | null {
  return current && !current.meta.finished ? current.meta.id : null;
}

/** Text the runner writes itself (redacted). */
export async function writeUpdateLog(text: string, opts: { force?: boolean } = {}): Promise<void> {
  if (!current || current.meta.finished) return;
  try {
    await current.write(redactUpdateLogText(text), opts);
  } catch { /* the log, not the update */ }
}

/** `==> [n/total] Label` — where a step's output starts. */
export async function logUpdateStepStart(step: { id: string; label: string }, index: number, total: number): Promise<void> {
  // Past the size cap too: where each step starts is what a reader of a cut
  // log needs most.
  await writeUpdateLog(
    `\n${CYAN}==> [${index + 1}/${total}] ${step.label}${RESET} ${DIM}${step.id} · ${clock(deps.now())}${RESET}\n`,
    { force: true },
  );
}

/** How a step ended, after its output. */
export async function logUpdateStepEnd(
  step: { id: string; label: string },
  outcome: "completed" | "failed" | "skipped",
  detail?: string,
  startedMs?: number,
): Promise<void> {
  const tone = outcome === "completed" ? GREEN : outcome === "failed" ? RED : YELLOW;
  const took = startedMs === undefined ? "" : ` ${DIM}(${Math.max(0, Math.round((deps.now() - startedMs) / 1000))}s)${RESET}`;
  // Past the size cap too: how each step ended is the point of the log.
  await writeUpdateLog(`${tone}==> ${step.label}: ${outcome}${detail ? ` — ${detail}` : ""}${RESET}${took}\n`, { force: true });
}

/** The streams of a child process, as `util.promisify(execFile)` hands it out on `.child`. */
interface ChildStreams {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
}

/**
 * What a running command prints, into the log as it prints it: stdout and
 * stderr in the order they arrive, a whole line at a time (so redaction never
 * sees half a credential). `flush` writes what is left once the command ends.
 */
function streamCommand(child: ChildStreams): { flush: () => Promise<void> } {
  const partial = new Map<NodeJS.ReadableStream, string>();
  let writing: Promise<void> = Promise.resolve();
  const streams = [child.stdout, child.stderr].filter(
    (stream): stream is NodeJS.ReadableStream => Boolean(stream) && typeof stream?.on === "function",
  );
  // Backpressure: past STREAM_PENDING_MAX bytes queued for the log, the
  // command's pipes are paused (it waits on its own writes, losing nothing)
  // until the log has taken them down to STREAM_PENDING_RESUME.
  let pending = 0;
  let paused = false;
  const settle = (bytes: number) => {
    pending -= bytes;
    if (paused && pending <= STREAM_PENDING_RESUME) {
      paused = false;
      for (const stream of streams) stream.resume?.();
    }
  };
  // Whole lines wait here for at most STREAM_BATCH_MS (or STREAM_BATCH_BYTES),
  // then go to the log as ONE write: a chatty build is a few writes a second,
  // not one write and one record per line.
  let batch = "";
  let timer: unknown = null;
  const send = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    if (!batch) return;
    const lines = batch;
    batch = "";
    const bytes = Buffer.byteLength(lines);
    pending += bytes;
    if (!paused && pending > STREAM_PENDING_MAX) {
      paused = true;
      for (const stream of streams) stream.pause?.();
    }
    writing = track(writing.then(() => writeUpdateLog(lines)).finally(() => settle(bytes)));
  };
  // One decoder per stream: a character whose bytes arrive in two chunks
  // (a raw pipe, a progress bar's block characters) is held until it is whole.
  const decoders = new Map<NodeJS.ReadableStream, StringDecoder>();
  const decode = (stream: NodeJS.ReadableStream, chunk: Buffer | string): string => {
    if (typeof chunk === "string") return chunk;
    let decoder = decoders.get(stream);
    if (!decoder) {
      decoder = new StringDecoder("utf8");
      decoders.set(stream, decoder);
    }
    return decoder.write(chunk);
  };
  const take = (stream: NodeJS.ReadableStream, chunk: Buffer | string) => {
    const text = (partial.get(stream) ?? "") + decode(stream, chunk);
    const cut = text.lastIndexOf("\n");
    partial.set(stream, cut < 0 ? text : text.slice(cut + 1));
    if (cut < 0) return;
    batch += text.slice(0, cut + 1);
    if (batch.length >= STREAM_BATCH_BYTES) send();
    else if (timer === null) timer = deps.setTimer(send, STREAM_BATCH_MS);
  };
  for (const stream of streams) stream.on("data", (chunk: Buffer | string) => take(stream, chunk));
  return {
    flush: async () => {
      send();
      await writing;
      // Whatever a decoder still holds is the end of its stream's last line.
      for (const [stream, decoder] of decoders) {
        const held = decoder.end();
        if (held) partial.set(stream, (partial.get(stream) ?? "") + held);
      }
      decoders.clear();
      const rest = [...partial.values()].filter(Boolean).map((line) => `${line}\n`).join("");
      partial.clear();
      if (rest) await writeUpdateLog(rest);
    },
  };
}

/**
 * A command the web server runs itself, and what it printed: `$ argv`, then
 * its output — live, as it prints it, where `run` answers with the promise
 * `util.promisify(execFile)` makes (it carries the child), and as stdout then
 * stderr once it ends otherwise. `run` is the command exactly as the caller
 * runs it; its answer and its error are passed through untouched.
 */
export async function logUpdateCommand<T>(
  argv: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  if (!current || current.meta.finished) return run();
  // Queued, not waited for: the log keeps the order it is asked in, and the
  // command does not wait on the disk.
  void writeUpdateLog(`${DIM}$ ${argv.join(" ")}${RESET}\n`);
  const pending = run();
  let streamed: { flush: () => Promise<void> } | null = null;
  try {
    const child = (pending as { child?: ChildStreams }).child;
    if (child && (child.stdout || child.stderr)) streamed = streamCommand(child);
  } catch { /* written when it ends instead */ }
  try {
    const result = await pending;
    if (streamed) await streamed.flush();
    else void writeCommandOutput(result);
    return result;
  } catch (err) {
    if (streamed) await streamed.flush();
    else void writeCommandOutput(err);
    void writeUpdateLog(`${RED}(${describeExit(err)})${RESET}\n`);
    throw err;
  }
}

/** stdout then stderr of an execFile answer (or error), each ending in a newline. */
export async function writeCommandOutput(result: unknown): Promise<void> {
  const r = (result ?? {}) as { stdout?: unknown; stderr?: unknown };
  for (const part of [r.stdout, r.stderr]) {
    const text = Buffer.isBuffer(part) ? part.toString("utf8") : typeof part === "string" ? part : "";
    // Queued in order, both at once (each write is queued as it is asked for).
    if (text) void writeUpdateLog(text.endsWith("\n") ? text : `${text}\n`);
  }
}

function describeExit(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; signal?: unknown; killed?: unknown; message?: unknown };
  if (e.killed) return `killed${e.signal ? ` by ${String(e.signal)}` : ""}`;
  if (typeof e.code === "number") return `exit ${e.code}`;
  return typeof e.message === "string" ? e.message.split("\n")[0] : "failed";
}

/** A follow the caller can end when the step it belongs to returns. */
export interface UpdateUnitFollow {
  /** The step returned: read what is there, and a little after. */
  finish(): Promise<void>;
  /** The step stopped waiting but the unit runs on: read on until it has stopped. */
  settleThenFinish(): void;
}

const NO_FOLLOW: UpdateUnitFollow = { finish: async () => {}, settleThenFinish: () => {} };

/**
 * Put a root step's journal into the log from `sinceMs` (the dispatch), live,
 * until the returned follow is finished — or, for a step this process does
 * not outlive, until the next process reads it on from the recorded cursor.
 */
export function followUpdateUnit(step: string, sinceMs: number = deps.now()): UpdateUnitFollow {
  if (!current || current.meta.finished) return NO_FOLLOW;
  try {
    const follow = current.follow(step, sinceMs);
    return {
      finish: () => follow.finish().catch(() => {}),
      settleThenFinish: () => follow.settleThenFinish(),
    };
  } catch {
    return NO_FOLLOW;
  }
}

/** Finish every follow of `step` still going (a step that overran, once it settled). */
export async function finishUpdateUnitFollows(step: string): Promise<void> {
  if (!current) return;
  try {
    await Promise.all(current.activeFollows(step).map((f) => f.finish()));
  } catch { /* the log, not the update */ }
}

/** The run is over: last reads, the closing line, and the file is complete. */
export function closeUpdateLog(outcome: "completed" | "failed", error?: string): Promise<void> {
  const log = current;
  if (!log || log.meta.finished) return closing;
  current = null;
  closingIds.add(log.meta.id);
  closing = closing
    .then(() => log.close(outcome, error))
    .catch(() => {})
    .finally(() => closingIds.delete(log.meta.id));
  return closing;
}

/**
 * Test seam: resolves once nothing is in flight — no journal read, no
 * streamed output, no queued write — however long the disk takes.
 */
export async function settleUpdateLogForTests(): Promise<void> {
  for (let round = 0; round < 1000; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (inFlight.size === 0) {
      await current?.flushed();
      await closing;
      await new Promise((resolve) => setImmediate(resolve));
      if (inFlight.size === 0) return;
    } else {
      await Promise.allSettled([...inFlight]);
    }
  }
}

/**
 * Test seam: forget the run this process was writing, as a process that died
 * would — its files stay exactly as the last write left them.
 */
export async function resetUpdateLogForTests(): Promise<void> {
  await settleUpdateLogForTests();
  if (current) {
    for (const f of current.activeFollows()) await f.abandon().catch(() => {});
    await current.flushed();
  }
  current = null;
}

// ---------------------------------------------------------------------------
// Reading (the route)

/** The newest run's log, or null when no update has written one. */
export async function latestUpdateLog(): Promise<UpdateLogInfo | null> {
  const latest = await latestRunId();
  return latest ? updateLogInfo(latest) : null;
}

/** A run's log as it is on disk now, or null for an id this box has no log for. */
export async function updateLogInfo(id: string): Promise<UpdateLogInfo | null> {
  if (!UPDATE_LOG_ID_RE.test(id)) return null;
  let size: number;
  try {
    size = (await fs.promises.stat(logPath(id))).size;
  } catch {
    return null;
  }
  const meta = await readMeta(id);
  return {
    id,
    // What the record accounts for: bytes past it are a write whose record a
    // dying process never made, which the next one truncates and writes again.
    size: meta ? Math.min(size, meta.size) : size,
    // A log with no record is one an older build cannot have written: it is
    // read as finished rather than followed for ever.
    finished: meta ? meta.finished : true,
    ...(meta?.outcome ? { outcome: meta.outcome } : {}),
    startedAt: meta?.startedAt ?? "",
  };
}

/**
 * The length of the longest prefix of `buf` that ends on a whole UTF-8
 * character, so a chunk never splits one (the offsets are bytes).
 */
export function wholeUtf8Length(buf: Uint8Array): number {
  const n = buf.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const byte = buf[n - back];
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte: look further back
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

/**
 * Up to `max` bytes of a run's log from byte `offset`, cut on a character
 * boundary: the text and the offset to ask from next. Answers "" at the end.
 */
export async function readUpdateLogChunk(
  id: string,
  offset: number,
  max: number = 64 * 1024,
  /** Read nothing at or past this byte (the recorded size). */
  limit: number = Number.MAX_SAFE_INTEGER,
): Promise<{ text: string; next: number } | null> {
  if (!UPDATE_LOG_ID_RE.test(id)) return null;
  max = Math.max(0, Math.min(max, limit - offset));
  if (max === 0) return { text: "", next: offset };
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(logPath(id), "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buf, 0, max, offset);
    // Also at the end of the file: a reader can meet a write half-way.
    const whole = wholeUtf8Length(buf.subarray(0, bytesRead));
    return { text: buf.subarray(0, whole).toString("utf8"), next: offset + whole };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** `<run>:<offset>`, the SSE event id a reconnecting reader sends back, or null for anything else. */
export function parseUpdateLogResumeId(value: string | null): { run: string; offset: number } | null {
  if (!value) return null;
  const at = value.lastIndexOf(":");
  if (at <= 0) return null;
  const run = value.slice(0, at);
  const offset = Number(value.slice(at + 1));
  if (!UPDATE_LOG_ID_RE.test(run) || !Number.isSafeInteger(offset) || offset < 0) return null;
  return { run, offset };
}

/** The path of a run's log, for a download. Null for an id that is not one. */
export function updateLogFile(id: string): string | null {
  return UPDATE_LOG_ID_RE.test(id) ? logPath(id) : null;
}
