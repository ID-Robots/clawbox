import * as config from "@/lib/config-store";
import {
  BACKUP_HISTORY_LIMIT,
  type BackupErrorCode,
  type BackupHistoryEntry,
  type LeftOutFile,
  type LeftOutReason,
} from "@/lib/project-backup-shared";

// ── What the box remembers about each project folder's backup (TASK-1358) ───
//
// One config key, a list of records keyed by the folder's browse-relative
// path — the same string the Projects pin stores, so a pin and its backup
// move together (followMovedBackupRecords, called from the pins' own move
// hook). A list, not an object: a folder may be called anything, and an
// object keyed by `__proto__` is not a place to keep a record.
//
// No address, token or remote URL is stored. A copy ClawBox made is named by
// its `owner/name` on github.com; a folder that brought its own remote is
// read live from git every time, so a password in that remote's address never
// reaches data/config.json.

export const PROJECT_BACKUPS_CONFIG_KEY = "files_project_backups";
export const BACKUP_SUGGESTION_CONFIG_KEY = "files_backup_suggestion_dismissed_at";

/** The left-out list kept per folder is for the owner to read, not an index. */
const LEFT_OUT_KEEP = 200;

export interface BackupRecord {
  /** Browse-relative folder path, as the pin stores it. */
  path: string;
  /** created: a private repository ClawBox made · existing: the folder's own remote, backed up as it was. */
  kind: "created" | "existing";
  /** `owner/name` on github.com, for a repository ClawBox created. */
  repo: string | null;
  /** The branch the last backup went to. */
  branch: string | null;
  createdAt: number;
  lastBackupAt: number | null;
  auto: boolean;
  /** When the daily auto-backup last looked at this folder (it may have found nothing to do). */
  lastAutoRunAt: number | null;
  lastAutoError: { at: number; code: BackupErrorCode } | null;
  history: BackupHistoryEntry[];
  leftOut: LeftOutFile[];
}

const LEFT_OUT_REASONS: readonly LeftOutReason[] = ["secret_name", "secret_content", "too_large", "nested_git"];
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

function parseRecord(raw: unknown): BackupRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string" || !r.path || r.path.startsWith("/") || r.path.split("/").includes("..")) return null;
  const kind = r.kind === "created" || r.kind === "existing" ? r.kind : null;
  if (!kind) return null;
  const repo = typeof r.repo === "string" && REPO_RE.test(r.repo) ? r.repo : null;
  if (kind === "created" && !repo) return null;
  const history = Array.isArray(r.history)
    ? r.history
      .map((h) => {
        const e = h as Record<string, unknown>;
        const at = num(e?.at);
        if (!at) return null;
        const files = typeof e.files === "number" && Number.isFinite(e.files) && e.files >= 0 ? Math.floor(e.files) : 0;
        const commit = typeof e.commit === "string" ? e.commit.replace(/[^0-9a-f]/gi, "").slice(0, 12) : "";
        return { at, files, commit };
      })
      .filter((h): h is BackupHistoryEntry => h !== null)
      .slice(0, BACKUP_HISTORY_LIMIT)
    : [];
  const leftOut = Array.isArray(r.leftOut)
    ? r.leftOut
      .filter((f): f is LeftOutFile => !!f && typeof f === "object"
        && typeof (f as LeftOutFile).path === "string"
        && LEFT_OUT_REASONS.includes((f as LeftOutFile).reason))
      .map((f) => ({ path: f.path, reason: f.reason }))
      .slice(0, LEFT_OUT_KEEP)
    : [];
  const err = r.lastAutoError as { at?: unknown; code?: unknown } | null | undefined;
  return {
    path: r.path,
    kind,
    repo,
    branch: typeof r.branch === "string" && r.branch ? r.branch : null,
    createdAt: num(r.createdAt) ?? Date.now(),
    lastBackupAt: num(r.lastBackupAt),
    auto: kind === "created" && r.auto === true,
    lastAutoRunAt: num(r.lastAutoRunAt),
    lastAutoError: err && num(err.at) && typeof err.code === "string"
      ? { at: num(err.at)!, code: err.code as BackupErrorCode }
      : null,
    history,
    leftOut,
  };
}

/** Every record, with anything malformed dropped. */
export async function listBackupRecords(): Promise<BackupRecord[]> {
  const raw = await config.get(PROJECT_BACKUPS_CONFIG_KEY);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: BackupRecord[] = [];
  for (const item of raw) {
    const rec = parseRecord(item);
    if (!rec || seen.has(rec.path)) continue;
    seen.add(rec.path);
    out.push(rec);
  }
  return out;
}

export async function getBackupRecord(rel: string): Promise<BackupRecord | null> {
  return (await listBackupRecords()).find((r) => r.path === rel) ?? null;
}

// One key, read-modify-write: every change waits for the one before it, the
// same rule the pins follow (project-folders.ts).
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Change one folder's record. `fn` gets the current record (or null) and
 * answers the new one, or null to remove it. Answers what was stored.
 */
export function updateBackupRecord(
  rel: string,
  fn: (current: BackupRecord | null) => BackupRecord | null,
): Promise<BackupRecord | null> {
  return serialized(async () => {
    const all = await listBackupRecords();
    const index = all.findIndex((r) => r.path === rel);
    const next = fn(index >= 0 ? all[index] : null);
    const parsed = next ? parseRecord({ ...next, path: rel }) : null;
    if (index >= 0) all.splice(index, 1);
    if (parsed) all.push(parsed);
    await config.set(PROJECT_BACKUPS_CONFIG_KEY, all);
    return parsed;
  });
}

/** A backup that reached GitHub: the newest first in History, at most BACKUP_HISTORY_LIMIT. */
export function withBackup(
  record: BackupRecord,
  entry: BackupHistoryEntry,
  leftOut: LeftOutFile[],
  branch: string,
): BackupRecord {
  return {
    ...record,
    branch,
    lastBackupAt: entry.at,
    history: [entry, ...record.history].slice(0, BACKUP_HISTORY_LIMIT),
    leftOut: leftOut.slice(0, LEFT_OUT_KEEP),
  };
}

/**
 * Carry records along when folders move — called from
 * `followMovedProjectFolders`, so a renamed project keeps its backup, its
 * history and its daily switch. Browse-relative, already normalised.
 */
export function followMovedBackupRecords(pairs: readonly { from: string; to: string }[]): Promise<boolean> {
  return serialized(async () => {
    if (pairs.length === 0) return false;
    const all = await listBackupRecords();
    let changed = false;
    const next = all.map((rec) => {
      for (const { from, to } of pairs) {
        if (rec.path === from) { changed = true; return { ...rec, path: to }; }
        if (rec.path.startsWith(`${from}/`)) { changed = true; return { ...rec, path: `${to}${rec.path.slice(from.length)}` }; }
      }
      return rec;
    });
    if (!changed) return false;
    const seen = new Set<string>();
    await config.set(PROJECT_BACKUPS_CONFIG_KEY, next.filter((r) => !seen.has(r.path) && seen.add(r.path)));
    return true;
  });
}

/** When the owner last said "Not now" to the suggestion card, or null. */
export async function getSuggestionDismissedAt(): Promise<number | null> {
  return num(await config.get(BACKUP_SUGGESTION_CONFIG_KEY));
}

export async function dismissSuggestion(now = Date.now()): Promise<number> {
  await config.set(BACKUP_SUGGESTION_CONFIG_KEY, now);
  return now;
}
