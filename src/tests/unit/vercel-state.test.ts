/**
 * The Vercel integration's pure half.
 *
 * The properties that matter, each of them a way this feature could lie to an
 * owner:
 *  - a state this box has never heard of is NOT "ready" (a preview URL on the
 *    card for a build that never finished);
 *  - the match prefers the COMMIT, because a branch can have several builds;
 *  - a URL the box puts in an `href` is an http(s) address and nothing else;
 *  - "no deployment yet" is waited through and then ABANDONED with a reason,
 *    never quietly forgotten and never called a failure;
 *  - the ceiling is reached before the pending branch, or a build that never
 *    completes is waited on for ever.
 */
import { describe, expect, it } from "vitest";
import {
  buildDeployFeedback,
  decideDeployment,
  deploymentUrl,
  foldReadyState,
  isVercelPending,
  isVercelPhase,
  matchDeployment,
  parseDeployment,
  VERCEL_MAX_WAIT_MS,
  VERCEL_NO_DEPLOYMENT_GRACE_MS,
  type VercelDeployment,
} from "@/lib/vercel-state";

function deployment(over: Partial<VercelDeployment> = {}): VercelDeployment {
  return {
    id: "dpl_1",
    readyState: "building",
    url: "https://app-abc.vercel.app",
    inspectorUrl: null,
    target: "preview",
    branch: "clawbox/run-1",
    sha: "abcdef1234567890",
    createdAt: 1,
    errorMessage: null,
    ...over,
  };
}

describe("foldReadyState", () => {
  it("reads the endings Vercel actually sends", () => {
    expect(foldReadyState("READY")).toBe("ready");
    expect(foldReadyState("ERROR")).toBe("error");
    expect(foldReadyState("CANCELED")).toBe("canceled");
    // Vercel has used both spellings of cancelled over the years.
    expect(foldReadyState("CANCELLED")).toBe("canceled");
    expect(foldReadyState("QUEUED")).toBe("queued");
    expect(foldReadyState("BUILDING")).toBe("building");
    expect(foldReadyState("INITIALIZING")).toBe("building");
  });

  it("is case- and space-insensitive, the way an API answer is not guaranteed to be", () => {
    expect(foldReadyState(" ready ")).toBe("ready");
    expect(foldReadyState("Error")).toBe("error");
  });

  it("reads a state it has NEVER HEARD OF as still building, never as ready", () => {
    for (const unknown of ["PROMOTING", "SKIPPED", "", null, undefined, 7, {}]) {
      expect(foldReadyState(unknown), String(unknown)).toBe("building");
    }
  });
});

describe("deploymentUrl", () => {
  it("puts a scheme on the bare host Vercel answers with", () => {
    expect(deploymentUrl("app-abc123.vercel.app")).toBe("https://app-abc123.vercel.app");
  });

  it("keeps an absolute http(s) address", () => {
    expect(deploymentUrl("https://vercel.com/acme/app/dpl_1")).toBe("https://vercel.com/acme/app/dpl_1");
  });

  it("refuses anything that is not an address this box may put in a link", () => {
    // Each of these would have been concatenated into an `href` the owner
    // clicks, which is the whole reason this function exists.
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>",
      "evil.example/path",
      "user@evil.example",
      "//evil.example",
      "",
      "   ",
      null,
      42,
    ]) {
      expect(deploymentUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe("parseDeployment", () => {
  it("reads the /v6 list shape — `uid` and `state`", () => {
    const parsed = parseDeployment({
      uid: "dpl_list",
      state: "READY",
      url: "app-xyz.vercel.app",
      target: "preview",
      created: 1_700_000_000_000,
      meta: { githubCommitRef: "clawbox/run-9", githubCommitSha: "DEADBEEF" },
    });
    expect(parsed).toMatchObject({
      id: "dpl_list",
      readyState: "ready",
      url: "https://app-xyz.vercel.app",
      branch: "clawbox/run-9",
      sha: "DEADBEEF",
      createdAt: 1_700_000_000_000,
    });
  });

  it("reads the /v13 detail shape — `id` and `readyState`", () => {
    const parsed = parseDeployment({
      id: "dpl_detail",
      readyState: "ERROR",
      url: "app-xyz.vercel.app",
      inspectorUrl: "https://vercel.com/acme/app/dpl_detail",
      errorMessage: "Command \"npm run build\" exited with 1",
      meta: {},
    });
    expect(parsed).toMatchObject({
      id: "dpl_detail",
      readyState: "error",
      inspectorUrl: "https://vercel.com/acme/app/dpl_detail",
      errorMessage: 'Command "npm run build" exited with 1',
      branch: null,
      sha: null,
    });
  });

  it("answers null for anything with no id — there is nothing to ask Vercel about", () => {
    expect(parseDeployment(null)).toBeNull();
    expect(parseDeployment({})).toBeNull();
    expect(parseDeployment({ uid: "" })).toBeNull();
    expect(parseDeployment("dpl_1")).toBeNull();
  });
});

describe("matchDeployment", () => {
  const wanted = deployment({ id: "dpl_wanted", sha: "abc123def456" });
  const sameBranchOlder = deployment({ id: "dpl_older", sha: "999999999999" });

  it("prefers the COMMIT over the branch — a branch can have several builds", () => {
    // The older build is FIRST in the list, so a branch-only match picks it.
    const found = matchDeployment([sameBranchOlder, wanted], { sha: "abc123def456", branch: "clawbox/run-1" });
    expect(found?.id).toBe("dpl_wanted");
  });

  it("matches a short sha against a long one, in both directions", () => {
    expect(matchDeployment([wanted], { sha: "abc123d", branch: null })?.id).toBe("dpl_wanted");
    expect(matchDeployment([deployment({ sha: "abc123d" })], { sha: "abc123def456", branch: null })?.id).toBe("dpl_1");
  });

  it("falls back to the branch when the run committed nothing to match on", () => {
    expect(matchDeployment([sameBranchOlder], { sha: null, branch: "clawbox/run-1" })?.id).toBe("dpl_older");
  });

  it("does not match a deployment whose sha is blank against a run that has one", () => {
    const blank = deployment({ id: "dpl_blank", sha: null, branch: "other" });
    expect(matchDeployment([blank], { sha: "abc123", branch: "clawbox/run-1" })).toBeNull();
  });

  it("answers null when nothing on Vercel is this push", () => {
    expect(matchDeployment([], { sha: "abc", branch: "clawbox/run-1" })).toBeNull();
    expect(matchDeployment([deployment({ sha: "zzz", branch: "main" })], { sha: "abc", branch: "clawbox/run-1" })).toBeNull();
  });
});

describe("decideDeployment", () => {
  it("waits while no deployment has appeared yet, inside the grace period", () => {
    expect(decideDeployment({ deployment: null, waitedMs: 1_000 })).toEqual({ action: "wait" });
    expect(decideDeployment({ deployment: null, waitedMs: VERCEL_NO_DEPLOYMENT_GRACE_MS - 1 })).toEqual({ action: "wait" });
  });

  it("ABANDONS a push no deployment ever appeared for, and says why", () => {
    const verdict = decideDeployment({ deployment: null, waitedMs: VERCEL_NO_DEPLOYMENT_GRACE_MS });
    expect(verdict.action).toBe("settle");
    // Not "failed": nothing broke, and telling the owner their build failed
    // when Vercel simply never built it is the wrong sentence.
    expect(verdict).toMatchObject({ phase: "abandoned" });
    expect((verdict as { detail: string }).detail).toMatch(/no vercel deployment/i);
  });

  it("settles a build that finished", () => {
    expect(decideDeployment({ deployment: deployment({ readyState: "ready" }), waitedMs: 1 }))
      .toEqual({ action: "settle", phase: "ready", detail: null });
  });

  it("settles a failed build with Vercel's own sentence, or its own when there is none", () => {
    expect(decideDeployment({ deployment: deployment({ readyState: "error", errorMessage: "out of memory" }), waitedMs: 1 }))
      .toEqual({ action: "settle", phase: "failed", detail: "out of memory" });
    expect(decideDeployment({ deployment: deployment({ readyState: "error" }), waitedMs: 1 }))
      .toMatchObject({ action: "settle", phase: "failed" });
  });

  it("settles a cancelled deployment as cancelled, not as a failure", () => {
    expect(decideDeployment({ deployment: deployment({ readyState: "canceled" }), waitedMs: 1 }))
      .toMatchObject({ action: "settle", phase: "canceled" });
  });

  it("waits while it builds", () => {
    expect(decideDeployment({ deployment: deployment({ readyState: "building" }), waitedMs: 1 })).toEqual({ action: "wait" });
    expect(decideDeployment({ deployment: deployment({ readyState: "queued" }), waitedMs: 1 })).toEqual({ action: "wait" });
  });

  it("gives up on a build that never completes — the ceiling comes BEFORE the pending branch", () => {
    const verdict = decideDeployment({ deployment: deployment({ readyState: "building" }), waitedMs: VERCEL_MAX_WAIT_MS });
    expect(verdict).toMatchObject({ action: "settle", phase: "abandoned" });
  });

  it("reads a FINISHED build past the ceiling as finished — the ending wins over the clock", () => {
    expect(decideDeployment({ deployment: deployment({ readyState: "ready" }), waitedMs: VERCEL_MAX_WAIT_MS * 10 }))
      .toMatchObject({ action: "settle", phase: "ready" });
  });
});

describe("isVercelPending / isVercelPhase", () => {
  it("counts only a watch that is still going", () => {
    const base = {
      projectId: "prj_1", teamId: null, deploymentId: null, readyState: "queued" as const,
      url: null, inspectorUrl: null, target: null, branch: null, sha: null,
      startedAt: 0, endedAt: null, detail: null, fixRunId: null, feedbackSent: false, promotion: null,
    };
    expect(isVercelPending({ ...base, phase: "looking" })).toBe(true);
    expect(isVercelPending({ ...base, phase: "building" })).toBe(true);
    for (const phase of ["ready", "failed", "canceled", "abandoned"] as const) {
      expect(isVercelPending({ ...base, phase }), phase).toBe(false);
    }
    expect(isVercelPending(null)).toBe(false);
    expect(isVercelPending(undefined)).toBe(false);
  });

  it("recognises exactly the phases this code writes", () => {
    expect(isVercelPhase("ready")).toBe(true);
    expect(isVercelPhase("promoted")).toBe(false);
    expect(isVercelPhase(null)).toBe(false);
  });
});

describe("buildDeployFeedback", () => {
  const task = buildDeployFeedback({
    projectId: "prj_acme",
    branch: "clawbox/run-7",
    url: "https://app.vercel.app",
    inspectorUrl: "https://vercel.com/acme/app/dpl_7",
    detail: "Command \"npm run build\" exited with 1",
    log: "> next build\nType error: x is not assignable to y",
  });

  it("carries the evidence: the project, the branch, what Vercel said and the log", () => {
    expect(task).toContain("prj_acme");
    expect(task).toContain("clawbox/run-7");
    expect(task).toContain('Command "npm run build" exited with 1');
    expect(task).toContain("Type error: x is not assignable to y");
    expect(task).toContain("https://vercel.com/acme/app/dpl_7");
  });

  it("tells the run to push, and NOT to deploy or promote anything itself", () => {
    expect(task).toMatch(/commit and push/i);
    expect(task).toMatch(/do not try to deploy, promote or call vercel yourself/i);
  });

  it("tells the run this is its own session, so it does not start the task over", () => {
    expect(task).toMatch(/do not start the task over/i);
  });

  it("says so plainly when Vercel returned no log at all, rather than quoting nothing", () => {
    const empty = buildDeployFeedback({
      projectId: "prj_acme", branch: null, url: null, inspectorUrl: null, detail: null, log: "   ",
    });
    expect(empty).toContain("(Vercel returned no build log for this deployment.)");
  });
});
