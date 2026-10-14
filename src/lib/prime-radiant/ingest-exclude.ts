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
  // system folders
  "Trash",
  ".Trash",
  "$RECYCLE.BIN",
  "System Volume Information",
  "lost+found",
]);

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
