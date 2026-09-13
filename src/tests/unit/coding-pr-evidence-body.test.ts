/**
 * Keeping a pull request's "What the review pass saw" block current
 * (`updatePullRequestBody` in src/lib/coding-pr.ts).
 *
 * The property that matters: a review round that looked again must be able to
 * replace what it said WITHOUT flattening a word a person wrote around it, and
 * a body it could not read must be left exactly as it is rather than
 * overwritten with a guess.
 */
import { beforeEach, expect, it, vi } from "vitest";
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

it("reads the body, rewrites it and edits the pull request", async () => {
  runChild
    .mockResolvedValueOnce(result(0, JSON.stringify({ body: "Opened by the ClawBox coding agent." })))
    .mockResolvedValueOnce(result(0));
  const answer = await lib.updatePullRequestBody({
    directory: "/tmp/project",
    number: 12,
    rewrite: (body) => `${body}\n\nWhat the review pass saw.`,
  });
  expect(answer).toEqual({ ok: true, changed: true });
  const [bin, args] = runChild.mock.calls[1];
  expect(bin).toBe("gh");
  expect(args.slice(0, 3)).toEqual(["pr", "edit", "12"]);
  expect(args[args.length - 1]).toContain("What the review pass saw.");
});

it("edits nothing when the rewrite changes nothing", async () => {
  runChild.mockResolvedValueOnce(result(0, JSON.stringify({ body: "unchanged" })));
  expect(await lib.updatePullRequestBody({ directory: "/tmp/p", number: 3, rewrite: (b) => b }))
    .toEqual({ ok: true, changed: false });
  expect(runChild).toHaveBeenCalledTimes(1);
});

it("leaves the pull request alone when its body cannot be read", async () => {
  runChild.mockResolvedValueOnce(result(1, "", "could not resolve to a PullRequest"));
  const answer = await lib.updatePullRequestBody({ directory: "/tmp/p", number: 9, rewrite: () => "new body" });
  expect(answer.ok).toBe(false);
  expect(runChild).toHaveBeenCalledTimes(1);
});

it("treats an unreadable answer as a refusal rather than an empty body", async () => {
  runChild.mockResolvedValueOnce(result(0, "not json"));
  const answer = await lib.updatePullRequestBody({ directory: "/tmp/p", number: 9, rewrite: () => "new body" });
  expect(answer.ok).toBe(false);
  expect(runChild).toHaveBeenCalledTimes(1);
});

it("reports the edit's own failure instead of claiming the body changed", async () => {
  runChild
    .mockResolvedValueOnce(result(0, JSON.stringify({ body: "before" })))
    .mockResolvedValueOnce(result(1, "", "HTTP 403"));
  const answer = await lib.updatePullRequestBody({ directory: "/tmp/p", number: 9, rewrite: () => "after" });
  expect(answer.ok).toBe(false);
});
