/**
 * Paths as a run in a WORKTREE must say them.
 *
 * A worker of a coding team (coding-team-worktree.ts) and a run with a
 * worktree of its own (coding-run-worktree.ts) both work in
 * `<project>/.clawbox/worktrees/<name>`, and the runner contains them to
 * that folder. Told a path in the project itself — a goal that names the
 * project folder, a `files_hint` of `styles.css` read as relative to the
 * project — a worker reads `<project>/styles.css`, is refused, and the
 * refusal used to reject the task and count toward the team's alert ceiling
 * with every deliverable on disk (bench, 2026-09-23). So a worker is told
 * its worktree as its ONLY folder, every path it is given is said inside
 * it, and a refused action on `<project>/<rel>` whose `<worktree>/<rel>` is
 * there is answered with where it meant to go.
 *
 * Pure path arithmetic, apart from `worktreeCounterpart`'s one look at the
 * worktree itself: nothing here widens what a run may reach.
 */

import fs from "fs";
import path from "path";
import { BOX_NOTE_PREFIX } from "./coding-run-messages";
import { WORKTREES_DIR } from "./coding-team-worktree";

/** `.clawbox/worktrees`, with forward slashes: every path here is POSIX. */
const WORKTREES = WORKTREES_DIR.split(path.sep).join("/");

/** A character a path name goes on with: a name ends where one of these does not follow. */
const NAME_CHAR = /[A-Za-z0-9_.-]/;

/**
 * The project a worktree belongs to: `<project>` for a folder at
 * `<project>/.clawbox/worktrees/<name>` — the team's and the runs' one
 * layout — or null for a folder that is not one.
 */
export function worktreeProject(folder: string): string | null {
  if (!path.posix.isAbsolute(folder)) return null;
  const dir = path.posix.resolve(folder);
  const marker = `/${WORKTREES}/`;
  const at = dir.lastIndexOf(marker);
  if (at <= 0) return null;
  const name = dir.slice(at + marker.length);
  if (!name || name.includes("/")) return null;
  return dir.slice(0, at);
}

/**
 * `text` with every mention of `project` said as `folder`: `<project>/<rel>`
 * becomes `<folder>/<rel>`, the bare project path becomes `folder`, and a
 * path in ANOTHER worktree of the project (`<project>/.clawbox/worktrees/
 * <other>/<rel>`, a sibling's) becomes `<folder>/<rel>` — once merged, the
 * same file is in the reader's own copy. A longer name that only starts like
 * the project (`<project>2`, `<project>.old`) is left alone; a sentence's
 * full stop after the project path is not part of it.
 *
 * With `folder` equal to `project` it takes worktree paths back to the
 * project — the words a reader in the project itself (a reviewer) needs
 * after the worktree is gone.
 */
export function toFolderPaths(text: string, project: string, folder: string): string {
  if (!text || !path.posix.isAbsolute(project) || !path.posix.isAbsolute(folder)) return text;
  const root = path.posix.resolve(project);
  const own = path.posix.resolve(folder);
  if (root === "/") return text;
  let out = "";
  let from = 0;
  for (let at = text.indexOf(root); at >= 0; at = text.indexOf(root, at + 1)) {
    if (at < from) continue;
    // Part of a longer path (`/srv/site` inside `/srv/site2` or `/x/srv/site`).
    if (at > 0 && (NAME_CHAR.test(text[at - 1]) || text[at - 1] === "/")) continue;
    let end = at + root.length;
    const next = text[end];
    if (next !== undefined && next !== "/" && NAME_CHAR.test(next) && !(next === "." && !NAME_CHAR.test(text[end + 1] ?? ""))) continue;
    // A worktree of the project — the reader's own or a sibling's — is
    // said as the reader's own folder, with the rest of the path kept.
    const worktrees = `/${WORKTREES}/`;
    if (text.startsWith(worktrees, end)) {
      let nameEnd = end + worktrees.length;
      while (nameEnd < text.length && NAME_CHAR.test(text[nameEnd])) nameEnd += 1;
      // `.` closing a sentence is not part of the worktree's name.
      while (nameEnd > end + worktrees.length && text[nameEnd - 1] === "." && !NAME_CHAR.test(text[nameEnd] ?? "")) nameEnd -= 1;
      if (nameEnd > end + worktrees.length) end = nameEnd;
    }
    out += text.slice(from, at) + own;
    from = end;
  }
  return out + text.slice(from);
}

/**
 * A `files_hint` entry as an absolute path in `folder`: a relative hint is
 * joined onto it, an absolute one in the project is moved into it
 * (`toFolderPaths`). Anything else — a hint that climbs out with `..`, one
 * somewhere else entirely, `~/…` — is left as the planner wrote it: it was
 * never the worker's to find in its folder.
 */
export function hintInFolder(hint: string, project: string, folder: string): string {
  const h = hint.trim();
  if (!h) return hint;
  if (path.posix.isAbsolute(h)) return toFolderPaths(h, project, folder);
  if (h.startsWith("~")) return h;
  const own = path.posix.resolve(folder);
  const joined = path.posix.join(own, h);
  const rel = path.posix.relative(own, joined);
  if (rel === ".." || rel.startsWith("../")) return h;
  return joined;
}

/**
 * Where a refused action on `target` meant to go, for a run working in
 * `worktree`: `<worktree>/<rel>` for a `target` of `<project>/<rel>`, when
 * that path is there — for a write (`forWrite`), when the file or the folder
 * it would go in is. Null for everything else: a run not in a worktree, a
 * target outside the project, one under `.clawbox` (another worktree is not
 * this run's to be pointed at), and a counterpart that is not there.
 *
 * The one look at the disk is inside the run's own worktree, at a path the
 * run named itself, and does not follow a link: it tells the run nothing
 * about any other folder.
 */
export function worktreeCounterpart(target: string, worktree: string, forWrite = false): string | null {
  const project = worktreeProject(worktree);
  if (!project || !path.posix.isAbsolute(target)) return null;
  const resolved = path.posix.resolve(target);
  const rel = path.posix.relative(project, resolved);
  if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) return null;
  if (rel === ".clawbox" || rel.startsWith(".clawbox/")) return null;
  const own = path.posix.resolve(worktree);
  const counterpart = rel ? path.posix.join(own, rel) : own;
  if (exists(counterpart)) return counterpart;
  if (forWrite && rel && exists(path.posix.dirname(counterpart))) return counterpart;
  return null;
}

/** The file tools a run is refused by path, and the input field that names it. */
const PATH_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
  LS: ["path"],
};
const WRITE_PATH_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Where a run in a worktree meant to go with a tool call — `worktreeCounterpart`
 * of the path a file tool (`tool`, its `input` as Claude Code sends it) was
 * pointed at — or null: not a file tool, no path, a run that is not in a
 * worktree, or nothing of the project's there. A Bash command is never
 * answered: which of its words is a path is a guess, and a guess is not a hint.
 */
export function worktreeHintFor(runDirectory: string, tool: unknown, input: unknown): string | null {
  if (typeof tool !== "string" || !Object.prototype.hasOwnProperty.call(PATH_TOOLS, tool)) return null;
  if (!input || typeof input !== "object") return null;
  const fields = input as Record<string, unknown>;
  const target = PATH_TOOLS[tool].map((k) => fields[k]).find((v): v is string => typeof v === "string" && v !== "");
  if (!target) return null;
  return worktreeCounterpart(target, runDirectory, WRITE_PATH_TOOLS.has(tool));
}

/**
 * The hint itself, as the runner queues it to the run (coding-run-messages.ts
 * frames it as the box's note): where the refused action should have gone,
 * and the run's folder as the only one it works in. It never names the
 * project path — the path the run was refused is the one it just typed.
 */
export function worktreeHintText(tool: string, worktree: string, counterpart: string): string {
  const own = path.posix.resolve(worktree);
  return `${BOX_NOTE_PREFIX} Your ${tool} was refused: its path is outside your folder. Your folder is ${own} — your own copy of the project, and the only folder you work in. In it, that path is ${counterpart}: retry with that path, and keep every path you read or write inside ${own}.`;
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
