// ── Projects → GitHub backup: the shapes both sides read (TASK-1358) ─────────
//
// Client-safe: no fs, no child processes. The Files app imports the answer
// types and the suggestion-card rule from here; the server modules
// (project-backup.ts, -safety.ts, -store.ts) import the constants, so the
// panel and the check that runs before every commit cannot disagree about,
// say, what "too big for GitHub" means.

/** Files bigger than this are left out of every backup (GitHub refuses files over 100 MB and warns at 50). */
export const LARGE_FILE_BYTES = 50 * 1024 * 1024;

/** How many backups the History list keeps. */
export const BACKUP_HISTORY_LIMIT = 10;

/** "Not now" on the suggestion card hides it for this long; then it may come back. */
export const BACKUP_SUGGESTION_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** Auto-backup runs at most this often per folder, and only when something changed. */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Why the check before a commit kept a file out of it. */
export type LeftOutReason =
  /** The name is a key, certificate, `.env`, `credentials*`, `secrets*`… */
  | "secret_name"
  /** The first part of the file holds something shaped like a token or a private key. */
  | "secret_content"
  /** Over LARGE_FILE_BYTES. */
  | "too_large"
  /** A folder with its own `.git` inside the project — its files are not this backup's to take. */
  | "nested_git";

export interface LeftOutFile {
  /** Relative to the project folder, `/`-separated. */
  path: string;
  reason: LeftOutReason;
}

export interface BackupHistoryEntry {
  /** Unix ms. */
  at: number;
  /** How many files the backup changed on GitHub. */
  files: number;
  /** Short commit id — for the Advanced view. */
  commit: string;
}

export type BackupStage = "preparing" | "uploading";

/** Every refusal the backup routes answer, each worded by the Files app. */
export type BackupErrorCode =
  | "invalid"
  | "not_pinned"
  | "missing"
  | "protected"
  | "inside_repo"
  | "no_gh"
  | "gh_broken"
  | "gh_unreachable"
  | "not_connected"
  | "name_taken"
  | "name_exhausted"
  | "missing_scope"
  | "not_private"
  | "has_remote"
  | "not_set_up"
  | "detached"
  | "unfinished_merge"
  | "no_upstream"
  | "remote_ahead"
  | "push_refused"
  | "push_auth"
  | "busy"
  | "failed";

export interface GitHubConnection {
  installed: boolean;
  connected: boolean;
  login: string | null;
  /** Set when the probe could not answer (no network, gh would not start). */
  reason?: string;
}

/** One pinned folder as the Projects list shows it — from the box's records, no network. */
export interface FolderBackupSummary {
  path: string;
  /** none: never backed up · backed_up: a private copy ClawBox made · existing_git: the folder's own remote. */
  state: "none" | "backed_up" | "existing_git";
  lastBackupAt: number | null;
  auto: boolean;
}

export interface BackupOverview {
  github: GitHubConnection;
  folders: FolderBackupSummary[];
  suggestionDismissedAt: number | null;
}

export interface PendingChanges {
  /** Files the next backup would send. */
  files: number;
  /** Files the next backup would leave out, and why. */
  leftOut: LeftOutFile[];
}

/** One folder, for the backup panel. */
export interface FolderBackupStatus {
  folder: { path: string; name: string };
  github: GitHubConnection;
  state: "not_set_up" | "backed_up" | "existing_git" | "refused";
  /** Why the folder cannot be backed up, when `state` is "refused". */
  refusal?: { code: BackupErrorCode; parent?: string };
  /** not_set_up: the folder already has a Git history of its own (no online copy yet). */
  isRepo?: boolean;
  /** not_set_up + connected: the free name the first backup will use, and the one it had to skip. */
  suggestedName?: string;
  takenName?: string;
  /** backed_up: the private copy ClawBox made. */
  repo?: { fullName: string; webUrl: string; branch: string };
  /** existing_git: where the folder's own online copy is — never with a password in it. */
  remote?: { label: string; webUrl: string | null; branch: string | null };
  lastBackupAt: number | null;
  auto: boolean;
  lastAutoError?: { at: number; code: BackupErrorCode } | null;
  history: BackupHistoryEntry[];
  /** What the last backup left out. */
  lastLeftOut: LeftOutFile[];
  /** What the next backup would send and leave out; null when it cannot be known yet. */
  pending: PendingChanges | null;
  /** A backup of this folder is running right now. */
  running: BackupStage | null;
}

/**
 * Whether the Projects view shows "Keep a safe copy of your projects on
 * GitHub". Only to the OWNER (a non-owner's session never reaches the Files
 * app, and must not see the card if it ever did), only when there is a pinned
 * folder to back up, only when the box can actually back up (gh installed and
 * the probe answered), and only when GitHub is not connected yet or some
 * pinned folder has no online copy. "Not now" hides it for 30 days.
 */
export function shouldShowBackupSuggestion(input: {
  isOwner: boolean | null | undefined;
  github: GitHubConnection | null;
  /** The pinned folders that exist right now. */
  folders: FolderBackupSummary[];
  dismissedAt: number | null;
  now: number;
}): boolean {
  const { isOwner, github, folders, dismissedAt, now } = input;
  if (isOwner !== true) return false;
  if (!github || !github.installed || github.reason) return false;
  if (folders.length === 0) return false;
  if (typeof dismissedAt === "number" && dismissedAt > 0 && now - dismissedAt < BACKUP_SUGGESTION_SNOOZE_MS) return false;
  return !github.connected || folders.some((f) => f.state === "none");
}
