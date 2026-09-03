import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

/** Undo for the environment each case below rewrites. */
let restoreEnv: () => void = () => {};

/**
 * The Hermes chat turn, on the thing the customer actually saw: the model's
 * internal monologue pasted into the reply bubble, twice, above the answer.
 *
 * THE CAPTURE BELOW IS REAL. It is what `hermes chat -q "Hey" -Q -m
 * deepseek-v4-flash` printed on the bench box on 2026-08-23, byte for byte
 * including the CRLFs and the missing bottom frame. That last detail is the
 * whole bug: the CLI opens the reasoning box and never closes it in quiet mode,
 * so a parser that trusts the frame either eats the answer or hands back the
 * lot. Which is why the route now asks the agent's own record first.
 */

const CRLF = "\r\n";
const MONOLOGUE_A = 'The user just said "Hey" - a simple greeting. I should respond warmly';
const MONOLOGUE_B = " and briefly. No need for tools here.";
/** The whole monologue as the recap prints it — one unbroken line. */
const MONOLOGUE_FULL = `${MONOLOGUE_A}${MONOLOGUE_B}`;

/** Opening frame at the width the box printed, and NO closing frame. */
const UNCLOSED_PANEL = [
  "",
  `┌─ Reasoning ${"─".repeat(66)}┐`,
  MONOLOGUE_A,
  // The second producer's copy runs straight onto the first with no newline.
  `${MONOLOGUE_B}${MONOLOGUE_FULL}`,
  "Hey! What can I help you with today?",
].join(CRLF);

const spawned: Array<{ bin: string; args: string[] }> = [];
let stdoutReply = UNCLOSED_PANEL;
let stderrBanner = "session_id: 20260823_140811_e999fd";

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: (bin: string, args: string[]) => {
    spawned.push({ bin, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (stdoutReply) child.stdout.emit("data", Buffer.from(stdoutReply));
      if (stderrBanner) child.stderr.emit("data", Buffer.from(stderrBanner));
      child.emit("close", 0);
    }, 0);
    return child;
  },
}));

vi.mock("@/lib/hermes-model-options", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-model-options")>()),
  getModelOptions: async () => {
    throw new Error("catalogue unavailable");
  },
}));

vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => "hermes",
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));

/**
 * The agent's record for the turn. `null` stands for every way reading it can
 * fail — no `node:sqlite`, no database, a column that moved — which is the case
 * that has to fall back to the console text rather than lose the reply.
 */
let turnRecord: unknown = null;
// Answering "" for the billing read keeps this file about reasoning, and
// keeps the mock complete: an omitted export the route imports fails as a
// missing-export error rather than as the assertion it was written for.
vi.mock("@/lib/harness/hermes-turn-record", () => ({
  readHermesTurn: async () => turnRecord,
  readHermesUsageMarks: async () => null,
  readHermesBillingProvider: async () => "",
}));

let root: string;

async function post(body: Record<string, unknown>) {
  vi.resetModules();
  const { POST } = await import("@/app/setup-api/hermes/chat/route");
  return POST(
    new Request("http://localhost/setup-api/hermes/chat", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

const transcript = () =>
  fs
    .readFileSync(path.join(root, "data", "chat-transcripts", "desktop.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe("POST /setup-api/hermes/chat — the monologue, separated from the answer", () => {
  beforeEach(() => {
    spawned.length = 0;
    stdoutReply = UNCLOSED_PANEL;
    stderrBanner = "session_id: 20260823_140811_e999fd";
    turnRecord = null;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-reasonfix-"));
    restoreEnv = saveEnv("CLAWBOX_ROOT", "HOME", "OPENCLAW_HOME");
    process.env.CLAWBOX_ROOT = root;
    process.env.HOME = root;
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("answers with the reply alone and the thinking beside it", async () => {
    turnRecord = {
      text: "Hey! What can I help you with today?",
      reasoning: MONOLOGUE_FULL,
    };
    const res = await post({ message: "Hey", model: "deepseek-v4-flash" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.text).toBe("Hey! What can I help you with today?");
    // The bug, pinned: not one word of the monologue in the bubble.
    expect(body.text).not.toContain("The user just said");
    expect(body.reasoning).toBe(MONOLOGUE_FULL);
  });

  it("stores the monologue ONCE, however many times the console printed it", async () => {
    turnRecord = {
      text: "Hey! What can I help you with today?",
      reasoning: MONOLOGUE_FULL,
    };
    const res = await post({ message: "Hey" });
    const body = await res.json();
    const copies = body.reasoning.split("The user just said").length - 1;
    expect(copies).toBe(1);
  });

  it("writes the answer, the thinking and the steps to the transcript as separate fields", async () => {
    turnRecord = {
      text: "It printed: Linux 5.15.185-tegra",
      reasoning: "Let me run it.",
      toolCalls: [{ name: "terminal", detail: "uname -sr", status: "ok" }],
    };
    await post({ message: "run uname -sr" });
    const rows = transcript();
    const assistant = rows.find((row) => row.role === "assistant");

    expect(assistant.text).toBe("It printed: Linux 5.15.185-tegra");
    expect(assistant.reasoning).toBe("Let me run it.");
    expect(assistant.toolCalls).toEqual([
      { name: "terminal", detail: "uname -sr", status: "ok" },
    ]);
    // The stored answer must not carry what was pulled out of it, or a refresh
    // puts the monologue straight back on screen.
    expect(assistant.text).not.toContain("Let me run it.");
  });

  it("reports the tools the agent used", async () => {
    turnRecord = {
      text: "Done.",
      toolCalls: [
        { name: "terminal", detail: "uname -sr", status: "ok" },
        { name: "web_search", detail: "jetson", status: "error" },
      ],
    };
    const body = await (await post({ message: "go" })).json();
    expect(body.toolCalls).toHaveLength(2);
    expect(body.toolCalls[0]).toEqual({ name: "terminal", detail: "uname -sr", status: "ok" });
    expect(body.toolCalls[1].status).toBe("error");
  });

  it("says nothing about reasoning or tools on a turn that had neither", async () => {
    turnRecord = { text: "Hello." };
    stdoutReply = "Hello.";
    const body = await (await post({ message: "hi" })).json();
    expect(body.text).toBe("Hello.");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("toolCalls");
    expect(transcript().find((row) => row.role === "assistant")).not.toHaveProperty("reasoning");
  });

  it("falls back to the console text when the agent's record cannot be read", async () => {
    // The record is unavailable (turnRecord stays null) and the capture is the
    // unclosed-panel shape. There is no marker in it that separates thinking
    // from answer, so the rule is to hand the reply back UNTOUCHED rather than
    // risk eating it — the reply survives, the panel is simply not offered.
    turnRecord = null;
    const res = await post({ message: "Hey" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toContain("Hey! What can I help you with today?");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("still separates a CLOSED panel with no record to fall back on", async () => {
    // The console parse is not dead code: when the CLI does close its frame,
    // this path alone produces a clean answer and a panel to collapse.
    turnRecord = null;
    stdoutReply = [
      `┌─ Reasoning ${"─".repeat(45)}┐`,
      "Thinking about the question.",
      `└${"─".repeat(58)}┘`,
      "The answer is 42.",
    ].join(CRLF);
    const body = await (await post({ message: "q" })).json();
    expect(body.text).toBe("The answer is 42.");
    expect(body.reasoning).toBe("Thinking about the question.");
  });

  it("keeps the session id it was already threading", async () => {
    turnRecord = { text: "ok" };
    const body = await (await post({ message: "hi" })).json();
    expect(body.sessionId).toBe("20260823_140811_e999fd");
  });
});
