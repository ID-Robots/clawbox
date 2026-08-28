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
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.join(process.cwd(), "scripts", "coding-run-preview");
const SESSION = "61400ab6-0da9-4feb-8ad5-b547239c1367";

// The cases run concurrently — each is a python process that mostly sleeps,
// and the file's time was the sum of their windows — so every case owns its
// working folder rather than sharing one variable; they are all removed at
// the end.
const bases: string[] = [];
function workdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-run-preview-"));
  bases.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of bases) fs.rmSync(dir, { recursive: true, force: true });
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
 * The script's floor for CLAWBOX_PREVIEW_HEARTBEAT. The follow loop checks the
 * file every POLL = 0.5 s, so at this setting the first beat lands on the
 * second check after the last line — about 0.7 s in — and a case waiting for
 * one is not paying for a second of silence first.
 */
const HEARTBEAT_S = 0.2;
/** The script's own file-check interval, in ms; a beat is never earlier. */
const POLL_MS = 500;

interface WatchOptions {
  /**
   * Ctrl-C as soon as the output satisfies this — the window is a ceiling for
   * a view that never gets there, not the time every case spends. Without it
   * each case ran its whole window (2.5–3.5 s) and the file took ~15 s for
   * assertions that were settled in the first second.
   */
  until?: (out: string) => boolean;
  /** Keep watching this long after `until` is met, for "and then nothing more". */
  settleMs?: number;
  /**
   * Called with the whole output each time more arrives. How a case grows the
   * transcript AFTER the view has replayed it: appending on a timer raced the
   * view's own start, and the beat then counted the wrong turn.
   */
  onOutput?: (out: string) => void;
  /** Seconds of silence before a beat; the script's floor unless a case needs more. */
  heartbeatS?: number;
}

/**
 * Run the view until `until` holds (plus `settleMs`), or for `ceilingMs`, then
 * Ctrl-C it the way the terminal would — SIGINT to the whole process group —
 * and hand back what it printed.
 */
function watch(
  args: string[],
  env: Record<string, string>,
  ceilingMs: number,
  { until, settleMs = 0, onOutput, heartbeatS = HEARTBEAT_S }: WatchOptions = {},
): Promise<{ out: string; code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT, ...args], {
      env: { ...process.env, ...env, CLAWBOX_PREVIEW_HEARTBEAT: String(heartbeatS) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let done = false;
    // Ctrl-C is for a view still running at the deadline. A script that ended
    // on its own (no transcript, no arguments) must not leave a timer behind
    // that later signals a process group the OS may have handed to someone
    // else — and keeps the worker's event loop busy for nothing.
    const interrupt = () => {
      try { process.kill(-child.pid!, "SIGINT"); } catch { /* already gone */ }
    };
    let ctrlC = setTimeout(interrupt, ceilingMs);
    const onData = (d: Buffer) => {
      out += String(d);
      onOutput?.(out);
      if (!done && until?.(out)) {
        done = true;
        clearTimeout(ctrlC);
        ctrlC = setTimeout(interrupt, settleMs);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => { clearTimeout(ctrlC); reject(err); });
    // `close`, not `exit`: the process can be gone while its piped stdout is
    // still delivering, and a watch resolved on `exit` could hand back an
    // `out` missing the last lines the view wrote on its way down.
    child.on("close", (code, signal) => { clearTimeout(ctrlC); resolve({ out, code, signal }); });
  });
}

/** The last line the view replays from the fixture: everything before it is on screen. */
const REPLAYED = "✗ 1 failing";
const beat = (out: string) => out.includes("still working");

/**
 * The heartbeat for a case that grows the file: the view must read the new
 * lines BEFORE its first beat, and the append is written from inside the
 * view's first POLL sleep (see growOnceReplayed), so the margin for the
 * worker to react to the replay is the smaller of POLL and the heartbeat. A
 * second of silence keeps it at the full POLL; the cases run concurrently, so
 * the longer wait costs the file nothing.
 */
const GROWTH_HEARTBEAT_S = 1;

/**
 * Append to the transcript once the view has replayed it — from inside the
 * view's first POLL sleep, so the line is read on the next check and the beat
 * that follows counts it. Appending on a timer of our own raced the python
 * start-up.
 */
function growOnceReplayed(file: string, lines: Record<string, unknown>[]): (out: string) => void {
  let grown = false;
  return (out) => {
    if (grown || !out.includes(REPLAYED)) return;
    grown = true;
    fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
}

/** A ceiling no passing case reaches; a hung view fails in this long, not the test timeout. */
const CEILING_MS = 8_000;

describe.concurrent("coding-run-preview", () => {
  it("names the task, shows a line of each thought, and beats while the model is quiet", async () => {
    const base = workdir();
    const file = transcript(path.join(base, "projects", "-home-clawbox-x"));
    const now = Date.now();
    runsFile(base, {
      id: "run-k3x9q2ab", sessionId: SESSION, status: "running", task: "Build a countdown timer",
      startedAt: now - 12 * 60_000, thinkingTokens: 56_000, lastActivityAt: now - 4_000,
    });

    const { out, code } = await watch([file, "run-k3x9q2ab"], { CLAWBOX_ROOT: base }, CEILING_MS, { until: beat });

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
    // The heartbeat, built from the record. Turn 3: two message ids over four
    // assistant lines; the line with no message is not a turn.
    const line = out.split("\n").find(beat);
    expect(line, out).toBeDefined();
    expect(line).toContain("12m in, turn 3");
    expect(line).toContain("thinking 56k tokens");
    expect(line).toMatch(/last activity \d+s ago/);
    // Ctrl-C ended it cleanly.
    expect(code).toBe(0);
  }, 15_000);

  it("finds the record by session id when no run id is given, and says so when there is none", async () => {
    const base = workdir();
    const file = transcript(path.join(base, "projects", "-home-clawbox-x"));
    runsFile(base, { id: "run-other", sessionId: SESSION, status: "running", startedAt: Date.now() - 30_000, thinkingTokens: 900, lastActivityAt: Date.now() });

    const bySession = await watch([file], { CLAWBOX_ROOT: base }, CEILING_MS, { until: beat });
    expect(bySession.out).toContain("thinking 900 tokens");

    // No runs file at all — a run that has not been persisted yet, or a
    // transcript opened from somewhere else. Still a sign of life.
    const none = await watch([file], { CLAWBOX_ROOT: path.join(base, "nowhere") }, CEILING_MS, { until: beat });
    expect(none.out).toContain("still working — waiting for the model");
    expect(none.out).not.toContain("tokens");
  }, 15_000);

  it("keeps following a file that grows, and stops beating once the record says the run is over", async () => {
    const base = workdir();
    const file = transcript(path.join(base, "projects", "-home-clawbox-x"));
    runsFile(base, { id: "run-k3x9q2ab", sessionId: SESSION, status: "completed", startedAt: Date.now() - 30_000 });

    const { out } = await watch([file, "run-k3x9q2ab"], { CLAWBOX_ROOT: base }, CEILING_MS, {
      onOutput: growOnceReplayed(file, [
        { type: "assistant", message: { id: "msg_03", content: [{ type: "text", text: "All done, tests pass." }] } },
      ]),
      until: (o) => o.includes("■ run completed"),
      heartbeatS: GROWTH_HEARTBEAT_S,
      // Long enough for a second beat to have arrived, had beating not stopped.
      settleMs: GROWTH_HEARTBEAT_S * 1000 + 2 * POLL_MS,
    });
    expect(out).toContain("All done, tests pass.");
    expect(out.split("\n").filter((l) => l.includes("■ run completed"))).toHaveLength(1);
    expect(out).not.toContain("still working");
  }, 15_000);

  it("counts a turn per message id as the file grows, not a line per block", async () => {
    const base = workdir();
    const file = transcript(path.join(base, "projects", "-home-clawbox-x"));
    runsFile(base, { id: "run-k3x9q2ab", sessionId: SESSION, status: "running", startedAt: Date.now() - 30_000 });

    const { out } = await watch([file, "run-k3x9q2ab"], { CLAWBOX_ROOT: base }, CEILING_MS, {
      // Turn 3 lands as two lines; the model is then IN turn 4.
      onOutput: growOnceReplayed(file, [
        { type: "assistant", message: { id: "msg_03", content: [{ type: "thinking", thinking: "Now the tests." }] } },
        { type: "assistant", message: { id: "msg_03", content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }] } },
      ]),
      until: beat,
      heartbeatS: GROWTH_HEARTBEAT_S,
    });
    expect(out).toContain("· thinking: Now the tests.");
    const line = out.split("\n").find(beat);
    expect(line, out).toBeDefined();
    expect(line).toContain("turn 4");
  }, 15_000);

  it("refuses to start without a transcript to follow", async () => {
    const base = workdir();
    const missing = await watch([path.join(base, "nope.jsonl")], {}, CEILING_MS);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("No transcript yet");
    const noArgs = await watch([], {}, CEILING_MS);
    expect(noArgs.code).toBe(2);
  }, 15_000);
});
