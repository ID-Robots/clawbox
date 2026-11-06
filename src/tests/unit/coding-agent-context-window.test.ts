/**
 * A ClawBox AI run whose provider refuses a request past the model's context
 * window (TASK-2203) — end to end, through the real runner and a fake harness.
 *
 * The field failure: a run on `deepseek-v4-pro[1m]` died 1,697 turns in on
 * DeepSeek's own 400 — "This model's maximum context length is 1048576 tokens.
 * However, you requested 1049351 tokens (1017351 in the messages, 32000 in the
 * completion)" — with its session intact and full. What must hold now:
 *
 *  - the run is carried on IN PLACE: the same record, `--resume` of the same
 *    session, back to "running" with nothing settled in between, and its
 *    timeline says so;
 *  - that spawn, and only that one, asks for a reply that fits beside the
 *    context (CLAUDE_CODE_MAX_OUTPUT_TOKENS), because Claude Code compacts it
 *    first and the compaction request is the whole context plus that reply;
 *  - it is bounded, and a run it cannot carry on fails with the numbers and
 *    the provider's own words instead of "Claude Code reported an error";
 *  - nothing else changes: an ordinary 400 is still a failure, and an
 *    Anthropic run is never carried on this way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { decodeHarnessTurns, readFirstTurn } from "@/tests/helpers/fake-harness";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/coding-agent-notify", () => ({
  announceCodingAgent: vi.fn(async () => undefined),
  announceCodingRunToChat: vi.fn(async () => undefined),
  announceAnthropicLimit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let restore: () => void;

const SESSION = "sess-window-1";
/** The refusal exactly as the field run reported it. */
const FIELD_400 = "API Error: 400 This model's maximum context length is 1048576 tokens. However, you requested 1049351 tokens (1017351 in the messages, 32000 in the completion). Please reduce the length of the messages or completion.";
/** One that went so far past the window in one step that no summary fits beside it. */
const FAR_400 = "API Error: 400 This model's maximum context length is 1048576 tokens. However, you requested 1078000 tokens (1046000 in the messages, 32000 in the completion). Please reduce the length of the messages or completion.";

function sq(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: SESSION, model: "deepseek-v4-pro[1m]" });
const result = (text: string, isError: boolean) => JSON.stringify({ type: "result", subtype: "success", is_error: isError, result: text, num_turns: 3 });

function callsLog(): string {
  return path.join(base, "calls.log");
}

interface Call { n: number; reply: string; args: string; turn: string }

function calls(): Call[] {
  if (!fs.existsSync(callsLog())) return [];
  return fs.readFileSync(callsLog(), "utf-8").trim().split("\n").filter(Boolean).map((line) => {
    const m = /^call (\d+) reply=(.*?) args=(.*)$/.exec(line);
    const n = Number(m?.[1]);
    const turnFile = path.join(base, `turn-${n}`);
    const raw = fs.existsSync(turnFile) ? fs.readFileSync(turnFile, "utf-8") : "";
    return { n, reply: m?.[2] ?? "", args: m?.[3] ?? "", turn: decodeHarnessTurns(raw).join("\n") || raw };
  });
}

/**
 * A fake claude-ds that does, on its Nth spawn, what line N of the plan says:
 * `overflow` / `far` (a session, then the provider's context-length refusal as
 * a failed result), `bad` (an ordinary 400), or `ok`. It logs the reply cap it
 * was handed and its argv, and keeps the turn it was told.
 */
function installWrapper(plan: readonly ("overflow" | "far" | "bad" | "ok")[]): void {
  fs.writeFileSync(path.join(base, "plan"), `${plan.join("\n")}\n`);
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      `counter=${sq(path.join(base, "counter"))}`,
      'n=$(cat "$counter" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$counter"',
      // Double-quoted by readFirstTurn, so the shell fills in this spawn's number.
      readFirstTurn(path.join(base, "turn-$n")),
      `printf 'call %s reply=%s args=%s\\n' "$n" "\${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-}" "$*" >> ${sq(callsLog())}`,
      `mode=$(sed -n "\${n}p" ${sq(path.join(base, "plan"))})`,
      'case "$mode" in',
      `  overflow) printf '%s\\n' ${sq(INIT)} ${sq(result(FIELD_400, true))}; exit 1 ;;`,
      `  far) printf '%s\\n' ${sq(INIT)} ${sq(result(FAR_400, true))}; exit 1 ;;`,
      `  bad) printf '%s\\n' ${sq(INIT)} ${sq(result('API Error: 400 {"error":{"message":"Bad request","type":"invalid_request_error"}}', true))}; exit 1 ;;`,
      `  *) printf '%s\\n' ${sq(INIT)} ${sq(result("Done.", false))}; exit 0 ;;`,
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-window-")));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  writeConfig({ clawai_token: "claw_test_token", clawai_tier: "pro", coding_agent_enabled: true });
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function settled(id: string) {
  // The carry-on puts the record straight back to "running", so a single wait
  // can wake on the first settle; wait until it really stops.
  for (let i = 0; i < 40; i += 1) {
    const run = await lib.waitForRun(id, 20_000);
    if (!run) throw new Error("run vanished");
    if (run.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const again = lib.getRun(id);
      if (again && again.status !== "running") return again;
    }
  }
  throw new Error("run never settled");
}

async function runWith(plan: readonly ("overflow" | "far" | "bad" | "ok")[]) {
  installWrapper(plan);
  makeProject("site");
  const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
  return { started, run: await settled(started.id) };
}

describe("a ClawBox AI run that outgrew its context window", () => {
  it("is carried on in the SAME session, compacted, with a reply that fits — and finishes", async () => {
    const { started, run } = await runWith(["overflow", "ok"]);

    expect(run.id).toBe(started.id);
    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    expect(run.contextRecoveries).toBe(1);
    // Not the transient retry, which starts a fresh session.
    expect(run.retries).toBe(0);
    expect(run.sessionId).toBe(SESSION);
    const [first, second] = calls();
    expect(calls()).toHaveLength(2);
    // The first spawn asks for Claude Code's own reply; the carry-on resumes the
    // session and asks for what fits: 1,048,576 − 1,017,351 − 4,096 is past the
    // 20,000 cap, so 20,000.
    expect(first.reply).toBe("");
    expect(first.args).not.toContain("--resume");
    expect(second.args).toContain(`--resume ${SESSION}`);
    expect(second.reply).toBe("20000");
    expect(second.turn).toContain("outgrown the model's context window");
    expect(second.turn).toContain("do not start over");
    expect(run.progress).toContain(
      "The conversation outgrew the model's context window (1017351 of 1048576 tokens); compacting it and carrying on in the same session (attempt 1 of 2)",
    );
  });

  it("is bounded: past MAX_CONTEXT_RECOVERIES it fails, saying so with the numbers and the provider's words", async () => {
    const { run } = await runWith(["overflow", "overflow", "overflow", "ok"]);

    expect(calls()).toHaveLength(3);
    expect(run.status).toBe("failed");
    expect(run.contextRecoveries).toBe(2);
    expect(run.error).toContain("The conversation outgrew the model's context window (1,017,351 tokens of context plus 32,000 for the reply against a 1,048,576-token window)");
    expect(run.error).toContain("carried it on 2 times");
    expect(run.error).toContain("This model's maximum context length is 1048576 tokens");
    expect(run.error).not.toContain("Claude Code reported an error");
  });

  it("fails at once, with the reason, when not even a summary fits beside the context", async () => {
    const { run } = await runWith(["far", "ok"]);

    expect(calls()).toHaveLength(1);
    expect(run.status).toBe("failed");
    expect(run.contextRecoveries ?? 0).toBe(0);
    expect(run.error).toContain("not even a summary of it fits");
    expect(run.error).toContain("1,046,000 tokens of context");
  });

  it("leaves an ordinary 400 a failure, carried on by nothing", async () => {
    const { run } = await runWith(["bad", "ok"]);

    expect(calls()).toHaveLength(1);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Bad request");
    expect(run.contextRecoveries ?? 0).toBe(0);
  });

  it("asks every later spawn for Claude Code's own reply again", async () => {
    // A recovery's cap belongs to the spawn that compacts; nothing else inherits it.
    const { run } = await runWith(["overflow", "ok"]);
    expect(run.status).toBe("completed");
    const env = lib.buildRunEnv({ provider: "clawbox-ai" });
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });
});

describe("an Anthropic run with the same words", () => {
  it("is not carried on: its refusal is the one Claude Code compacts on itself", async () => {
    writeConfig({ clawai_token: "claw_test_token", clawai_tier: "pro", coding_agent_enabled: true, coding_agent_provider: "anthropic", anthropic_api_key: "sk-ant-api03-test-key-000000000000000000" });
    installWrapper(["overflow", "ok"]);
    makeProject("site");
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" });
    const run = await settled(started.id);

    expect(calls()).toHaveLength(1);
    expect(run.status).toBe("failed");
    expect(run.contextRecoveries ?? 0).toBe(0);
    expect(run.error).toContain("maximum context length");
  });
});

describe("buildRunEnv's reply cap", () => {
  it("is set only when asked, for Claude Code only, and no secret can undo it", () => {
    expect(lib.buildRunEnv({ provider: "clawbox-ai" }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(lib.buildRunEnv({ provider: "clawbox-ai", maxReplyTokens: 20_000 }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("20000");
    expect(lib.buildRunEnv({ provider: "openai", maxReplyTokens: 20_000 }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(lib.buildRunEnv({ provider: "clawbox-ai", maxReplyTokens: 0 }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    const env = lib.buildRunEnv({ provider: "clawbox-ai", maxReplyTokens: 8192, secrets: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" } });
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8192");
  });
});
