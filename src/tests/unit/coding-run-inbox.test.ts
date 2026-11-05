/**
 * A run's inbox (src/lib/coding-run-inbox.ts) and the hook that reads it
 * (scripts/coding-run-hook.mjs) — the mid-turn half of telling a run
 * something, and the merge guard a coding team's runs carry.
 *
 * The hook is run for real, as the harness runs it: a `node` process with the
 * hook input on stdin, its JSON answer on stdout. What Claude Code then does
 * with `additionalContext` was checked against the box's own harness; what is
 * pinned here is everything on this side of that line — the order, the shape,
 * and that a message goes exactly ONE way however the hook and the box race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Starts real processes (the hook, `sh`): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return { ...actual, get DATA_DIR() { return path.join(root, "data"); } };
});

type Inbox = typeof import("@/lib/coding-run-inbox");
let inbox: Inbox;

const SCRIPT = path.resolve(__dirname, "../../../scripts/coding-run-hook.mjs");
const RUN = "run-abcd1234";

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "run-inbox-"));
  vi.resetModules();
  inbox = await import("@/lib/coding-run-inbox");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function hook(args: string[], input: Record<string, unknown>): string {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input: JSON.stringify(input), encoding: "utf-8", timeout: 10_000 });
  expect(r.status).toBe(0);
  return r.stdout;
}

function hookAsync(args: string[], input: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
    child.on("error", reject);
    child.on("close", () => resolve(out));
    child.stdin.end(JSON.stringify(input));
  });
}

const POST_TOOL = { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "npm test" } };
const contextOf = (out: string): string => (JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput.additionalContext;

describe("the inbox on disk", () => {
  it("keeps messages in the order they arrived, and the box takes back what the hook did not", () => {
    expect(inbox.postToInbox(RUN, { id: "m-00000002", at: 2_000, context: "second" })).toBe(true);
    expect(inbox.postToInbox(RUN, { id: "m-00000001", at: 1_000, context: "first" })).toBe(true);
    expect(inbox.inboxPending(RUN)).toEqual(["m-00000001", "m-00000002"]);
    expect(inbox.reclaimInbox(RUN)).toEqual(["m-00000001", "m-00000002"]);
    expect(inbox.inboxPending(RUN)).toEqual([]);
    expect(inbox.inboxReceipts(RUN)).toEqual([]);
    // Nothing is written that a half-read could see: no temp file is left over.
    expect(fs.readdirSync(inbox.runInboxDir(RUN)).sort()).toEqual(["pending", "reclaimed", "taken"]);
  });

  it("refuses an id that is not a message's, and a folder that is not a run's", () => {
    expect(inbox.postToInbox(RUN, { id: "../escape", at: 1, context: "x" })).toBe(false);
    expect(() => inbox.runInboxDir("../../etc")).toThrow(/Not a run id/);
  });

  it("is gone with the run", () => {
    inbox.postToInbox(RUN, { id: "m-00000001", at: 1, context: "x" });
    inbox.removeRunInbox(RUN);
    expect(fs.existsSync(inbox.runInboxDir(RUN))).toBe(false);
  });
});

describe("the hook (scripts/coding-run-hook.mjs)", () => {
  it("hands every waiting message to the model after a tool call, oldest first, and leaves a receipt for each", () => {
    const dir = inbox.ensureRunInbox(RUN);
    inbox.postToInbox(RUN, { id: "m-00000001", at: 1_000, context: "[ClawBox: a message] use tabs" });
    inbox.postToInbox(RUN, { id: "m-00000002", at: 2_000, context: "[ClawBox: a message] and port 8080" });
    const out = hook(["inbox", dir], POST_TOOL);
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(contextOf(out)).toBe("[ClawBox: a message] use tabs\n\n[ClawBox: a message] and port 8080");
    expect(inbox.inboxPending(RUN)).toEqual([]);
    expect(inbox.inboxReceipts(RUN).map((r) => r.id)).toEqual(["m-00000001", "m-00000002"]);
    // Taken once: the next tool call has nothing to say.
    expect(hook(["inbox", dir], POST_TOOL)).toBe("");
    inbox.clearReceipts(RUN, ["m-00000001"]);
    expect(inbox.inboxReceipts(RUN).map((r) => r.id)).toEqual(["m-00000002"]);
  });

  it("says nothing after a SUB-AGENT's tool call: the run's own turn is where a message goes", () => {
    const dir = inbox.ensureRunInbox(RUN);
    inbox.postToInbox(RUN, { id: "m-00000001", at: 1, context: "use tabs" });
    expect(hook(["inbox", dir], { ...POST_TOOL, agent_id: "agent-1", agent_type: "Explore" })).toBe("");
    expect(inbox.inboxPending(RUN)).toEqual(["m-00000001"]);
  });

  it("never fails the tool call it rides on — no inbox, no input, a file that is not a message", () => {
    expect(hook(["inbox", path.join(root, "nowhere")], POST_TOOL)).toBe("");
    const r = spawnSync(process.execPath, [SCRIPT, "inbox", inbox.ensureRunInbox(RUN)], { input: "not json", encoding: "utf-8" });
    expect(r.status).toBe(0);
    const dir = inbox.ensureRunInbox(RUN);
    fs.writeFileSync(path.join(dir, "pending", "0000000000001-m-00000009.json"), "{ broken");
    expect(hook(["inbox", dir], POST_TOOL)).toBe("");
  });

  it("delivers each message exactly ONE way when hooks and the box's reclaim race for it", async () => {
    const dir = inbox.ensureRunInbox(RUN);
    const ids = Array.from({ length: 20 }, (_, i) => `m-${String(i + 1).padStart(8, "0")}`);
    ids.forEach((id, i) => inbox.postToInbox(RUN, { id, at: 1_000 + i, context: `message ${id}` }));
    // Six parallel tool calls' hooks, and the turn's end, all at once.
    const outs = Promise.all(Array.from({ length: 6 }, () => hookAsync(["inbox", dir], POST_TOOL)));
    const reclaimed = inbox.reclaimInbox(RUN);
    const handed = (await outs).filter(Boolean).flatMap((o) => contextOf(o).split("\n\n")).map((c) => c.replace("message ", ""));
    const taken = inbox.inboxReceipts(RUN).map((r) => r.id);
    expect(new Set(handed)).toEqual(new Set(taken));
    expect(handed).toHaveLength(new Set(handed).size);
    expect([...handed, ...reclaimed].sort()).toEqual(ids);
  });
});

describe("the merge guard a coding team's run carries", () => {
  const verdict = (command: string) => {
    const out = hook(["merge-guard"], { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
    return out ? (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput : null;
  };

  it.each([
    "gh pr merge 12 --merge",
    "cd site && gh -R owner/repo pr merge 3 --squash",
    "bash -c \"gh pr merge 1 --auto --merge\"",
    "env GH_TOKEN=x gh pr merge 2",
    "git push origin HEAD",
    "git -C /home/clawbox/Projects/site push --force",
    "gh api repos/o/r/pulls/3/merge -X PUT",
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/pulls/2/merge",
    "hub merge https://github.com/o/r/pull/2",
  ])("denies %s", (command) => {
    const v = verdict(command);
    expect(v?.permissionDecision).toBe("deny");
    expect(v?.permissionDecisionReason).toMatch(/orchestrator merges/);
  });

  it.each([
    "git commit -m \"fix push notifications\"",
    "git add -A && git commit -m wip",
    "gh pr view 3 --json state",
    "gh pr checks 3",
    "npm test",
    "git log --oneline -5",
  ])("lets %s through", (command) => {
    expect(verdict(command)).toBeNull();
  });

  it("reads only Bash", () => {
    expect(hook(["merge-guard"], { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "gh pr merge" } })).toBe("");
  });
});

describe("the --settings a run is spawned with", () => {
  it("names the hook script with the inbox, quoted for the shell the harness runs it in", () => {
    const odd = path.join(root, "it's a dir");
    fs.mkdirSync(odd);
    const script = path.join(odd, "hook.mjs");
    fs.copyFileSync(SCRIPT, script);
    const dir = inbox.ensureRunInbox(RUN);
    inbox.postToInbox(RUN, { id: "m-00000001", at: 1, context: "use tabs" });
    const settings = JSON.parse(inbox.runHookSettings({ node: process.execPath, script, inbox: dir, mergeGuard: false })!) as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    };
    expect(Object.keys(settings.hooks)).toEqual(["PostToolUse"]);
    expect(settings.hooks.PostToolUse[0]).toMatchObject({ matcher: "*", hooks: [{ type: "command", timeout: 10 }] });
    // Run exactly as Claude Code runs a command hook: `sh -c`, the input on stdin.
    const r = spawnSync("sh", ["-c", settings.hooks.PostToolUse[0].hooks[0].command], { input: JSON.stringify(POST_TOOL), encoding: "utf-8" });
    expect(contextOf(r.stdout)).toBe("use tabs");
  });

  it("an empty inbox costs no Node process: the shell guard alone answers, with exit 0", () => {
    const dir = inbox.ensureRunInbox(RUN);
    // A node binary that cannot run: the guard must never reach it.
    const settings = JSON.parse(inbox.runHookSettings({ node: path.join(root, "no-such-node"), script: SCRIPT, inbox: dir, mergeGuard: false })!) as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.PostToolUse[0].matcher).toBe("*");
    const r = spawnSync("sh", ["-c", settings.hooks.PostToolUse[0].hooks[0].command], { input: JSON.stringify(POST_TOOL), encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("adds the merge guard for a team's run, and says nothing when there is no hook to give", () => {
    const both = JSON.parse(inbox.runHookSettings({ node: "/usr/bin/node", script: "/x/hook.mjs", inbox: "/d/in", mergeGuard: true })!) as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>> };
    expect(both.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(both.hooks.PreToolUse[0].hooks[0].command).toBe("'/usr/bin/node' '/x/hook.mjs' 'merge-guard'");
    expect(inbox.runHookSettings({ node: "/usr/bin/node", script: "/x/hook.mjs", inbox: null, mergeGuard: false })).toBeNull();
  });
});

describe("the keep-alive Stop hook", () => {
  const STOP = { hook_event_name: "Stop", session_id: "s", stop_hook_active: false };
  const blockOf = (out: string): { decision: string; reason: string } => JSON.parse(out) as { decision: string; reason: string };
  let state: string;
  let jobs: string;
  beforeEach(() => {
    state = path.join(root, "evidence");
    jobs = path.join(state, ".run-jobs");
    fs.mkdirSync(state, { recursive: true });
  });

  it("lets a run with nothing of its own going on stop, and writes nothing", () => {
    expect(hook(["keepalive", state], STOP)).toBe("");
    expect(fs.existsSync(path.join(jobs, "stop-blocks.json"))).toBe(false);
  });

  it("refuses the stop while a message waits in the inbox, and hands the message over", () => {
    const dir = inbox.ensureRunInbox(RUN);
    inbox.postToInbox(RUN, { id: "m-00000001", at: 1, context: "also test on Hermes" });
    const out = blockOf(hook(["keepalive", state, dir], STOP));
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("also test on Hermes");
    expect(inbox.inboxPending(RUN)).toEqual([]);
    expect(inbox.inboxReceipts(RUN).map((r) => r.id)).toEqual(["m-00000001"]);
  });

  it("refuses the stop while a registered job's process lives, and not once it is gone", () => {
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      fs.mkdirSync(jobs, { recursive: true });
      fs.writeFileSync(path.join(jobs, "board.json"), JSON.stringify({ name: "board matrix", pid: sleeper.pid }));
      const out = blockOf(hook(["keepalive", state], STOP));
      expect(out.decision).toBe("block");
      expect(out.reason).toContain(`board matrix (pid ${sleeper.pid})`);
      expect(out.reason).toMatch(/nothing wakes you again/);
    } finally {
      sleeper.kill("SIGKILL");
    }
    // A dead pid is a finished job.
    const dead = spawnSync("true").pid ?? 999_999;
    fs.writeFileSync(path.join(jobs, "board.json"), JSON.stringify({ name: "board matrix", pid: dead }));
    expect(hook(["keepalive", state], STOP)).toBe("");
  });

  it("counts a job with no pid as running until it is old, and the counter caps the refusals", () => {
    fs.mkdirSync(jobs, { recursive: true });
    fs.writeFileSync(path.join(jobs, "update.json"), JSON.stringify({ name: "in-app update" }));
    expect(blockOf(hook(["keepalive", state], STOP)).reason).toContain("in-app update");
    const counted = JSON.parse(fs.readFileSync(path.join(jobs, "stop-blocks.json"), "utf8")) as { count: number; capped: boolean };
    expect(counted).toMatchObject({ count: 1, capped: false });
    // Out of refusals: the stop goes through and the record says so.
    fs.writeFileSync(path.join(jobs, "stop-blocks.json"), JSON.stringify({ count: 20, first: Date.now() }));
    expect(hook(["keepalive", state], STOP)).toBe("");
    const capped = JSON.parse(fs.readFileSync(path.join(jobs, "stop-blocks.json"), "utf8")) as { capped: boolean; last: { jobs: string[] } };
    expect(capped.capped).toBe(true);
    expect(capped.last.jobs).toEqual(["in-app update"]);
    // An old job with no pid no longer counts.
    const old = (Date.now() - 4 * 60 * 60 * 1000) / 1000;
    fs.writeFileSync(path.join(jobs, "stop-blocks.json"), JSON.stringify({ count: 0 }));
    fs.utimesSync(path.join(jobs, "update.json"), old, old);
    expect(hook(["keepalive", state], STOP)).toBe("");
  });

  it("finds a background process the harness's shell left running, and does not let a 'kept' pid go", () => {
    // A stand-in harness: a program whose name is `claude`, which starts a
    // background shell (the way a Bash tool call with run_in_background does)
    // and then runs the Stop hook as its child, the way the harness does.
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const harness = path.join(bin, "claude");
    fs.writeFileSync(
      harness,
      `#!${process.execPath}
const { spawn, spawnSync } = require("child_process");
const bg = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
const keep = process.argv[2] === "keep";
if (keep) require("fs").writeFileSync(${JSON.stringify(path.join(jobs, "keep"))}, String(bg.pid) + "\\n");
setTimeout(() => {
  const r = spawnSync(process.execPath, [${JSON.stringify(SCRIPT)}, "keepalive", ${JSON.stringify(state)}], { input: JSON.stringify(${JSON.stringify(STOP)}), encoding: "utf-8" });
  process.stdout.write(r.stdout);
  bg.kill("SIGKILL");
}, 300);
`,
      { mode: 0o755 },
    );
    fs.mkdirSync(jobs, { recursive: true });
    const blocked = spawnSync(harness, [], { encoding: "utf-8", timeout: 20_000 });
    const out = blockOf(blocked.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/Processes you started are still running:[\s\S]*sh -c sleep 30/);
    fs.rmSync(path.join(jobs, "stop-blocks.json"), { force: true });
    // A pid written to the old keep list is still a job that has not finished:
    // a model that was offered the list put its test job there and stopped.
    const kept = spawnSync(harness, ["keep"], { encoding: "utf-8", timeout: 20_000 });
    expect(blockOf(kept.stdout).decision).toBe("block");
    expect(blockOf(kept.stdout).reason).toMatch(/only once it listens on a TCP port/);
    expect(blockOf(kept.stdout).reason).not.toMatch(/\.run-jobs\/keep/);
  });

  it("is not the run's stop when a sub-agent stops", () => {
    fs.mkdirSync(jobs, { recursive: true });
    fs.writeFileSync(path.join(jobs, "update.json"), JSON.stringify({ name: "in-app update" }));
    expect(hook(["keepalive", state], { ...STOP, agent_id: "a1" })).toBe("");
  });

  it("is in the --settings only for a run that has an evidence folder, after the inbox", () => {
    const s = JSON.parse(inbox.runHookSettings({ node: "/usr/bin/node", script: "/x/hook.mjs", inbox: "/d/in", mergeGuard: false, keepAlive: "/e/run" })!) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(s.hooks)).toEqual(["PostToolUse", "Stop"]);
    expect(s.hooks.Stop[0].hooks[0].command).toBe("'/usr/bin/node' '/x/hook.mjs' 'keepalive' '/e/run' '/d/in'");
    const none = JSON.parse(inbox.runHookSettings({ node: "/usr/bin/node", script: "/x/hook.mjs", inbox: "/d/in", mergeGuard: false, keepAlive: null })!) as { hooks: Record<string, unknown> };
    expect(Object.keys(none.hooks)).toEqual(["PostToolUse"]);
  });
});

/**
 * The command clock: what the RUN started, not what launched it.
 *
 * A run's scope is shared with whatever started the harness. A launcher's
 * own watcher (`<launcher> --heal-watch <session dir>`, forked at session
 * start, reparented to init, alive until the session ends) sat in it, and the
 * Stop hook refused every stop over it as "a process you started": finished
 * runs looped on sleep and ps until the cap (2026-11-05). The spawn's
 * PreToolUse guard stamps when the first command began; only what started
 * after it is the run's — reparented or not.
 */
describe("the command clock", () => {
  const STOP = { hook_event_name: "Stop", session_id: "s", stop_hook_active: false };
  let state: string;
  let clock: string;
  beforeEach(() => {
    state = path.join(root, "evidence");
    // Made by hand rather than by createCommandClock, so the same test runs
    // against a checkout that has no clock at all.
    clock = path.join(state, ".run-jobs", "first-command-t1");
    fs.mkdirSync(path.dirname(clock), { recursive: true });
    fs.writeFileSync(clock, "");
  });

  type Settings = { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
  const settingsWith = (node = process.execPath): Settings =>
    JSON.parse(inbox.runHookSettings({ node, script: SCRIPT, inbox: null, mergeGuard: false, keepAlive: state, commandClock: clock })!) as Settings;
  /** The guard the harness runs before every tool call; "" where the settings have none. */
  const guardOf = (s: Settings): string => s.hooks.PreToolUse?.find((m) => m.matcher === "*")?.hooks[0].command ?? "";
  const stopOf = (s: Settings): string => s.hooks.Stop[0].hooks[0].command;

  it("is stamped once, before the first tool call, by a guard that never starts Node", () => {
    // A node binary that cannot run: the guard must never reach it.
    const s = settingsWith(path.join(root, "no-such-node"));
    expect(s.hooks.PreToolUse[0].matcher).toBe("*");
    expect(stopOf(s)).toContain(`'--first-command=${clock}'`);
    const before = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    for (let call = 0; call < 3; call++) {
      const r = spawnSync("sh", ["-c", guardOf(s)], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }), encoding: "utf-8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    }
    const stamps = fs.readFileSync(clock, "utf8").trim().split("\n");
    expect(stamps).toHaveLength(1);
    // Seconds since boot, the clock a process's start time is kept in.
    expect(Number(stamps[0])).toBeGreaterThanOrEqual(Math.floor(before));
    expect(Number(stamps[0])).toBeLessThan(before + 60);
  });

  it("is stamped only for a run with the keep-alive hook, beside a team run's merge guard", () => {
    const team = JSON.parse(inbox.runHookSettings({ node: "/usr/bin/node", script: "/x/hook.mjs", inbox: "/d/in", mergeGuard: true, keepAlive: "/e/run", commandClock: "/e/run/.run-jobs/first-command-a" })!) as Settings;
    expect(Object.keys(team.hooks)).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
    expect(team.hooks.PreToolUse.map((m) => m.matcher)).toEqual(["*", "Bash"]);
    expect(team.hooks.PreToolUse[1].hooks[0].command).toBe("'/usr/bin/node' '/x/hook.mjs' 'merge-guard'");
    expect(stopOf(team)).toBe("'/usr/bin/node' '/x/hook.mjs' 'keepalive' '/e/run' '/d/in' '--first-command=/e/run/.run-jobs/first-command-a'");
    // No keep-alive hook (a read-only run): nothing reads a clock, so none is stamped.
    const readOnly = JSON.parse(inbox.runHookSettings({ node: "/usr/bin/node", script: "/x/hook.mjs", inbox: "/d/in", mergeGuard: false, keepAlive: null, commandClock: "/e/c" })!) as Settings;
    expect(Object.keys(readOnly.hooks)).toEqual(["PostToolUse"]);
    expect(inbox.commandClockPath("/e/run", "mh4x1k2a")).toBe("/e/run/.run-jobs/first-command-mh4x1k2a");
    expect(() => inbox.commandClockPath("/e/run", "../x")).toThrow();
    const made = inbox.createCommandClock(state, "mh4x1k2b");
    expect(fs.readFileSync(made, "utf8")).toBe("");
    // Empty, and no sign the harness runs this spawn's hooks: it cannot answer.
    expect(inbox.commandClockAnswers(made)).toBe(false);
    fs.appendFileSync(made, "1234.56\n");
    expect(inbox.commandClockAnswers(made)).toBe(true);
    expect(inbox.commandClockAnswers(path.join(state, "missing"))).toBe(false);
    fs.writeFileSync(made, "garbled\n");
    expect(inbox.commandClockAnswers(made)).toBe(false);
  });

  it("is marked by the run's own Stop hook, so an unstamped clock answers 'no command ran'", () => {
    const s = settingsWith();
    expect(inbox.commandClockAnswers(clock)).toBe(false);
    const r = spawnSync("sh", ["-c", stopOf(s)], { input: JSON.stringify(STOP), encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(fs.existsSync(`${clock}.stop-ran`)).toBe(true);
    expect(inbox.commandClockAnswers(clock)).toBe(true);
    // A sub-agent's stop is not the run's, and says nothing.
    fs.rmSync(`${clock}.stop-ran`);
    spawnSync("sh", ["-c", stopOf(s)], { input: JSON.stringify({ ...STOP, agent_id: "a1" }), encoding: "utf-8" });
    expect(fs.existsSync(`${clock}.stop-ran`)).toBe(false);
    // A fresh spawn under the same token starts unmarked.
    fs.writeFileSync(`${clock}.stop-ran`, "");
    const again = inbox.createCommandClock(state, "t1");
    expect(again).toBe(clock);
    expect(fs.existsSync(`${clock}.stop-ran`)).toBe(false);
  });

  it("still finds the background shell a tool call left, when the run is not in a scope of its own", () => {
    // The stand-in harness of the test above, stamping its clock first, as the
    // real one does before the tool call that starts the background shell.
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const harness = path.join(bin, "claude");
    const s = settingsWith();
    fs.writeFileSync(
      harness,
      `#!${process.execPath}
const { spawn, spawnSync } = require("child_process");
spawnSync("sh", ["-c", ${JSON.stringify(guardOf(s))}]);
const bg = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
setTimeout(() => {
  const r = spawnSync("sh", ["-c", ${JSON.stringify(stopOf(s))}], { input: JSON.stringify(${JSON.stringify(STOP)}), encoding: "utf-8" });
  process.stdout.write(r.stdout);
  bg.kill("SIGKILL");
}, 300);
`,
      { mode: 0o755 },
    );
    const out = spawnSync(harness, [], { encoding: "utf-8", timeout: 20_000 });
    expect(out.stdout).toMatch(/Processes you started are still running:[\s\S]*sh -c sleep 30/);
  });

  describe("after the run: what it left in its process group (the settle's `leftovers` question)", () => {
    /** A group whose leader starts one sleeper, stamps the clock, starts another and goes: both are orphans of the group now. */
    function leaveGroup(stamp: boolean): number {
      const s = settingsWith();
      const leader = spawn("sh", ["-c", `sleep 31 & sleep 0.2; ${stamp ? 'sh -c "$1";' : ""} sleep 0.05; sleep 32 & exit 0`, "sh", guardOf(s)], { detached: true, stdio: "ignore" });
      leader.unref();
      return leader.pid as number;
    }
    const leftovers = (args: string[]): { seen: number; procs: string[] } => {
      const r = spawnSync(process.execPath, [SCRIPT, "leftovers", ...args], { encoding: "utf-8", timeout: 10_000 });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout) as { seen: number; procs: string[] };
    };
    const settle = async (pgid: number) => {
      // Both sleepers are up and the leader has gone: each is a root of its own.
      await vi.waitFor(
        () => expect(leftovers([`--pgid=${pgid}`]).procs.map((p) => p.replace(/^pid \d+: /, ""))).toEqual(["sleep 31", "sleep 32"]),
        { timeout: 5_000 },
      );
    };

    it("counts what started after the first command, not what was there before it", async () => {
      const pgid = leaveGroup(true);
      try {
        await settle(pgid);
        const out = leftovers([`--first-command=${clock}`, `--pgid=${pgid}`]);
        expect(out.seen).toBe(2);
        expect(out.procs).toHaveLength(1);
        expect(out.procs[0]).toMatch(/^pid \d+: sleep 32$/);
      } finally {
        process.kill(-pgid, "SIGKILL");
      }
    });

    it("counts everything without a clock, as before, and nothing while the clock is unstamped", async () => {
      const pgid = leaveGroup(false);
      try {
        await settle(pgid);
        expect(leftovers([`--pgid=${pgid}`]).procs.map((p) => p.replace(/^pid \d+: /, ""))).toEqual(["sleep 31", "sleep 32"]);
        expect(leftovers([`--first-command=${path.join(state, "gone")}`, `--pgid=${pgid}`]).procs).toHaveLength(2);
        expect(leftovers([`--first-command=${clock}`, `--pgid=${pgid}`])).toEqual({ seen: 2, procs: [] });
      } finally {
        process.kill(-pgid, "SIGKILL");
      }
    });

    it("says it saw nothing, rather than 'nothing is left', where it cannot look", () => {
      expect(leftovers([`--first-command=${clock}`, "--unit=clawbox-run-run-nothere1-zz.scope"])).toEqual({ seen: 0, procs: [] });
    });
  });

  /**
   * In a real scope, the way a run lives on a box: `systemd-run --user --scope`.
   * Skipped where this user has no systemd manager or no unified cgroup (a CI
   * container); the board suite runs it on every box (43-coding-run-keepalive).
   */
  const scopeWorks = (() => {
    const r = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "sh", "-c", 'r=$(sed -n "s/^0:://p" /proc/self/cgroup); test -r "/sys/fs/cgroup$r/cgroup.procs"'], { encoding: "utf-8", timeout: 15_000 });
    return r.status === 0;
  })();

  describe.skipIf(!scopeWorks)("in the run's own scope, with the launcher's watcher in it", () => {
    let unit: string;
    let session: string;
    beforeEach(() => {
      unit = `clawbox-run-run-hooktest-${Date.now().toString(36)}.scope`;
      session = path.join(root, "launcher-session");
      fs.mkdirSync(session);
    });
    afterEach(() => {
      // The watcher and any job outlive the stand-in: the scope goes with them.
      spawnSync("systemctl", ["--user", "stop", unit], { timeout: 15_000 });
    });

    /**
     * A stand-in for the launcher and the harness it becomes: the launcher
     * forks its watcher into a session of its own and lets go of it (init
     * adopts it), with the session folder on its command line; then the
     * harness runs its first tool call — the guard first, as Claude Code runs
     * PreToolUse hooks — which, with `job`, backgrounds a job with nohup that
     * outlives the tool call's shell; then it stops, running the Stop hook.
     */
    function runInScope(job: boolean): string {
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin, { recursive: true });
      const harness = path.join(bin, "claude");
      const s = settingsWith();
      fs.writeFileSync(
        harness,
        `#!${process.execPath}
const { spawnSync } = require("child_process");
spawnSync("sh", ["-c", "setsid sh -c 'while :; do sleep 1; done' launcher --heal-watch \\"$1\\" </dev/null >/dev/null 2>&1 & exit 0", "sh", ${JSON.stringify(session)}], { stdio: "ignore" });
spawnSync("sleep", ["0.3"]);
const guard = ${JSON.stringify(guardOf(s))};
if (guard) spawnSync("sh", ["-c", guard], { input: "{}" });
if (${job}) spawnSync("sh", ["-c", "nohup sh -c 'sleep 30; : run-job' >/dev/null 2>&1 & exit 0"], { stdio: "ignore" });
spawnSync("sleep", ["1.2"]);
const r = spawnSync("sh", ["-c", ${JSON.stringify(stopOf(s))}], { input: JSON.stringify(${JSON.stringify(STOP)}), encoding: "utf-8" });
process.stdout.write(r.stdout);
`,
        { mode: 0o755 },
      );
      const r = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, harness], { encoding: "utf-8", timeout: 30_000 });
      expect(r.status).toBe(0);
      return r.stdout;
    }

    it("lets a run that started nothing stop, though the watcher is in its scope", () => {
      const out = runInScope(false);
      // The watcher really is in the scope, adopted by init, its session folder on its command line.
      const cgroup = spawnSync("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", unit], { encoding: "utf-8" }).stdout.trim();
      const pids = fs.readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, "utf8").split("\n").filter(Boolean);
      const watcher = pids.map((p) => ({ p, argv: fs.readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").join(" ") })).find((x) => x.argv.includes("--heal-watch"));
      expect(watcher?.argv).toContain(session);
      // Adopted: its parent is not in the scope (init, or a subreaper outside it).
      const ppid = fs.readFileSync(`/proc/${watcher?.p}/stat`, "utf8").split(") ")[1].split(" ")[1];
      expect(pids).not.toContain(ppid);
      expect(out).toBe("");
      expect(fs.existsSync(path.join(state, ".run-jobs", "stop-blocks.json"))).toBe(false);
    });

    it("still refuses the stop over a job a tool call backgrounded, after init adopted it — and names only that", () => {
      const out = JSON.parse(runInScope(true)) as { decision: string; reason: string };
      expect(out.decision).toBe("block");
      expect(out.reason).toMatch(/Processes you started are still running:\n- pid \d+: sh -c sleep 30; : run-job\n\n/);
      expect(out.reason).not.toMatch(/heal-watch/);
    });
  });
});
