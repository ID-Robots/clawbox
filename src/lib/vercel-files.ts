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
 * is one `ln -s` away from being uploaded to the internet otherwise. Three
 * things hold that, and each covers what the others cannot:
 *
 *  - the walk skips a link by its dirent and never leaves the folder it was
 *    given;
 *  - the path is contained in TWO stages, the `coding-agent-media.ts` pattern:
 *    as typed, and then by the realpath'd PARENT — which is what catches a
 *    FOLDER symlink planted inside the project;
 *  - and every file is read through ONE descriptor opened `O_NOFOLLOW`, which
 *    refuses a link in git's listing and closes the window that checking a path
 *    and then opening it again leaves for a run still working in that folder.
 */

import crypto from "crypto";
import { constants as fsConstants } from "fs";
import fsp from "fs/promises";
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

export type CollectRefusal = "too_many_files" | "too_large" | "empty" | "unreadable" | "ignores_unreadable";

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
  // NO `trim()` per path: git permits leading and trailing whitespace in a
  // filename, `-z` is exactly the format that carries one unambiguously, and
  // trimming changed the path before it was opened — so the tracked file was
  // dropped from the deployment (found in review).
  //
  // One residue is outside this module and is stated rather than hidden:
  // `runChild` trims the WHOLE of a child's stdout, so a leading space on the
  // FIRST path git lists (which is where such a name sorts) is gone before
  // this sees it. That file is then skipped and reported in `skipped` — an
  // omission the caller can see, never a wrong file under a right name.
  return listed.stdout.split("\0").filter((p) => p.length > 0);
}

/**
 * Is this folder a git repository at all?
 *
 * Asked on DISK rather than of git, because the question only arises when git
 * has just failed to answer one — a second spawn would be just as likely to
 * time out. `.git` is a directory in an ordinary checkout and a FILE in a
 * worktree, so the presence of the name is the test.
 */
async function isRepository(dir: string): Promise<boolean> {
  try {
    await fsp.lstat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Credential-shaped names that never go up, WHATEVER path found them.
 *
 * The fallback walk has no `.gitignore` to honour — that is what makes it the
 * fallback — so the one thing it must not do is upload the file every project
 * keeps its secrets in. And git's answer gets the same floor: a run can write
 * a `.env`, commit it, and ask for a deployment, after which the file is
 * served on an address anybody with the link can open. The same shape
 * `mcp/lib/guard.ts` refuses for the agent's own file tools, applied here to
 * what leaves the box.
 */
const NEVER_UPLOADED_FILE_RE = /^(\.env(\..*)?|\.envrc|.*\.pem|.*\.key|id_[a-z0-9]+)$/i;

/**
 * May this path go up at all?
 *
 * ONE rule for both paths. The credential names were applied to the fallback
 * walk alone at first, which left a git-TRACKED `.env` going up: a run can
 * write one, commit it and ask for a deployment, and the file is then served
 * on an address anybody with the link can open (found in review). What git
 * ignores is still git's to decide; this is the floor underneath that answer,
 * and what it leaves out is reported in `skipped` rather than dropped
 * silently.
 */
function excluded(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.some((part) => NEVER_UPLOADED.has(part))) return false;
  return !NEVER_UPLOADED_FILE_RE.test(parts[parts.length - 1] ?? "");
}

/** Every ordinary file under `dir`, relative and posix-spelled. The fallback. */
async function walk(dir: string, base = "", out: string[] = []): Promise<string[]> {
  const entries = await fsp.readdir(path.join(dir, base), { withFileTypes: true });
  for (const entry of entries) {
    if (out.length > MAX_DEPLOY_FILES) return out;
    if (NEVER_UPLOADED.has(entry.name)) continue;
    if (entry.isFile() && NEVER_UPLOADED_FILE_RE.test(entry.name)) continue;

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
  let excludedByRule: string[] = [];
  try {
    const listed = await Promise.race([
      gitListing(dir),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LIST_TIMEOUT_MS).unref?.()),
    ]);
    if (listed) {
      // git lists `.clawbox/worktrees/...` and, in a repository whose ignores
      // do not cover them, `node_modules`: the never-uploaded rule is applied
      // on top of git's answer rather than instead of it.
      names = listed.filter(excluded);
      // What the floor left out is REPORTED, not dropped silently: an owner
      // who tracked a `.env` on purpose is entitled to know it did not go up.
      excludedByRule = listed.filter((rel) => !excluded(rel));
    } else if (await isRepository(dir)) {
      // A REPOSITORY whose ignores this box could not read is refused, never
      // walked. The fallback exists for a folder that has no `.gitignore` to
      // honour; using it here would upload the very files the owner told git
      // to keep — `.env` first among them — because git happened to time out
      // or fail. Refusing is recoverable; a credential on somebody else's
      // servers is not (found in review).
      return {
        ok: false,
        code: "ignores_unreadable",
        detail: "This ClawBox could not ask git what this project ignores, and it will not upload a repository without that answer — .gitignore is what keeps a .env out of a deployment. Try again in a moment.",
      };
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
  const skipped: string[] = [...excludedByRule];
  let bytes = 0;
  const root = path.resolve(dir);
  // The folder's own real location, resolved once: every parent below is
  // compared with THIS rather than with the name the caller typed.
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
  } catch (err) {
    return { ok: false, code: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
  /** Parents already vetted — one realpath per directory, not per file. */
  const vettedParents = new Map<string, boolean>();

  for (const rel of names) {
    // TWO STAGES, the `coding-agent-media.ts` pattern. First the path AS
    // TYPED: git prints what git has, and a repository can hold a path with
    // `..` in it only if somebody put one there on purpose.
    const abs = path.resolve(dir, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      skipped.push(rel);
      continue;
    }
    // Then the realpath'd PARENT. `O_NOFOLLOW` below refuses a link at the
    // FINAL component only, so a folder symlink planted inside the project —
    // which a run can write — would otherwise satisfy the lexical check above
    // while the bytes came from wherever it points. Neither the walk (which
    // skips a link by its dirent) nor git (which records a link as a blob
    // rather than descending into it) produces such a path today; this is the
    // second stage that means it does not have to stay true.
    const parent = path.dirname(abs);
    let parentOk = vettedParents.get(parent);
    if (parentOk === undefined) {
      try {
        const realParent = await fsp.realpath(parent);
        parentOk = realParent === realRoot || realParent.startsWith(realRoot + path.sep);
      } catch {
        parentOk = false;
      }
      vettedParents.set(parent, parentOk);
    }
    if (!parentOk) {
      skipped.push(rel);
      continue;
    }
    // ONE descriptor, opened `O_NOFOLLOW`, and every question asked of THAT
    // handle rather than of the path again.
    //
    // Not a style preference: `lstat` then `readFile` is two lookups of the
    // same name, and between them a run still working in this folder can
    // replace the file with a link to somewhere else — so the check would pass
    // on one file and the bytes would come from another. The same discipline
    // the MCP file sinks use (`resolveGuardedPath`), and CodeQL flags the
    // stat-then-read shape by name.
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      // Listed and gone, or a symlink O_NOFOLLOW refused. Either way it is
      // skipped and reported, never a failed deploy: a run may still be
      // working in this folder.
      skipped.push(rel);
      continue;
    }
    let data: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_DEPLOY_FILE_BYTES) { skipped.push(rel); continue; }
      if (bytes + stat.size > MAX_DEPLOY_BYTES) {
        return {
          ok: false,
          code: "too_large",
          detail: `That folder is more than the ${Math.round(MAX_DEPLOY_BYTES / (1024 * 1024))} MB this ClawBox uploads in one deployment. Add what does not belong in the deployment to .gitignore, or connect the Vercel project to a git repository.`,
        };
      }
      data = await handle.readFile();
    } catch {
      skipped.push(rel);
      continue;
    } finally {
      await handle.close().catch(() => {});
    }
    // The handle's own size bounded what was read; this is what actually
    // arrived, which is what the deployment is charged for.
    if (bytes + data.length > MAX_DEPLOY_BYTES) {
      return {
        ok: false,
        code: "too_large",
        detail: `That folder is more than the ${Math.round(MAX_DEPLOY_BYTES / (1024 * 1024))} MB this ClawBox uploads in one deployment. Add what does not belong in the deployment to .gitignore, or connect the Vercel project to a git repository.`,
      };
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
