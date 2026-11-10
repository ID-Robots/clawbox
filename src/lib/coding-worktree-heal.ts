/**
 * A run's TEMPORARY folder, written into the files it leaves behind.
 *
 * A team's worker and a run with a worktree of its own both work in
 * `<project>/.clawbox/worktrees/<name>`, are told that folder as the only one
 * they have, and are never told the project's (coding-worktree-paths.ts: told
 * it, they read and wrote there and were refused). So when the work calls for
 * an absolute path INSIDE a file — the command a README documents, a config's
 * `cwd`, a script's shebang line — the only path the run knows is its
 * worktree's, and it writes that. The worktree is removed when the work is
 * merged, and every such path is dead on arrival:
 *
 *   node ~/Projects/calculator/.clawbox/worktrees/t4-1/mcp/server.mjs
 *
 * Two coding teams in a row did every task, merged, and FAILED their final
 * review on exactly this (2026-11-08, calculator and pomodoro; the owner's
 * goals had begun to carry a paragraph against it, which the box itself
 * rewrote into the worktree's path on the way to the worker).
 *
 * The box knows both paths and the run knows one, so the box does it: once a
 * run's work is committed, every tracked text file in its worktree that names
 * that worktree is said in the project's own folder instead (`toFolderPaths`
 * with the project as the reader — a sibling's worktree in the same file goes
 * with it), and the rewrite is one more commit on the run's branch, in the
 * box's name. Before a team merges the branch, before a single run's pull
 * request is pushed.
 *
 * Never throws and never fails a run: a file it cannot read, a tree git will
 * not answer for, an identity it cannot resolve leave the branch as the run
 * made it, with the reason for the caller to log.
 */

import fs from "fs";
import path from "./runtime-path";
import { codingGitIdentityArgs } from "./coding-git-identity";
import { gitIn } from "./coding-team-worktree";
import { toFolderPaths, worktreeProject } from "./coding-worktree-paths";

/** A file larger than this is not a document a run wrote a path into; it is left alone. */
const MAX_HEAL_BYTES = 2 * 1024 * 1024;
/** No run names its folder in more files than this; past it something else is going on, and nothing is rewritten. */
const MAX_HEAL_FILES = 200;

/** The subject of the commit the rewrite makes. */
export const HEAL_COMMIT_SUBJECT = "Paths: the project's own folder, not the run's temporary copy";

export type HealOutcome =
  /** `files`: what was rewritten and committed, relative to the worktree — empty when nothing named it. */
  | { ok: true; files: string[]; commit: string | null }
  | { ok: false; detail: string };

/**
 * Rewrite and commit, in the worktree at `worktreePath`. Null for a folder
 * that is not a worktree of a project (`worktreeProject`): there is nothing
 * temporary about a run's folder then.
 */
export async function healWorktreePaths(worktreePath: string): Promise<HealOutcome | null> {
  const own = path.resolve(worktreePath);
  const project = worktreeProject(own);
  if (!project) return null;
  // Tracked text files that name THIS worktree: fixed string, binaries
  // skipped (-I), NUL-separated names. Exit 1 is "none".
  const found = await gitIn(own, ["grep", "-l", "-I", "-z", "--fixed-strings", "-e", own, "--", "."]);
  if (found.code === 1) return { ok: true, files: [], commit: null };
  if (found.code !== 0) return { ok: false, detail: `git could not search the run's files for its own folder: ${(found.stderr || "no answer").trim().slice(0, 200)}` };
  const names = found.stdout.split("\0").filter(Boolean);
  if (names.length > MAX_HEAL_FILES) return { ok: false, detail: `${names.length} files name the run's folder — too many to be paths a run wrote; nothing was rewritten.` };
  const healed: string[] = [];
  for (const rel of names) {
    const file = path.join(own, rel);
    let handle: fs.promises.FileHandle | undefined;
    try {
      // A regular file of the worktree itself: never through a link, never a
      // huge one. ONE handle for the check, the read and the write —
      // O_NOFOLLOW refuses a link, and nothing can swap the path between the
      // look and the write (a path checked and then opened again is two
      // files to anything that can rename in between). Handle methods, not
      // fs calls on a descriptor, which the build would trace (runtime-path.ts).
      handle = await fs.promises.open(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_HEAL_BYTES) continue;
      const before = await handle.readFile("utf8");
      const after = toFolderPaths(before, project, project);
      if (after === before) continue;
      await handle.truncate(0);
      await handle.write(after, 0, "utf8");
      healed.push(rel);
    } catch {
      // Unreadable, a link, or gone meanwhile: left as the run made it.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  if (!healed.length) return { ok: true, files: [], commit: null };
  const as = await codingGitIdentityArgs(own);
  if (!as.ok) return { ok: false, detail: as.detail };
  const added = await gitIn(own, ["--literal-pathspecs", "add", "--", ...healed]);
  if (added.code !== 0) return { ok: false, detail: `The rewritten files could not be staged: ${(added.stderr || "no answer").trim().slice(0, 200)}` };
  const n = healed.length;
  const body = `The run worked in ${path.relative(project, own)}, which is removed once its work is merged, and wrote that\nfolder's path into ${n === 1 ? "this file" : `these ${n} files`}. Each mention now names the project's own folder.`;
  const committed = await gitIn(own, [...as.args, "commit", "-q", "--no-verify", "-m", HEAL_COMMIT_SUBJECT, "-m", body]);
  if (committed.code !== 0) return { ok: false, detail: `The rewritten files could not be committed: ${(committed.stderr || committed.stdout || "no answer").trim().slice(0, 200)}` };
  const head = await gitIn(own, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, files: healed, commit: head.code === 0 ? head.stdout.trim() : null };
}
