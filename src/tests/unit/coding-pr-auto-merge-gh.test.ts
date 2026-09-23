/**
 * The `gh` calls behind GitHub's auto-merge and the box's own merge
 * (src/lib/coding-pr.ts), argv by argv.
 *
 * Pinned because every one of them is a way an implementation written from
 * memory of a newer gh fails on the box's 2.4.0: `autoMergeRequest` is not a
 * `gh pr view --json` field there (so the facts are read over REST), and a
 * merge method the repository refuses must not leave a green pull request
 * unmerged.
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

type Lib = typeof import("@/lib/coding-pr");
let lib: Lib;

beforeEach(async () => {
  runChild.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-pr");
});

describe("the box's own merge", () => {
  it("is a merge commit that deletes the branch", async () => {
    runChild.mockResolvedValueOnce(result(0));
    expect(await lib.mergePullRequest("/tmp/p", 12)).toEqual({ ok: true });
    expect(runChild.mock.calls[0][0]).toBe("gh");
    expect(runChild.mock.calls[0][1]).toEqual(["pr", "merge", "12", "--merge", "--delete-branch"]);
  });

  it("falls back to a squash when the repository refuses merge commits", async () => {
    runChild
      .mockResolvedValueOnce(result(1, "", "GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)"))
      .mockResolvedValueOnce(result(0));
    expect(await lib.mergePullRequest("/tmp/p", 12)).toEqual({ ok: true });
    expect(runChild.mock.calls[1][1]).toEqual(["pr", "merge", "12", "--squash", "--delete-branch"]);
  });

  it("does not retry another method over a refusal that is about something else", async () => {
    runChild.mockResolvedValueOnce(result(1, "", "GraphQL: Pull request is not mergeable (mergePullRequest)"));
    const answer = await lib.mergePullRequest("/tmp/p", 12);
    expect(answer.ok).toBe(false);
    expect(runChild).toHaveBeenCalledTimes(1);
  });
});

describe("turning GitHub's auto-merge on and off", () => {
  it("is `gh pr merge <n> --auto --merge`, and nothing that deletes a branch now", async () => {
    runChild.mockResolvedValueOnce(result(0));
    expect(await lib.enableAutoMerge("/tmp/p", 7)).toEqual({ ok: true });
    expect(runChild.mock.calls[0][1]).toEqual(["pr", "merge", "7", "--auto", "--merge"]);
  });

  it("asks for a squash instead where merge commits are refused", async () => {
    runChild
      .mockResolvedValueOnce(result(1, "", "Merge method merge commits are not allowed for this repository"))
      .mockResolvedValueOnce(result(0));
    expect(await lib.enableAutoMerge("/tmp/p", 7)).toEqual({ ok: true });
    expect(runChild.mock.calls[1][1]).toEqual(["pr", "merge", "7", "--auto", "--squash"]);
  });

  it("reports GitHub's own words when it refuses", async () => {
    runChild.mockResolvedValueOnce(result(1, "", "GraphQL: Pull request Auto merge is not allowed for this repository (enablePullRequestAutoMerge)"));
    const answer = await lib.enableAutoMerge("/tmp/p", 7);
    expect(answer.ok).toBe(false);
    expect((answer as { detail: string }).detail).toContain("Auto merge is not allowed");
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it("is `--disable-auto` to turn it off", async () => {
    runChild.mockResolvedValueOnce(result(0));
    expect(await lib.disableAutoMerge("/tmp/p", 7)).toEqual({ ok: true });
    expect(runChild.mock.calls[0][1]).toEqual(["pr", "merge", "7", "--disable-auto"]);
  });
});

describe("what GitHub says about the merge", () => {
  it("is read over REST, trimmed by jq, and folded into the facts", async () => {
    runChild.mockResolvedValueOnce(result(0, JSON.stringify({
      state: "open", merged: false, draft: false, base: "beta",
      labels: ["area: ui", "hold-for-4.1"], mergeable_state: "blocked", auto_merge: true,
    })));
    expect(await lib.readAutoMergeFacts("/tmp/p", 996)).toEqual({
      state: "OPEN", draft: false, base: "beta", labels: ["area: ui", "hold-for-4.1"], mergeState: "BLOCKED", enabled: true,
    });
    const [bin, args] = runChild.mock.calls[0];
    expect(bin).toBe("gh");
    expect(args.slice(0, 2)).toEqual(["api", "repos/{owner}/{repo}/pulls/996"]);
    expect(args[2]).toBe("--jq");
  });

  it("calls a merged pull request MERGED, and an unanswered state UNKNOWN", async () => {
    runChild.mockResolvedValueOnce(result(0, JSON.stringify({ state: "closed", merged: true, mergeable_state: null, auto_merge: false })));
    expect(await lib.readAutoMergeFacts("/tmp/p", 1)).toMatchObject({ state: "MERGED", mergeState: "UNKNOWN", enabled: false, base: null, labels: [] });
  });

  it("answers an error, never a guess, when gh fails or says something unreadable", async () => {
    runChild.mockResolvedValueOnce(result(1, "", "HTTP 404"));
    expect("error" in (await lib.readAutoMergeFacts("/tmp/p", 1))).toBe(true);
    runChild.mockResolvedValueOnce(result(0, "not json"));
    expect("error" in (await lib.readAutoMergeFacts("/tmp/p", 1))).toBe(true);
  });

  it("asks the checks read for the labels too, a field the box's gh has", async () => {
    runChild.mockResolvedValueOnce(result(0, JSON.stringify({
      state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: null, labels: [{ name: "hold" }],
    })));
    const snapshot = await lib.readPullRequest("/tmp/p", 3);
    expect(snapshot).toMatchObject({ labels: ["hold"] });
    expect(runChild.mock.calls[0][1]).toEqual(["pr", "view", "3", "--json", "state,mergeable,statusCheckRollup,isDraft,labels"]);
  });
});
