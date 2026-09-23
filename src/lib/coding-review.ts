/**
 * The review loop's side-effecting half: what it asks GitHub, and the one push
 * it makes on the run's behalf.
 *
 * Everything here is a `gh` or `git` call. The decisions live in
 * ./coding-review-state, which is pure and browser-safe; this module spawns
 * processes and must never be imported from a client component.
 *
 * WHY `gh` IS DRIVEN THE WAY IT IS — the same caveats ./coding-pr carries,
 * because it is the same 2022-era binary (2.4.0) on the box:
 *   - `gh pr view --json statusCheckRollup` answers `null`, not `[]`, when a
 *     pull request has no checks, and `mergeable` is the string enum
 *     MERGEABLE/CONFLICTING/UNKNOWN rather than a boolean.
 *   - `gh repo view` takes the repository POSITIONALLY; `--repo` is rejected.
 *   - there is no `gh pr view --json reviewThreads`. Unresolved threads are a
 *     GraphQL-only fact, which is why this module talks to `gh api graphql`.
 *   - `gh run view --log-failed` needs the WORKFLOW RUN id, which the rollup
 *     only carries inside `detailsUrl`.
 * Each of those is a way an implementation written from memory of a newer gh
 * fails silently.
 */

import path from "path";
import { runChild, type ChildResult, failureDetail } from "./child-run";
import {
  labelNames,
  parseCheckRollup,
  parseReviewThreads,
  type FailedCheckLog,
  type ReviewCheck,
  type ReviewSnapshot,
} from "./coding-review-state";

// One import for server callers, the way ./coding-pr re-exports its own pure
// half; the browser imports ./coding-review-state directly.
export * from "./coding-review-state";

/** How long a single gh/git call gets. */
const CALL_TIMEOUT_MS = 60_000;

/**
 * A workflow log is a different kind of call: `gh run view --log-failed`
 * downloads a zip from GitHub before printing anything, and a minute is not
 * always enough on a box on a home connection.
 */
const LOG_TIMEOUT_MS = 120_000;

/**
 * The most of one job's failed-step log that is ever held in memory.
 *
 * Passed INTO `runChild` as `maxStdoutChars` rather than sliced off what it
 * gives back: a failing matrix job prints megabytes, and a cap applied after
 * the child resolves bounds what is kept without ever bounding what was held —
 * on a Jetson with one long-lived web server on it. Only the TAIL is ever
 * quoted back to the run anyway, because the error is at the end of a log.
 */
const MAX_LOG_CHARS = 200_000;

/** How many failing checks' logs are fetched. Each is a zip download. */
const MAX_LOG_FETCHES = 5;

function run(bin: string, args: string[], cwd: string, timeoutMs = CALL_TIMEOUT_MS, maxStdoutChars?: number): Promise<ChildResult> {
  return runChild(bin, args, {
    cwd,
    timeoutMs,
    // Unset for every call but the log fetch: a JSON answer that arrived
    // truncated would be worse than one that cost memory.
    ...(maxStdoutChars === undefined ? {} : { maxStdoutChars }),
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
 * The GraphQL query for a pull request's review threads.
 *
 * `first: 100` on the threads and `first: 1` on each thread's comments: only
 * the opening comment of a thread is the finding, and asking for the whole
 * conversation on a busy pull request is how a GraphQL call starts costing
 * rate limit for text nothing reads.
 */
const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          isResolved
          isOutdated
          path
          line
          comments(first:1){ nodes{ body url author{ login } } }
        }
      }
    }
  }
}`;

/** `owner/name` for the repository this folder is in, or null. */
export async function readRepoSlug(dir: string): Promise<string | null> {
  // Positional, never `--repo`: see the header.
  const viewed = await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], path.resolve(dir));
  if (!ok(viewed)) return null;
  const slug = out(viewed);
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
}

/**
 * Everything one review round needs to know, in two calls.
 *
 * The threads are read best-effort: a repository whose token lacks the scope,
 * or a gh too old for `api graphql`, answers no threads rather than failing the
 * whole poll — the checks and the mergeability are still worth acting on, and
 * "could not read the threads" rendered as "the pull request is broken" would
 * strand every round.
 */
export async function readReviewSnapshot(dir: string, number: number): Promise<ReviewSnapshot | { error: string }> {
  const cwd = path.resolve(dir);
  const viewed = await run(
    "gh",
    // `labels` and `baseRefName` are in the 2.4.0 gh's field list; the hold
    // label and a retarget onto a protected base are read off every poll.
    ["pr", "view", String(number), "--json", "state,mergeable,reviewDecision,statusCheckRollup,labels,baseRefName"],
    cwd,
  );
  if (!ok(viewed)) {
    return { error: failureDetail(viewed, `Reading pull request #${number}`, "Try again.") };
  }
  let parsed: { state?: unknown; mergeable?: unknown; reviewDecision?: unknown; statusCheckRollup?: unknown; labels?: unknown; baseRefName?: unknown };
  try {
    parsed = JSON.parse(out(viewed)) as typeof parsed;
  } catch {
    return { error: "Could not read GitHub's answer about the pull request." };
  }

  return {
    state: String(parsed.state ?? "UNKNOWN").toUpperCase(),
    // A STRING enum here, not the boolean it is easy to assume.
    mergeable: String(parsed.mergeable ?? "UNKNOWN").toUpperCase(),
    // null is a real answer: a repository with no review requirement and no
    // review submitted has no decision, and reading that as "changes
    // requested" would put every such pull request into a round it does not
    // need.
    reviewDecision: typeof parsed.reviewDecision === "string" && parsed.reviewDecision
      ? parsed.reviewDecision.toUpperCase()
      : null,
    checks: parseCheckRollup(parsed.statusCheckRollup),
    noChecks: parsed.statusCheckRollup == null,
    threads: await readReviewThreads(cwd, number),
    labels: labelNames(parsed.labels),
    base: typeof parsed.baseRefName === "string" && parsed.baseRefName ? parsed.baseRefName : null,
  };
}

/** The unresolved review threads, or an empty list when they cannot be read. */
export async function readReviewThreads(dir: string, number: number) {
  const slug = await readRepoSlug(dir);
  if (!slug) return [];
  const [owner, repo] = slug.split("/");
  const answered = await run(
    "gh",
    [
      "api", "graphql",
      "-f", `query=${REVIEW_THREADS_QUERY}`,
      "-F", `owner=${owner}`,
      "-F", `repo=${repo}`,
      "-F", `number=${number}`,
    ],
    path.resolve(dir),
  );
  if (!ok(answered)) return [];
  try {
    return parseReviewThreads(JSON.parse(out(answered)));
  } catch {
    return [];
  }
}

/**
 * The workflow-run id inside a check's `detailsUrl`.
 *
 * `https://github.com/o/r/actions/runs/123/job/456` — the id `gh run view`
 * wants is the one after `/runs/`, not the job id at the end. A status context
 * from something that is not GitHub Actions (a third-party CI) has no such
 * URL, and answers null rather than a guess.
 */
export function workflowRunIdFrom(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const match = /\/actions\/runs\/(\d+)\b/.exec(url);
  return match ? match[1] : null;
}

/**
 * The tail of each failing check's log.
 *
 * Best-effort by construction: a check with no Actions URL, a `gh` too old for
 * `--log-failed`, an expired log — each answers `log: null`, and the feedback
 * message says so rather than pretending the check passed or dropping it.
 *
 * One fetch per distinct workflow RUN, not per check: a matrix of ten jobs in
 * one workflow shares a run id, and `--log-failed` already prints every failed
 * step in it.
 */
export async function readFailedCheckLogs(dir: string, checks: readonly ReviewCheck[]): Promise<FailedCheckLog[]> {
  const cwd = path.resolve(dir);
  const failed = checks.filter((c) => c.state === "fail");
  const byRun = new Map<string, string>();
  const logs: FailedCheckLog[] = [];
  for (const check of failed) {
    const runId = workflowRunIdFrom(check.url);
    if (!runId) {
      logs.push({ check, log: null });
      continue;
    }
    if (!byRun.has(runId)) {
      if (byRun.size >= MAX_LOG_FETCHES) {
        logs.push({ check, log: null });
        continue;
      }
      const viewed = await run("gh", ["run", "view", runId, "--log-failed"], cwd, LOG_TIMEOUT_MS, MAX_LOG_CHARS);
      // Even a failing `gh run view` sometimes prints the useful part before
      // it gives up, so stdout is taken when there is any. Already bounded by
      // the cap above, so nothing is sliced here.
      byRun.set(runId, viewed.stdout);
    }
    const log = byRun.get(runId) ?? "";
    logs.push({ check, log: log.trim() ? log : null });
  }
  return logs;
}

/**
 * An open pull request whose HEAD is this branch, whoever opened it.
 *
 * WHY THIS EXISTS. The loop used to watch only a pull request the box had
 * opened itself, because `pr.number` is written on the auto-PR path and nowhere
 * else. A run whose task says to open its own — which is most delegated work on
 * this device — pushed, ran `gh pr create` in its own turn, and settled with
 * `pr: null` and `review: null` on the record: no number to poll, so the whole
 * loop silently never engaged. Observed on a real run with the review pass and
 * auto-PR both switched on and zero rounds worked. Asking GitHub which pull
 * request is open on the branch is the answer that does not care who opened it.
 *
 * ONLY ever called with a branch the RUN owns (`clawbox/<runId>`, or its
 * worktree's). A run that worked straight on a shared branch would match
 * whatever pull request happens to be open from it — somebody else's — and
 * adopting that would have the box pushing rounds onto a stranger's work.
 *
 * Best-effort by construction, which is also what makes it safe on the old `gh`
 * this box carries: every failure answers null — no remote, no sign-in, a `gh`
 * too old for `--head` refusing the flag outright — and null reads as "there is
 * nothing to adopt", leaving the auto-PR path to open one exactly as it always
 * did. Nothing here can turn into a worse outcome than the behaviour it
 * replaces.
 */
export async function findOpenPullRequestForBranch(
  dir: string,
  branch: string,
): Promise<{ number: number; base: string | null; url: string | null } | null> {
  if (!branch.trim()) return null;
  const listed = await run(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number,baseRefName,url", "--limit", "10"],
    path.resolve(dir),
  );
  if (!ok(listed)) return null;
  let rows: unknown;
  try {
    rows = JSON.parse(out(listed) || "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const open = rows.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const row = raw as { number?: unknown; baseRefName?: unknown; url?: unknown };
    if (typeof row.number !== "number" || !Number.isInteger(row.number) || row.number <= 0) return [];
    return [{
      number: row.number,
      base: typeof row.baseRefName === "string" && row.baseRefName ? row.baseRefName : null,
      url: typeof row.url === "string" && row.url ? row.url : null,
    }];
  });
  if (!open.length) return null;
  // The LOWEST number when a branch somehow has more than one: the oldest is
  // the one the run opened, and picking deterministically is what keeps two
  // settles of the same chain from adopting two different pull requests.
  return open.reduce((lowest, row) => (row.number < lowest.number ? row : lowest));
}

/**
 * Push whatever the follow-up turn committed.
 *
 * The run is told to push itself, and usually does; this is the safety net for
 * a turn that committed and stopped without pushing, which would otherwise
 * leave the loop re-reading an unchanged pull request until the rounds ran out.
 * An up-to-date branch makes this a no-op, so it is cheap to always call.
 *
 * Deliberately NOT `--force`: a follow-up that rebased has already pushed with
 * `--force-with-lease` itself, and a force from out here — with no idea what is
 * on the remote — is how a concurrent push gets discarded.
 */
export async function pushBranch(dir: string, branch: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const pushed = await run("git", ["push", "origin", `HEAD:refs/heads/${branch}`], path.resolve(dir));
  if (ok(pushed)) return { ok: true };
  return { ok: false, detail: failureDetail(pushed, `Pushing ${branch}`, "Push it yourself and re-run the checks.") };
}
