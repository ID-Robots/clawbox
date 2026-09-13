/**
 * The files of a project folder, ready to be uploaded as a Vercel deployment.
 *
 * WHY THIS IS A MODULE OF ITS OWN. `./vercel` is the REST client and touches
 * no disk at all — that is what lets its test run against a fake API with
 * nothing mocked. Walking a folder, asking git what it ignores and hashing
 * bytes is the other half, and keeping it here means the client cannot grow a
 * filesystem dependency by accident.
 *
 * WHAT MAY GO UP, AND WHY THE RULE IS GIT'S AND NOT OURS. A deploy of a folder
 * the coding agent has been working in is a deploy of somebody's real project,
 * and the thing that must never be uploaded is the thing they already told git
 * not to track: `.env`, a key, a database dump, the build cache. Writing a
 * second ignore matcher here would mean maintaining a worse copy of a rule the
 * folder already states, and being wrong about it is a credential on somebody
 * else's servers. So where the folder is a git repository, `git ls-files
 * --cached --others --exclude-standard` IS the list — exactly the files git
 * would show as tracked or as untracked-and-not-ignored, with `.gitignore`,
 * `.git/info/exclude` and the global excludes all honoured by the tool that
 * defines them.
 *
 * A folder that is NOT a repository (git missing, never initialised) falls back
 * to a plain walk with the names below skipped. That is a weaker rule, and it
 * is why `usedGit` is on the answer: the caller says so, rather than letting a
 * customer assume their ignores were respected when this box could not ask.
 *
 * SYMLINKS ARE NEVER FOLLOWED. A link in the folder is skipped, not resolved:
 * a run can write one, and `data/` — which holds this box's credential stores —
 * is one `ln -s` away from being uploaded to the internet otherwise. `lstat`
 * everywhere, and the walk never leaves the folder it was given.
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { gitIn } from "@/lib/coding-team-worktree";
import type { DeployFileBody } from "@/lib/vercel";

/**
 * The most files one deployment may carry.
 *
 * A bound on what this box holds and uploads, not a judgement about the
 * project: a folder with more than this is one whose ignores are wrong or
 * which has no business being uploaded file by file, and refusing it with a
 * sentence beats spending ten minutes of a Jetson's evening finding that out.
 */
export const MAX_DEPLOY_FILES = 3_000;

/** The most one file may be. Bigger than any source file and any sane asset. */
export const MAX_DEPLOY_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The most a whole deployment may be.
 *
 * The real constraint is this box: every file is read into memory to be hashed
 * and uploaded, and the web server is one process on a device that also runs
 * the agent, a model server and whatever the owner has open. 100 MB is
 * generous for a built site and small enough that it cannot take the desktop
 * down with it.
 */
export const MAX_DEPLOY_BYTES = 100 * 1024 * 1024;

/**
 * Folders that are never uploaded, whatever git says.
 *
 * `.git` is the repository itself (and its config, and its credentials);
 * `node_modules` is what the build reinstalls and is megabytes of it;
 * `.clawbox` is where this box keeps a project's run worktrees, which are
 * whole second copies of the same project. Each one is skipped by NAME at
 * every depth, because every one of them can legitimately appear in a
 * subdirectory of a monorepo.
 */
export const NEVER_UPLOADED = new Set([".git", "node_modules", ".clawbox"]);

/** How long git gets to list a folder. */
const LIST_TIMEOUT_MS = 30_000;

export type CollectRefusal = "too_many_files" | "too_large" | "empty" | "unreadable";

export interface CollectedFiles {
  ok: true;
  files: DeployFileBody[];
  bytes: number;
  /** Did git decide what was included? False = the fallback walk, weaker rule. */
  usedGit: boolean;
  /** Paths left out because they are links, unreadable, or over the file cap. */
  skipped: string[];
}

export type CollectResult = CollectedFiles | { ok: false; code: CollectRefusal; detail: string };

/** The sha1 of some bytes, lowercase hex — Vercel's own content address. */
export function sha1Of(data: Uint8Array): string {
  return crypto.createHash("sha1").update(data).digest("hex");
}

/**
 * The deployment paths of a folder, as git sees it.
 *
 * Null — not an empty list — when git could not answer, so "this is not a
 * repository" and "this repository has no files" stay different facts. `-z`
 * because a path may contain anything but a NUL, and `--exclude-standard` is
 * what makes `.gitignore` count.
 */
async function gitListing(dir: string): Promise<string[] | null> {
  const listed = await gitIn(dir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (listed.code !== 0) return null;
  const paths = listed.stdout.split("\0").map((p) => p.trim()).filter(Boolean);
  return paths;
}

/** Every ordinary file under `dir`, relative and posix-spelled. The fallback. */
async function walk(dir: string, base = "", out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(path.join(dir, base), { withFileTypes: true });
  for (const entry of entries) {
    if (out.length > MAX_DEPLOY_FILES) return out;
    if (NEVER_UPLOADED.has(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    // A link is never followed and never uploaded — see the header.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(dir, rel, out);
      continue;
    }
    if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Read a folder into the file list a deployment is made of.
 *
 * Every refusal is a `code` beside a sentence, the shape the rest of this
 * feature uses, because "your project is too big" and "this box could not read
 * that folder" need different things done about them.
 */
export async function collectDeployFiles(dir: string): Promise<CollectResult> {
  let names: string[];
  let usedGit = true;
  try {
    const listed = await Promise.race([
      gitListing(dir),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LIST_TIMEOUT_MS).unref?.()),
    ]);
    if (listed) {
      // git lists `.clawbox/worktrees/...` and, in a repository whose ignores
      // do not cover them, `node_modules`: the never-uploaded rule is applied
      // on top of git's answer rather than instead of it.
      names = listed.filter((rel) => !rel.split("/").some((part) => NEVER_UPLOADED.has(part)));
    } else {
      usedGit = false;
      names = await walk(dir);
    }
  } catch (err) {
    return { ok: false, code: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }

  if (names.length > MAX_DEPLOY_FILES) {
    return {
      ok: false,
      code: "too_many_files",
      detail: `That folder has ${names.length} files to upload and this ClawBox deploys at most ${MAX_DEPLOY_FILES}. Add what does not belong in the deployment to .gitignore, or connect the Vercel project to a git repository.`,
    };
  }

  const files: DeployFileBody[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  for (const rel of names) {
    // `path.resolve` then a containment check, the pattern every path-taking
    // module here uses: git prints what git has, and a repository can hold a
    // path with `..` in it only if somebody put one there on purpose.
    const abs = path.resolve(dir, rel);
    if (abs !== path.resolve(dir) && !abs.startsWith(path.resolve(dir) + path.sep)) {
      skipped.push(rel);
      continue;
    }
    let stat;
    try {
      stat = await fs.lstat(abs);
    } catch {
      // Listed and gone by the time it was read: a run may still be working in
      // this folder. Skipped and reported, never a failed deploy.
      skipped.push(rel);
      continue;
    }
    if (!stat.isFile()) { skipped.push(rel); continue; }
    if (stat.size > MAX_DEPLOY_FILE_BYTES) { skipped.push(rel); continue; }
    if (bytes + stat.size > MAX_DEPLOY_BYTES) {
      return {
        ok: false,
        code: "too_large",
        detail: `That folder is more than the ${Math.round(MAX_DEPLOY_BYTES / (1024 * 1024))} MB this ClawBox uploads in one deployment. Add what does not belong in the deployment to .gitignore, or connect the Vercel project to a git repository.`,
      };
    }
    let data: Buffer;
    try {
      data = await fs.readFile(abs);
    } catch {
      skipped.push(rel);
      continue;
    }
    bytes += data.length;
    files.push({
      // Forward slashes whatever the platform spells them as: this string is a
      // path inside the deployment, not a path on this box.
      file: rel.split(path.sep).join("/"),
      sha: sha1Of(data),
      size: data.length,
      data,
    });
  }

  if (!files.length) {
    return {
      ok: false,
      code: "empty",
      detail: "There is nothing in that folder to deploy. Build the project first, or check what .gitignore leaves out.",
    };
  }
  return { ok: true, files, bytes, usedGit, skipped };
}
