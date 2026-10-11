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

  it("adds the merge guard for a team's run, and says nothing when there is no hook to give", () => {
    const both = JSON.parse(inbox.runHookSettings({ node: "/usr/bin/node", script: "/x/hook.mjs", inbox: "/d/in", mergeGuard: true })!) as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>> };
    expect(both.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(both.hooks.PreToolUse[0].hooks[0].command).toBe("'/usr/bin/node' '/x/hook.mjs' 'merge-guard'");
    expect(inbox.runHookSettings({ node: "/usr/bin/node", script: "/x/hook.mjs", inbox: null, mergeGuard: false })).toBeNull();
  });
});
