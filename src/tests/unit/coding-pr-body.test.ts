/**
 * The pull request the box opens for a run (TASK-1366): its title and body as
 * composed in src/lib/coding-pr-body.ts, and the `gh` door in
 * src/lib/coding-pr.ts that redacts them once more on the way out.
 *
 * The property under test: whatever the owner chose for the task, nothing of
 * theirs — a home path, a LAN address, an e-mail, a token, the box's name —
 * reaches GitHub, and a long task is a summary rather than the whole brief.
 *
 * Every value here is invented; token-shaped strings are assembled at run time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "os";
import type { ChildResult } from "@/lib/child-run";
import {
  composePullRequestBody,
  DEFAULT_PR_BODY_TASK_MODE,
  isPrBodyTaskMode,
  prBodyTaskModeFrom,
  pullRequestTitle,
  PR_TASK_EXCERPT_CHARS,
  taskSection,
  type PullRequestBodyInput,
} from "@/lib/coding-pr-body";

const runChild = vi.hoisted(() => vi.fn<(bin: string, args: string[], opts?: unknown) => Promise<ChildResult>>());
vi.mock("@/lib/child-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/child-run")>()),
  runChild,
}));

const result = (code: number, stdout = "", stderr = ""): ChildResult =>
  ({ code, stdout, stderr, signal: null, timedOut: false } as unknown as ChildResult);

const GHP = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const HOSTS = { hostNames: ["ada-desk"] };

/** Everything the redactor must take out, in one place, to look for afterwards. */
const PRIVATE = ["192.168.1.20", "10.0.0.5", "/home/ada", "ada@example.com", "ghp_", "ada-desk"];
const expectNothingPrivate = (text: string) => {
  for (const value of PRIVATE) expect(text, `"${value}" reached the pull request`).not.toContain(value);
};

/** A first line, a body that names everything private, and a tail far past the cut. */
const LONG_TASK = [
  "## Deploy the dashboard to 192.168.1.20",
  "",
  "Read /home/ada/Projects/briefs/dashboard.md first, then build and copy it over with",
  `\`scp -r out/ pi@10.0.0.5:/srv/www\`. The deploy token is ${GHP}; mail ada@example.com`,
  "when it is live, and check it from ada-desk afterwards.",
  "",
  ...Array.from({ length: 12 }, (_, i) => `- Step ${i + 1}: keep going with the ordinary part of the brief.`),
  "",
  "TAIL-SENTINEL: this sentence is well past the first six hundred characters.",
].join("\n");

const input = (over: Partial<PullRequestBodyInput> = {}): PullRequestBodyInput => ({
  task: LONG_TASK,
  runId: "run-abc12345",
  commit: "3a10510",
  reviewRunId: null,
  summary: "Built out/ and copied it to 10.0.0.5; see /home/ada/Projects/site/README.md.",
  taskMode: "summary",
  ...over,
});

describe("the setting", () => {
  it("defaults to summary and reads anything unknown as the default", () => {
    expect(DEFAULT_PR_BODY_TASK_MODE).toBe("summary");
    expect(prBodyTaskModeFrom(undefined)).toBe("summary");
    expect(prBodyTaskModeFrom("everything")).toBe("summary");
    expect(prBodyTaskModeFrom(3)).toBe("summary");
    expect(prBodyTaskModeFrom("full-redacted")).toBe("full-redacted");
    expect(prBodyTaskModeFrom("none")).toBe("none");
    expect(isPrBodyTaskMode("summary")).toBe(true);
    expect(isPrBodyTaskMode("full")).toBe(false);
  });
});

describe("pullRequestTitle", () => {
  it("is the task's first line, redacted", () => {
    expect(pullRequestTitle(LONG_TASK, HOSTS)).toBe("Deploy the dashboard to <private-ip>");
    expect(pullRequestTitle("Ship it to ada-desk for ada@example.com", HOSTS)).toBe("Ship it to <host> for <email>");
  });

  it("is redacted before it is cut, so no half token survives the 72 characters", () => {
    const title = pullRequestTitle(`${"x".repeat(60)} ${GHP}`, HOSTS);
    expect(title).not.toContain("ghp_");
    expect(title.length).toBeLessThanOrEqual(72);
  });

  it("falls back to a name when the task has no words", () => {
    expect(pullRequestTitle("   \n  ")).toBe("ClawBox coding agent");
  });
});

describe("composePullRequestBody", () => {
  it("summary (the default): a one-line summary and the first ~600 characters, quoted and redacted", () => {
    const body = composePullRequestBody(input(), HOSTS);
    expectNothingPrivate(body);
    expect(body).not.toContain("TAIL-SENTINEL");
    const lines = body.split("\n");
    const task = lines.indexOf("**Task**");
    expect(task).toBeGreaterThan(0);
    expect(lines[task + 1]).toBe("Deploy the dashboard to <private-ip>");
    expect(lines[task + 2]).toBe("");
    expect(lines[task + 3]).toBe("> ## Deploy the dashboard to <private-ip>");
    expect(body).toContain("> Read ~/Projects/briefs/dashboard.md first");
    expect(body).toContain("pi@<private-ip>:/srv/www");
    expect(body).toContain("The deploy token is <redacted>; mail <email>");
    expect(body).toContain("check it from <host> afterwards.");
    expect(body).toContain(`_Shortened to its first ${PR_TASK_EXCERPT_CHARS} characters; the full task stays on the device._`);
    // The quoted excerpt itself is no longer than the cut, plus its ellipsis.
    const excerpt = lines.filter((l) => l.startsWith(">")).map((l) => l.replace(/^> ?/, "")).join("\n");
    expect(excerpt.length).toBeLessThanOrEqual(PR_TASK_EXCERPT_CHARS + 1);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("summary of a short task is the whole task, redacted, with nothing quoted or shortened", () => {
    const body = composePullRequestBody(input({ task: "Fix the login form on 192.168.1.20.\n\nCheck it in /home/ada/site." }), HOSTS);
    expect(body).toBe([
      "Opened by the ClawBox coding agent.",
      "",
      "**Task**",
      "Fix the login form on <private-ip>.",
      "",
      "Check it in ~/site.",
      "",
      "Run `run-abc12345` · commit `3a10510`",
      "",
      "**Summary**",
      "Built out/ and copied it to <private-ip>; see ~/Projects/site/README.md.",
    ].join("\n"));
  });

  it("full-redacted: the whole task, every line of it, redacted", () => {
    const body = composePullRequestBody(input({ taskMode: "full-redacted" }), HOSTS);
    expectNothingPrivate(body);
    expect(body).toContain("TAIL-SENTINEL");
    expect(body).toContain("- Step 12: keep going");
    expect(body).not.toContain("_Shortened");
    expect(body).not.toMatch(/^> /m);
  });

  it("none: no task at all, and the rest of the body as before", () => {
    const body = composePullRequestBody(input({ taskMode: "none", reviewRunId: "run-rev00001" }), HOSTS);
    expect(body).toBe([
      "Opened by the ClawBox coding agent.",
      "",
      "Run `run-abc12345` · commit `3a10510`",
      "Reviewed by run `run-rev00001` (automatic review pass).",
      "",
      "**Summary**",
      "Built out/ and copied it to <private-ip>; see ~/Projects/site/README.md.",
    ].join("\n"));
  });

  it("leaves out what the run did not have — a commit, a summary, a task", () => {
    expect(composePullRequestBody(input({ task: "  ", commit: null, summary: null }))).toBe([
      "Opened by the ClawBox coding agent.",
      "",
      "Run `run-abc12345`",
    ].join("\n"));
  });

  it("never cuts through a token or a placeholder", () => {
    // The token straddles the cut: redacted first, its placeholder ends past
    // character 600, and the cut falls back to the space before it.
    const straddling = taskSection(`${"a".repeat(595)} ${GHP} and more words after it`, "summary");
    // No space anywhere near the cut: the half placeholder is dropped whole.
    const glued = taskSection(`${"b".repeat(596)}${GHP}${"c".repeat(50)}`, "summary");
    for (const section of [straddling, glued]) {
      const text = section.join("\n");
      expect(text).not.toContain("ghp_");
      expect(text).not.toMatch(/<[a-z-]*…/);
      expect(text).toContain("_Shortened");
    }
  });

  it("quotes the excerpt, so a code fence the cut left open closes with the quote", () => {
    const task = ["Run this:", "```sh", ...Array.from({ length: 80 }, () => "echo ordinary line"), "```", "done"].join("\n");
    const body = composePullRequestBody(input({ task, summary: null }));
    const lines = body.split("\n");
    const firstQuoted = lines.findIndex((l) => l.startsWith(">"));
    const lastQuoted = lines.length - 1 - [...lines].reverse().findIndex((l) => l.startsWith(">"));
    expect(lines.slice(firstQuoted, lastQuoted + 1).every((l) => l.startsWith(">"))).toBe(true);
    expect(lines[lines.length - 1]).toBe("Run `run-abc12345` · commit `3a10510`");
  });

  it("redacts the summary as well as the task", () => {
    const body = composePullRequestBody(input({ taskMode: "none", summary: `Pushed with ${GHP} from ada-desk.local.` }), HOSTS);
    expect(body).toContain("Pushed with <redacted> from <host>.");
  });
});

describe("the gh door (openPullRequest)", () => {
  let pr: typeof import("@/lib/coding-pr");

  beforeEach(async () => {
    runChild.mockReset();
    vi.resetModules();
    pr = await import("@/lib/coding-pr");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("knows the box's names, whole and as the first label", () => {
    vi.spyOn(os, "hostname").mockReturnValue("Ada-Desk.example.lan");
    expect(pr.boxHostNames()).toEqual(["ada-desk.example.lan", "ada-desk"]);
    vi.spyOn(os, "hostname").mockImplementation(() => { throw new Error("no uts"); });
    expect(pr.boxHostNames()).toEqual([]);
  });

  it("redacts the title and the body it is handed, whoever composed them", async () => {
    vi.spyOn(os, "hostname").mockReturnValue("ada-desk");
    runChild
      .mockResolvedValueOnce(result(0, "https://github.com/o/r.git"))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0, "https://github.com/o/r/pull/12"))
      .mockResolvedValueOnce(result(0, JSON.stringify({ number: 12, url: "https://github.com/o/r/pull/12" })));
    const opened = await pr.openPullRequest({
      directory: "/tmp/p",
      branch: "clawbox/run-x",
      base: "beta",
      title: "Deploy from ada-desk to 192.168.1.20",
      body: `Built in /home/ada/site for ada@example.com with ${GHP}.`,
      draft: true,
    });
    expect(opened).toMatchObject({ ok: true, number: 12 });
    const [bin, args] = runChild.mock.calls[2];
    expect(bin).toBe("gh");
    expect(args[args.indexOf("--title") + 1]).toBe("Deploy from <host> to <private-ip>");
    expect(args[args.indexOf("--body") + 1]).toBe("Built in ~/site for <email> with <redacted>.");
  });
});
