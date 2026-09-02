import fsp from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";

/**
 * A durable transcript for a harness whose transport does not keep one.
 *
 * SERVER ONLY.
 *
 * WHY THIS EXISTS, and why it is not the harness' own memory. Two stores now
 * describe one Hermes conversation and they answer different questions:
 *
 *   - `~/.hermes/state.db` is the AGENT's memory. It is what `--resume`
 *     threads, it decides what the model knows, and it is Hermes' to own.
 *   - This file is the UI's REPLAY LOG. It decides what the screen shows after
 *     a refresh, and nothing else.
 *
 * Reading the agent's DB for the screen was the obvious shortcut and is
 * rejected on purpose: it would spawn a Python process per read, it would
 * couple the chat surface to a private `schema_version`-stamped schema right as
 * the version pin lands, and `hermes sessions list` answers "No sessions found"
 * on the live box anyway because listing is workspace-scoped by cwd while the
 * chat route runs from HOME. Two jobs, two stores, and neither pretends to be
 * the other — in particular NOTHING here may ever decide what the agent knows.
 *
 * SPLIT BRAIN IS ACCEPTED, AND BOUNDED. The two can diverge: a turn whose
 * process dies after the model answered but before the reply is appended, or a
 * customer running `hermes chat` from a shell against the same session. The
 * write order is what bounds the damage — the QUESTION is appended before the
 * child is spawned and the ANSWER only on success, so a lost turn shows a
 * question with no answer (visibly incomplete) rather than an answer to
 * nothing.
 *
 * JSONL because an append is one `appendFile` with no read-modify-write. A
 * Hermes turn can run for 600 s and the service can restart under it; a store
 * that had to read the whole conversation back before adding a line to it would
 * be the thing that corrupts on that restart.
 */

/**
 * Where transcripts live: beside `config.json` and `kv.json`, under DATA_DIR.
 *
 * That location is load-bearing for factory reset. The reset route wipes
 * everything under DATA_DIR that is not named in its `DATA_KEEP` allowlist, so
 * a transcript directory here is erased by DEFAULT rather than by a rule
 * somebody has to remember to add. `transcript-store-reset.test.ts` pins that:
 * these files hold the customer's own words, and a resold box handing them to
 * its next owner is the failure that matters most here.
 */
export const TRANSCRIPT_DIR = path.join(DATA_DIR, "chat-transcripts");

/**
 * Directory 0700 and every file 0600, matching `config.json` next door.
 *
 * The threat is not remote — this is a single-user box — it is the other local
 * accounts and any service that runs as one. A transcript is the least
 * redacted thing on the device: passwords the user typed at the agent, names,
 * addresses, whatever was in the picture they attached.
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Retention, applied together: whichever bites first.
 *
 * 2 MB of conversation is far more than the 50 messages the UI ever renders,
 * and 500 records is roughly 250 exchanges. The point is not to keep the
 * transcript small, it is that an unbounded append-only file on a device with a
 * customer's disk to protect is a slow leak with no upper bound at all.
 */
const MAX_RECORDS = 500;

/**
 * How many records each transcript this process has touched currently holds.
 *
 * Purely an optimisation: it saves re-reading the file on every append just to
 * find out whether the record cap has been reached. Anything that removes a
 * transcript drops its entry, and an entry this process never had is derived
 * from disk on first use, so a stale value cannot outlive the file.
 */
const recordCounts = new Map<string, number>();
const MAX_BYTES = 2 * 1024 * 1024;

/** A transcript nobody has touched for this long is swept on the next boot. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A record can only be so long. A single 600-second agentic turn can print a
 * lot, and the screen shows a bubble, not a book — but the real reason for the
 * cap is that one runaway reply must not be able to blow the whole file past
 * its budget in a single append.
 */
const MAX_TEXT_BYTES = 64 * 1024;
/** Media refs are paths, and a reply carries a handful at most. */
const MAX_MEDIA_REFS = 8;
/** A turn's tool chips. Matches the cap the turn reader applies at the source. */
const MAX_TOOL_CALLS = 24;
/** One chip's argument summary. Long enough to recognise the step by. */
const MAX_DETAIL_CHARS = 160;

export type TranscriptRole = "user" | "assistant" | "system";

/**
 * One step the agent took during a turn.
 *
 * Deliberately harness-NEUTRAL and structural rather than an import from the
 * Hermes reader: OpenClaw turns have tool activity too, and the transcript is
 * the one store both editions write to. It records what a chip renders, not
 * what any one agent's wire format happens to call it.
 */
export interface TranscriptToolCall {
  /** The tool's own name, e.g. "terminal". */
  name: string;
  /** A short summary of what it was called with. */
  detail?: string;
  /** Whether it came back clean. Absent when no result was recorded. */
  status?: "ok" | "error";
}

export interface TranscriptRecord {
  role: TranscriptRole;
  text: string;
  /** Epoch ms on the SERVER clock, so both editions timestamp the same way. */
  timestamp: number;
  /** `/setup-api/chat/media` refs for pictures. */
  media?: string[];
  /** Same, for spoken replies. Kept apart for the same reason `ChatMessage` does. */
  audio?: string[];
  /**
   * The model's internal monologue for this turn, kept OUT of `text`.
   *
   * Its own field precisely so replay can render it the way the live turn did —
   * collapsed, under the answer — instead of pasting it back into the bubble,
   * which is what the transcript used to preserve forever.
   */
  reasoning?: string;
  /** The tools the agent used, in call order. */
  toolCalls?: TranscriptToolCall[];
  /**
   * The model that actually produced this reply, and the provider behind it.
   *
   * Per RECORD rather than per conversation, because one conversation can be
   * answered by several models: the pills can be changed between turns, and the
   * whole reason this field exists is that a switch which silently failed to
   * apply was indistinguishable from one that worked. Written from what the
   * transport reported for the turn, never from what the picker was showing.
   */
  model?: string;
  provider?: string;
  /** The run this record belongs to, so a reconcile can match it to a bubble. */
  turnId?: string;
  /** Only ever "error", and only on a record that reports a failed turn. */
  variant?: "error";
}

/**
 * One chat surface, one transcript.
 *
 * The desktop chat is a single conversation — there is one popup and one thread
 * in it — so there is one file and its name is a constant rather than a
 * parameter threaded through four call sites for a second value that does not
 * exist. THIS is the line to change when a second chat surface arrives: make it
 * an argument, and `transcriptKeyIsSafe` below is already the validator that
 * argument needs.
 */
export const DESKTOP_TRANSCRIPT_KEY = "desktop";

/**
 * A key must be a bare filename, because it becomes one.
 *
 * Unused while the key is a constant, and deliberately kept anyway: the moment
 * the key comes from a request this is the guard that stops `../../openclaw.json`
 * being a transcript name. Exported so its test can hold it to that.
 */
export function transcriptKeyIsSafe(key: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(key);
}

function transcriptPath(key: string): string {
  if (!transcriptKeyIsSafe(key)) {
    throw new Error("Invalid transcript key");
  }
  return path.join(TRANSCRIPT_DIR, `${key}.jsonl`);
}

/** Clamp one tool chip to what a line is allowed to carry. */
function boundToolCall(call: TranscriptToolCall): TranscriptToolCall {
  const detail = typeof call.detail === "string" ? call.detail : "";
  return {
    name: String(call.name).slice(0, MAX_DETAIL_CHARS),
    ...(detail ? { detail: detail.slice(0, MAX_DETAIL_CHARS) } : {}),
    ...(call.status === "ok" || call.status === "error" ? { status: call.status } : {}),
  };
}

/** Clamp one record to what a line is allowed to carry. */
function boundRecord(record: TranscriptRecord): TranscriptRecord {
  const text = typeof record.text === "string" ? record.text : "";
  // The monologue gets the same budget as the answer and is clamped
  // separately, so a long think cannot eat the reply's share of the line.
  const reasoning = typeof record.reasoning === "string" ? record.reasoning : "";
  const toolCalls = Array.isArray(record.toolCalls)
    ? record.toolCalls.filter((call) => call && typeof call.name === "string" && call.name)
    : [];
  return {
    role: record.role,
    // Byte-safe truncation is not needed: this bounds a JSON line's size, and
    // slicing by code unit cannot exceed the byte budget it is compared against.
    text: text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text,
    timestamp: Number.isFinite(record.timestamp) ? record.timestamp : Date.now(),
    ...(record.media?.length ? { media: record.media.slice(0, MAX_MEDIA_REFS) } : {}),
    ...(record.audio?.length ? { audio: record.audio.slice(0, MAX_MEDIA_REFS) } : {}),
    ...(reasoning
      ? {
        reasoning: reasoning.length > MAX_TEXT_BYTES
          ? reasoning.slice(0, MAX_TEXT_BYTES)
          : reasoning,
      }
      : {}),
    ...(toolCalls.length
      ? { toolCalls: toolCalls.slice(0, MAX_TOOL_CALLS).map(boundToolCall) }
      : {}),
    // Short identifiers, clamped the same way everything else on the line is —
    // they arrive from the dashboard rather than from us.
    ...(record.model ? { model: String(record.model).slice(0, MAX_DETAIL_CHARS) } : {}),
    ...(record.provider ? { provider: String(record.provider).slice(0, MAX_DETAIL_CHARS) } : {}),
    ...(record.turnId ? { turnId: record.turnId } : {}),
    ...(record.variant ? { variant: record.variant } : {}),
  };
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(TRANSCRIPT_DIR, { recursive: true, mode: DIR_MODE });
  // `mkdir`'s mode is ignored when the directory already exists, and an older
  // build (or a umask) may have left it at 0755. Best effort: a failed chmod
  // must not cost the user their transcript.
  await fsp.chmod(TRANSCRIPT_DIR, DIR_MODE).catch(() => {});
}

/**
 * Add one line. Never throws: a transcript is a convenience and a failure to
 * write one must not fail the turn the user actually asked for.
 *
 * Returns whether the line landed, so a caller that wants to log the miss can,
 * and so the tests can assert the failure path without reading the disk.
 */
export async function appendTranscript(
  record: TranscriptRecord,
  key: string = DESKTOP_TRANSCRIPT_KEY,
): Promise<boolean> {
  try {
    await ensureDir();
    const file = transcriptPath(key);
    const line = `${JSON.stringify(boundRecord(record))}\n`;
    await healTruncatedTail(file);
    await fsp.appendFile(file, line, { mode: FILE_MODE, encoding: "utf8" });
    // `appendFile`'s mode applies only when it CREATES the file, so a file that
    // predates this (or a umask that widened it) keeps whatever it had.
    await fsp.chmod(file, FILE_MODE).catch(() => {});
    const known = recordCounts.get(file);
    if (known !== undefined) recordCounts.set(file, known + 1);
    await trimIfOversized(file);
    return true;
  } catch (err) {
    // Never the record itself, and never the path: this log line is the one
    // piece of the transcript pipeline that reaches the journal, and the
    // journal is not where the customer's words belong.
    console.warn(
      "[chat/transcript] could not append:",
      err instanceof Error ? err.message : "unknown error",
    );
    return false;
  }
}

/**
 * Close off a line a crash left unterminated, before adding the next one.
 *
 * A turn can run for 600 s and the service can restart under it, so a partial
 * write is a real state this file reaches. Without this the next append lands
 * on the SAME line and glues a good record onto a broken one — so the reader
 * drops both, and the damage from one interrupted write spreads to the message
 * after it. Costs one `stat` and a single-byte read per append.
 */
async function healTruncatedTail(file: string): Promise<void> {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || stat.size === 0) return;
  let handle: import("fs/promises").FileHandle | null = null;
  try {
    handle = await fsp.open(file, "r");
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, stat.size - 1);
    if (buffer[0] === 0x0a) return;
  } catch {
    return;
  } finally {
    await handle?.close().catch(() => {});
  }
  await fsp.appendFile(file, "\n", { encoding: "utf8" });
}

/**
 * Rewrite the file down to the caps — but only once it is actually over one.
 *
 * SIZE-TRIGGERED, never per-append. The trim is a read-modify-rewrite of the
 * whole conversation, which is exactly the work JSONL was chosen to avoid; run
 * on every turn it would put that cost back on a Jetson for no benefit. One
 * `stat` per append is the price, and it only pays out once every few hundred
 * messages.
 */
async function trimIfOversized(file: string): Promise<void> {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) return;
  // The RECORD cap needs enforcing too, and the byte cap alone never reached
  // it: 500 short turns is far under 2 MB, so a long conversation of small
  // messages was never compacted — and because every append refreshes the
  // file's mtime, the retention sweep never reached that older content either.
  // Counting lines per append is the read the size trigger exists to avoid, so
  // the count is carried in memory and only re-derived when this process has
  // not seen the file before.
  let records = recordCounts.get(file);
  if (records === undefined) {
    records = await countRecords(file);
    recordCounts.set(file, records);
  }
  if (stat.size <= MAX_BYTES && records <= MAX_RECORDS) return;
  const raw = await fsp.readFile(file, "utf8").catch(() => null);
  if (raw === null) return;
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const kept = lines.slice(-MAX_RECORDS);
  // Newest-last, so dropping from the FRONT is what keeps the recent
  // conversation. Trim by bytes too — 500 records of 64 KB each would still be
  // over budget.
  let bytes = kept.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  while (kept.length > 1 && bytes > MAX_BYTES) {
    bytes -= Buffer.byteLength(kept[0]) + 1;
    kept.shift();
  }
  // Write-then-rename, so a crash mid-trim leaves the previous complete file
  // rather than a half-written one. The temp is created at 0600 and the rename
  // carries those permissions onto the target.
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, kept.length ? `${kept.join("\n")}\n` : "", { mode: FILE_MODE });
  await fsp.chmod(tmp, FILE_MODE).catch(() => {});
  await fsp.rename(tmp, file);
  recordCounts.set(file, kept.length);
}

/** Records currently in a transcript, counted off the disk. */
async function countRecords(file: string): Promise<number> {
  const raw = await fsp.readFile(file, "utf8").catch(() => null);
  if (raw === null) return 0;
  return raw.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * The tail of the conversation, oldest first, at most `limit` records.
 *
 * A missing file is an empty transcript, not an error: that is what a fresh
 * chat looks like, and every caller would otherwise have to special-case it.
 * A malformed line is skipped rather than fatal — one bad append (a crash
 * mid-line) must not cost the user the whole conversation.
 */
export async function readTranscript(
  limit = 50,
  key: string = DESKTOP_TRANSCRIPT_KEY,
): Promise<TranscriptRecord[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(transcriptPath(key), "utf8");
  } catch {
    return [];
  }
  const records: TranscriptRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (record) records.push(record);
  }
  const capped = Math.max(0, Math.min(limit, MAX_RECORDS));
  // `slice(-0)` is `slice(0)` — the whole array. A caller asking for zero
  // records (or a negative count from arithmetic upstream) would have been
  // handed the entire conversation instead of nothing.
  if (capped === 0) return [];
  return records.slice(-capped);
}

/**
 * One line back into a record, or null.
 *
 * Everything is re-validated on the way out even though we wrote it: the file
 * is on a disk a shell can reach, and a value from it is about to be rendered
 * in the browser. Trusting our own writer is how a hand-edited `role` becomes
 * a bubble the UI has no branch for.
 */
function parseRecord(line: string): TranscriptRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  const role = row.role;
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  if (typeof row.text !== "string") return null;
  const timestamp = typeof row.timestamp === "number" && Number.isFinite(row.timestamp)
    ? row.timestamp
    : 0;
  const strings = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const list = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return list.length ? list.slice(0, MAX_MEDIA_REFS) : undefined;
  };
  const media = strings(row.media);
  const audio = strings(row.audio);
  // Both are OPTIONAL on the way in, which is what makes this backward
  // compatible: every line written before these fields existed parses exactly
  // as it did, and simply replays without a disclosure or chips.
  const reasoning = typeof row.reasoning === "string" && row.reasoning ? row.reasoning : undefined;
  const toolCalls = Array.isArray(row.toolCalls)
    ? row.toolCalls
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .map((entry) => {
        const name = typeof entry.name === "string" ? entry.name : "";
        const detail = typeof entry.detail === "string" ? entry.detail : "";
        const status = entry.status === "ok" || entry.status === "error" ? entry.status : undefined;
        return {
          name,
          ...(detail ? { detail } : {}),
          ...(status ? { status } : {}),
        } satisfies TranscriptToolCall;
      })
      .filter((call) => call.name)
      .slice(0, MAX_TOOL_CALLS)
    : [];
  return {
    role,
    text: row.text,
    timestamp,
    ...(media ? { media } : {}),
    ...(audio ? { audio } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(typeof row.model === "string" && row.model ? { model: row.model } : {}),
    ...(typeof row.provider === "string" && row.provider ? { provider: row.provider } : {}),
    ...(typeof row.turnId === "string" && row.turnId ? { turnId: row.turnId } : {}),
    ...(row.variant === "error" ? { variant: "error" as const } : {}),
  };
}

/**
 * Forget the conversation. Idempotent — "new chat" is a double-clickable
 * button, and a transcript that is already gone is the desired end state.
 */
export async function clearTranscript(key: string = DESKTOP_TRANSCRIPT_KEY): Promise<void> {
  await fsp.rm(transcriptPath(key), { force: true });
  // The trim's temp file is the one thing that could survive a crash holding a
  // copy of what was just deleted.
  await fsp.rm(`${transcriptPath(key)}.tmp`, { force: true });
  // The file is gone, so the remembered length describes nothing.
  recordCounts.delete(transcriptPath(key));
}

/**
 * Delete transcripts nobody has touched in a month.
 *
 * Age, not size: the per-file caps already bound how big any one conversation
 * gets, so what is left to bound is how many stale ones accumulate. Best
 * effort and never throws — this runs at boot and must not be able to stop it.
 */
export async function sweepTranscripts(now = Date.now()): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(TRANSCRIPT_DIR);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl") && !entry.endsWith(".jsonl.tmp")) continue;
    const file = path.join(TRANSCRIPT_DIR, entry);
    try {
      const stat = await fsp.stat(file);
      if (now - stat.mtimeMs <= MAX_AGE_MS) continue;
      await fsp.rm(file, { force: true });
      recordCounts.delete(file);
      removed += 1;
    } catch {
      // A file that vanished under us, or one we cannot stat. Either way there
      // is nothing to do and nothing worth failing the sweep over.
    }
  }
  return removed;
}

/** Test seam: the caps, so a test cannot silently drift from the module. */
export const TRANSCRIPT_LIMITS = {
  MAX_RECORDS,
  MAX_BYTES,
  MAX_AGE_MS,
  MAX_TEXT_BYTES,
  MAX_MEDIA_REFS,
  MAX_TOOL_CALLS,
  MAX_DETAIL_CHARS,
  DIR_MODE,
  FILE_MODE,
} as const;
