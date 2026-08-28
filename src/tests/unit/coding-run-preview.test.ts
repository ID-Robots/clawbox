/**
 * scripts/coding-run-preview — the Terminal app's live view of a coding run,
 * run for real against a fixture transcript and a fixture runs file.
 *
 * What it pins is the fix for a view that read as dead: watched on the box, a
 * run at effort "max" sits inside one model turn for ten minutes and more,
 * and in that time the transcript gains nothing. So after HEARTBEAT seconds
 * of silence the view prints a status line from the run record — the
 * reasoning count and the last sign of life are there even when the file is
 * not moving — and a thought that has words shows a line of them rather than
 * a bare "thinking…".
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.join(process.cwd(), "scripts", "coding-run-preview");
const SESSION = "61400ab6-0da9-4feb-8ad5-b547239c1367";

let base: string;
afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

/**
 * A transcript the way Claude Code writes one: the task, then ONE LINE PER
 * CONTENT BLOCK, every line of a turn carrying that turn's message.id. Two
 * turns here, four assistant lines — the view must say "turn 3", which
 * counting lines would put at 5. And one line each with a string and a list
 * where the message should be: not a shape the view has ever been handed by
 * Claude Code, but one odd line must never end the view.
 */
function transcript(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SESSION}.jsonl`);
  const block = (id: string, b: Record<string, unknown>) => ({ type: "assistant", message: { id, role: "assistant", content: [b] } });
  const lines = [
    { type: "queue-operation", operation: "enqueue", sessionId: SESSION },
    { type: "user", message: { role: "user", content: "Build a countdown timer\n\nWork entirely inside this folder." } },
    block("msg_01", { type: "thinking", thinking: "Let me start by understanding the task:\n\n1. Build a polished timer\n2. Verify it", signature: "x" }),
    block("msg_01", { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [
      { content: "Scaffold", status: "completed" },
      { content: "Wire the loop", status: "in_progress", activeForm: "Wiring the game loop" },
    ] } }),
    { type: "assistant", message: "weird" },
    block("msg_02", { type: "thinking", thinking: "   " }),
    { type: "user", message: ["not", "a", "message"] },
    block("msg_02", { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "1 failing" }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function runsFile(root: string, run: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([run]));
}

/**
 * Run the view for `ms`, then Ctrl-C it the way the terminal would — SIGINT
 * to the whole process group — and hand back what it printed.
 */
function watch(args: string[], env: Record<string, string>, ms: number): Promise<{ out: string; code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT, ...args], {
      env: { ...process.env, ...env, CLAWBOX_PREVIEW_HEARTBEAT: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    // Ctrl-C is for a view still running at the deadline. A script that ended
    // on its own (no transcript, no arguments) must not leave a timer behind
    // that later signals a process group the OS may have handed to someone
    // else — and keeps the worker's event loop busy for nothing.
    const ctrlC = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGINT"); } catch { /* already gone */ }
    }, ms);
    child.on("error", (err) => { clearTimeout(ctrlC); reject(err); });
    child.on("exit", (code, signal) => { clearTimeout(ctrlC); resolve({ out, code, signal }); });
  });
}

describe("coding-run-preview", () => {
  it("names the task, shows a line of each thought, and beats while the model is quiet", async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-run-preview-"));
    const file = transcript(path.join(base, "projects", "-home-clawbox-x"));
    const now = Date.now();
    runsFile(base, {
      id: "run-k3x9q2ab", sessionId: SESSION, status: "running", task: "Build a countdown timer",
      startedAt: now - 12 * 60_000, thinkingTokens: 56_000, lastActivityAt: now - 4_000,
    });

    const { out, code } = await watch([file, "run-k3x9q2ab"], { CLAWBOX_ROOT: base }, 3_000);

    expect(out).toContain("── task: Build a countdown timer");
    // The thought itself, on one line, cut — not a bare "thinking…".
    expect(out).toContain("· thinking: Let me start by understanding the task: 1. Build a polished timer 2. Verify it");
    // A thought with no words stays the old bare line.
    expect(out).toContain("· thinking…");
    expect(out).toContain("→ plan: 2 tasks, 1 done");
    expect(out).toContain("● Wiring the game loop");
    expect(out).toContain("→ Bash npm test");
    expect(out).toContain("✗ 1 failing");
    // The odd lines were skipped, not fatal: no traceback, and the view
    // went on to the heartbeat.
    expect(out).not.toContain("Traceback");
    expect(out).not.toContain("weird");
    // The heartbeat, within ~3 s at HEARTBEAT=1, built from the record. Turn
    // 3: two message ids over four assistant lines; the line with no message is not a turn.
    const beat = out.split("\n").find((l) => l.includes("still working"));
    expect(beat, out).toBeDefined();
    expect(beat).toContain("12m in, turn 3");
    expect(beat).toContain("thinking 56k tokens");
    expect(beat).toMatch(/last activity \d+s ago/);
    // Ctrl-C ended it cleanly.
    expect(code).toBe(0);
  }, 15_000);

  it("finds the record by session id when no run id is given, and says so when there is none", async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-run-preview-"));
    const file = transcript(path.join(base, "projects", "-home-clawbox-x"));
    runsFile(base, { id: "run-other", sessionId: SESSION, status: "running", startedAt: Date.now() - 30_000, thinkingTokens: 900, lastActivityAt: Date.now() });

    const bySession = await watch([file], { CLAWBOX_ROOT: base }, 2_500);
    expect(bySession.out).toContain("thinking 900 tokens");

    // No runs file at all — a run that has not been persisted yet, or a
    // transcript opened from somewhere else. Still a sign of life.
    const none = await watch([file], { CLAWBOX_ROOT: path.join(base, "nowhere") }, 2_500);
    expect(none.out).toContain("still working — waiting for the model");
    expect(none.out).not.toContain("tokens");
  }, 15_000);

  it("keeps following a file that grows, and stops beating once the record says the run is over", async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-run-preview-"));
    const file = transcript(path.join(base, "projects", "-home-clawbox-x"));
    runsFile(base, { id: "run-k3x9q2ab", sessionId: SESSION, status: "completed", startedAt: Date.now() - 30_000 });
    setTimeout(() => {
      fs.appendFileSync(file, JSON.stringify({ type: "assistant", message: { id: "msg_03", content: [{ type: "text", text: "All done, tests pass." }] } }) + "\n");
    }, 500);

    const { out } = await watch([file, "run-k3x9q2ab"], { CLAWBOX_ROOT: base }, 3_500);
    expect(out).toContain("All done, tests pass.");
    expect(out.split("\n").filter((l) => l.includes("■ run completed"))).toHaveLength(1);
    expect(out).not.toContain("still working");
  }, 15_000);

  it("counts a turn per message id as the file grows, not a line per block", async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-run-preview-"));
    const file = transcript(path.join(base, "projects", "-home-clawbox-x"));
    runsFile(base, { id: "run-k3x9q2ab", sessionId: SESSION, status: "running", startedAt: Date.now() - 30_000 });
    setTimeout(() => {
      // Turn 3 lands as two lines; the model is then IN turn 4.
      fs.appendFileSync(file, [
        { type: "assistant", message: { id: "msg_03", content: [{ type: "thinking", thinking: "Now the tests." }] } },
        { type: "assistant", message: { id: "msg_03", content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }] } },
      ].map((l) => JSON.stringify(l)).join("\n") + "\n");
    }, 300);

    const { out } = await watch([file, "run-k3x9q2ab"], { CLAWBOX_ROOT: base }, 3_000);
    expect(out).toContain("· thinking: Now the tests.");
    const beat = out.split("\n").find((l) => l.includes("still working"));
    expect(beat, out).toBeDefined();
    expect(beat).toContain("turn 4");
  }, 15_000);

  it("refuses to start without a transcript to follow", async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-run-preview-"));
    const missing = await watch([path.join(base, "nope.jsonl")], {}, 2_000);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("No transcript yet");
    const noArgs = await watch([], {}, 2_000);
    expect(noArgs.code).toBe(2);
  }, 15_000);
});
