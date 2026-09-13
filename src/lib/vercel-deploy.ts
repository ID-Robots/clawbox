/**
 * Deploy a coding-agent project to Vercel — the whole of one Deploy press,
 * from "which project is this" to "here is the deployment".
 *
 * WHAT IT IS FOR. The box could already watch what Vercel's git integration
 * did by itself after a run pushed a branch. That is not a button, it is not
 * available on a project with no repository, and it never touches production.
 * The owner asked for two buttons — deploy a preview so we can test it, and
 * deploy to the real domain — and for the assistant to be able to press the
 * first one itself.
 *
 * THE RAIL THAT MATTERS: THE VERCEL PROJECT IS NEVER THE CALLER'S. Everything
 * here starts from a CODING project (a folder or a code project) and looks up
 * the Vercel project the OWNER attached to it (./vercel-link). No argument on
 * any route or tool names a Vercel project, a team or a token, so a
 * prompt-injected agent cannot deploy the owner's code to an account it chose,
 * and cannot deploy somebody else's project to the owner's. What a caller may
 * choose is the coding project (which the owner's own project-folder rule
 * already fences) and the target.
 *
 * THE TWO SHAPES ARE VERCEL'S TO DECLARE. `readProject` says whether that
 * Vercel project is wired to a repository, and that answer alone decides
 * whether the deployment names a git REF or carries the folder's FILES. See
 * the header of `createDeployment` in ./vercel; the point of doing it this way
 * round is that a customer who connects their repository later gets the better
 * shape without touching anything on the box.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not decide WHO may
 * deploy. Every gate — the owner's session, this box's own origin, the
 * confirmation, the per-project switch that lets the agent ship to production,
 * the rate limit — is the route's, in one readable place, the way the promote
 * route holds its own. A module that could be called into production from
 * anywhere is one where the gate has to be looked for.
 */

import { gitInfo } from "@/lib/coding-git";
import { collectDeployFiles, type CollectRefusal } from "@/lib/vercel-files";
import { readVercelLink, resolveVercelAuth } from "@/lib/vercel-link";
import {
  createDeployment,
  readProject,
  uploadDeployFile,
  type DeployFileBody,
  type VercelAuth,
  type VercelErrorKind,
  type VercelGitLink,
} from "@/lib/vercel";
import { VercelLinkError, type DeployTarget, type VercelDeployment, type VercelLinkRefusal } from "@/lib/vercel-state";

/** Why a deploy did not happen, with a stable code beside the sentence. */
export type DeployRefusal =
  | "not_linked"
  | "no_branch"
  | "no_remote"
  | CollectRefusal
  | VercelLinkRefusal
  | VercelErrorKind;

export interface DeployFailure {
  ok: false;
  code: DeployRefusal;
  detail: string;
}

export interface DeploySuccess {
  ok: true;
  deployment: VercelDeployment;
  projectId: string;
  teamId: string | null;
  /** How it was made, which is what the record and the card both say. */
  source: "git" | "files";
  gitRef: string | null;
  fileCount: number | null;
  /**
   * True when the files were chosen by git (so `.gitignore` was honoured), and
   * false when this box had to walk the folder itself.
   *
   * Surfaced rather than assumed: on the fallback path the only thing left out
   * is `.git`, `node_modules` and `.clawbox`, and an owner is entitled to know
   * that the folder's own ignore rules were not what decided.
   */
  usedGit: boolean;
  /** Files left out: links, unreadable entries, and anything over the file cap. */
  skipped: string[];
}

export type DeployOutcome = DeploySuccess | DeployFailure;

function fail(code: DeployRefusal, detail: string): DeployFailure {
  return { ok: false, code, detail };
}

/**
 * How many uploads run at once.
 *
 * Small on purpose. This is a Jetson with one web server on it, and each
 * upload holds a file's bytes in memory for the length of a request on a home
 * connection. Four is enough to keep the line busy and far short of holding a
 * hundred megabytes of a project in flight at once.
 */
const UPLOAD_CONCURRENCY = 4;

/** Push every file up, stopping at the first failure. */
async function uploadAll(auth: VercelAuth, files: readonly DeployFileBody[]): Promise<DeployFailure | null> {
  let next = 0;
  let failure: DeployFailure | null = null;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure) return;
      const index = next++;
      if (index >= files.length) return;
      const sent = await uploadDeployFile(auth, files[index]);
      if (!sent.ok) {
        // The FIRST failure is the one reported: after it the other workers
        // stop, and a second sentence about the same dead connection would
        // only bury it.
        failure ??= fail(sent.kind, sent.detail);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));
  return failure;
}

export interface DeployProjectInput {
  /** The coding project, as `resolveProjectScope` names it. */
  scope: string;
  /** Its folder on this box — where the files come from, and which git is asked about. */
  directory: string;
  target: DeployTarget;
  /**
   * The git ref to build, when the caller already knows it — a run deploys the
   * branch it worked on. Omitted, the folder's current branch is used.
   */
  gitRef?: string | null;
  /** Shown on Vercel's own build page. Never a credential, never a path. */
  meta?: Record<string, string>;
}

/**
 * Make the deployment.
 *
 * Never throws for anything a caller can act on: a missing link, a token this
 * box cannot open, a folder too big to upload and everything Vercel refused all
 * come back as `{ ok: false, code, detail }`, because each of them needs a
 * different thing said and a 500 says none of them.
 */
export async function deployProject(input: DeployProjectInput): Promise<DeployOutcome> {
  const link = await readVercelLink(input.scope);
  if (!link) {
    return fail("not_linked", "No Vercel project is attached to this project, so there is nothing to deploy to.");
  }

  let auth: VercelAuth;
  try {
    auth = await resolveVercelAuth(link, input.scope);
  } catch (err) {
    if (err instanceof VercelLinkError) return fail(err.code, err.message);
    return fail("token_missing", err instanceof Error ? err.message : "This ClawBox could not read the Vercel token.");
  }

  // Vercel's own answer about the project decides the shape — see the header.
  const project = await readProject(auth, link.projectId);
  if (!project.ok) {
    return fail(
      project.kind,
      project.kind === "not_found"
        ? `Vercel has no project called ${link.projectId} on this account.`
        : project.detail,
    );
  }

  return project.gitLink
    ? deployFromGit({ ...input, auth, link: link.projectId, teamId: link.teamId, name: project.name, gitLink: project.gitLink })
    : deployFromFiles({ ...input, auth, link: link.projectId, teamId: link.teamId, name: project.name });
}

/** A project Vercel is connected to: build a ref it can clone. */
async function deployFromGit(input: DeployProjectInput & {
  auth: VercelAuth;
  link: string;
  teamId: string | null;
  name: string | null;
  gitLink: VercelGitLink;
}): Promise<DeployOutcome> {
  const info = await gitInfo(input.directory);
  const ref = input.gitRef?.trim() || info.branch;
  if (!ref || ref === "HEAD") {
    // A folder with no commits, or one on a detached HEAD. Vercel would answer
    // its own 400 several seconds later; this is the same refusal said in the
    // words of the thing the owner can fix.
    return fail("no_branch", "This project is not on a branch with any commits yet, so there is nothing for Vercel to build.");
  }
  if (!info.remote) {
    // Vercel clones from the REMOTE, not from this box: a branch that exists
    // only on the Jetson builds nothing, and the failure arrives minutes later
    // as "ref not found". Said here instead, with what to do about it.
    return fail(
      "no_remote",
      "That Vercel project builds from a git repository, and this folder has no remote — back it up to GitHub first, so Vercel has something to clone.",
    );
  }

  const made = await createDeployment(input.auth, {
    projectId: input.link,
    projectName: input.name,
    teamId: input.teamId,
    target: input.target,
    gitRef: ref,
    gitLink: input.gitLink,
    meta: input.meta,
  });
  if (!made.ok) return fail(made.kind, made.detail);
  return {
    ok: true,
    deployment: made.deployment,
    projectId: input.link,
    teamId: input.teamId,
    source: "git",
    gitRef: ref,
    fileCount: null,
    // git DECIDED the build, so the question the flag answers — "were this
    // folder's ignore rules honoured" — does not arise: nothing was uploaded.
    usedGit: true,
    skipped: [],
  };
}

/** A project with no repository: upload the folder and deploy those files. */
async function deployFromFiles(input: DeployProjectInput & {
  auth: VercelAuth;
  link: string;
  teamId: string | null;
  name: string | null;
}): Promise<DeployOutcome> {
  const collected = await collectDeployFiles(input.directory);
  if (!collected.ok) return fail(collected.code, collected.detail);

  const uploadFailed = await uploadAll(input.auth, collected.files);
  if (uploadFailed) return uploadFailed;

  const made = await createDeployment(input.auth, {
    projectId: input.link,
    projectName: input.name,
    teamId: input.teamId,
    target: input.target,
    // The bytes are already on Vercel; the deployment names them by hash.
    files: collected.files.map(({ file, sha, size }) => ({ file, sha, size })),
    meta: input.meta,
  });
  if (!made.ok) return fail(made.kind, made.detail);
  return {
    ok: true,
    deployment: made.deployment,
    projectId: input.link,
    teamId: input.teamId,
    source: "files",
    gitRef: null,
    fileCount: collected.files.length,
    usedGit: collected.usedGit,
    skipped: collected.skipped,
  };
}
