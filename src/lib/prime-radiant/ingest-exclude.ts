/**
 * Which folders an ingest never walks into, whatever folder the owner picked.
 *
 * A folder of documents is usually also a folder of things that are not the
 * owner's knowledge: version-control internals, dependency trees, caches,
 * build output, a second checkout of the same project (a worktree), an
 * experiment's scratch folder, the archive of an agent's earlier runs. Read,
 * they cost model calls and produce pages about tooling — or worse, pages
 * about pages an earlier ingest already wrote.
 *
 * The list is folder-NAME patterns (`*` and `?` wildcards, case-insensitive,
 * no slashes), matched on each folder before the walk goes in. The owner can
 * replace it in the settings file; {@link DEFAULT_INGEST_EXCLUDES} applies
 * until they do. ClawBox's own output folders and linked git worktrees are
 * left out in addition, always (see `ingest-sources.ts`).
 *
 * Beside the folder list, two rules this module also owns, so that pointing
 * an ingest at a whole home folder reads the owner's documents and not the
 * machine's:
 * - {@link fileSkipReason}: files left out by NAME — repository boilerplate
 *   (LICENSE, CHANGELOG, requirements.txt …) and temporary or partial copies
 *   (`~$report.docx`, `notes.md~`, `*.crdownload` …).
 * - {@link codeProjectMarker}: a folder that is a code project (a `.git`
 *   folder, or a project manifest such as package.json or Cargo.toml), which a
 *   walk does not go into. The folder the owner picked is never asked: only
 *   projects FOUND during the walk are left out.
 *
 * Pure.
 */

export const DEFAULT_INGEST_EXCLUDES: readonly string[] = Object.freeze([
  // version control
  ".git",
  ".hg",
  ".svn",
  ".bzr",
  "_darcs",
  // dependencies and environments
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  "site-packages",
  "venv",
  ".venv",
  "__pypackages__",
  ".tox",
  "Pods",
  ".gradle",
  ".m2",
  // caches
  "__pycache__",
  ".cache",
  "*_cache",
  ".npm",
  ".yarn",
  ".pnpm-store",
  ".turbo",
  // build output
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  // worktrees (a linked worktree is also recognised by its `.git` file)
  "worktrees",
  ".worktrees",
  // experiment and scratch folders
  "spikes",
  "*-spikes",
  "scratch",
  "*-scratch",
  "tmp",
  // archives of agent runs
  "coding-agent-*",
  "coding-runs",
  "agent-runs",
  // logs
  "logs",
  "log",
  // test data and code samples
  "fixtures",
  "__fixtures__",
  "test",
  "tests",
  "__tests__",
  "e2e",
  "examples",
  // system folders (snap and flatpak keep each app's own data and caches)
  "snap",
  "flatpak",
  "Trash",
  ".Trash",
  "$RECYCLE.BIN",
  "System Volume Information",
  "lost+found",
]);

/**
 * Every default list ClawBox shipped before {@link DEFAULT_INGEST_EXCLUDES},
 * oldest first. Saving the settings form stores the exclude list it shows, so
 * an owner who never changed a pattern has an earlier default list on file;
 * that list reads as today's defaults (see {@link isDefaultExcludeList}). Never
 * edit an entry: add the list being replaced instead.
 */
export const PREVIOUS_DEFAULT_INGEST_EXCLUDES: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([
    ".git", ".hg", ".svn", ".bzr", "_darcs",
    "node_modules", "bower_components", "jspm_packages", "vendor", "site-packages", "venv", ".venv", "__pypackages__", ".tox", "Pods", ".gradle", ".m2",
    "__pycache__", ".cache", "*_cache", ".npm", ".yarn", ".pnpm-store", ".turbo",
    "dist", "build", "target", "coverage", ".next", ".nuxt", ".output",
    "worktrees", ".worktrees",
    "spikes", "*-spikes", "scratch", "*-scratch", "tmp",
    "coding-agent-*", "coding-runs", "agent-runs",
    "Trash", ".Trash", "$RECYCLE.BIN", "System Volume Information", "lost+found",
  ]),
]);

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const key = (list: readonly string[]) => [...new Set(list.map((p) => p.trim().toLowerCase()))].sort().join("\n");
  return key(a) === key(b);
}

/**
 * Which default list {@link DEFAULT_INGEST_EXCLUDES} is: one more than the
 * lists before it. A saved exclude list records it (`excludeSavedWith`), so a
 * copy of an earlier default the owner chose AFTER it stopped being the
 * default is told apart from one that was merely never changed.
 */
export const EXCLUDE_DEFAULTS_GENERATION = PREVIOUS_DEFAULT_INGEST_EXCLUDES.length + 1;

/**
 * Whether `patterns` is a default list — today's, or one ClawBox shipped
 * earlier — in any order and letter case. Such a list was never the owner's
 * choice, so it follows the defaults; any other list is the owner's and is
 * kept exactly as it is. `savedWith` is the generation the list was saved
 * under: an earlier default saved once it was no longer the default (an
 * owner who removed exactly the patterns added since) is the owner's choice.
 */
export function isDefaultExcludeList(patterns: readonly string[], savedWith?: unknown): boolean {
  if (sameList(patterns, DEFAULT_INGEST_EXCLUDES)) return true;
  const generation = typeof savedWith === "number" && Number.isInteger(savedWith) ? savedWith : 0;
  // The k-th earlier list was the default of generation k + 1.
  return PREVIOUS_DEFAULT_INGEST_EXCLUDES.some((old, k) => generation <= k + 1 && sameList(patterns, old));
}

export const MAX_EXCLUDE_PATTERNS = 200;
export const MAX_EXCLUDE_PATTERN_CHARS = 80;

/**
 * A caller's exclude list read strictly: every entry a folder-name pattern
 * (1–80 characters, no slash, backslash, NUL or control character, not `.`
 * or `..`), duplicates dropped, at most {@link MAX_EXCLUDE_PATTERNS}. A bad
 * entry refuses the whole list with the reason.
 */
export function readExcludeList(raw: unknown): { ok: true; patterns: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "exclude must be a list of folder-name patterns." };
  if (raw.length > MAX_EXCLUDE_PATTERNS) return { ok: false, error: `exclude holds at most ${MAX_EXCLUDE_PATTERNS} patterns.` };
  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") return { ok: false, error: "Every exclude pattern must be text." };
    const p = entry.trim();
    if (p === "" || p.length > MAX_EXCLUDE_PATTERN_CHARS) {
      return { ok: false, error: `An exclude pattern must be 1 to ${MAX_EXCLUDE_PATTERN_CHARS} characters.` };
    }
    if (/[/\\\u0000-\u001f\u007f]/.test(p) || p === "." || p === "..") {
      return { ok: false, error: `"${p.slice(0, 40)}" is not a folder-name pattern (no slashes).` };
    }
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push(p);
  }
  return { ok: true, patterns };
}

function patternToRegExp(pattern: string): RegExp {
  let src = "";
  for (const ch of pattern) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else src += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`, "i");
}

/** A matcher for folder names; compiled once per list. */
export function compileExcludes(patterns: readonly string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const globs: RegExp[] = [];
  for (const p of patterns) {
    if (p.includes("*") || p.includes("?")) globs.push(patternToRegExp(p));
    else exact.add(p.toLowerCase());
  }
  return (name) => exact.has(name.toLowerCase()) || globs.some((re) => re.test(name));
}

// ── why something was left out ──

/**
 * Every reason an ingest leaves a file or a folder out, counted per job (and
 * per preview) rather than dropped silently. `codeProject` and
 * `excludedFolder` count FOLDERS not gone into; the rest count files.
 */
export const SKIP_REASONS = [
  "codeProject",
  "excludedFolder",
  "boilerplate",
  "temp",
  "machineText",
  "tooLarge",
  "unsupported",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export type SkipCounts = Record<SkipReason, number>;

export function emptySkipCounts(): SkipCounts {
  return { codeProject: 0, excludedFolder: 0, boilerplate: 0, temp: 0, machineText: 0, tooLarge: 0, unsupported: 0 };
}

/** Counts read back from storage: every known reason a whole number, anything else dropped. */
export function readSkipCounts(raw: unknown): SkipCounts {
  const out = emptySkipCounts();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const reason of SKIP_REASONS) {
    const v = (raw as Record<string, unknown>)[reason];
    if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) out[reason] = v;
  }
  return out;
}

// ── files left out by name ──

/**
 * Temporary and partial files: an office suite's lock file (`~$report.docx`),
 * an editor's backup (`notes.md~`) or lock (`.#notes.md`), and `*.tmp`,
 * `*.bak`, `*.swp`, `*.part`, `*.crdownload` (a download still running).
 */
const TEMP_RE = /^~\$|~$|^\.#|\.(?:tmp|bak|swp|part|crdownload)$/i;

/**
 * Repository boilerplate, judged on the name without its extension, in a
 * `.txt` or `.md` file only (a `License agreement.pdf` is the owner's): the
 * licence, copying, changelog, code-of-conduct and contributing files in any
 * letter case and with any suffix (`LICENSE-MIT`, `CHANGELOG.old`) …
 */
const BOILERPLATE_STEM_RE = /^(?:licen[cs]e|copying|changelog|code[-_ ]?of[-_ ]?conduct|contributing)(?:[-_.].*)?$/i;
/** … NOTICE, AUTHORS and SECURITY only in capitals, as a repository names them (a `notice.txt` may be a letter) … */
const BOILERPLATE_UPPER_STEM_RE = /^(?:NOTICE|AUTHORS|SECURITY)(?:[-_.].*)?$/;
/** … and machine files by their whole name. */
const BOILERPLATE_NAME_RE = /^(?:requirements[\w.-]*\.txt|cmakelists\.txt|robots\.txt|llms[\w.-]*\.txt|.+\.lock\.txt)$/i;

export type FileSkipReason = "temp" | "boilerplate";

/**
 * Why a file is left out by its NAME alone, or null. Temporary and partial
 * files are left out whatever their kind; boilerplate only as `.txt`/`.md`.
 */
export function fileSkipReason(name: string): FileSkipReason | null {
  if (TEMP_RE.test(name)) return "temp";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  if (ext !== ".txt" && ext !== ".md") return null;
  const stem = name.slice(0, dot);
  if (BOILERPLATE_STEM_RE.test(stem) || BOILERPLATE_UPPER_STEM_RE.test(stem) || BOILERPLATE_NAME_RE.test(name)) {
    return "boilerplate";
  }
  return null;
}

// ── code projects ──

/** Files whose presence makes a folder a code project. */
export const PROJECT_MANIFESTS: readonly string[] = Object.freeze([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "CMakeLists.txt",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
]);
const MANIFEST_SET = new Set(PROJECT_MANIFESTS);
/** Project and solution files named after the project (`Widgets.csproj`, `Widgets.sln`). */
const PROJECT_FILE_RE = /\.(?:csproj|sln)$/i;
const MAKEFILES = new Set(["Makefile", "makefile", "GNUmakefile"]);
/** Source files that make a folder with a Makefile a code project (a LaTeX folder's `.tex` is not one). */
const SOURCE_RE =
  /\.(?:c|h|cc|cpp|cxx|hh|hpp|hxx|m|mm|s|asm|go|rs|py|rb|pl|pm|java|kt|kts|scala|js|mjs|cjs|jsx|ts|tsx|cs|fs|vb|swift|zig|nim|d|f|f90|f95|hs|ml|lua|php|sh|bash|cmake|ino)$/i;

export interface FolderEntry {
  name: string;
  /** A directory (never a symlink to one). */
  dir: boolean;
}

/**
 * What makes a folder a code project, from its entries, or null:
 * - a `.git` FOLDER (a repository; a `.git` file is a linked worktree, left
 *   out on its own rule) — unless the folder is also an Obsidian vault
 *   (`.obsidian`), which is notes kept in git, not code;
 * - a project manifest ({@link PROJECT_MANIFESTS}), a `*.csproj` or a `*.sln`;
 * - a Makefile next to source files.
 */
export function codeProjectMarker(entries: Iterable<FolderEntry>): string | null {
  let git = false;
  let notesVault = false;
  let makefile: string | null = null;
  let source = false;
  for (const e of entries) {
    if (e.dir) {
      if (e.name === ".git") git = true;
      else if (e.name === ".obsidian") notesVault = true;
      continue;
    }
    if (MANIFEST_SET.has(e.name) || PROJECT_FILE_RE.test(e.name)) return e.name;
    if (MAKEFILES.has(e.name)) makefile = e.name;
    else if (SOURCE_RE.test(e.name)) source = true;
  }
  if (git && !notesVault) return ".git";
  if (makefile && source) return makefile;
  return null;
}
