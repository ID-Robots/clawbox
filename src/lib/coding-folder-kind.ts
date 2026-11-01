/**
 * What a folder directly inside the owner's project folder IS: the owner's
 * own project, a git WORKTREE of a project, or a COPY of one that a run or an
 * agent made — and, for the last two, which project it belongs to.
 *
 * Shared by the project listing (`listProjects` in coding-agent.ts), which
 * must not show a worktree or a run's copy as a project of its own, and the
 * folder janitor (coding-folder-janitor.ts), which may only ever consider the
 * second two. A leaf module that reads files and spawns nothing: the listing
 * asks on every poll of the Coding Agent app, and a box with five hundred
 * folders cannot afford a `git` per folder per poll.
 *
 * The rules, in the order they are applied:
 *
 * - `.git` is a FILE naming a worktree admin folder (one with a `commondir`)
 *   → a worktree of the repository that admin folder belongs to. Registered
 *   (the admin folder's `gitdir` points back here) it is a real linked
 *   worktree; not registered, it is a `cp -r` of one, which is a copy.
 * - `.git` is a directory and `.clawbox/run.json` (the run marker this box
 *   writes into every run and team worktree, `writeRunMarker`) names another
 *   folder → a copy of that run's worktree.
 * - `.git` is a directory, another top-level repository has the same `origin`,
 *   and this one is checked out on a run-style branch (`isRunStyleBranch`) →
 *   a copy of that project. Never a repository with linked worktrees of its
 *   own: that one is somebody's original.
 * - Anything else — no git at all, a submodule pointer, a repository with no
 *   twin — is the owner's project, and nothing here or in the janitor touches
 *   it.
 *
 * SERVER ONLY.
 */

import fs from "fs";
import path from "./runtime-path";

/** The run marker, relative to a worktree's root. `.clawbox/` is in every project's `info/exclude`. */
export const RUN_MARKER_FILE = path.join(".clawbox", "run.json");

/** What the box writes into a run's or a team worker's worktree when it makes one. */
export interface RunMarker {
  kind: "run" | "team";
  /** The run id, or the team id for a team worker. */
  id: string;
  /** The project the worktree was made from. */
  project: string;
  /** Where the worktree was made — a copy of it carries the original's path. */
  path: string;
  createdAt: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Leave the marker in a fresh worktree. Best effort: a worktree without one
 * is still found by `git worktree list`; the marker only matters for a COPY
 * of the worktree, which git no longer knows about.
 */
export function writeRunMarker(worktree: string, marker: { kind: RunMarker["kind"]; id: string; project: string }, now = Date.now()): void {
  if (!ID_RE.test(marker.id)) return;
  const body: RunMarker = { kind: marker.kind, id: marker.id, project: path.resolve(marker.project), path: path.resolve(worktree), createdAt: now };
  try {
    fs.mkdirSync(path.join(worktree, ".clawbox"), { recursive: true });
    fs.writeFileSync(path.join(worktree, RUN_MARKER_FILE), `${JSON.stringify(body)}\n`, { mode: 0o644 });
  } catch {
    // A read-only or vanished folder: the worktree works without its marker.
  }
}

/** The marker in `dir`, or null when there is none or it is not one of ours. */
export function readRunMarker(dir: string): RunMarker | null {
  const raw = readSmall(path.join(dir, RUN_MARKER_FILE), 4096);
  if (raw === null) return null;
  try {
    const m = JSON.parse(raw) as Partial<RunMarker>;
    if ((m.kind !== "run" && m.kind !== "team") || typeof m.id !== "string" || !ID_RE.test(m.id)) return null;
    if (typeof m.project !== "string" || !path.isAbsolute(m.project)) return null;
    if (typeof m.path !== "string" || !path.isAbsolute(m.path)) return null;
    return { kind: m.kind, id: m.id, project: m.project, path: m.path, createdAt: typeof m.createdAt === "number" ? m.createdAt : 0 };
  } catch {
    return null;
  }
}

/** What `<dir>/.git` says about `dir`. */
export type GitPointer =
  | { kind: "none" }
  /** `.git` is a directory: a repository of its own. */
  | { kind: "repo"; gitDir: string }
  /**
   * `.git` is a file naming a worktree admin folder. `mainRoot` is the main
   * checkout (null for a bare repository); `registered` says whether git
   * still lists THIS folder as that worktree.
   */
  | { kind: "worktree"; gitDir: string; commonDir: string; mainRoot: string | null; registered: boolean }
  /** `.git` is a file that is not a worktree's: a submodule, or something hand-made. */
  | { kind: "pointer" };

/** Read `<dir>/.git`. Never throws; a folder it cannot read is `none`. */
export function readGitPointer(dir: string): GitPointer {
  const dotGit = path.join(dir, ".git");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dotGit);
  } catch {
    return { kind: "none" };
  }
  if (st.isDirectory()) return { kind: "repo", gitDir: dotGit };
  if (!st.isFile()) return { kind: "none" };
  const raw = readSmall(dotGit, 4096);
  const m = raw ? /^gitdir:\s*(.+?)\s*$/m.exec(raw) : null;
  if (!m) return { kind: "pointer" };
  const gitDir = path.resolve(dir, m[1]);
  const common = readSmall(path.join(gitDir, "commondir"), 4096);
  if (common === null) return { kind: "pointer" };
  const commonDir = path.resolve(gitDir, common.trim());
  const mainRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
  const back = readSmall(path.join(gitDir, "gitdir"), 4096);
  let registered = false;
  if (back !== null) {
    const pointsAt = path.dirname(path.resolve(gitDir, back.trim()));
    registered = samePath(pointsAt, dir);
  }
  return { kind: "worktree", gitDir, commonDir, mainRoot, registered };
}

/** The `origin` remote's URL from a repository's config file, or null. */
export function readOriginUrl(gitDir: string): string | null {
  const config = readSmall(path.join(gitDir, "config"), 256 * 1024);
  if (config === null) return null;
  let inOrigin = false;
  for (const line of config.split("\n")) {
    const text = line.trim();
    if (text.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(text);
      continue;
    }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/.exec(text);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * One spelling per repository: `git@host:o/r.git`, `https://user@host/o/r`
 * and `ssh://git@host/o/r/` all become `host/o/r`. Credentials never survive.
 */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^[^@/:]+@([^:/]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]*@/, "");
  u = u.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const slash = u.indexOf("/");
  return slash < 0 ? u.toLowerCase() : u.slice(0, slash).toLowerCase() + u.slice(slash);
}

/** The branch HEAD names (`refs/heads/<b>` → `<b>`), or null for a detached HEAD or no repository. */
export function readHeadBranch(gitDir: string): string | null {
  const head = readSmall(path.join(gitDir, "HEAD"), 1024);
  const m = head ? /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head) : null;
  return m ? m[1] : null;
}

/**
 * A branch a run or an agent made, not one a person names: the box's own
 * (`clawbox/<run>`, `clawbox/<team>-…`), Claude Code's (`claude/…`,
 * `worktree-…`), Codex's (`codex/…`) and a bare `run-…`.
 */
export function isRunStyleBranch(branch: string | null): boolean {
  if (!branch) return false;
  return /^(clawbox|claude|codex)\/./i.test(branch) || /^(worktree|run)-./i.test(branch);
}

/**
 * Does this repository have a linked worktree that is really ITS — one whose
 * `.git` file points back into this `.git`? A `cp -r` of a project carries
 * the original's `worktrees/` admin folders along, and those point at the
 * original: they make the copy no less a copy.
 */
export function hasLinkedWorktrees(gitDir: string): boolean {
  const admin = path.join(gitDir, "worktrees");
  let names: string[] = [];
  try {
    names = fs.readdirSync(admin);
  } catch {
    return false;
  }
  for (const name of names) {
    const back = readSmall(path.join(admin, name, "gitdir"), 4096);
    if (back === null) continue;
    const dotGit = readSmall(path.resolve(admin, name, back.trim()), 4096);
    const m = dotGit ? /^gitdir:\s*(.+?)\s*$/m.exec(dotGit) : null;
    if (m && samePath(path.resolve(path.dirname(path.resolve(admin, name, back.trim())), m[1]), path.join(admin, name))) return true;
  }
  return false;
}

/** One top-level folder, classified. */
export interface FolderKind {
  name: string;
  dir: string;
  kind: "project" | "worktree" | "copy";
  /** The project it belongs to, for a worktree or a copy; null for a project. */
  parent: string | null;
  /** Why it is a worktree or a copy, in a few words; empty for a project. */
  why: string;
  /** The branch it is on, when that was read (repositories and copies). */
  branch: string | null;
}

/**
 * Classify the folders `names` directly inside `base` (see the header).
 * `knownProjects` are folders the box KNOWS are projects — a run's or a
 * team's project — which are never taken for a copy of anything.
 */
export function classifyFolders(base: string, names: readonly string[], knownProjects: ReadonlySet<string> = new Set()): Map<string, FolderKind> {
  const out = new Map<string, FolderKind>();
  const repos: { name: string; dir: string; gitDir: string; origin: string | null; branch: string | null; original: boolean }[] = [];
  for (const name of names) {
    const dir = path.join(base, name);
    const pointer = readGitPointer(dir);
    if (pointer.kind === "worktree") {
      const parent = pointer.mainRoot ?? pointer.commonDir;
      out.set(name, {
        name,
        dir,
        kind: pointer.registered ? "worktree" : "copy",
        parent,
        why: pointer.registered ? "git worktree" : "copy of a git worktree",
        branch: readHeadBranch(pointer.gitDir),
      });
      continue;
    }
    if (pointer.kind !== "repo") {
      out.set(name, { name, dir, kind: "project", parent: null, why: "", branch: null });
      continue;
    }
    const branch = readHeadBranch(pointer.gitDir);
    const marker = readRunMarker(dir);
    const known = knownProjects.has(path.resolve(dir));
    if (!known && marker && !samePath(marker.path, dir) && !samePath(marker.project, dir)) {
      out.set(name, { name, dir, kind: "copy", parent: path.resolve(marker.project), why: `copy of ${marker.kind} ${marker.id}`, branch });
      continue;
    }
    const origin = readOriginUrl(pointer.gitDir);
    repos.push({
      name,
      dir,
      gitDir: pointer.gitDir,
      origin: origin ? normalizeRemote(origin) : null,
      branch,
      original: known || !isRunStyleBranch(branch) || hasLinkedWorktrees(pointer.gitDir),
    });
  }
  const byOrigin = new Map<string, typeof repos>();
  for (const r of repos) {
    if (!r.origin) continue;
    const group = byOrigin.get(r.origin) ?? [];
    group.push(r);
    byOrigin.set(r.origin, group);
  }
  for (const r of repos) {
    const group = r.origin ? byOrigin.get(r.origin) ?? [] : [];
    let parent: (typeof repos)[number] | null = null;
    if (!r.original && group.length > 1) {
      // A copy is usually named after what it copied (`shop` → `shop-run-x`),
      // so an original whose name starts this one's wins; otherwise the
      // shortest name. With no original at all — every twin on a run branch —
      // the shortest-named twin stands in for one and stays a project.
      const originals = group.filter((g) => g !== r && g.original);
      if (originals.length) {
        parent = originals.filter((g) => r.name.startsWith(g.name)).sort(byShortName)[0] ?? originals.sort(byShortName)[0];
      } else {
        const standIn = group.slice().sort(byShortName)[0];
        if (standIn !== r) parent = standIn;
      }
    }
    out.set(r.name, parent
      ? { name: r.name, dir: r.dir, kind: "copy", parent: parent.dir, why: `same origin as ${parent.name}, on run branch ${r.branch}`, branch: r.branch }
      : { name: r.name, dir: r.dir, kind: "project", parent: null, why: "", branch: r.branch });
  }
  return out;
}

function byShortName(a: { name: string }, b: { name: string }): number {
  return a.name.length - b.name.length || a.name.localeCompare(b.name);
}

/** Do two paths name the same folder? Real paths when both resolve, the spelling otherwise. */
export function samePath(a: string, b: string): boolean {
  const ra = realOr(a);
  const rb = realOr(b);
  return ra === rb;
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function readSmall(file: string, max: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(st.size, max));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
