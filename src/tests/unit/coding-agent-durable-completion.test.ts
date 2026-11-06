/**
 * The attempt loop, as the runner actually drives it, against a fake harness.
 *
 * WHAT THIS IS FOR. A headless run settled as `completed` on one fact: Claude
 * Code emitted a success result event. A harness that looked around for a while,
 * concluded the task was beyond it and wrote a courteous paragraph emits exactly
 * that — so the card said "Finished", the notice fired, and nothing on the box
 * had looked at whether the thing the owner asked for existed.
 *
 * What the pure suites cannot see is the bookkeeping around the decision: that
 * the attempt goes back into the SAME record and the SAME session, that the
 * attempt list is one entry per harness turn with what was missing at the end of
 * each, that the cap actually stops it, that the finish notice is HELD until the
 * verdict (a "finished" notice for a run about to go back to work is the exact
 * lie being removed), and that a run with no deliverable behaves precisely as it
 * always did.
 *
 * The harness is a bash script standing in for `claude-ds`, the pattern
 * `coding-agent-harness-fault.test.ts` established. Everything else is the real
 * runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
// The ceiling `openAttempt` actually reads. A literal 6 here would stop
// reaching the "declines at the ceiling" branch the moment the constant moved,
// and both tests below would keep passing without exercising it.
import { MAX_COMPLETION_ATTEMPTS } from "@/lib/coding-deliverable";

// A real child process per attempt, and a settle chain after each.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

// Typed through its real signature, so the assertions below can read the record
// it was handed: a bare `vi.fn(async () => undefined)` has an empty argument
// tuple and `mock.calls[0][0]` does not compile.
const announceCodingAgent = vi.hoisted(() => vi.fn(async (run: { status: string }) => { void run; }));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));
// The settle path's git: a fake harness writes files, and committing them is
// neither the subject here nor something a temp folder should pay for. The
// outcome is the real `GitOutcome` no-change shape — `{ committed: false,
// reason: GitSkipReason }` — so `recordRunWork` reads it as "nothing to record"
// rather than filing a `commitError` off a shape the device never produces.
const commitRunWork = vi.hoisted(() => vi.fn<() => Promise<import("@/lib/coding-git").GitOutcome>>(
  async () => ({ committed: false, reason: "no_changes" }),
));
/**
 * The commit a run made THROUGH ITS OWN SHELL, which `noteOwnCommit` records.
 * Steerable per test because it is the only commit path a fake harness can take:
 * `recordRunWork` returns early when the stream reported no file touched, and a
 * bash stand-in emits no Write events.
 */
const newestCommitSince = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
vi.mock("@/lib/coding-git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-git")>()),
  commitRunWork,
  newestCommitSince,
}));
// Only the GitHub call is replaced; `startRunBranch` stays real, so a run's
// branch — and the implied pull-request bar that depends on it — is genuine.
const openPullRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pr")>()),
  openPullRequest,
}));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let projectDir: string;
let restore: () => void;

const INIT = '{"type":"system","subtype":"init","session_id":"sess-durable-1","model":"deepseek-v4-pro","permissionMode":"acceptEdits"}';

/**
 * One entry per harness invocation — what the box said to it on stdin.
 *
 * Split on an explicit delimiter rather than on newlines: a task travels with
 * the working folder's listing beside it, and a nudge is six lines, so a
 * line-per-entry log would count one invocation as several.
 */
const STDIN_DELIMITER = "<<<clawbox-stdin-end>>>";

function stdinLog(): string[] {
  const file = path.join(base, "stdin.log");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").split(STDIN_DELIMITER).map((e) => e.trim()).filter(Boolean);
}

function okResult(text = "Done."): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1 });
}

/**
 * A wrapper whose body is the bash the test wants. It reads stdin to /dev/null
 * first, like the real one: the runner puts the task — and a nudge — there.
 */
function installWrapper(body: string): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    ["#!/usr/bin/env bash", 'STDIN="$(head -n 1)"', body].join("\n"),
    { mode: 0o755 },
  );
}

/**
 * A harness that reports success every time and NEVER writes the file — the
 * shape of the run this whole feature exists for. It records each invocation's
 * stdin, so the test can see what the box said to it.
 */
function installHarnessThatNeverDelivers(): void {
  installWrapper([
    `printf '%s\\n%s\\n' "$STDIN" '${STDIN_DELIMITER}' >> "${path.join(base, "stdin.log")}"`,
    `printf '%s\\n' '${INIT}' '${okResult()}'`,
    "exit 0",
  ].join("\n"));
}

/**
 * A harness that reports success and writes the file on the attempt named by
 * the counter file — so "it failed once and then delivered" can be exercised.
 */
function installHarnessThatDeliversOnAttempt(n: number, file = "app.js"): void {
  const counter = path.join(base, "attempts");
  installWrapper([
    `printf '%s\\n%s\\n' "$STDIN" '${STDIN_DELIMITER}' >> "${path.join(base, "stdin.log")}"`,
    `echo x >> "${counter}"`,
    `COUNT=$(wc -l < "${counter}")`,
    `if [ "$COUNT" -ge ${n} ]; then printf 'content\\n' > "${path.join(projectDir, file)}"; fi`,
    `printf '%s\\n' '${INIT}' '${okResult()}'`,
    "exit 0",
  ].join("\n"));
}

/**
 * A harness that reports success AT ONCE and then lingers, so a Stop can land
 * while the run is still alive but its result event has already been parsed —
 * the race that settles a stopped run as `completed`.
 */
function installHarnessThatLingersAfterSucceeding(): void {
  installWrapper([
    `printf '%s\\n%s\\n' "$STDIN" '${STDIN_DELIMITER}' >> "${path.join(base, "stdin.log")}"`,
    `printf '%s\\n' '${INIT}' '${okResult()}'`,
    "sleep 20",
  ].join("\n"));
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({
    clawai_token: "claw_test_token",
    coding_agent_enabled: true,
    ...cfg,
  }), "utf-8");
}

/**
 * A real repository in the project folder, so `startRunBranch` succeeds and the
 * auto-PR switch actually implies a deliverable. Two tests need one.
 */
function initGitRepo(dir: string): void {
  for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) {
    execFileSync("git", args, { cwd: dir });
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "first"], { cwd: dir });
}

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

/**
 * Wait until the record is settled for good.
 *
 * `waitForRun` answers the FIRST settle, which for a run with a deliverable is
 * not the end of it — the gate still has to judge the folder, and a poll that
 * caught the record between the harness's settle and the verdict ran its
 * assertions in the MIDDLE of the chain.
 *
 * So the signal is the gate's own VERDICT, which is the one thing that happens
 * exactly once per run however it ends: the finish notice. Every terminal path
 * sends it — `completed` with the deliverable met, `gave_up`, the owner's Stop,
 * a run that never had a bar — and no intermediate state does.
 */
async function settledForGood(id: string): Promise<NonNullable<ReturnType<Lib["getRun"]>>> {
  await vi.waitFor(() => {
    const run = lib.getRun(id);
    expect(run).not.toBeNull();
    expect(run!.status === "running").toBe(false);
    expect(run!.attempts.some((a) => a.endedAt === null)).toBe(false);
    // Told about exactly once, and that is what says the box has finished
    // deciding. Asserting the COUNT stays meaningful in the tests that do it:
    // this waits for the first notice, they check there was only one.
    expect(announceCodingAgent.mock.calls.length).toBeGreaterThan(0);
  }, { timeout: 25_000, interval: 50 });
  return lib.getRun(id)!;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  // The token and the switch alone: the box has no attempt budget since SCA A2.
  writeConfig({});
  // Re-armed per test: `mockResolvedValueOnce` chains in one test must not leak
  // into the next, and the default here is the device's ordinary answer.
  commitRunWork.mockReset();
  commitRunWork.mockResolvedValue({ committed: false, reason: "no_changes" });
  newestCommitSince.mockReset();
  newestCommitSince.mockResolvedValue(null);
  openPullRequest.mockReset();
  openPullRequest.mockResolvedValue({ ok: false, detail: "no remote" });
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
  projectDir = makeProject("site");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  announceCodingAgent.mockClear();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a run with no deliverable", () => {
  it("settles exactly as it always did, and is announced at once", async () => {
    // The no-regression case, and the commonest one: auto-PR off, nothing named.
    installHarnessThatNeverDelivers();
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    const run = await settledForGood(started.id);

    expect(run.status).toBe("completed");
    expect(run.deliverable).toBeNull();
    expect(run.deliverableCheck).toBeNull();
    // No bar means no attempt list: a run nobody held to anything must not grow
    // bookkeeping it will never use.
    expect(run.attempts).toEqual([]);
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
    // The harness saw the task and no nudge.
    expect(stdinLog()).toHaveLength(1);
  });
});

describe("a paths deliverable the harness never delivers", () => {
  it("checks the folder ONCE, names what is missing, and gives up — no second go unasked", async () => {
    // Since SCA A2 the box spends no attempt of its own: one harness turn, one
    // verdict, and the owner's Resume is the only way back in.
    installHarnessThatNeverDelivers();
    const started = await lib.startRun({
      task: "build the app",
      projectId: "site",
      source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    const run = await settledForGood(started.id);

    // The ending this feature exists to produce: not `completed`, and not
    // `failed` either — the harness worked, and what it made is not the thing.
    expect(run.status).toBe("gave_up");
    expect(run.error).toContain("app.js was not created.");
    expect(run.error).toContain("one attempt");
    // The session holds the work, so Resume is the way on and the record says so.
    expect(run.resumable).toBe(true);
    expect(run.sessionId).toBe("sess-durable-1");

    // The run's own first go, closed with what was missing when it was judged.
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0].endedAt).not.toBeNull();
    expect(run.attempts[0].reason).toBe("app.js was not created.");
    expect(run.deliverableCheck).toMatchObject({ ok: false, missing: "app.js was not created." });

    // ONE harness turn: the task, and no nudge after it.
    const stdin = stdinLog();
    expect(stdin).toHaveLength(1);
    expect(stdin[0]).toContain("build the app");

    // ONE notice, saying what the run actually is.
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
    expect(announceCodingAgent.mock.calls[0][0]).toMatchObject({ status: "gave_up" });

    // The timeline carries the verdict, in the runner's own vocabulary.
    const progress = run.progress.join("\n");
    expect(progress).toContain("Not finished yet: app.js was not created.");
    expect(progress).not.toMatch(/Attempt \d+ of \d+/);
    expect(progress).toContain("Finished: gave_up");
  });
});

describe("a paths deliverable the harness delivers when the owner resumes", () => {
  it("ends COMPLETED, with the first go's failure still on the record", async () => {
    installHarnessThatDeliversOnAttempt(2);
    const started = await lib.startRun({
      task: "build",
      projectId: "site",
      source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    const gaveUp = await settledForGood(started.id);
    expect(gaveUp.status).toBe("gave_up");
    announceCodingAgent.mockClear();

    await lib.resumeRun(started.id);
    const run = await settledForGood(started.id);

    expect(run.status).toBe("completed");
    expect(run.deliverableCheck).toMatchObject({ ok: true, missing: null });
    // The history is kept: the owner asked one question and it took two goes.
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[0].reason).toBe("app.js was not created.");
    expect(run.attempts[1].reason).toBeNull();
    // The resumed go was nudged with what was missing, in the same session.
    const stdin = stdinLog();
    expect(stdin).toHaveLength(2);
    expect(stdin[1]).toContain("app.js was not created.");
    expect(stdin[1]).toMatch(/do not start over/i);
    expect(run.progress.join("\n")).toContain("The deliverable is there");
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
    expect(announceCodingAgent.mock.calls[0][0]).toMatchObject({ status: "completed" });
  });

  it("passes on the FIRST go without spending an attempt, and says nothing is missing", async () => {
    installHarnessThatDeliversOnAttempt(1);
    const started = await lib.startRun({
      task: "build",
      projectId: "site",
      source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    const run = await settledForGood(started.id);

    expect(run.status).toBe("completed");
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0].reason).toBeNull();
    expect(stdinLog()).toHaveLength(1);
  });
});

describe("a command deliverable", () => {
  it("holds the run to the command's exit status", async () => {
    // Owner-only, and this is the owner. The command runs in the run's own
    // folder, so it can see what the harness did or did not leave there.
    installHarnessThatNeverDelivers();
    // One attempt: the subject here is the verdict, not the loop, and a command
    // deliverable spawns a real child per go. Written before the start, because
    // the cap is read there and frozen on the record.
    const started = await lib.startRun({
      task: "build",
      projectId: "site",
      source: "owner",
      deliverable: { kind: "command", command: "test -f app.js" },
    });
    const run = await settledForGood(started.id);

    expect(run.status).toBe("gave_up");
    expect(run.deliverableCheck?.missing).toContain("exited 1");
  }, 40_000);

  it("refuses to let the AGENT set one, and the run does not start", async () => {
    // The boundary: a command deliverable has the box RUN something, outside
    // Claude Code's permission layer. An MCP caller able to name one would hold
    // execution its own Bash does not grant it.
    installHarnessThatNeverDelivers();
    await expect(lib.startRun({
      task: "build",
      projectId: "site",
      source: "agent",
      deliverable: { kind: "command", command: "true" },
    })).rejects.toThrow(/Only the owner/);
    // Refused at the door, not started and silently unheld: a run whose bar was
    // dropped would settle as `completed` on the old rule with the caller none
    // the wiser.
    expect(lib.listRuns()).toHaveLength(0);
  });

  it("refuses a deliverable this box will not accept rather than dropping it", async () => {
    installHarnessThatNeverDelivers();
    await expect(lib.startRun({
      task: "build",
      projectId: "site",
      source: "owner",
      deliverable: { kind: "paths", paths: ["../../etc/shadow"] },
    })).rejects.toThrow(/relative path inside the run's folder/);
    expect(lib.listRuns()).toHaveLength(0);
  });
});

describe("resuming a run that gave up", () => {
  it("is allowed in place, and carries on in the same session", async () => {
    installHarnessThatNeverDelivers();
    const started = await lib.startRun({
      task: "build",
      projectId: "site",
      source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    const gaveUp = await settledForGood(started.id);
    expect(gaveUp.status).toBe("gave_up");

    // The harness delivers this time. Its counter starts fresh — the wrapper
    // that gave up never touched it — so the very next invocation writes.
    installHarnessThatDeliversOnAttempt(1);
    await lib.resumeRun(started.id);
    const run = await settledForGood(started.id);

    expect(run.status).toBe("completed");
    expect(run.deliverableCheck?.ok).toBe(true);
    // The owner's own go is on the record like every other, and it named what
    // was missing rather than "you were paused".
    const last = stdinLog().at(-1) ?? "";
    expect(last).toContain("app.js was not created.");
    expect(last).toContain("resumed this run themselves");
    // It is NOT reported as "attempt 2 of 1": the cap bounds what the box
    // spends unasked, not what the owner decides to spend.
    expect(last).not.toMatch(/attempt \d+ of \d+/);
  });

  it("is still refused for a run that merely finished", async () => {
    installHarnessThatNeverDelivers();
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    await settledForGood(started.id);
    await expect(lib.resumeRun(started.id)).rejects.toThrow(/paused run, or one that gave up/);
  });
});

/**
 * The implied pull-request deliverable.
 *
 * With auto-PR on, the owner has already said the point of a run is a pull
 * request, so there is nothing to type — but the implication has to step aside
 * where a pull request was never POSSIBLE, or every attempt goes on the one
 * thing the harness cannot fix. And when it steps aside AFTER `finishRun` held
 * the finish notice on the strength of it, the notice still has to be sent: a
 * run nobody is ever told about is the worse failure of the two.
 */
describe("the deliverable the auto-PR switch implies", () => {
  it("is not implied at all in a folder that is not a repository yet", async () => {
    // `startRunBranch` answers `no_repository` and the record gets no `pr`, so
    // there is no bar — which is the existing "a fresh folder with auto-PR on is
    // not a failed pull request" rule, unchanged.
    installHarnessThatNeverDelivers();
    writeConfig({ coding_agent_auto_pr: true });
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    const run = await settledForGood(started.id);

    expect(run.pr).toBeNull();
    expect(run.status).toBe("completed");
    expect(run.attempts).toEqual([]);
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
    // One harness turn: nothing nudged it for a pull request this folder could
    // never have had.
    expect(stdinLog()).toHaveLength(1);
  });

  it("still tells the owner when the bar goes away after the run settled", async () => {
    // A git repository, so the run DOES get a branch and an implied pull-request
    // deliverable — and then `maybeOpenPullRequest` fails on its own (no remote,
    // no `gh`), which records `pr.phase: "failed"`. The implied bar steps aside,
    // and the notice `finishRun` held must still arrive.
    installHarnessThatNeverDelivers();
    writeConfig({ coding_agent_auto_pr: true });
    const { execFileSync } = await import("child_process");
    for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) {
      execFileSync("git", args, { cwd: projectDir });
    }
    execFileSync("git", ["add", "-A"], { cwd: projectDir });
    execFileSync("git", ["commit", "-qm", "first"], { cwd: projectDir });

    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    const run = await settledForGood(started.id);

    // It had a branch, so the bar was real while it worked…
    expect(run.pr?.branch).toBeTruthy();
    // …and the box's own flow is what could not deliver it.
    expect(run.pr?.phase).not.toBe("review");
    // Whatever the flow decided, the owner is told exactly once.
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
    // And no attempt is left hanging open, which would read as a turn still
    // being made and would block a later Resume from opening one.
    expect(run.attempts.some((a) => a.endedAt === null)).toBe(false);
  });
});

/**
 * A run that gave up is SETTLED and still resumable, and both halves have to
 * hold at once — which is the whole reason `holdsResumableSession` exists beside
 * `isHeld` rather than inside it.
 */
describe("a run that gave up is not the box's to throw away", () => {
  async function giveUpOne(task: string): Promise<string> {
    const started = await lib.startRun({
      task, projectId: "site", source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    const run = await settledForGood(started.id);
    expect(run.status).toBe("gave_up");
    return started.id;
  }

  it("survives the owner's Clear history, like a paused run does", async () => {
    // The reason written on `clearFinishedRuns`: a run holding a resumable
    // session is not "finished". Clearing it would take the session and the
    // evidence folder the owner is being asked to resume into.
    installHarnessThatNeverDelivers();
    const id = await giveUpOne("build the app");

    expect(lib.clearFinishedRuns()).toBe(0);
    expect(lib.getRun(id)?.status).toBe("gave_up");
  });

  it("is not TRIMMED to make room for a new run, while an ordinary ending is", async () => {
    // The half of this that matters most, and the half I had not covered: Clear
    // history is at least the owner's own gesture, while the trim at
    // MAX_RUNS_KEPT happens unasked, to make room, and past the rail's newest
    // dozen it is invisible. `findLastFinished` scans from the OLDEST end, so the
    // fixture puts the `gave_up` run there — exactly where the old `isHeld` test
    // would have picked it first — and the next-oldest ordinary ending behind it.
    installHarnessThatNeverDelivers();
    const runsFile = path.join(root, "data", "coding-agent-runs.json");
    const stamp = Date.now() - 10_000_000;
    // 29 finished runs, newest first, then the one that gave up as the oldest.
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 29; i += 1) {
      records.push({
        id: `run-trim${String(i).padStart(4, "0")}`,
        task: `old work ${i}`,
        directory: projectDir,
        status: "completed",
        startedAt: stamp + (29 - i) * 1000,
        completedAt: stamp + (29 - i) * 1000 + 500,
      });
    }
    records.push({
      id: "run-gaveup01",
      task: "the one waiting on the owner",
      directory: projectDir,
      status: "gave_up",
      startedAt: stamp,
      completedAt: stamp + 500,
      sessionId: "sess-durable-1",
      resumable: true,
      deliverable: { kind: "paths", paths: ["app.js"] },
      attempts: [{ startedAt: stamp, endedAt: stamp + 500, reason: "app.js was not created." }],
    });
    expect(records).toHaveLength(30);
    fs.writeFileSync(runsFile, JSON.stringify(records));
    await lib._resetCodingAgentStateForTests();

    // One more run takes the list past the cap and forces exactly one trim.
    const started = await lib.startRun({ task: "something new", projectId: "site", source: "owner" });
    await settledForGood(started.id);

    // The run holding a resumable session is still there…
    expect(lib.getRun("run-gaveup01")?.status).toBe("gave_up");
    // …and the oldest ORDINARY ending is what made room instead.
    expect(lib.getRun("run-trim0028")).toBeNull();
    // Nothing else was taken: 30 kept (29 old + the new one), one dropped.
    expect(lib.listRuns(100)).toHaveLength(30);
  });

  it("IS cleared once its folder is gone, because then it cannot be resumed", async () => {
    // The same exception paused runs and drafts get: `resumeRun` refuses a run
    // whose folder has been deleted, so kept it would be immortal.
    installHarnessThatNeverDelivers();
    const id = await giveUpOne("build the app");

    fs.rmSync(projectDir, { recursive: true, force: true });
    expect(lib.clearFinishedRuns()).toBe(1);
    expect(lib.getRun(id)).toBeNull();
  });
});

describe("a resumed go that delivers the pull request", () => {
  it("gets one opened, which the first settle had already ruled out", async () => {
    // `maybeOpenPullRequest` opens a pull request only from `phase: "opening"`.
    // The first settle committed nothing, so it recorded "blocked" — and without
    // `reopenPullRequestStep` putting the step back on the owner's Resume, the
    // go that DOES commit would find it blocked, no pull request would ever
    // follow, and the one deliverable that can then never be met is the one
    // the owner asked for.
    installHarnessThatNeverDelivers();
    initGitRepo(projectDir);
    writeConfig({ coding_agent_auto_pr: true });
    // Nothing on the first turn; the second leaves a commit of its own, which is
    // what lets the pull request step run at all. Through `noteOwnCommit`, the
    // path a run that commits through its own shell takes — and the only commit
    // path open to a harness stand-in, which reports no file touched.
    newestCommitSince.mockReset();
    newestCommitSince
      .mockResolvedValueOnce(null)
      .mockResolvedValue("abc1234");
    openPullRequest.mockReset();
    openPullRequest.mockResolvedValue({ ok: true, number: 7, url: "https://github.com/o/r/pull/7" });

    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    const gaveUp = await settledForGood(started.id);
    expect(gaveUp.status).toBe("gave_up");
    await lib.resumeRun(started.id);
    const run = await settledForGood(started.id);

    // Two harness turns: the first left nothing, the Resume's nudge asked for
    // the missing pull request, and the second delivered.
    expect(stdinLog()).toHaveLength(2);
    expect(stdinLog()[1]).toContain("pull request");
    // The step was reopened and the pull request actually opened…
    expect(openPullRequest).toHaveBeenCalledTimes(1);
    expect(run.pr?.number).toBe(7);
    // …so the deliverable is met and the run is finished for real.
    expect(run.status).toBe("completed");
    expect(run.deliverableCheck).toMatchObject({ ok: true, missing: null });
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[0].reason).toMatch(/pull request/i);
    expect(run.attempts[1].reason).toBeNull();
  });
});

describe("an EXPLICIT pull-request deliverable after the flow failed", () => {
  it("gets the step reopened on Resume, so the go is not spent on something unreachable", async () => {
    // The implied bar steps aside on `phase: "failed"`, so nothing is held to
    // it. An explicit `{ kind: "pr" }` is honoured as the caller stated it,
    // whatever the phase — so unless the step is reopened, `maybeOpenPullRequest`
    // (which opens only from "opening") can never run again and the owner's
    // Resume is spent on a bar that cannot be met, ending `gave_up` over work
    // that was done.
    installHarnessThatNeverDelivers();
    initGitRepo(projectDir);
    writeConfig({ coding_agent_auto_pr: true });
    // The first settle's pull-request flow FAILS (not "blocked"): it has a commit
    // to open one from, and the GitHub call refuses.
    newestCommitSince.mockReset();
    newestCommitSince.mockResolvedValue("abc1234");
    openPullRequest.mockReset();
    openPullRequest
      .mockResolvedValueOnce({ ok: false, detail: "gh is not logged in" })
      .mockResolvedValue({ ok: true, number: 9, url: "https://github.com/o/r/pull/9" });

    const started = await lib.startRun({
      task: "build", projectId: "site", source: "owner",
      deliverable: { kind: "pr" },
    });
    const gaveUp = await settledForGood(started.id);
    expect(gaveUp.status).toBe("gave_up");
    await lib.resumeRun(started.id);
    const run = await settledForGood(started.id);

    // The resumed go got a real go at it, and took it.
    expect(openPullRequest).toHaveBeenCalledTimes(2);
    expect(run.pr?.number).toBe(9);
    expect(run.status).toBe("completed");
    expect(run.deliverableCheck).toMatchObject({ ok: true });
    expect(run.attempts).toHaveLength(2);
  });
});

describe("the owner's own Stop", () => {
  it("decides the ending instead of the deliverable, and is still announced", async () => {
    // A run the owner stopped can still settle `completed` — the final result
    // event is applied ahead of the stop, so a Stop that raced the finish keeps
    // the work. The gate must then step aside: judging the deliverable would
    // answer a question the owner has already closed, and `gave_up` over a Stop
    // would read as the box blaming the harness for obeying.
    //
    // But `finishRun` is holding the notice for this run, so "step aside" cannot
    // mean "say nothing" — without the announce on that branch a stopped run with
    // a deliverable would be reported nowhere at all.
    installHarnessThatLingersAfterSucceeding();
    const started = await lib.startRun({
      task: "build", projectId: "site", source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    // Wait until the result event has been PARSED — that is what makes the race
    // settle as `completed` — then stop it while the process is still alive.
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.summary).toBeTruthy();
    }, { timeout: 20_000, interval: 25 });
    lib.stopRun(started.id);
    const run = await settledForGood(started.id);

    // The owner's gesture did not cost them the work…
    expect(run.status).toBe("completed");
    // …the deliverable was NOT judged, although it was never delivered…
    expect(run.deliverableCheck).toBeNull();
    expect(run.status).not.toBe("gave_up");
    // …the attempt was closed rather than left hanging…
    expect(run.attempts.some((a) => a.endedAt === null)).toBe(false);
    expect(run.attempts[0]?.reason).toBeNull();
    // …and they were told exactly once. Without the announce on that branch: 0.
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
  });
});

describe("the held notice reaches the owner on every path", () => {
  it("is sent once for a run resumed at the attempt ceiling", async () => {
    // An owner Resume at the ceiling opens no new attempt (`openAttempt`
    // declines) and `closeAttempt` records none either, so the list does not
    // grow and the cap is already met: the gate gives up again. The notice comes
    // from `giveUp` on this path — NOT from the bar-vanished branch, because an
    // explicit deliverable is returned by `deliverableFor` before `run.pr` is
    // ever looked at. The test below is the one that reaches that branch.
    installHarnessThatNeverDelivers();
    const started = await lib.startRun({
      task: "build", projectId: "site", source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    await settledForGood(started.id);
    announceCodingAgent.mockClear();

    // Fill the attempt list to the module-wide ceiling, so the next Resume's
    // `openAttempt` declines — the state the proxy got wrong.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8")) as Record<string, unknown>[];
    onDisk[0].attempts = Array.from({ length: MAX_COMPLETION_ATTEMPTS }, (_, i) => ({ startedAt: i + 1, endedAt: i + 2, reason: "app.js was not created." }));
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify(onDisk));
    await lib._resetCodingAgentStateForTests();

    await lib.resumeRun(started.id);
    const run = await settledForGood(started.id);

    // The ceiling branch was the one taken: `openAttempt` declined and
    // `closeAttempt` recorded nothing, so the list did not grow.
    expect(run.attempts).toHaveLength(MAX_COMPLETION_ATTEMPTS);
    // However it ended, the owner was told exactly once.
    expect(run.status).toBe("gave_up");
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
  });

  it("is sent when the IMPLIED bar vanishes and no attempt is open", async () => {
    // The branch `wasGated` exists for, reached the only way it can be: no
    // explicit deliverable (or `deliverableFor` would answer with it and never
    // look at `run.pr`), the bar IMPLIED by auto-PR, and a settle in which
    // `maybeOpenPullRequest` records `phase: "failed"` — so `deliverableFor`
    // answers null at the gate although it answered the pull request at
    // `finishRun`, which is therefore holding the notice.
    //
    // Plus the attempt list at the module ceiling, so `openAttempt` declines and
    // NO attempt is open. That is the combination the old "is an attempt open?"
    // proxy got wrong: it would have sent nothing at all, and the run would have
    // been reported nowhere.
    installHarnessThatNeverDelivers();
    initGitRepo(projectDir);
    writeConfig({ coding_agent_auto_pr: true });
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    const first = await settledForGood(started.id);
    // The implied bar was real: a branch was made and an attempt recorded.
    expect(first.pr?.branch).toBeTruthy();
    expect(first.deliverable).toBeNull();
    expect(first.attempts.length).toBeGreaterThan(0);
    announceCodingAgent.mockClear();

    // Fill the attempt list to the module-wide ceiling, so the Resume's
    // `openAttempt` declines and no attempt is open at the next settle.
    const runsFile = path.join(root, "data", "coding-agent-runs.json");
    const onDisk = JSON.parse(fs.readFileSync(runsFile, "utf-8")) as Record<string, unknown>[];
    onDisk[0].attempts = Array.from({ length: MAX_COMPLETION_ATTEMPTS }, (_, i) => ({ startedAt: i + 1, endedAt: i + 2, reason: "no pull request" }));
    fs.writeFileSync(runsFile, JSON.stringify(onDisk));
    await lib._resetCodingAgentStateForTests();

    // Switched off while the run was away: this is what makes
    // `maybeOpenPullRequest` record "failed" rather than "blocked", which is
    // what takes the implied bar away mid-settle.
    writeConfig({ coding_agent_auto_pr: false });

    await lib.resumeRun(started.id);
    const run = await settledForGood(started.id);

    // The bar stepped aside, so the harness's own verdict stands…
    expect(run.pr?.phase).toBe("failed");
    expect(run.status).toBe("completed");
    expect(run.attempts.some((a) => a.endedAt === null)).toBe(false);
    // The ceiling branch, again asserted rather than assumed.
    expect(run.attempts).toHaveLength(MAX_COMPLETION_ATTEMPTS);
    // …and the notice `finishRun` held was sent exactly once. Without `wasGated`
    // this is 0.
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
  });

  it("is NOT sent twice for a run that never had a bar", async () => {
    // The other side of the same discriminator: a run with no deliverable is
    // announced by `finishRun` itself, and the gate must not add a second notice
    // when it walks the same branch.
    installHarnessThatNeverDelivers();
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    await settledForGood(started.id);
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
  });
});
