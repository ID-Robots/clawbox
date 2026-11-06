/**
 * What the box keeps of FINISHED coding runs, and where (TASK-1178).
 *
 * The runs file (data/coding-agent-runs.json) held the newest thirty runs and
 * nothing else: the thirty-first finished run was deleted with its evidence
 * folder and its inputs, and Claude Code deleted the run's transcript on its own
 * after thirty days. The owner's setting, `coding_agent_history_retention`,
 * picks one of two answers:
 *
 *  - `standard` (the default, and the behaviour every box had before): the
 *    newest HISTORY_LIVE_RUNS_KEPT runs; an older one is deleted.
 *  - `everything`: no run is ever deleted unless the owner clears it, and
 *    Claude Code is told to keep its transcripts too (`cleanupPeriodDays`).
 *
 * Two earlier modes, `extended` (the newest N) and `archive` (a leaving run
 * moved into a read-only bundle under data/coding-agent-archive/), went on
 * 2026-10-30 (SCA2 C1): both read as `everything` now — the mode that KEEPS,
 * since a stored value must never make the box keep less than it did — and
 * coding-agent.ts rewrites the stored value once. An archive folder an
 * earlier build filled is left where it is: nothing reads it, nothing
 * deletes it, and it stays on the runs' deny list.
 *
 * WHY THE RUNS FILE STAYS AT THIRTY IN EVERY MODE. It is rewritten whole on
 * every progress flush (once a second while a run works), so a thousand
 * records in it would be a thousand records serialised and written to the
 * flash every second. Runs past the newest thirty that `everything` keeps are
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
import { artifactsRoot, INTERPRETER_TREES, safeRunId } from "@/lib/coding-agent-artifacts";
import { inputsRoot, SHARED_INPUTS_DIR_NAME } from "@/lib/coding-run-inputs";
import { MODEL_ROLES, type ModelRole } from "@/lib/coding-role-models";
import { processStore } from "@/lib/process-store";
import type { ZipSource } from "@/lib/zip-writer";

// ─── The setting ─────────────────────────────────────────────────────────────

export const CODING_AGENT_HISTORY_RETENTION_CONFIG_KEY = "coding_agent_history_retention";
/**
 * What the box changed in Claude Code's settings files to keep transcripts,
 * so leaving "keep everything" can put back exactly that and nothing else.
 * Bookkeeping, not a setting: not in the reset list, emptied by the release.
 */
export const CODING_AGENT_HISTORY_PINS_CONFIG_KEY = "coding_agent_history_transcript_pins";

export const HISTORY_RETENTION_MODES = ["standard", "everything"] as const;
export type HistoryRetentionMode = typeof HISTORY_RETENTION_MODES[number];

/** The modes this build no longer offers, and the one each reads as. */
const RETIRED_HISTORY_MODES: ReadonlyMap<string, HistoryRetentionMode> = new Map([["extended", "everything"], ["archive", "everything"]]);

/**
 * Runs the live list holds in EVERY mode — the thirty the box always kept.
 * coding-agent.ts's MAX_RUNS_KEPT is this number.
 */
export const HISTORY_LIVE_RUNS_KEPT = 30;

export interface HistoryPolicy {
  mode: HistoryRetentionMode;
}

export const STANDARD_HISTORY_POLICY: HistoryPolicy = Object.freeze({ mode: "standard" });

export function isHistoryRetentionMode(value: unknown): value is HistoryRetentionMode {
  return typeof value === "string" && (HISTORY_RETENTION_MODES as readonly string[]).includes(value);
}

/**
 * The policy from the raw config value. A retired mode reads as the nearer
 * of the two that remain; anything this build does not know reads as the
 * default — a hand-edited or future value must never make the box keep LESS
 * than it did, and standard is what it always did.
 */
export function historyPolicyFrom(rawMode: unknown): HistoryPolicy {
  if (isHistoryRetentionMode(rawMode)) return { mode: rawMode };
  return { mode: (typeof rawMode === "string" && RETIRED_HISTORY_MODES.get(rawMode)) || "standard" };
}

/** Does this mode keep runs past the live thirty as older runs (rather than delete them)? */
export function keepsOlderRuns(policy: HistoryPolicy): boolean {
  return policy.mode === "everything";
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

/** A loosely-typed run record: the fields this module reads. coding-agent.ts owns the real shape. */
export interface HistoryRecord {
  id: string;
  task?: unknown;
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  directory?: unknown;
  worktree?: unknown;
  /** The team role the run's provider and model were chosen for; absent on a record from before it. */
  modelRole?: unknown;
}

/**
 * A stored team role read back: one of the roles a run could have been
 * started under, else null — a run that was not a team's, a record from
 * before the field, or a hand edit. The one reader for the live record
 * (normalizeRun in coding-agent.ts).
 */
export function readModelRole(raw: unknown): ModelRole | null {
  // `bulk` — a worker on a task marked token-heavy, until 2026-10-30 — was a worker's run.
  const role = raw === "bulk" ? "worker" : raw;
  return typeof role === "string" && (MODEL_ROLES as readonly string[]).includes(role) ? role as ModelRole : null;
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

// ─── Older runs (everything) ─────────────────────────────────────────────────

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
    const [runsFile, olderRuns, evidence, inputs, streams, ...transcripts] = await Promise.all([
      fileBytes(paths.runsFile),
      treeBytes(olderRunsRoot()),
      treeBytes(artifactsRoot()),
      treeBytes(inputsRoot(), new Set([SHARED_INPUTS_DIR_NAME])),
      treeBytes(paths.streamsDir),
      ...[...new Set(paths.transcriptDirs)].map((d) => treeBytes(d)),
    ]);
    const trees = [olderRuns, evidence, inputs, streams, ...transcripts];
    const usage: HistoryUsage = {
      runsFile,
      olderRuns: olderRuns.bytes,
      evidence: evidence.bytes,
      inputs: inputs.bytes,
      streams: streams.bytes,
      transcripts: transcripts.reduce((sum, t) => sum + t.bytes, 0),
      total: runsFile + olderRuns.bytes + evidence.bytes + inputs.bytes + streams.bytes,
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
}
