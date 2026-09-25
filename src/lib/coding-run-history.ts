/**
 * What the box keeps of FINISHED coding runs, and where (TASK-1178).
 *
 * The runs file (data/coding-agent-runs.json) held the newest thirty runs and
 * nothing else: the thirty-first finished run was deleted with its evidence
 * folder and its inputs, and Claude Code deleted the run's transcript on its own
 * after thirty days. The owner's setting, `coding_agent_history_retention`,
 * picks one of four answers:
 *
 *  - `standard` (the default, and the behaviour every box had before): the
 *    newest HISTORY_LIVE_RUNS_KEPT runs; an older one is deleted.
 *  - `extended`: the newest N (HISTORY_EXTENDED_LIMITS), evidence and inputs
 *    kept with them.
 *  - `everything`: no run is ever deleted unless the owner clears it, and
 *    Claude Code is told to keep its transcripts too (`cleanupPeriodDays`).
 *  - `archive`: the newest thirty as in standard; an older run is MOVED into
 *    data/coding-agent-archive/<runId>/ — record, evidence, inputs, stream log
 *    and a copy of the transcript — browsable read-only and exported as .zip.
 *
 * WHY THE RUNS FILE STAYS AT THIRTY IN EVERY MODE. It is rewritten whole on
 * every progress flush (once a second while a run works), so a thousand
 * records in it would be a thousand records serialised and written to the
 * flash every second. Runs past the newest thirty that a mode keeps are
 * "older runs": one JSON file each under data/coding-agent-history/, with a
 * small index for paging, read only when somebody asks for them. Their
 * evidence and inputs stay exactly where they were, so an older run opens on
 * the same run page as a recent one.
 *
 * THE DISK GUARD. Nanos have a small eMMC. Below HISTORY_MIN_FREE_BYTES free,
 * a run leaving the newest thirty is deleted as in standard, whatever the mode
 * says — the history stops GROWING — and the settings card says so. What is
 * already kept is not mass-deleted by the guard: that is the owner's to clear.
 *
 * Sync fs for everything the runs store calls (the trim runs inside insertRun,
 * which is sync on purpose — see coding-agent.ts); async only for the
 * owner-facing usage walk and the export. Nothing here imports coding-agent.ts:
 * that module imports this one, and hands it the paths it owns.
 */
import fs from "fs";
import os from "os";
import path, { untraced } from "@/lib/runtime-path";
import { DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import {
  ARTIFACT_NAME_RE,
  artifactKind,
  artifactsRoot,
  INTERPRETER_TREES,
  safeRunId,
  type ArtifactKind,
} from "@/lib/coding-agent-artifacts";
import { inputsRoot, SHARED_INPUTS_DIR_NAME } from "@/lib/coding-run-inputs";
import { processStore } from "@/lib/process-store";
import { taskTitle } from "@/lib/task-title";
import type { ZipSource } from "@/lib/zip-writer";

// ─── The setting ─────────────────────────────────────────────────────────────

export const CODING_AGENT_HISTORY_RETENTION_CONFIG_KEY = "coding_agent_history_retention";
/** N for the extended mode. Kept when the mode changes, so switching back restores it. */
export const CODING_AGENT_HISTORY_LIMIT_CONFIG_KEY = "coding_agent_history_limit";
/**
 * What the box changed in Claude Code's settings files to keep transcripts,
 * so leaving "keep everything" can put back exactly that and nothing else.
 * Bookkeeping, not a setting: not in the reset list, emptied by the release.
 */
export const CODING_AGENT_HISTORY_PINS_CONFIG_KEY = "coding_agent_history_transcript_pins";

export const HISTORY_RETENTION_MODES = ["standard", "extended", "everything", "archive"] as const;
export type HistoryRetentionMode = typeof HISTORY_RETENTION_MODES[number];
export const HISTORY_EXTENDED_LIMITS = [100, 300, 1000] as const;
export const DEFAULT_HISTORY_EXTENDED_LIMIT = 100;

/**
 * Runs the live list holds in EVERY mode — the thirty the box always kept.
 * coding-agent.ts's MAX_RUNS_KEPT is this number.
 */
export const HISTORY_LIVE_RUNS_KEPT = 30;

export interface HistoryPolicy {
  mode: HistoryRetentionMode;
  /** The extended mode's N. Carried in every mode; only read by extended. */
  limit: number;
}

export const STANDARD_HISTORY_POLICY: HistoryPolicy = Object.freeze({ mode: "standard", limit: DEFAULT_HISTORY_EXTENDED_LIMIT });

export function isHistoryRetentionMode(value: unknown): value is HistoryRetentionMode {
  return typeof value === "string" && (HISTORY_RETENTION_MODES as readonly string[]).includes(value);
}

export function isHistoryExtendedLimit(value: unknown): value is number {
  return typeof value === "number" && (HISTORY_EXTENDED_LIMITS as readonly number[]).includes(value);
}

/**
 * The policy from the two raw config values. Anything this build does not
 * know reads as the default — a hand-edited or future value must never make
 * the box keep LESS than it did, and standard is what it always did.
 */
export function historyPolicyFrom(rawMode: unknown, rawLimit: unknown): HistoryPolicy {
  return {
    mode: isHistoryRetentionMode(rawMode) ? rawMode : "standard",
    limit: isHistoryExtendedLimit(rawLimit) ? rawLimit : DEFAULT_HISTORY_EXTENDED_LIMIT,
  };
}

/** Does this mode keep runs past the live thirty as older runs (rather than delete or archive them)? */
export function keepsOlderRuns(policy: HistoryPolicy): boolean {
  return policy.mode === "extended" || policy.mode === "everything";
}

/**
 * How many older runs this mode keeps beside `liveCount` records in the runs
 * file: N minus what the live list already holds for extended, no limit for
 * everything, none for standard and archive (whose older runs are deleted or
 * archived — including ones kept under a mode the owner has since left).
 */
export function olderRunsCap(policy: HistoryPolicy, liveCount: number): number {
  if (policy.mode === "everything") return Number.POSITIVE_INFINITY;
  if (policy.mode === "extended") return Math.max(0, policy.limit - liveCount);
  return 0;
}

// ─── The disk guard ──────────────────────────────────────────────────────────

/**
 * Free space below which history stops growing. Two gigabytes: a Jetson Nano's
 * 16 GB eMMC has four or five free after the OS, and an update needs room for
 * a full build beside the running one.
 */
export const HISTORY_MIN_FREE_BYTES = 2 * 1024 ** 3;

export interface DiskSpace {
  freeBytes: number | null;
  totalBytes: number | null;
}

/**
 * Free and total bytes of the filesystem data/ is on. Null halves when the
 * question cannot be asked — which the guard reads as "not low": a statfs
 * that failed says nothing about the disk, and must not make the box delete.
 */
export function diskSpace(dir: string = DATA_DIR): DiskSpace {
  let probe = path.resolve(dir);
  // A fresh box may not have data/ yet; the filesystem is the nearest ancestor's.
  for (let i = 0; i < 64 && !fs.existsSync(probe); i += 1) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  try {
    const st = fs.statfsSync(probe);
    return { freeBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

export function isDiskLow(space: DiskSpace): boolean {
  return space.freeBytes !== null && space.freeBytes < HISTORY_MIN_FREE_BYTES;
}

// ─── Small sync helpers ──────────────────────────────────────────────────────

function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = untraced(`${file}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    // best-effort, as the runs store does
  }
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Entries a walk looks at before it stops. A history is thousands of files, not millions. */
const MAX_WALK_ENTRIES = 200_000;

interface WalkedFile {
  /** Relative to the walk's root, forward slashes. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/**
 * Every regular file under `root`, without following a link and without
 * entering an interpreter tree (a venv a run left behind is not history).
 * Missing root → nothing.
 */
function* walkFilesSync(root: string, skipTop: ReadonlySet<string> = new Set()): Generator<WalkedFile> {
  const pending: string[] = [""];
  let seen = 0;
  while (pending.length) {
    const rel = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) return;
      if (!rel && skipTop.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!INTERPRETER_TREES.has(entry.name)) pending.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = path.join(root, childRel);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      yield { rel: childRel, abs, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  }
}

function treeBytesSync(root: string): number {
  let bytes = 0;
  for (const f of walkFilesSync(root)) bytes += f.size;
  return bytes;
}

/** What a tree weighs, walked asynchronously so the owner's page does not stall the server. */
async function treeBytes(root: string, skipTop: ReadonlySet<string> = new Set()): Promise<{ bytes: number; truncated: boolean }> {
  const pending: string[] = [root];
  let bytes = 0;
  let seen = 0;
  while (pending.length) {
    const dir = pending.pop()!;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) return { bytes, truncated: true };
      if (dir === root && skipTop.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.promises.lstat(full).catch(() => null);
      if (stat?.isFile()) bytes += stat.size;
    }
  }
  return { bytes, truncated: false };
}

async function fileBytes(file: string): Promise<number> {
  const stat = await fs.promises.lstat(file).catch(() => null);
  return stat?.isFile() ? stat.size : 0;
}

/**
 * Move a file or folder, across filesystems if it has to. False when there is
 * nothing to move or the move failed — the caller records the absence.
 */
function moveInto(source: string | null, target: string): boolean {
  if (!source) return false;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(source);
  } catch {
    return false;
  }
  // A link where a folder or a log should be is not the run's to move: the
  // link goes, its target stays where it is.
  if (stat.isSymbolicLink()) {
    fs.rmSync(source, { force: true });
    return false;
  }
  try {
    fs.renameSync(source, target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
      console.error(`[coding-agent] could not archive ${source}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }
  try {
    fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(source, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error(`[coding-agent] could not archive ${source}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Copy one REGULAR file (never through a link). False when there is none. */
function copyRegular(source: string | null, target: string): boolean {
  if (!source) return false;
  try {
    if (!fs.lstatSync(source).isFile()) return false;
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** A loosely-typed run record: the fields this module reads. coding-agent.ts owns the real shape. */
export interface HistoryRecord {
  id: string;
  task?: unknown;
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  directory?: unknown;
  worktree?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The project folder a record belongs to — `projectDirectoryOf` in coding-agent.ts, on an untyped record. */
function projectOf(record: HistoryRecord): string {
  const w = record.worktree as { project?: unknown } | null | undefined;
  return typeof w?.project === "string" && w.project ? w.project : str(record.directory);
}

const byNewest = <T extends { startedAt: number; id: string }>(a: T, b: T) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1);

// ─── Older runs (extended, everything) ──────────────────────────────────────

const OLDER_RUNS_DIR = "coding-agent-history";
const INDEX_FILE = "index.json";

export function olderRunsRoot(): string {
  return path.join(DATA_DIR, OLDER_RUNS_DIR);
}

function olderRecordPath(runId: string): string | null {
  const safe = safeRunId(runId);
  if (!safe) return null;
  return path.join(olderRunsRoot(), `${safe}.json`);
}

/** One older run, as the index keeps it: enough to page and filter without opening its file. */
export interface OlderRunEntry {
  id: string;
  startedAt: number;
  completedAt: number | null;
  status: string;
  directory: string;
  project: string;
}

function olderEntryOf(record: HistoryRecord): OlderRunEntry | null {
  const id = safeRunId(record.id);
  const startedAt = num(record.startedAt);
  if (!id || startedAt === null) return null;
  return {
    id,
    startedAt,
    completedAt: num(record.completedAt),
    status: str(record.status),
    directory: str(record.directory),
    project: projectOf(record),
  };
}

/** True when there is an older-runs folder at all — one stat, the cost a standard box pays per insert. */
export function hasOlderRuns(): boolean {
  return fs.existsSync(olderRunsRoot());
}

/**
 * The older runs, newest first. The index is trusted only as far as the folder
 * agrees with it: an entry whose file is gone is dropped, a file the index does
 * not name is read and added — so a crash between the two writes, a restore
 * or a hand edit heals on the next look.
 */
export function olderRunIndex(): OlderRunEntry[] {
  const root = olderRunsRoot();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const onDisk = new Set(names.filter((n) => n.endsWith(".json") && n !== INDEX_FILE).map((n) => n.slice(0, -5)).filter((id) => safeRunId(id) === id));
  const raw = readJson(path.join(root, INDEX_FILE));
  const listed = Array.isArray(raw) ? raw.filter((e): e is OlderRunEntry => !!e && typeof e === "object" && typeof (e as OlderRunEntry).id === "string" && typeof (e as OlderRunEntry).startedAt === "number") : [];
  const kept = listed.filter((e) => onDisk.has(e.id));
  const known = new Set(kept.map((e) => e.id));
  let changed = !Array.isArray(raw) || kept.length !== raw.length;
  for (const id of onDisk) {
    if (known.has(id)) continue;
    const record = readJson(path.join(root, `${id}.json`)) as HistoryRecord | undefined;
    const entry = record && typeof record === "object" ? olderEntryOf({ ...record, id }) : null;
    if (entry) kept.push(entry);
    changed = true;
  }
  kept.sort(byNewest);
  if (changed) {
    try {
      writeJsonAtomic(path.join(root, INDEX_FILE), kept);
    } catch (err) {
      console.error("[coding-agent] could not rewrite the older-runs index:", err instanceof Error ? err.message : err);
    }
  }
  return kept;
}

/**
 * Keep a run past the live thirty: its record into a file of its own, then
 * its index entry. Evidence and inputs are not touched — they stay where the
 * run page already finds them. False (and nothing half-written) on failure,
 * so the caller can fall back to what standard would have done.
 */
export function writeOlderRun(record: HistoryRecord): boolean {
  const file = olderRecordPath(record.id);
  const entry = olderEntryOf(record);
  if (!file || !entry) return false;
  try {
    writeJsonAtomic(file, record);
  } catch (err) {
    console.error(`[coding-agent] could not keep ${record.id} as an older run:`, err instanceof Error ? err.message : err);
    try { fs.rmSync(file, { force: true }); } catch { /* nothing to undo */ }
    return false;
  }
  // The index adopts a file it does not name — which this one now is.
  olderRunIndex();
  invalidateUsage();
  return true;
}

/** The parsed record of an older run, or undefined. Normalising it is coding-agent.ts's job. */
export function readOlderRunRecord(runId: string): unknown {
  const file = olderRecordPath(runId);
  return file ? readJson(file) : undefined;
}

/** Forget an older run's record and index entry (not its evidence — the caller decides that). */
export function removeOlderRun(runId: string): void {
  const file = olderRecordPath(runId);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    console.error(`[coding-agent] could not remove the older run ${runId}:`, err instanceof Error ? err.message : err);
  }
  try {
    const root = olderRunsRoot();
    const raw = readJson(path.join(root, INDEX_FILE));
    if (Array.isArray(raw)) writeJsonAtomic(path.join(root, INDEX_FILE), raw.filter((e) => (e as OlderRunEntry)?.id !== runId));
  } catch {
    // olderRunIndex heals it on the next look.
  }
  invalidateUsage();
}

// ─── The archive (archive mode) ──────────────────────────────────────────────

const ARCHIVE_DIR = "coding-agent-archive";
const RUN_FILE = "run.json";
const META_FILE = "archive.json";
export const ARCHIVE_EVIDENCE_DIR = "evidence";
export const ARCHIVE_INPUTS_DIR = "inputs";
const ARCHIVE_TRANSCRIPT = "transcript.jsonl";
const ARCHIVE_STREAM = "stream.jsonl";
const ARCHIVE_STDERR = "stream.err";

export function archiveRoot(): string {
  return path.join(DATA_DIR, ARCHIVE_DIR);
}

function archiveDir(runId: string): string | null {
  const safe = safeRunId(runId);
  if (!safe) return null;
  const root = path.resolve(archiveRoot());
  const dir = path.resolve(root, safe);
  return dir.startsWith(root + path.sep) ? dir : null;
}

/** Why a run is in the archive: it fell off the live list, or the owner cleared it there. */
export type ArchiveReason = "trimmed" | "cleared";

/** One archived run, as the index keeps it. */
export interface ArchiveEntry {
  id: string;
  title: string;
  status: string;
  startedAt: number;
  completedAt: number | null;
  archivedAt: number;
  directory: string;
  project: string;
  bytes: number;
  /** Top-level files in its evidence folder. */
  evidence: number;
  /** Files it was given. */
  inputs: number;
  transcript: boolean;
  stream: boolean;
  reason: ArchiveReason;
}

/** Where the parts of a run are before it is archived — coding-agent.ts knows these paths. */
export interface ArchiveSources {
  evidenceDir: string | null;
  inputsDir: string | null;
  streamLog: string | null;
  stderrLog: string | null;
  transcript: string | null;
}

function countTop(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

function archiveEntryOf(raw: unknown, id: string): ArchiveEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<ArchiveEntry>;
  const startedAt = num(e.startedAt);
  if (startedAt === null) return null;
  return {
    id,
    title: str(e.title),
    status: str(e.status),
    startedAt,
    completedAt: num(e.completedAt),
    archivedAt: num(e.archivedAt) ?? startedAt,
    directory: str(e.directory),
    project: str(e.project),
    bytes: num(e.bytes) ?? 0,
    evidence: num(e.evidence) ?? 0,
    inputs: num(e.inputs) ?? 0,
    transcript: e.transcript === true,
    stream: e.stream === true,
    reason: e.reason === "cleared" ? "cleared" : "trimmed",
  };
}

/** Rebuild an entry from a bundle whose archive.json is missing — its run.json and what is on disk. */
function archiveEntryFromBundle(dir: string, id: string): ArchiveEntry | null {
  const meta = archiveEntryOf(readJson(path.join(dir, META_FILE)), id);
  if (meta) return meta;
  const record = readJson(path.join(dir, RUN_FILE)) as HistoryRecord | undefined;
  if (!record || typeof record !== "object") return null;
  const startedAt = num(record.startedAt);
  if (startedAt === null) return null;
  let archivedAt = startedAt;
  try { archivedAt = fs.statSync(dir).mtimeMs; } catch { /* the start will do */ }
  return {
    id,
    title: taskTitle(str(record.task), 120),
    status: str(record.status),
    startedAt,
    completedAt: num(record.completedAt),
    archivedAt,
    directory: str(record.directory),
    project: projectOf(record),
    bytes: treeBytesSync(dir),
    evidence: countTop(path.join(dir, ARCHIVE_EVIDENCE_DIR)),
    inputs: countTop(path.join(dir, ARCHIVE_INPUTS_DIR)),
    transcript: fs.existsSync(path.join(dir, ARCHIVE_TRANSCRIPT)),
    stream: fs.existsSync(path.join(dir, ARCHIVE_STREAM)),
    reason: "trimmed",
  };
}

/**
 * The archived runs, newest first, healed against the folder the same way
 * olderRunIndex is: the bundles on disk are the truth, the index a cache of
 * their archive.json files.
 */
export function archiveIndex(): ArchiveEntry[] {
  const root = archiveRoot();
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const onDisk = new Set(dirents.filter((d) => d.isDirectory() && safeRunId(d.name) === d.name).map((d) => d.name));
  const raw = readJson(path.join(root, INDEX_FILE));
  const listed = Array.isArray(raw)
    ? raw.flatMap((e) => {
      const id = typeof (e as ArchiveEntry)?.id === "string" ? (e as ArchiveEntry).id : "";
      const entry = id && safeRunId(id) === id ? archiveEntryOf(e, id) : null;
      return entry ? [entry] : [];
    })
    : [];
  const kept = listed.filter((e) => onDisk.has(e.id));
  const known = new Set(kept.map((e) => e.id));
  let changed = kept.length !== (Array.isArray(raw) ? raw.length : -1);
  for (const id of onDisk) {
    if (known.has(id)) continue;
    const entry = archiveEntryFromBundle(path.join(root, id), id);
    if (entry) kept.push(entry);
    changed = true;
  }
  kept.sort(byNewest);
  if (changed) {
    try {
      writeJsonAtomic(path.join(root, INDEX_FILE), kept);
    } catch (err) {
      console.error("[coding-agent] could not rewrite the archive index:", err instanceof Error ? err.message : err);
    }
  }
  return kept;
}

/**
 * Move a run that is leaving the live list into the archive.
 *
 * The RECORD is written first, into a staging folder: once it is there nothing
 * after it can lose the run, and a failure before it answers null so the caller
 * falls back to what standard does. Then the evidence folder and the inputs are
 * MOVED (a rename on the same filesystem — no second copy on the flash), the
 * stream logs moved if the box still has them, and the transcript COPIED: it is
 * Claude Code's file, in Claude Code's folder, and the box does not delete it.
 * The staging folder is renamed into place last, so the archive never lists a
 * half-made bundle.
 */
export function archiveRun(record: HistoryRecord, sources: ArchiveSources, reason: ArchiveReason, now: number = Date.now()): ArchiveEntry | null {
  const id = safeRunId(record.id);
  const final = id ? archiveDir(id) : null;
  const startedAt = num(record.startedAt);
  if (!id || !final || startedAt === null) return null;
  const root = archiveRoot();
  const staging = path.join(root, `.${id}.partial`);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { mode: 0o700 });
    writeJsonAtomic(path.join(staging, RUN_FILE), record);
  } catch (err) {
    console.error(`[coding-agent] could not archive ${id}:`, err instanceof Error ? err.message : err);
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* nothing to undo */ }
    return null;
  }

  const evidenceMoved = moveInto(sources.evidenceDir, path.join(staging, ARCHIVE_EVIDENCE_DIR));
  const inputsMoved = moveInto(sources.inputsDir, path.join(staging, ARCHIVE_INPUTS_DIR));
  const streamMoved = moveInto(sources.streamLog, path.join(staging, ARCHIVE_STREAM));
  moveInto(sources.stderrLog, path.join(staging, ARCHIVE_STDERR));
  const transcriptCopied = copyRegular(sources.transcript, path.join(staging, ARCHIVE_TRANSCRIPT));

  const entry: ArchiveEntry = {
    id,
    title: taskTitle(str(record.task), 120),
    status: str(record.status),
    startedAt,
    completedAt: num(record.completedAt),
    archivedAt: now,
    directory: str(record.directory),
    project: projectOf(record),
    bytes: 0,
    evidence: evidenceMoved ? countTop(path.join(staging, ARCHIVE_EVIDENCE_DIR)) : 0,
    inputs: inputsMoved ? countTop(path.join(staging, ARCHIVE_INPUTS_DIR)) : 0,
    transcript: transcriptCopied,
    stream: streamMoved,
    reason,
  };
  try {
    writeJsonAtomic(path.join(staging, META_FILE), entry);
    entry.bytes = treeBytesSync(staging);
    writeJsonAtomic(path.join(staging, META_FILE), entry);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(staging, final);
  } catch (err) {
    // The record and the moved parts are in the staging folder; say where,
    // because nothing lists a staging folder.
    console.error(`[coding-agent] could not finish archiving ${id}; its parts are in ${staging}:`, err instanceof Error ? err.message : err);
    return entry;
  }
  // A bundle of this id archived before (a run re-archived after a restore)
  // is replaced, so its old index entry goes; the index then adopts the new
  // bundle from its archive.json.
  try {
    const raw = readJson(path.join(root, INDEX_FILE));
    if (Array.isArray(raw)) writeJsonAtomic(path.join(root, INDEX_FILE), raw.filter((e) => (e as ArchiveEntry)?.id !== id));
  } catch {
    // archiveIndex heals it below
  }
  archiveIndex();
  invalidateUsage();
  return entry;
}

export function listArchive(offset: number, limit: number): { entries: ArchiveEntry[]; total: number } {
  const all = archiveIndex();
  return { entries: all.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit)), total: all.length };
}

export interface ArchivedFile {
  name: string;
  bytes: number;
}

export interface ArchivedRunDetail {
  entry: ArchiveEntry;
  /** The run record exactly as it was when archived. */
  record: Record<string, unknown>;
  evidence: (ArchivedFile & { kind: ArtifactKind })[];
  inputs: ArchivedFile[];
  transcriptBytes: number | null;
  streamBytes: number | null;
}

/** The top-level regular files of a folder that pass the artifact-name rule, oldest first. */
function listTopFiles(dir: string, max: number): (ArchivedFile & { modifiedAt: number })[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: (ArchivedFile & { modifiedAt: number })[] = [];
  for (const name of names) {
    if (!ARTIFACT_NAME_RE.test(name)) continue;
    try {
      const stat = fs.lstatSync(path.join(dir, name));
      if (stat.isFile()) out.push({ name, bytes: stat.size, modifiedAt: stat.mtimeMs });
    } catch {
      // gone between the listing and the look
    }
  }
  out.sort((a, b) => a.modifiedAt - b.modifiedAt || a.name.localeCompare(b.name));
  return out.slice(-max);
}

function sizeOf(file: string): number | null {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export function readArchivedRun(runId: string): ArchivedRunDetail | null {
  const dir = archiveDir(runId);
  if (!dir || !fs.existsSync(/* turbopackIgnore: true */ dir)) return null;
  const id = path.basename(dir);
  const entry = archiveIndex().find((e) => e.id === id) ?? archiveEntryFromBundle(dir, id);
  const record = readJson(path.join(dir, RUN_FILE));
  if (!entry || !record || typeof record !== "object") return null;
  return {
    entry,
    record: record as Record<string, unknown>,
    evidence: listTopFiles(path.join(dir, ARCHIVE_EVIDENCE_DIR), 200).map(({ name, bytes }) => ({ name, bytes, kind: artifactKind(name) })),
    inputs: listTopFiles(path.join(dir, ARCHIVE_INPUTS_DIR), 200).map(({ name, bytes }) => ({ name, bytes })),
    transcriptBytes: sizeOf(path.join(dir, ARCHIVE_TRANSCRIPT)),
    streamBytes: sizeOf(path.join(dir, ARCHIVE_STREAM)),
  };
}

/**
 * One file of an archived run's evidence, for serving — the same rules as
 * artifactFilePath: a name that passes the artifact-name rule, and a realpath
 * that is exactly that name inside that folder (a link a run planted before
 * its folder was archived resolves elsewhere and is refused).
 */
export function archivedEvidencePath(runId: string, name: string): string | null {
  const dir = archiveDir(runId);
  if (!dir || !ARTIFACT_NAME_RE.test(name)) return null;
  const evidence = path.join(dir, ARCHIVE_EVIDENCE_DIR);
  try {
    const realDir = fs.realpathSync(evidence);
    const real = fs.realpathSync(path.join(evidence, name));
    if (real !== path.join(realDir, name)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** Delete every archived run. Answers how many there were. */
export function clearArchive(): number {
  const root = archiveRoot();
  const count = archiveIndex().length;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    console.error("[coding-agent] could not clear the archive:", err instanceof Error ? err.message : err);
    throw err;
  }
  invalidateUsage();
  return count;
}

/** The files of one archived run, named `<runId>/…`, for its .zip. Null when it is not archived. */
export function archivedRunZipSources(runId: string): ZipSource[] | null {
  const dir = archiveDir(runId);
  if (!dir || !fs.existsSync(/* turbopackIgnore: true */ dir)) return null;
  const id = path.basename(dir);
  return [...walkFilesSync(dir)].map((f) => ({ name: `${id}/${f.rel}`, file: f.abs, size: f.size, mtimeMs: f.mtimeMs }));
}

// ─── Claude Code's own transcripts ───────────────────────────────────────────

/**
 * `cleanupPeriodDays` while the owner keeps everything: a hundred years. Not
 * larger — Claude Code subtracts it from now as milliseconds, and a figure
 * near Date's range limit would give it an Invalid Date to compare against.
 */
export const HARNESS_KEEP_TRANSCRIPT_DAYS = 36_500;
/** Claude Code's own default when its settings name no period. */
export const HARNESS_DEFAULT_TRANSCRIPT_DAYS = 30;

type HarnessRead =
  | { state: "missing" }
  | { state: "ok"; settings: Record<string, unknown> }
  | { state: "unreadable" };

function readHarnessSettings(file: string): HarnessRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable" };
  }
  if (!text.trim()) return { state: "ok", settings: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "unreadable" };
    return { state: "ok", settings: parsed as Record<string, unknown> };
  } catch {
    return { state: "unreadable" };
  }
}

/**
 * Write a Claude Code settings file back with one key changed and every other
 * key exactly as it was: through a temp file and a rename, keeping the file's
 * mode (0600 for a file that did not exist — it sits beside credentials).
 */
function writeHarnessSettings(file: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // a new file
  }
  const tmp = untraced(`${file}.clawbox-tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** What the box changed, per settings file: was the key there, and what did it hold. */
type TranscriptPins = Record<string, { present: boolean; value?: unknown }>;

async function readPins(): Promise<TranscriptPins> {
  const raw = await configGet(CODING_AGENT_HISTORY_PINS_CONFIG_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TranscriptPins = {};
  for (const [file, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!path.isAbsolute(file) || !v || typeof v !== "object") continue;
    const pin = v as { present?: unknown; value?: unknown };
    out[file] = pin.present === true ? { present: true, value: pin.value } : { present: false };
  }
  return out;
}

async function writePins(pins: TranscriptPins): Promise<void> {
  await configSet(CODING_AGENT_HISTORY_PINS_CONFIG_KEY, Object.keys(pins).length ? pins : undefined);
}

export interface TranscriptPinResult {
  file: string;
  /**
   * kept — the box set the period; already — it was long enough; restored —
   * the owner's own value is back; left — the file had changed since, so the
   * box left it as it found it; unreadable — not a JSON object, never
   * overwritten; failed — the write did not land.
   */
  state: "kept" | "already" | "restored" | "left" | "unreadable" | "failed";
}

/**
 * Tell Claude Code to keep its transcripts, in each of the settings files the
 * box's runs use. MERGED: only `cleanupPeriodDays` is touched, a file that is
 * not a JSON object is left alone rather than replaced, and what the key held
 * before is remembered so releaseHarnessTranscripts can put it back.
 */
export async function keepHarnessTranscripts(settingsFiles: readonly string[]): Promise<TranscriptPinResult[]> {
  const pins = await readPins();
  const results: TranscriptPinResult[] = [];
  for (const file of [...new Set(settingsFiles)]) {
    const read = readHarnessSettings(file);
    if (read.state === "unreadable") {
      results.push({ file, state: "unreadable" });
      continue;
    }
    const settings = read.state === "ok" ? read.settings : {};
    const current = settings.cleanupPeriodDays;
    if (typeof current === "number" && current >= HARNESS_KEEP_TRANSCRIPT_DAYS) {
      results.push({ file, state: "already" });
      continue;
    }
    try {
      writeHarnessSettings(file, { ...settings, cleanupPeriodDays: HARNESS_KEEP_TRANSCRIPT_DAYS });
      if (!pins[file]) pins[file] = "cleanupPeriodDays" in settings ? { present: true, value: current } : { present: false };
      results.push({ file, state: "kept" });
    } catch (err) {
      console.error(`[coding-agent] could not update ${file}:`, err instanceof Error ? err.message : err);
      results.push({ file, state: "failed" });
    }
  }
  await writePins(pins);
  return results;
}

/**
 * Undo keepHarnessTranscripts: where the file still says what the box wrote,
 * put back what was there before (or take the key out). A file whose period
 * someone has changed since is theirs now and is left alone.
 */
export async function releaseHarnessTranscripts(): Promise<TranscriptPinResult[]> {
  const pins = await readPins();
  const results: TranscriptPinResult[] = [];
  for (const [file, before] of Object.entries(pins)) {
    const read = readHarnessSettings(file);
    if (read.state === "unreadable") {
      results.push({ file, state: "unreadable" });
      continue;
    }
    if (read.state === "missing" || read.settings.cleanupPeriodDays !== HARNESS_KEEP_TRANSCRIPT_DAYS) {
      delete pins[file];
      results.push({ file, state: "left" });
      continue;
    }
    const next = { ...read.settings };
    if (before.present) next.cleanupPeriodDays = before.value;
    else delete next.cleanupPeriodDays;
    try {
      writeHarnessSettings(file, next);
      delete pins[file];
      results.push({ file, state: "restored" });
    } catch (err) {
      console.error(`[coding-agent] could not restore ${file}:`, err instanceof Error ? err.message : err);
      results.push({ file, state: "failed" });
    }
  }
  await writePins(pins);
  return results;
}

export interface HarnessTranscriptState {
  file: string;
  /** The file with the home folder written as ~, for the page. */
  label: string;
  /** The period the file names, or null for Claude Code's default. */
  days: number | null;
  kept: boolean;
  readable: boolean;
}

export function harnessTranscriptState(settingsFiles: readonly string[]): HarnessTranscriptState[] {
  const home = os.homedir();
  return [...new Set(settingsFiles)].map((file) => {
    const read = readHarnessSettings(file);
    const days = read.state === "ok" && typeof read.settings.cleanupPeriodDays === "number" ? read.settings.cleanupPeriodDays : null;
    return {
      file,
      label: home && file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file,
      days,
      kept: days !== null && days >= HARNESS_KEEP_TRANSCRIPT_DAYS,
      readable: read.state !== "unreadable",
    };
  });
}

// ─── What it all weighs ──────────────────────────────────────────────────────

export interface HistoryUsage {
  runsFile: number;
  olderRuns: number;
  evidence: number;
  inputs: number;
  streams: number;
  archive: number;
  /** Claude Code's transcripts for every project — outside data/, so not in `total`. */
  transcripts: number;
  /** Everything under data/ that is run history. */
  total: number;
  truncated: boolean;
  computedAt: number;
}

interface HistoryCache {
  usage: HistoryUsage | null;
  pending: Promise<HistoryUsage> | null;
}

const cache = processStore<HistoryCache>("clawbox.coding-run-history", () => ({ usage: null, pending: null }));

/** Measured at most this often: a walk of a large history is seconds of disk on a Nano. */
const USAGE_TTL_MS = 30_000;

export function invalidateUsage(): void {
  cache.usage = null;
}

export async function historyUsage(paths: { runsFile: string; streamsDir: string; transcriptDirs: readonly string[] }, now: number = Date.now()): Promise<HistoryUsage> {
  if (cache.usage && now - cache.usage.computedAt < USAGE_TTL_MS) return cache.usage;
  if (cache.pending) return cache.pending;
  const work = (async () => {
    const [runsFile, olderRuns, evidence, inputs, streams, archive, ...transcripts] = await Promise.all([
      fileBytes(paths.runsFile),
      treeBytes(olderRunsRoot()),
      treeBytes(artifactsRoot()),
      treeBytes(inputsRoot(), new Set([SHARED_INPUTS_DIR_NAME])),
      treeBytes(paths.streamsDir),
      treeBytes(archiveRoot()),
      ...[...new Set(paths.transcriptDirs)].map((d) => treeBytes(d)),
    ]);
    const trees = [olderRuns, evidence, inputs, streams, archive, ...transcripts];
    const usage: HistoryUsage = {
      runsFile,
      olderRuns: olderRuns.bytes,
      evidence: evidence.bytes,
      inputs: inputs.bytes,
      streams: streams.bytes,
      archive: archive.bytes,
      transcripts: transcripts.reduce((sum, t) => sum + t.bytes, 0),
      total: runsFile + olderRuns.bytes + evidence.bytes + inputs.bytes + streams.bytes + archive.bytes,
      truncated: trees.some((t) => t.truncated),
      computedAt: Date.now(),
    };
    cache.usage = usage;
    return usage;
  })();
  cache.pending = work;
  try {
    return await work;
  } finally {
    cache.pending = null;
  }
}

// ─── Export everything ───────────────────────────────────────────────────────

/**
 * Every file of the run history, named for the export's zip:
 *
 *   manifest.json                what was exported, when, under which mode
 *   runs.json                    the live list (the runs file as it is)
 *   older-runs/<runId>.json      the older runs' records
 *   evidence/<runId>/…           evidence folders of the live and older runs
 *   inputs/<runId>/…             the files those runs were given
 *   transcripts/<runId>.jsonl    their Claude Code transcripts, where they still exist
 *   archive/<runId>/…            the archive, bundle by bundle
 *
 * Lazy: the zip writer pulls from this while it sends, so a large history is
 * walked as fast as the owner downloads it rather than all up front.
 */
export async function* historyExportSources(input: {
  manifest: unknown;
  /**
   * The live list, as this process holds it. Not the file: it is rewritten
   * every second while a run works, and a size read before a rename would cut
   * the new file's JSON short.
   */
  runs: readonly unknown[];
  transcripts: readonly { id: string; file: string | null }[];
}): AsyncGenerator<ZipSource> {
  const now = Date.now();
  yield { name: "manifest.json", data: Buffer.from(`${JSON.stringify(input.manifest, null, 2)}\n`), mtimeMs: now };
  yield { name: "runs.json", data: Buffer.from(`${JSON.stringify(input.runs, null, 2)}\n`), mtimeMs: now };
  for (const f of walkFilesSync(olderRunsRoot(), new Set([INDEX_FILE]))) {
    if (!f.rel.includes("/") && f.rel.endsWith(".json")) yield { name: `older-runs/${f.rel}`, file: f.abs, size: f.size, mtimeMs: f.mtimeMs };
  }
  for (const f of walkFilesSync(artifactsRoot())) yield { name: `evidence/${f.rel}`, file: f.abs, size: f.size, mtimeMs: f.mtimeMs };
  for (const f of walkFilesSync(inputsRoot(), new Set([SHARED_INPUTS_DIR_NAME]))) yield { name: `inputs/${f.rel}`, file: f.abs, size: f.size, mtimeMs: f.mtimeMs };
  for (const t of input.transcripts) {
    if (!t.file || safeRunId(t.id) !== t.id) continue;
    try {
      const stat = fs.lstatSync(t.file);
      if (stat.isFile()) yield { name: `transcripts/${t.id}.jsonl`, file: t.file, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      // Claude Code has already let it go
    }
  }
  const archive = archiveRoot();
  for (const f of walkFilesSync(archive, new Set([INDEX_FILE]))) {
    // A staging folder is a bundle still being made (or one that failed): not the archive.
    if (f.rel.startsWith(".")) continue;
    yield { name: `archive/${f.rel}`, file: f.abs, size: f.size, mtimeMs: f.mtimeMs };
  }
}
