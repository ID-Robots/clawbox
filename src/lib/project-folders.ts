import fs from "fs";
import path from "@/lib/runtime-path";
import * as config from "@/lib/config-store";
import { DATA_DIR } from "@/lib/config-store";
import { filesBrowseRoot, isProtectedFilePath, OPENCLAW_AGENT_SUBTREE_RE } from "@/lib/file-guard";

// ── The owner's project folders, in the Files app ───────────────────────────
//
// Folders the owner PINS so they show in the desktop's own file manager — a
// "Projects" section in the Files sidebar, a Projects view, and the Projects
// icon on the desktop — instead of being reached through a network share or by
// knowing that the assistant's projects live three hidden folders down in
// `~/.openclaw/workspace/projects`.
//
// A pin is a BOOKMARK, not a new root. It is stored as the path relative to the
// Files browse root (`filesBrowseRoot()`), the same string the Files app
// navigates by, so everything a pinned folder shows goes through the Files API
// and its guard exactly as it would when the owner walked there by hand. That
// is also why a folder outside the browse root cannot be pinned: pinning must
// not widen what the desktop can read. (A drive mounted elsewhere is reachable
// the way it always was — a symlink to it in the home folder.)
//
// Every pin is judged again whenever the list is read: a folder that has since
// been deleted is listed as `missing` so the owner can unpin it, and one a guard
// rule now covers is not listed at all — its name is not the desktop's to show.

export const PROJECT_FOLDERS_CONFIG_KEY = "files_project_folders";

/** A sidebar, not a directory tree: past this the list stops being a shortcut. */
export const MAX_PROJECT_FOLDERS = 50;

export interface ProjectFolder {
  /** Relative to the Files browse root, `/`-separated — what the Files app navigates by. */
  path: string;
  /** The folder's own name. */
  name: string;
  /** Pinned, but not a folder on the disk right now (moved, deleted, a drive not mounted). */
  missing?: boolean;
}

export type ProjectFolderErrorCode =
  | "invalid"
  | "outside_root"
  | "protected"
  | "not_found"
  | "not_directory"
  | "is_root"
  | "too_many";

const STATUS: Record<ProjectFolderErrorCode, number> = {
  invalid: 400,
  outside_root: 400,
  protected: 403,
  not_found: 404,
  not_directory: 400,
  is_root: 400,
  too_many: 409,
};

/** A pin the box turned down, with a code the Files app words for the owner. */
export class ProjectFolderError extends Error {
  readonly status: number;
  constructor(readonly code: ProjectFolderErrorCode, message: string) {
    super(message);
    this.name = "ProjectFolderError";
    this.status = STATUS[code];
  }
}

function browseRoot(): string {
  return path.resolve(filesBrowseRoot());
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/**
 * A path as the owner may type it — `~/projects/x`, `/home/clawbox/projects/x`
 * or `projects/x` — resolved against the browse root, or null when it lies
 * outside it. `~` is the browse root (the Files app shows it as `~`), which on
 * the appliance is the home folder. Lexical only: nothing on the disk is read.
 */
function spell(input: string, root: string): string | null {
  const typed = input.trim();
  if (!typed || typed.includes("\0")) return null;
  const expanded = typed === "~" ? root : typed.startsWith("~/") ? path.join(root, typed.slice(2)) : typed;
  return path.resolve(root, expanded);
}

/**
 * The folder `input` names, as an absolute path and as the browse-relative one
 * the list stores — or a `ProjectFolderError` saying why it cannot be pinned.
 *
 * The same containment the Files API's `safePath` applies (with the separator,
 * so `/home/clawboxx` is not inside `/home/clawbox`), then the same guard, then
 * the disk: it must exist and be a directory.
 */
export function resolveProjectFolder(input: unknown): { abs: string; rel: string } {
  if (typeof input !== "string") throw new ProjectFolderError("invalid", "path required");
  const root = browseRoot();
  const resolved = spell(input, root);
  if (resolved === null) throw new ProjectFolderError("invalid", "path required");
  if (resolved === root) throw new ProjectFolderError("is_root", "The home folder is already in the sidebar");
  if (!resolved.startsWith(root + path.sep)) {
    throw new ProjectFolderError("outside_root", "Only folders inside the home folder can be added");
  }
  if (isProtectedFilePath(resolved)) {
    throw new ProjectFolderError("protected", "That folder holds the box's private data and cannot be shown here");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(/* turbopackIgnore: true */ resolved);
  } catch {
    throw new ProjectFolderError("not_found", "There is no folder at that path");
  }
  if (!stat.isDirectory()) throw new ProjectFolderError("not_directory", "That is a file, not a folder");
  return { abs: resolved, rel: toRel(root, resolved) };
}

/** The stored list, with anything that is not a well-formed pin inside the root dropped. */
async function readPinned(): Promise<string[]> {
  const raw = await config.get(PROJECT_FOLDERS_CONFIG_KEY);
  if (!Array.isArray(raw)) return [];
  const root = browseRoot();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const rel = item && typeof item === "object" ? (item as { path?: unknown }).path : undefined;
    if (typeof rel !== "string" || !rel || path.isAbsolute(rel)) continue;
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) continue;
    const clean = toRel(root, abs);
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

async function writePinned(rels: string[]): Promise<void> {
  await config.set(PROJECT_FOLDERS_CONFIG_KEY, rels.map((rel) => ({ path: rel })));
}

// Pins are a read-modify-write of one config key. Two changes in flight at
// once (two browser tabs, a double click) must not each write a list that lost
// the other's pin, so every change runs after the one before it has landed.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

function describeFolder(root: string, rel: string): ProjectFolder | null {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return null;
  // A rule that covers it now (a store renamed into place, the folder
  // replaced by a link into one): not shown, and not named.
  if (isProtectedFilePath(abs)) return null;
  let missing = false;
  try {
    missing = !fs.statSync(/* turbopackIgnore: true */ abs).isDirectory();
  } catch {
    missing = true;
  }
  return missing ? { path: rel, name: path.basename(abs), missing: true } : { path: rel, name: path.basename(abs) };
}

/** The pinned folders, in the order the owner pinned them. */
export async function listProjectFolders(): Promise<ProjectFolder[]> {
  const root = browseRoot();
  return (await readPinned()).map((rel) => describeFolder(root, rel)).filter((f): f is ProjectFolder => f !== null);
}

/** Pin a folder. Pinning one that is already pinned is not an error — the answer is the same list. */
export function addProjectFolder(input: unknown): Promise<{ folder: ProjectFolder; folders: ProjectFolder[]; added: boolean }> {
  return serialized(async () => {
    const { rel } = resolveProjectFolder(input);
    const pinned = await readPinned();
    let added = false;
    if (!pinned.includes(rel)) {
      if (pinned.length >= MAX_PROJECT_FOLDERS) {
        throw new ProjectFolderError("too_many", `Up to ${MAX_PROJECT_FOLDERS} folders can be pinned`);
      }
      await writePinned([...pinned, rel]);
      added = true;
    }
    const folders = await listProjectFolders();
    const folder = folders.find((f) => f.path === rel) ?? { path: rel, name: path.basename(rel) };
    return { folder, folders, added };
  });
}

/**
 * Unpin a folder, named the way it was pinned or any other way that resolves
 * to it. Lexical only, and never refused for what is on the disk: a folder
 * that was deleted, or that a guard now covers, must still come off the list.
 */
export function removeProjectFolder(input: unknown): Promise<{ removed: boolean; folders: ProjectFolder[] }> {
  return serialized(async () => {
    if (typeof input !== "string") throw new ProjectFolderError("invalid", "path required");
    const root = browseRoot();
    const resolved = spell(input, root);
    if (resolved === null) throw new ProjectFolderError("invalid", "path required");
    const rel = toRel(root, resolved);
    const pinned = await readPinned();
    const removed = pinned.includes(rel);
    if (removed) await writePinned(pinned.filter((p) => p !== rel));
    return { removed, folders: await listProjectFolders() };
  });
}

/**
 * Folders this box already keeps projects in, offered for one-click pinning:
 * the OpenClaw agent's `projects` folder in each of its workspaces (the
 * assistant writes the owner's projects there), the Coding Agent's default
 * working folder, a `projects`/`Projects` folder in the home, and the code
 * assistant's project sources. Only what exists, holds something, lies inside
 * the browse root, passes the guard and is not pinned yet.
 */
export async function suggestedProjectFolders(pinned?: ProjectFolder[]): Promise<ProjectFolder[]> {
  const root = browseRoot();
  const taken = new Set((pinned ?? (await listProjectFolders())).map((f) => f.path));
  const candidates: string[] = [];

  const openclaw = path.join(root, ".openclaw");
  try {
    for (const d of fs.readdirSync(/* turbopackIgnore: true */ openclaw, { withFileTypes: true })) {
      if (d.isDirectory() && OPENCLAW_AGENT_SUBTREE_RE.test(d.name)) candidates.push(path.join(openclaw, d.name, "projects"));
    }
  } catch { /* no OpenClaw state on this box (the Hermes edition) */ }

  try {
    // Imported late: the coding agent's module is large and this is one
    // config value in it. A box that cannot load it still gets the rest.
    const { getDefaultDirectory } = await import("@/lib/coding-agent");
    const dir = await getDefaultDirectory();
    if (dir) candidates.push(path.resolve(dir));
  } catch { /* not configured, or not loadable here */ }

  candidates.push(path.join(root, "projects"), path.join(root, "Projects"), path.join(DATA_DIR, "code-projects"));

  const out: ProjectFolder[] = [];
  // By where they really are, pins included: `~/projects` a link to the
  // workspace's projects folder is one folder, offered (or pinned) once.
  const seenReal = new Set<string>();
  for (const rel of taken) {
    try { seenReal.add(fs.realpathSync(/* turbopackIgnore: true */ path.resolve(root, rel))); } catch { /* missing */ }
  }
  for (const abs of candidates) {
    if (abs === root || !abs.startsWith(root + path.sep)) continue;
    const rel = toRel(root, abs);
    if (taken.has(rel)) continue;
    if (isProtectedFilePath(abs)) continue;
    let real: string;
    try {
      if (!fs.statSync(/* turbopackIgnore: true */ abs).isDirectory()) continue;
      if (fs.readdirSync(/* turbopackIgnore: true */ abs).filter((n) => !n.startsWith(".")).length === 0) continue;
      real = fs.realpathSync(/* turbopackIgnore: true */ abs);
    } catch {
      continue;
    }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    taken.add(rel);
    out.push({ path: rel, name: path.basename(abs) });
  }
  return out;
}
