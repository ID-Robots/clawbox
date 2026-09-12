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
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

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
const commitRunWork = vi.hoisted(() => vi.fn(async () => ({ committed: false as const, reason: "no_changes" as const })));
vi.mock("@/lib/coding-git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-git")>()),
  commitRunWork,
  newestCommitSince: vi.fn(async () => null),
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
    ["#!/usr/bin/env bash", 'STDIN="$(cat)"', body].join("\n"),
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

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({
    clawai_token: "claw_test_token",
    coding_agent_enabled: true,
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

/**
 * Wait until the record is settled for good.
 *
 * `waitForRun` answers the FIRST settle, which for a run with a deliverable is
 * not the end of it — the gate may put it straight back to work. Nor is "settled
 * status and no open attempt" enough: between the gate closing one attempt and
 * `startCompletionAttempt` flipping the record back to `running`, the record is
 * briefly `completed` with no attempt open, and a poll that caught that window
 * ran its assertions in the MIDDLE of the loop (seen under a parallel sweep:
 * "attempt 3 of 3" in the log beside a zero announce count).
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
  writeConfig({});
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
  it("resumes the SAME run in the SAME session, naming what is missing, and then gives up", async () => {
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
    // The session holds the work, so Resume is the way on and the record says so.
    expect(run.resumable).toBe(true);
    expect(run.sessionId).toBe("sess-durable-1");

    // One attempt per harness turn, the run's own first go counted as one, each
    // closed with what was still missing when it was judged.
    expect(run.attempts).toHaveLength(3);
    expect(run.attempts.every((a) => a.endedAt !== null)).toBe(true);
    expect(run.attempts.map((a) => a.reason)).toEqual([
      "app.js was not created.",
      "app.js was not created.",
      "app.js was not created.",
    ]);
    expect(run.deliverableCheck).toMatchObject({ ok: false, missing: "app.js was not created." });

    // Three harness turns: the original and two nudges. The nudges name the
    // missing file and tell it not to start over — it is the same session and
    // the transcript of the last turn is still in front of it.
    const stdin = stdinLog();
    expect(stdin).toHaveLength(3);
    expect(stdin[0]).toContain("build the app");
    for (const nudge of stdin.slice(1)) {
      expect(nudge).toContain("app.js was not created.");
      expect(nudge).toMatch(/do not start over/i);
    }
    expect(stdin[1]).toContain("attempt 2 of 3");
    expect(stdin[2]).toContain("attempt 3 of 3");

    // ONE notice, at the end, saying what the run actually is. A "finished"
    // notice after the first turn — with the run about to go back to work — is
    // the exact claim this feature removes.
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
    expect(announceCodingAgent.mock.calls[0][0]).toMatchObject({ status: "gave_up" });

    // The timeline carries the whole story, in the runner's own vocabulary.
    const progress = run.progress.join("\n");
    expect(progress).toContain("Not finished yet: app.js was not created.");
    expect(progress).toContain("Attempt 2 of 3 at the deliverable");
    expect(progress).toContain("Finished: gave_up");
  });

  it("stops at ONE attempt when that is all the owner allows", async () => {
    // `min 1` is a real setting: check it, say so, spend nothing more.
    installHarnessThatNeverDelivers();
    writeConfig({ coding_agent_completion_attempts: 1 });
    const started = await lib.startRun({
      task: "build",
      projectId: "site",
      source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    const run = await settledForGood(started.id);

    expect(run.status).toBe("gave_up");
    expect(run.attempts).toHaveLength(1);
    expect(run.completionAttempts).toBe(1);
    expect(stdinLog()).toHaveLength(1);
    expect(run.error).toContain("one attempt");
  });

  it("keeps the cap the run STARTED with when the owner changes it mid-run", async () => {
    // Frozen like `effort` and `media`: the promise a run was started under must
    // not move under it.
    installHarnessThatNeverDelivers();
    writeConfig({ coding_agent_completion_attempts: 2 });
    const started = await lib.startRun({
      task: "build",
      projectId: "site",
      source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    writeConfig({ coding_agent_completion_attempts: 6 });
    const run = await settledForGood(started.id);

    expect(run.completionAttempts).toBe(2);
    expect(run.attempts).toHaveLength(2);
  });
});

describe("a paths deliverable the harness delivers on the second go", () => {
  it("ends COMPLETED, with the first attempt's failure still on the record", async () => {
    installHarnessThatDeliversOnAttempt(2);
    const started = await lib.startRun({
      task: "build",
      projectId: "site",
      source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    const run = await settledForGood(started.id);

    expect(run.status).toBe("completed");
    expect(run.deliverableCheck).toMatchObject({ ok: true, missing: null });
    // The history is kept: the owner asked one question and it took two goes.
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[0].reason).toBe("app.js was not created.");
    expect(run.attempts[1].reason).toBeNull();
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
    writeConfig({ coding_agent_completion_attempts: 1 });
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
    writeConfig({ coding_agent_completion_attempts: 1 });
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
 * Two properties of the attempt itself, each the kind of thing a loop gets
 * quietly wrong.
 */
describe("what an attempt must not destroy or invent", () => {
  it("keeps the refusals and the turn count of the attempts before it", async () => {
    // The per-segment counters (`numTurns`, `permissionDenials`, `deniedActions`,
    // `denials`) are OVERWRITTEN by a result event unless the spawn says it is
    // continuing the same record — so without that, a refusal from the first
    // attempt, and the "Allow next time" button that answers it, vanished the
    // moment the second ran.
    const denial = JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 2,
      permission_denials: [{ tool_name: "Write", tool_input: { file_path: "/etc/hosts" } }],
    });
    installWrapper([
      `printf '%s\\n%s\\n' "$STDIN" '${STDIN_DELIMITER}' >> "${path.join(base, "stdin.log")}"`,
      `printf '%s\\n' '${INIT}' '${denial.replace(/'/g, "'\\''")}'`,
      "exit 0",
    ].join("\n"));
    writeConfig({ coding_agent_completion_attempts: 2 });
    const started = await lib.startRun({
      task: "build", projectId: "site", source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    const run = await settledForGood(started.id);

    expect(run.status).toBe("gave_up");
    expect(run.attempts).toHaveLength(2);
    // Two attempts, each reporting one refusal and two turns: the record is the
    // run's whole history, not its last segment's.
    expect(run.permissionDenials).toBe(2);
    expect(run.deniedActions).toHaveLength(2);
    expect(run.numTurns).toBe(4);
  });

  it("does not try again when there is no session to carry on in", async () => {
    // The loop's whole premise is that the transcript of the attempt that just
    // ended is still in front of the harness — that is why the nudge says "do
    // not start over". Without a session it would be a fresh one handed a note
    // about a missing file: the task redone from nothing, charged to the owner
    // as "one more attempt".
    installWrapper([
      `printf '%s\\n%s\\n' "$STDIN" '${STDIN_DELIMITER}' >> "${path.join(base, "stdin.log")}"`,
      // No init event, so the record never learns a session id.
      `printf '%s\\n' '${okResult()}'`,
      "exit 0",
    ].join("\n"));
    const started = await lib.startRun({
      task: "build", projectId: "site", source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    const run = await settledForGood(started.id);

    expect(run.sessionId).toBeNull();
    expect(run.status).toBe("gave_up");
    expect(run.error).toContain("no session to carry on in");
    // ONE harness turn, not three: the budget was not spent restarting the task.
    expect(stdinLog()).toHaveLength(1);
    expect(run.attempts).toHaveLength(1);
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
    writeConfig({ coding_agent_completion_attempts: 1 });
    const id = await giveUpOne("build the app");

    expect(lib.clearFinishedRuns()).toBe(0);
    expect(lib.getRun(id)?.status).toBe("gave_up");
  });

  it("IS cleared once its folder is gone, because then it cannot be resumed", async () => {
    // The same exception paused runs and drafts get: `resumeRun` refuses a run
    // whose folder has been deleted, so kept it would be immortal.
    installHarnessThatNeverDelivers();
    writeConfig({ coding_agent_completion_attempts: 1 });
    const id = await giveUpOne("build the app");

    fs.rmSync(projectDir, { recursive: true, force: true });
    expect(lib.clearFinishedRuns()).toBe(1);
    expect(lib.getRun(id)).toBeNull();
  });
});

describe("the held notice reaches the owner on every path", () => {
  it("is sent even when the bar vanishes and no attempt is open", async () => {
    // The hole an "is an attempt still open?" proxy left. An owner Resume at the
    // attempt CEILING opens no new attempt (`openAttempt` declines), so if the
    // implied pull-request bar then steps aside in the same settle chain, the
    // notice `finishRun` held would have been swallowed and the run reported
    // nowhere. `wasGated` is what answers the question `finishRun` actually
    // asked, and it is true for this record whatever its attempt list says.
    installHarnessThatNeverDelivers();
    writeConfig({ coding_agent_completion_attempts: 1 });
    const started = await lib.startRun({
      task: "build", projectId: "site", source: "owner",
      deliverable: { kind: "paths", paths: ["app.js"] },
    });
    await settledForGood(started.id);
    announceCodingAgent.mockClear();

    // Fill the attempt list to the module-wide ceiling, so the next Resume's
    // `openAttempt` declines — the state the proxy got wrong.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8")) as Record<string, unknown>[];
    onDisk[0].attempts = Array.from({ length: 6 }, (_, i) => ({ startedAt: i + 1, endedAt: i + 2, reason: "app.js was not created." }));
    fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify(onDisk));
    await lib._resetCodingAgentStateForTests();

    await lib.resumeRun(started.id);
    const run = await settledForGood(started.id);

    // However it ended, the owner was told exactly once.
    expect(run.status).toBe("gave_up");
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
