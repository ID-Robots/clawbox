/**
 * The `gh` half of "CodeRabbit reviews a pull request once": opening the run's
 * pull request as a draft, readying it, asking CodeRabbit about a head it has
 * no status on, and reading the facts the loop decides those on.
 *
 * The decisions are pinned in coding-review-state.test.ts and coding-pr.test.ts.
 * What is pinned here is the argv and the parsing, which is where an
 * implementation written from memory of a newer gh fails silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildResult } from "@/lib/child-run";

const runChild = vi.hoisted(() => vi.fn<(bin: string, args: string[], opts?: unknown) => Promise<ChildResult>>());
vi.mock("@/lib/child-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/child-run")>()),
  runChild,
}));

const result = (code: number, stdout = "", stderr = ""): ChildResult =>
  ({ code, stdout, stderr, signal: null, timedOut: false } as unknown as ChildResult);

const HEAD = "ea30e3b47b8ea9d4e7c12e59c7d5c91690d81ab8";
const EARLIER = "3e9a760a869a7e3cd362d9381014f3afb3a7089a";

let pr: typeof import("@/lib/coding-pr");
let review: typeof import("@/lib/coding-review");

beforeEach(async () => {
  runChild.mockReset();
  vi.resetModules();
  pr = await import("@/lib/coding-pr");
  review = await import("@/lib/coding-review");
});

describe("openPullRequest", () => {
  const input = { directory: "/tmp/p", branch: "clawbox/run-x", base: "beta", title: "t", body: "b" };
  const viewed = result(0, JSON.stringify({ number: 12, url: "https://github.com/o/r/pull/12" }));

  it("opens the run's pull request as a draft", async () => {
    runChild
      .mockResolvedValueOnce(result(0, "https://github.com/o/r.git"))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0, "https://github.com/o/r/pull/12"))
      .mockResolvedValueOnce(viewed);
    expect(await pr.openPullRequest({ ...input, draft: true })).toEqual({ ok: true, number: 12, url: "https://github.com/o/r/pull/12" });
    const [, args] = runChild.mock.calls[2];
    expect(args.slice(0, 2)).toEqual(["pr", "create"]);
    expect(args).toContain("--draft");
  });

  it("opens a ready one where GitHub refuses drafts, rather than none", async () => {
    // A private repository on a free plan has no drafts.
    runChild
      .mockResolvedValueOnce(result(0, "https://github.com/o/r.git"))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1, "", "pull request create failed: GraphQL: Draft pull requests are not supported in this repository. (createPullRequest)"))
      .mockResolvedValueOnce(result(0, "https://github.com/o/r/pull/12"))
      .mockResolvedValueOnce(viewed);
    expect(await pr.openPullRequest({ ...input, draft: true })).toMatchObject({ ok: true, number: 12 });
    expect(runChild.mock.calls[2][1]).toContain("--draft");
    expect(runChild.mock.calls[3][1].slice(0, 2)).toEqual(["pr", "create"]);
    expect(runChild.mock.calls[3][1]).not.toContain("--draft");
  });

  it("does not retry a refusal that has nothing to do with drafts", async () => {
    runChild
      .mockResolvedValueOnce(result(0, "https://github.com/o/r.git"))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1, "", "a pull request for branch \"clawbox/run-x\" into branch \"beta\" already exists"));
    expect((await pr.openPullRequest({ ...input, draft: true })).ok).toBe(false);
    expect(runChild).toHaveBeenCalledTimes(3);
  });

  it("opens a ready pull request when nobody asked for a draft", async () => {
    runChild
      .mockResolvedValueOnce(result(0, "https://github.com/o/r.git"))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0, "https://github.com/o/r/pull/12"))
      .mockResolvedValueOnce(viewed);
    expect(await pr.openPullRequest(input)).toMatchObject({ ok: true, number: 12 });
    expect(runChild.mock.calls[2][1]).not.toContain("--draft");
  });
});

describe("readying and asking", () => {
  it("readies a draft with `gh pr ready <n>`", async () => {
    runChild.mockResolvedValueOnce(result(0));
    expect(await pr.markPullRequestReady("/tmp/p", 12)).toEqual({ ok: true });
    expect(runChild.mock.calls[0].slice(0, 2)).toEqual(["gh", ["pr", "ready", "12"]]);
  });

  it("says what gh said when it cannot ready one", async () => {
    runChild.mockResolvedValueOnce(result(1, "", "HTTP 403: Resource not accessible by integration"));
    const answer = await pr.markPullRequestReady("/tmp/p", 12);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.detail).toContain("403");
  });

  it("asks CodeRabbit with one `@coderabbitai review` comment", async () => {
    runChild.mockResolvedValueOnce(result(0));
    expect(await review.requestCodeRabbitReview("/tmp/p", 12)).toEqual({ ok: true });
    expect(runChild.mock.calls[0].slice(0, 2)).toEqual(["gh", ["pr", "comment", "12", "--body", "@coderabbitai review"]]);
  });
});

describe("what the watchers read", () => {
  it("reads the draft flag for the checks-only watcher", async () => {
    runChild.mockResolvedValueOnce(result(0, JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: null, isDraft: true })));
    expect(await pr.readPullRequest("/tmp/p", 12)).toMatchObject({ isDraft: true, noChecks: true });
    // `labels` beside it, for the hold label (see isHoldLabel).
    expect(runChild.mock.calls[0][1]).toContain("state,mergeable,statusCheckRollup,isDraft,labels");
  });

  it("reads the draft flag, the head and CodeRabbit's footprint for the review loop", async () => {
    runChild
      .mockResolvedValueOnce(result(0, JSON.stringify({
        state: "OPEN",
        mergeable: "MERGEABLE",
        reviewDecision: "CHANGES_REQUESTED",
        isDraft: false,
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS" },
        ],
      })))
      .mockResolvedValueOnce(result(0, "o/r"))
      .mockResolvedValueOnce(result(0, JSON.stringify({
        data: { repository: { pullRequest: {
          headRefOid: HEAD,
          reviewThreads: { nodes: [{
            isResolved: false,
            isOutdated: false,
            path: "a.ts",
            line: 1,
            comments: { nodes: [{ body: "This drops the error.", url: null, author: { login: "coderabbitai" } }] },
            replies: { nodes: [{ author: { login: "coderabbitai" } }, { author: { login: "clawbox-bot" } }] },
          }] },
          reviews: { nodes: [{ state: "CHANGES_REQUESTED", author: { login: "coderabbitai" }, commit: { oid: EARLIER } }] },
          comments: { nodes: [{ author: { login: "coderabbitai" } }] },
        } } },
      })));
    const snapshot = await review.readReviewSnapshot("/tmp/p", 12);
    expect(snapshot).toMatchObject({
      isDraft: false,
      headSha: HEAD,
      codeRabbit: { present: true, reviewedEarlier: true },
      changesRequestedBy: [{ author: "coderabbitai", commit: EARLIER }],
      // The one thread was CodeRabbit's, and it was answered.
      threads: [],
    });
    // `labels` and `baseRefName` beside it, for the hold label and a retarget.
    expect(runChild.mock.calls[0][1]).toContain("state,mergeable,reviewDecision,statusCheckRollup,isDraft,labels,baseRefName");
    // Answered with everything GitHub-side in order: nothing is left to feed back.
    if ("error" in snapshot) throw new Error(snapshot.error);
    expect(review.reviewProblems(snapshot)).toEqual({ failedChecks: [], threads: [], conflicting: false, changesRequested: false });
  });

  it("knows nothing of CodeRabbit when the GraphQL cannot be read, and says so as null", async () => {
    runChild
      .mockResolvedValueOnce(result(0, JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", reviewDecision: null, statusCheckRollup: null, isDraft: true })))
      .mockResolvedValueOnce(result(0, "o/r"))
      .mockResolvedValueOnce(result(1, "", "HTTP 502"));
    expect(await review.readReviewSnapshot("/tmp/p", 12)).toMatchObject({
      isDraft: true, headSha: null, codeRabbit: null, changesRequestedBy: null, threads: [],
    });
  });
});
