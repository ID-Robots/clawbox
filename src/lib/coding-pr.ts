/**
 * The auto-PR flow: a finished run's work becomes a branch, a pull request, a
 * wait on GitHub Actions, and — only when the checks actually say so — a merge.
 *
 * WHY THIS LIVES ON THE SERVER, not in the run's brief.
 *
 * The obvious design is to tell the agent to do it. That fails three ways on
 * this box, all measured: a run polling CI spends one of its 150 turns per
 * poll; it holds the single run slot (MAX_CONCURRENT_RUNS) for as long as CI
 * takes; and the idle killer ends a run that sits quiet in a long `gh` wait.
 * The aftermath of a run already happens out here — finishRun() settles the
 * record and THEN commits the work and may start the review pass — so a PR
 * wait is one more phase of that aftermath, not a state of the process.
 *
 * WHY `gh` IS DRIVEN THE WAY IT IS. The gh on this device is 2.4.0 (2022):
 *   - `gh pr checks` has ONE flag, `-w/--web`. No --watch, no --json. The
 *     modern one-line wait does not exist here; polling is forced.
 *   - `--repo` is not accepted by `gh repo view`; the repo is positional.
 *   - `gh pr view --json statusCheckRollup` answers `null`, not `[]`, when a PR
 *     has no checks, and `mergeable` is the string enum MERGEABLE/CONFLICTING/
 *     UNKNOWN, not a boolean.
 * Each of those was verified against real PRs from this box, and each is a way
 * an implementation written from memory of a newer gh fails silently.
 */

import path from "path";
import { runChild, type ChildResult, failureDetail } from "./child-run";
import {
  emptyChecks,
  foldChecks,
  runBranchName,
  type PrChecks,
  type PrSnapshot,
} from "./coding-pr-state";

// One import for server callers: the pure half is re-exported here, and the
// browser imports ./coding-pr-state directly (this module spawns processes).
export * from "./coding-pr-state";

/** How long a single gh/git call gets. */
const CALL_TIMEOUT_MS = 60_000;



function run(bin: string, args: string[], cwd?: string): Promise<ChildResult> {
  return runChild(bin, args, {
    cwd,
    timeoutMs: CALL_TIMEOUT_MS,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/home/clawbox",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
      LANG: "C",
    },
  });
}

const ok = (r: ChildResult) => r.code === 0;
const out = (r: ChildResult) => r.stdout.trim();

/**
 * The branch a PR should target.
 *
 * NOT the literal "main". Every repo the coding agent has made is on `master`,
 * because `git init` on this box (git 2.34.1, no init.defaultBranch) has no
 * opinion and neither did initRepo. Asking the remote what its default branch
 * is, and falling back to the local HEAD, is the only answer that is true on
 * both the old repos and the new ones.
 */
export async function resolveBaseBranch(dir: string): Promise<string> {
  // What the remote calls its default. `gh repo view` takes the repo as a
  // POSITIONAL argument on 2.4.0 — `--repo` is rejected — and with no argument
  // at all it reads the repo from the cwd, which is what we want.
  const viewed = await run("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], dir);
  if (ok(viewed) && out(viewed)) return out(viewed);

  // No remote, or gh cannot see it: whatever this checkout is on.
  const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (ok(head) && out(head) && out(head) !== "HEAD") return out(head);
  return "main";
}

/**
 * Put the run's work on its own branch, leaving the base branch behind.
 *
 * Called BEFORE the run starts, which is the only simple moment: commitRunWork
 * commits to whatever branch is checked out, so branching first means the
 * commits land where the PR needs them with no history rewriting afterwards.
 *
 * The unborn-HEAD case is the one that bites: on a repository with no commits,
 * `git checkout -b x` RENAMES the unborn branch rather than forking from it, so
 * the base branch never comes into existence and `gh repo create --push` then
 * makes the RUN branch the repository default — PRs would target the run's own
 * branch forever. An empty initial commit on the base branch first is what
 * makes the fork a fork.
 */
export async function startRunBranch(input: {
  directory: string;
  runId: string;
  /** The ClawBox checkout. A run must never branch or commit THIS repository. */
  protectedRoot: string;
}): Promise<{ ok: true; branch: string; base: string } | { ok: false; detail: string }> {
  const dir = path.resolve(input.directory);
  const branch = runBranchName(input.runId);

  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], dir);
  if (!ok(inside)) {
    return { ok: false, detail: failureDetail(inside, "Reading the git repository", "Make the folder a git repository first.") };
  }

  // NEVER the ClawBox checkout itself.
  //
  // A code project lives at data/code-projects/<id>, which is INSIDE this
  // repository — so `git` there resolves to ClawBox's own repo, and the project
  // page shows the product's branch, commit count and remote as if they were
  // the project's. Branching from here would `git checkout -b clawbox/<runId>`
  // in the working tree the box itself is served from, moving the operator's
  // branch under them; pushing would put a run's work on the product's remote.
  // The folder is refused instead, and the run does its work uncommitted.
  const top = await run("git", ["rev-parse", "--show-toplevel"], dir);
  if (ok(top) && out(top)) {
    const root = path.resolve(out(top));
    const guarded = path.resolve(input.protectedRoot);
    if (root === guarded) {
      return {
        ok: false,
        detail: "This folder is inside ClawBox's own checkout, so a pull request would branch ClawBox itself. Work in a folder under your project folder instead.",
      };
    }
  }

  const hasHead = await run("git", ["rev-parse", "--verify", "HEAD"], dir);
  if (!ok(hasHead)) {
    // Unborn HEAD. Name the base branch, then give it a commit of its own so
    // the run branch can fork FROM something.
    const base = await resolveBaseBranch(dir);
    const named = await run("git", ["symbolic-ref", "HEAD", `refs/heads/${base}`], dir);
    if (!ok(named)) {
      return { ok: false, detail: failureDetail(named, "Naming the base branch", "Try again.") };
    }
    const seeded = await run("git", ["commit", "--allow-empty", "-m", "Initial commit"], dir);
    if (!ok(seeded)) {
      return { ok: false, detail: failureDetail(seeded, "Creating the first commit", "Try again.") };
    }
  }

  const base = await resolveBaseBranch(dir);
  const forked = await run("git", ["checkout", "-b", branch], dir);
  if (!ok(forked)) {
    return { ok: false, detail: failureDetail(forked, `Creating the branch ${branch}`, "Try again.") };
  }
  return { ok: true, branch, base };
}

/**
 * Push the branch and open the PR.
 *
 * Deliberately does NOT go through backupToGitHub() to "make sure there is a
 * remote": that helper pushes the CURRENT branch to origin, which on this path
 * would push the run branch as the repository's own default and leave nothing
 * for a PR to target. A missing remote is reported, not papered over.
 */
export async function openPullRequest(input: {
  directory: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<{ ok: true; number: number; url: string } | { ok: false; detail: string }> {
  const dir = path.resolve(input.directory);

  const remote = await run("git", ["remote", "get-url", "origin"], dir);
  if (!ok(remote)) {
    return {
      ok: false,
      detail: "This project has no GitHub remote yet. Back it up to GitHub once from the project page, then future runs can open pull requests.",
    };
  }

  const pushed = await run("git", ["push", "--set-upstream", "origin", input.branch], dir);
  if (!ok(pushed)) {
    return { ok: false, detail: failureDetail(pushed, `Pushing ${input.branch}`, "Check the GitHub connection and try again.") };
  }

  const created = await run(
    "gh",
    ["pr", "create", "--base", input.base, "--head", input.branch, "--title", input.title, "--body", input.body],
    dir,
  );
  if (!ok(created)) {
    return { ok: false, detail: failureDetail(created, "Opening the pull request", "Check the GitHub connection and try again.") };
  }

  // `gh pr create` prints the URL. Ask for the number rather than parsing it
  // out, so a changed output format cannot silently produce PR #0.
  const viewed = await run("gh", ["pr", "view", input.branch, "--json", "number,url"], dir);
  if (!ok(viewed)) {
    return { ok: false, detail: failureDetail(viewed, "Reading the new pull request", "Try again.") };
  }
  try {
    const parsed = JSON.parse(out(viewed)) as { number?: number; url?: string };
    if (typeof parsed.number !== "number" || !parsed.url) {
      return { ok: false, detail: "GitHub did not say which pull request it opened." };
    }
    return { ok: true, number: parsed.number, url: parsed.url };
  } catch {
    return { ok: false, detail: "Could not read GitHub's answer about the new pull request." };
  }
}

/** Read a PR's current state. */
export async function readPullRequest(dir: string, number: number): Promise<PrSnapshot | { error: string }> {
  const viewed = await run(
    "gh",
    ["pr", "view", String(number), "--json", "state,mergeable,statusCheckRollup"],
    path.resolve(dir),
  );
  if (!ok(viewed)) {
    return { error: failureDetail(viewed, `Reading pull request #${number}`, "Try again.") };
  }
  try {
    const parsed = JSON.parse(out(viewed)) as { state?: string; mergeable?: string; statusCheckRollup?: unknown };
    return {
      // `mergeable` is a STRING enum here (MERGEABLE / CONFLICTING / UNKNOWN),
      // not the boolean it is easy to assume.
      state: (parsed.state ?? "UNKNOWN").toUpperCase(),
      mergeable: (parsed.mergeable ?? "UNKNOWN").toUpperCase(),
      checks: foldChecks(parsed.statusCheckRollup),
      noChecks: parsed.statusCheckRollup == null,
    };
  } catch {
    return { error: "Could not read GitHub's answer about the pull request." };
  }
}

/** Squash-merge and delete the branch. */
export async function mergePullRequest(dir: string, number: number): Promise<{ ok: true } | { ok: false; detail: string }> {
  const merged = await run("gh", ["pr", "merge", String(number), "--squash", "--delete-branch"], path.resolve(dir));
  if (!ok(merged)) {
    return { ok: false, detail: failureDetail(merged, `Merging pull request #${number}`, "Merge it yourself on GitHub.") };
  }
  return { ok: true };
}
