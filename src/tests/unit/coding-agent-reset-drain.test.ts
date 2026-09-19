/**
 * What `_resetCodingAgentStateForTests()` promises, and what it was not
 * keeping.
 *
 * WHY THIS FILE EXISTS. The hook says it answers "once the settle path has
 * stopped touching the disk", and every suite that drives a real run leans on
 * that in its teardown. It did not hold: the sweep ends what is live at the
 * moment it is called and then waits for `settling` to empty — but the chain it
 * is waiting for is the chain that STARTS the next run. `reviewAndShip` awaits
 * `maybeStartReviewPass`, which spawns the automatic review pass, and
 * `enforceDeliverable` resumes the record for another attempt; both register a
 * brand-new live run AFTER `live` was cleared. The drain then returned with a
 * harness process still going, holding the previous test's module copy and the
 * shared hoisted mocks with it.
 *
 * What that cost: `coding-pipeline-driver.test.ts` ("the whole flow, end to
 * end") and `coding-agent-durable-completion.test.ts` went red in CI's full run
 * and green on their own — a leaked `announceCodingAgent` landing in the next
 * test's freshly cleared spy. Reproduced here on demand by asking the hook the
 * question directly instead of waiting for the machine to be slow enough.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const announceCodingAgent = vi.hoisted(() => vi.fn(async (run: { id: string; status: string }) => { void run; }));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
/**
 * The lever that makes this file deterministic.
 *
 * The leak needs the teardown to land while the settle chain is BETWEEN the
 * record settling and the chain starting its next run — on an idle machine that
 * window is a few milliseconds wide, which is exactly why the two suites this
 * fixes went red only on a loaded CI runner. `commitProjectAssets` is the first
 * step of `reviewAndShip` and this is the call it makes, so holding it open for
 * a beat puts the chain reliably where CI found it. The device's own budget for
 * it is 20 s, so a second is well inside what the code already tolerates.
 */
const SETTLE_CHAIN_HOLD_MS = 1_200;
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => {
    await new Promise((resolve) => { setTimeout(resolve, SETTLE_CHAIN_HOLD_MS); });
    return { icon: "skipped", favicon: false };
  }),
}));
const newestCommitSince = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
vi.mock("@/lib/coding-git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-git")>()),
  commitRunWork: vi.fn(async () => ({ committed: false, reason: "no_changes" })),
  newestCommitSince,
}));
const openPullRequest = vi.hoisted(() => vi.fn<typeof import("@/lib/coding-pr").openPullRequest>(async () => ({ ok: false, detail: "no remote" })));
vi.mock("@/lib/coding-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pr")>()),
  openPullRequest,
}));

/**
 * The shared spies, as a suite that drives real runs holds them: hoisted once
 * per FILE and re-armed per test. Silence on all three after the hook has
 * answered is the contract — every one of them is on the settle path, so a run
 * still going reaches at least one.
 */
const SHARED_SPIES = () => [announceCodingAgent, newestCommitSince, openPullRequest];

/** Nothing on the settle path has been touched since the spies were cleared. */
function expectNothingStirred(): void {
  for (const spy of SHARED_SPIES()) expect(spy).not.toHaveBeenCalled();
}

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let projectDir: string;
let restore: () => void;

const INIT = '{"type":"system","subtype":"init","session_id":"sess-reset-1","model":"deepseek-v4-pro","permissionMode":"acceptEdits"}';

function okResult(text = "Done."): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1 });
}

/**
 * A harness that succeeds and reports a file touched, because
 * `maybeStartReviewPass` skips a run that changed nothing — and the review pass
 * is the run this file is about.
 *
 * It exits AT ONCE on purpose: a leaked run has to reach its own settle for the
 * spies to see it, and a stand-in that lingered would stay silent for the
 * length of the assertion and prove nothing.
 */
function installHarness(): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      'head -n 1 > /dev/null',
      `printf '%s\\n' '${INIT}' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Write","input":{"file_path":"app.js"}}]}}' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1"}]}}' '${okResult()}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** How long the stand-in `gh` holds the review loop's first poll open. */
const GH_POLL_HOLD_S = 1.5;

/**
 * A `gh` ahead of the real one on PATH. Every call answers "not signed in" at
 * once — which is what CI's runner says, with no token in the test step — except
 * the review loop's `pr view`, which holds on for a beat and writes under HOME
 * at the start and at the end of it. The writes are the shape of the failure
 * this pins: a `gh` that puts one entry in HOME while the teardown is removing
 * the tree is all `rmSync` needs to fail with ENOTEMPTY.
 */
function installSlowGh(): { started: string; finished: string } {
  const marks = path.join(home, ".config", "gh");
  const started = path.join(marks, "pr-view-started");
  const finished = path.join(marks, "pr-view-finished");
  fs.writeFileSync(
    path.join(binDir, "gh"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      `  mkdir -p "${marks}" && : > "${started}"`,
      `  sleep ${GH_POLL_HOLD_S}`,
      `  : > "${finished}"`,
      "fi",
      "echo 'To get started with GitHub CLI, please run:  gh auth login' >&2",
      "exit 4",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  return { started, finished };
}

/** A real repository, so the run gets a branch and auto-PR has something to open. */
function initGitRepo(dir: string): void {
  for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) {
    execFileSync("git", args, { cwd: dir });
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "first"], { cwd: dir });
}

function writeConfig(cfg: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({
    clawai_token: "claw_test_token",
    coding_agent_enabled: true,
    coding_agent_review_pass: true,
    ...cfg,
  }), "utf-8");
}

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN", "PATH");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-reset-drain-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  writeConfig();
  newestCommitSince.mockReset();
  newestCommitSince.mockResolvedValue(null);
  openPullRequest.mockReset();
  openPullRequest.mockResolvedValue({ ok: false, detail: "no remote" });
  announceCodingAgent.mockClear();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
  projectDir = makeProject("site");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the teardown hook", () => {
  it("leaves nothing going when the settle chain started a review pass behind it", async () => {
    installHarness();
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    // Exactly where a suite's own `waitFor` lets go: the record is settled, and
    // the chain that follows it — assets, review pass, pull request, gate — is
    // still in flight.
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.status).not.toBe("running");
    }, { timeout: 30_000, interval: 25 });

    await lib._resetCodingAgentStateForTests();

    // The review pass really was reached — otherwise this case proves nothing.
    const review = lib.listRuns().find((r) => r.reviewOf === started.id);
    expect(review).toBeTruthy();

    // …and the hook ended it. Nothing may reach the shared spies after the hook
    // has answered: before the fix the review pass was spawned AFTER `live` was
    // swept, so the drain returned with the harness still going and its settle
    // landed one test later, in that test's freshly cleared spies.
    for (const spy of SHARED_SPIES()) spy.mockClear();
    await wait(3_000);
    expectNothingStirred();
  });

  it("leaves nothing going when the gate resumed the record for another attempt", async () => {
    // The other way the settle chain starts a run: the deliverable gate puts
    // the SAME record back to work. A harness that never writes `app.js` means
    // every attempt is spent, so there is always one starting behind the sweep.
    writeConfig({ coding_agent_review_pass: false, coding_agent_completion_attempts: 3 });
    installHarness();
    const started = await lib.startRun({
      task: "build", projectId: "site", source: "owner",
      deliverable: { kind: "paths", paths: ["nothing-here.txt"] },
    });
    // The first turn has settled of its own accord — no Stop anywhere on this
    // record, so the gate really will put it back to work — and the chain is
    // held open ahead of that, which is where a teardown lands.
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.summary).toBeTruthy();
      expect(lib.getRun(started.id)?.status).not.toBe("running");
    }, { timeout: 30_000, interval: 25 });

    await lib._resetCodingAgentStateForTests();

    for (const spy of SHARED_SPIES()) spy.mockClear();
    await wait(3_000);
    expectNothingStirred();
  });

  it("waits for the review loop's first poll, which the opened pull request started", async () => {
    // The third thing the settle chain starts: the watchers. The review loop
    // looks at a pull request the moment it is opened — `gh pr view` from the
    // run's folder with the box's HOME — and that look was started and
    // forgotten, so the hook answered with `gh` still going in the tree the
    // teardown was about to remove. CI: `ENOTEMPTY ... rmdir '.../home'` in
    // coding-agent-durable-completion.test.ts. The stand-in holds the poll open,
    // so the hook is asked while it is out rather than when CI is slow enough.
    writeConfig({ coding_agent_review_pass: false, coding_agent_auto_pr: true });
    installHarness();
    const gh = installSlowGh();
    initGitRepo(projectDir);
    // A commit to open from, and GitHub agreeing to open it.
    newestCommitSince.mockResolvedValue("abc1234");
    openPullRequest.mockResolvedValue({ ok: true, number: 7, url: "https://github.com/o/r/pull/7" });

    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    await vi.waitFor(() => {
      expect(fs.existsSync(gh.started)).toBe(true);
    }, { timeout: 30_000, interval: 25 });
    // The poll that is out is the review loop's, on the pull request this run
    // opened — otherwise this case proves nothing.
    expect(lib.getRun(started.id)?.review?.prNumber).toBe(7);

    await lib._resetCodingAgentStateForTests();

    // The hook answered only once `gh` was done in the tree. Before the fix it
    // answered with the poll still asleep, and the teardown's `rmSync` ran
    // against a live `gh`.
    expect(fs.existsSync(gh.finished)).toBe(true);
  });
});
