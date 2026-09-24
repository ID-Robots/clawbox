/**
 * The auto-PR flow: a finished run's work becomes a branch, a pull request, a
 * wait on GitHub Actions, and — only when the checks actually say so — a merge.
 *
 * WHY THIS LIVES ON THE SERVER, not in the run's brief.
 *
 * The obvious design is to tell the agent to do it. That fails three ways on
 * this box, all measured: a run polling CI spends one of its 400 turns per
 * poll; it holds one of the box's few run slots (coding_agent_max_parallel_runs)
 * for as long as CI
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

import path from "./runtime-path";
import { runChild, type ChildResult, failureDetail } from "./child-run";
import {
  emptyChecks,
  foldChecks,
  runBranchName,
  type AutoMergeFacts,
  type PrChecks,
  type PrSnapshot,
} from "./coding-pr-state";
import { labelNames } from "./coding-review-state";

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
}): Promise<{ ok: true; branch: string; base: string } | { ok: false; detail: string; reason?: "no_repository" }> {
  const dir = path.resolve(input.directory);
  const branch = runBranchName(input.runId);

  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], dir);
  if (!ok(inside)) {
    // A killed or missing git is a failure; a folder git says is not a
    // work tree is a fact the caller can act on — the runner commits into
    // a fresh repository at settle and says so, rather than reporting a
    // failed pull request.
    const notARepo = inside.code === 128 && !inside.timedOut && !inside.signal && /not a git repository/i.test(inside.stderr);
    return {
      ok: false,
      ...(notARepo ? { reason: "no_repository" as const } : {}),
      detail: notARepo ? "Not a git repository yet." : failureDetail(inside, "Reading the git repository", "Make the folder a git repository first."),
    };
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
  /**
   * Open it as a draft. The run's own pull requests are, so the watcher can
   * ready them once the checks pass: that is when a reviewer that reviews
   * once (CodeRabbit) gives its review. The owner's "Create PR" button opens
   * a ready one, because nothing watches that pull request to ready it.
   */
  draft?: boolean;
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

  const args = ["pr", "create", "--base", input.base, "--head", input.branch, "--title", input.title, "--body", input.body];
  let created = await run("gh", input.draft ? [...args, "--draft"] : args, dir);
  // Drafts need a plan that has them: a private repository on a free account
  // answers "Draft pull requests are not supported in this repository". Such a
  // repository gets a ready pull request, as it always did, rather than none.
  if (!ok(created) && input.draft && /draft/i.test(`${created.stderr}\n${created.stdout}`)) {
    created = await run("gh", args, dir);
  }
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

/**
 * Rewrite an open pull request's body.
 *
 * Used to keep the review pass's evidence current across review rounds: a round
 * that fixed what a screenshot showed has new screenshots, and a body frozen at
 * the moment the pull request opened would go on describing the defect.
 *
 * Reads the body back first and hands the CALLER the rewrite, so the one thing
 * this cannot do is flatten a word a person wrote — `withEvidenceSection`
 * replaces only its own marked block. A pull request whose body cannot be read
 * is left exactly as it is.
 */
export async function updatePullRequestBody(input: {
  directory: string;
  number: number;
  rewrite: (body: string) => string;
}): Promise<{ ok: true; changed: boolean } | { ok: false; detail: string }> {
  const dir = path.resolve(input.directory);
  const viewed = await run("gh", ["pr", "view", String(input.number), "--json", "body"], dir);
  if (!ok(viewed)) return { ok: false, detail: failureDetail(viewed, "Reading the pull request body", "Try again.") };
  let body: string;
  try {
    const parsed = JSON.parse(out(viewed)) as { body?: unknown };
    body = typeof parsed.body === "string" ? parsed.body : "";
  } catch {
    return { ok: false, detail: "Could not read GitHub's answer about the pull request body." };
  }
  const next = input.rewrite(body);
  if (next === body) return { ok: true, changed: false };
  const edited = await run("gh", ["pr", "edit", String(input.number), "--body", next], dir);
  if (!ok(edited)) return { ok: false, detail: failureDetail(edited, "Updating the pull request body", "Try again.") };
  return { ok: true, changed: true };
}

/**
 * The project page's "Create PR": a pull request for whatever branch the
 * project is on, against the remote's default branch.
 *
 * A run's PR is opened by the runner with the run's own title and body;
 * this is the owner's hand on the same lever, for a branch a run left behind
 * without one (the auto-PR switch off, a network fault at the time, a branch
 * the owner made in the terminal). The title is the newest commit's subject
 * and the body lists the commits the branch adds — what `gh pr create --fill`
 * would write, spelled out because gh 2.4.0's --fill takes the FIRST commit.
 *
 * Refusals are answers, each with its own reason: `no_remote` (nothing to
 * open it on — a backup comes first), `on_base` (the project is on the
 * default branch, so there is nothing to compare), and `failed` for the
 * rest, with gh's own words. A PR that is already open for the branch is
 * returned as it is (`existing`), never opened twice.
 */
export type ProjectPrOutcome =
  | { ok: true; number: number; url: string; branch: string; base: string; existing: boolean }
  | { ok: false; reason: "no_remote" | "on_base" | "failed"; detail: string; transient?: boolean };

export async function openProjectPullRequest(directory: string): Promise<ProjectPrOutcome> {
  const dir = path.resolve(directory);

  const remote = await run("git", ["remote", "get-url", "origin"], dir);
  if (!ok(remote)) {
    return { ok: false, reason: "no_remote", detail: "This project is not on GitHub yet. Back it up first, then a pull request has somewhere to go." };
  }
  const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (!ok(head) || !out(head) || out(head) === "HEAD") {
    return { ok: false, reason: "failed", detail: failureDetail(head, "Reading the current branch", "Check out a branch first."), transient: head.code === null };
  }
  const branch = out(head);
  const base = await resolveBaseBranch(dir);
  if (branch === base) {
    return { ok: false, reason: "on_base", detail: `The project is on its default branch (${base}), so there is nothing to compare. A pull request is opened from a run's branch.` };
  }

  // One already open for this branch: hand it back rather than opening a twin.
  const existing = await run("gh", ["pr", "view", branch, "--json", "number,url,state"], dir);
  if (ok(existing)) {
    try {
      const parsed = JSON.parse(out(existing)) as { number?: number; url?: string; state?: string };
      if (typeof parsed.number === "number" && parsed.url && parsed.state === "OPEN") {
        return { ok: true, number: parsed.number, url: parsed.url, branch, base, existing: true };
      }
    } catch { /* not JSON: treat as none open */ }
  }

  const subject = await run("git", ["log", "-1", "--format=%s"], dir);
  const title = ok(subject) && out(subject) ? out(subject).slice(0, 200) : branch;
  const commits = await run("git", ["log", `${base}..${branch}`, "--format=- %s"], dir);
  const list = ok(commits) && out(commits) ? out(commits).split("\n").slice(0, 40).join("\n") : "";
  const body = [`Opened from ClawBox for \`${branch}\`.`, ...(list ? ["", "Commits:", list] : [])].join("\n");

  const opened = await openPullRequest({ directory: dir, branch, base, title, body });
  if (!opened.ok) return { ok: false, reason: "failed", detail: opened.detail };
  return { ok: true, number: opened.number, url: opened.url, branch, base, existing: false };
}

/** Read a PR's current state. */
export async function readPullRequest(dir: string, number: number): Promise<PrSnapshot | { error: string }> {
  const viewed = await run(
    "gh",
    ["pr", "view", String(number), "--json", "state,mergeable,statusCheckRollup,isDraft,labels"],
    path.resolve(dir),
  );
  if (!ok(viewed)) {
    return { error: failureDetail(viewed, `Reading pull request #${number}`, "Try again.") };
  }
  try {
    const parsed = JSON.parse(out(viewed)) as { state?: string; mergeable?: string; statusCheckRollup?: unknown; isDraft?: unknown; labels?: unknown };
    return {
      // `mergeable` is a STRING enum here (MERGEABLE / CONFLICTING / UNKNOWN),
      // not the boolean it is easy to assume.
      state: (parsed.state ?? "UNKNOWN").toUpperCase(),
      mergeable: (parsed.mergeable ?? "UNKNOWN").toUpperCase(),
      checks: foldChecks(parsed.statusCheckRollup),
      noChecks: parsed.statusCheckRollup == null,
      isDraft: parsed.isDraft === true,
      labels: labelNames(parsed.labels),
    };
  } catch {
    return { error: "Could not read GitHub's answer about the pull request." };
  }
}

/** Mark a draft ready for review (`gh pr ready`). */
export async function markPullRequestReady(dir: string, number: number): Promise<{ ok: true } | { ok: false; detail: string }> {
  const readied = await run("gh", ["pr", "ready", String(number)], path.resolve(dir));
  if (!ok(readied)) {
    return { ok: false, detail: failureDetail(readied, `Marking pull request #${number} ready for review`, "Mark it ready yourself on GitHub.") };
  }
  return { ok: true };
}

/**
 * The merge method, and the one fallback.
 *
 * A MERGE COMMIT, not a squash: `beta` on ClawBox's own repository keeps every
 * pull request's commits under a merge commit, and a branch history is the
 * one thing a merge cannot give back. A repository that allows only squash
 * (or refuses merge commits) answers with a refusal naming the method, and is
 * then squash-merged as it always was rather than left unmerged.
 */
function mergeMethodRefused(r: ChildResult): boolean {
  return /(merge commit|merge method)[^\n]*not allowed|not allowed[^\n]*merge commit/i.test(`${r.stderr}\n${r.stdout}`);
}

/** Merge (a merge commit — see mergeMethodRefused) and delete the branch. */
export async function mergePullRequest(dir: string, number: number): Promise<{ ok: true } | { ok: false; detail: string }> {
  const cwd = path.resolve(dir);
  let merged = await run("gh", ["pr", "merge", String(number), "--merge", "--delete-branch"], cwd);
  if (!ok(merged) && mergeMethodRefused(merged)) {
    merged = await run("gh", ["pr", "merge", String(number), "--squash", "--delete-branch"], cwd);
  }
  if (!ok(merged)) {
    return { ok: false, detail: failureDetail(merged, `Merging pull request #${number}`, "Merge it yourself on GitHub.") };
  }
  return { ok: true };
}

/**
 * The jq that trims REST's pull request (tens of kilobytes: the body, every
 * user object) to the six facts decideAutoMerge reads.
 */
const AUTO_MERGE_FACTS_JQ =
  "{state, merged, draft, base: .base.ref, labels: [.labels[]?.name], mergeable_state, auto_merge: (.auto_merge != null)}";

/**
 * What GitHub says about this pull request's merge — see AutoMergeFacts.
 *
 * REST through `gh api`, whose fields do not depend on the gh version: the
 * 2.4.0 gh on the box has no `autoMergeRequest` for `gh pr view --json`, and
 * `mergeable_state` is the one field that says whether GitHub itself is
 * holding the merge for a requirement. `{owner}/{repo}` is filled in by gh
 * from the folder's remote, as `gh pr view` does.
 */
export async function readAutoMergeFacts(dir: string, number: number): Promise<AutoMergeFacts | { error: string }> {
  const viewed = await run("gh", ["api", `repos/{owner}/{repo}/pulls/${number}`, "--jq", AUTO_MERGE_FACTS_JQ], path.resolve(dir));
  if (!ok(viewed)) return { error: failureDetail(viewed, `Reading pull request #${number}`, "Try again.") };
  try {
    const parsed = JSON.parse(out(viewed)) as {
      state?: unknown; merged?: unknown; draft?: unknown; base?: unknown; labels?: unknown; mergeable_state?: unknown; auto_merge?: unknown;
    };
    const state = parsed.merged === true ? "MERGED" : typeof parsed.state === "string" ? parsed.state.toUpperCase() : "UNKNOWN";
    return {
      state,
      draft: parsed.draft === true,
      base: typeof parsed.base === "string" && parsed.base ? parsed.base : null,
      labels: labelNames(parsed.labels),
      mergeState: typeof parsed.mergeable_state === "string" && parsed.mergeable_state ? parsed.mergeable_state.toUpperCase() : "UNKNOWN",
      enabled: parsed.auto_merge === true,
    };
  } catch {
    return { error: "Could not read GitHub's answer about the pull request." };
  }
}

/**
 * Turn GitHub's auto-merge on: `gh pr merge <n> --auto --merge`, so GitHub
 * merges the pull request the moment its required checks pass, and deletes the
 * branch where the repository is set to. Only ever called for a pull request
 * GitHub is holding for a requirement (see GATED_MERGE_STATES in
 * ./coding-pr-state) — a newer gh merges a CLEAN one on the spot instead.
 * No `--delete-branch`: with `--auto` gh skips it, and the repository's own
 * "delete head branches" setting is what removes the branch.
 */
export async function enableAutoMerge(dir: string, number: number): Promise<{ ok: true } | { ok: false; detail: string }> {
  const cwd = path.resolve(dir);
  let armed = await run("gh", ["pr", "merge", String(number), "--auto", "--merge"], cwd);
  if (!ok(armed) && mergeMethodRefused(armed)) {
    armed = await run("gh", ["pr", "merge", String(number), "--auto", "--squash"], cwd);
  }
  if (!ok(armed)) {
    return { ok: false, detail: failureDetail(armed, `Turning on auto-merge for pull request #${number}`, "Turn it on yourself on GitHub.") };
  }
  return { ok: true };
}

/** Turn GitHub's auto-merge off: `gh pr merge <n> --disable-auto`. */
export async function disableAutoMerge(dir: string, number: number): Promise<{ ok: true } | { ok: false; detail: string }> {
  const disarmed = await run("gh", ["pr", "merge", String(number), "--disable-auto"], path.resolve(dir));
  if (!ok(disarmed)) {
    return { ok: false, detail: failureDetail(disarmed, `Turning off auto-merge for pull request #${number}`, "Turn it off yourself on GitHub.") };
  }
  return { ok: true };
}
