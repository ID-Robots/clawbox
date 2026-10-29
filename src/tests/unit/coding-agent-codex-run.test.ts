/**
 * An `openai` run end to end through the real runner — spawn, stream, settle,
 * commit — against a fake `codex` in ~/.local/bin that writes down what it was
 * handed and prints `codex exec --json` events, as the Claude path is tested
 * against a fake claude-ds (coding-agent-cost-learning.test.ts).
 *
 * What is pinned: the run is Codex, not Claude Code; it is started in its own
 * folder with the coding agent's own CODEX_HOME and nothing of the wrapper's;
 * its feed, changed files, tokens, model and closing words land on the same
 * record the app reads; its work is committed like any run's; a resume goes
 * back into the same Codex thread and bills only what it added; and OpenAI's
 * usage limit is remembered as the provider's "limited", holding the next run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

// Starts real processes (bash / git): see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/coding-run-cpu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-run-cpu")>();
  return { ...actual, hostCpuCount: () => 8, onBatteryPower: vi.fn(async () => false) };
});

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let artifactsDir: (runId: string) => string;
let base: string;
let home: string;
let root: string;
let binDir: string;
let projects: string;
let restore: () => void;

/** A placeholder in the shape of an OpenAI project key — not a real credential. */
const KEY = "sk-proj-codex-run-test-placeholder-000000";
const THREAD = "01a1827d-0000-7000-8000-00000000c0de";

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ coding_agent_enabled: true, coding_agent_default_directory: projects, ...cfg }), "utf-8");
}

/** Sign the coding agent's Codex in to ChatGPT, the way `codex login` leaves it. */
function signInWithChatGPT(): void {
  const codexHome = path.join(root, "data", "coding-agent-codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh" } }));
}

/**
 * The fake CLI. What it prints depends on a mode file in the test's HOME (the
 * run's environment is built from scratch, so it cannot be told any other way):
 *
 *   ok      a whole turn — a command, a file it writes, its closing words
 *   resume  the same thread continued: its usage is the thread's cumulative figure
 *   limit   OpenAI's usage limit
 *   echo    closing words that quote the API key it was handed
 */
function installCodex(): void {
  fs.writeFileSync(path.join(binDir, "codex"), [
    "#!/usr/bin/env bash",
    'out="$CLAWBOX_RUN_ARTIFACTS_DIR"',
    'cat > "$out/stdin.txt"',
    'printf "%s\\n" "$@" > "$out/argv.txt"',
    'env > "$out/env.txt"',
    'pwd > "$out/cwd.txt"',
    'mode=$(cat "$HOME/codex-mode" 2>/dev/null || echo ok)',
    'ev() { printf "%s\\n" "$1"; }',
    `ev '{"type":"thread.started","thread_id":"${THREAD}"}'`,
    "ev '{\"type\":\"turn.started\"}'",
    'case "$mode" in',
    "  limit)",
    "    ev '{\"type\":\"error\",\"message\":\"Reconnecting... 1/5 (429 Too Many Requests)\"}'",
    "    ev '{\"type\":\"turn.failed\",\"error\":{\"message\":\"You'\"'\"'ve hit your usage limit. Try again in 2 hours.\"}}'",
    "    exit 1 ;;",
    "  resume)",
    "    ev '{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"agent_message\",\"text\":\"Followed up.\"}}'",
    "    ev '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":20000,\"cached_input_tokens\":14000,\"output_tokens\":900}}'",
    "    exit 0 ;;",
    "  echo)",
    '    ev "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"id\\":\\"item_0\\",\\"type\\":\\"agent_message\\",\\"text\\":\\"My key is ${CODEX_API_KEY:-none}.\\"}}"',
    "    ev '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"output_tokens\":5}}'",
    "    exit 0 ;;",
    "esac",
    "ev '{\"type\":\"item.started\",\"item\":{\"id\":\"item_0\",\"type\":\"reasoning\",\"text\":\"\"}}'",
    "ev '{\"type\":\"item.started\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\",\"command\":\"bash -lc ls\",\"status\":\"in_progress\"}}'",
    "ev '{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\",\"command\":\"bash -lc ls\",\"aggregated_output\":\"README.md\",\"exit_code\":0,\"status\":\"completed\"}}'",
    "printf 'hello\\n' > hello.txt",
    'ev "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"id\\":\\"item_2\\",\\"type\\":\\"file_change\\",\\"changes\\":[{\\"path\\":\\"$PWD/hello.txt\\",\\"kind\\":\\"add\\"}],\\"status\\":\\"completed\\"}}"',
    "ev '{\"type\":\"item.updated\",\"item\":{\"id\":\"item_3\",\"type\":\"todo_list\",\"items\":[{\"text\":\"Write hello.txt\",\"completed\":true},{\"text\":\"Say so\",\"completed\":false}]}}'",
    "ev '{\"type\":\"item.completed\",\"item\":{\"id\":\"item_4\",\"type\":\"agent_message\",\"text\":\"Added hello.txt.\"}}'",
    "ev '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12000,\"cached_input_tokens\":8000,\"output_tokens\":500}}'",
    "exit 0",
  ].join("\n"), { mode: 0o755 });
}

const setMode = (mode: string) => fs.writeFileSync(path.join(home, "codex-mode"), mode);
const handed = (runId: string, what: "argv" | "env" | "stdin" | "cwd") => fs.readFileSync(path.join(artifactsDir(runId), `${what}.txt`), "utf8");

function makeGitProject(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

async function finished(id: string) {
  const run = await lib.waitForRun(id, 20_000);
  if (!run) throw new Error("run vanished");
  return run;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-codex-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({ coding_agent_provider: "openai", coding_agent_providers: ["openai"] });
  installCodex();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
  artifactsDir = (await import("@/lib/coding-agent-artifacts")).artifactsDir;
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("an OpenAI run", () => {
  it("is refused, naming OpenAI, while no OpenAI account is connected", async () => {
    makeGitProject("site");
    await expect(lib.startRun({ task: "add hello.txt", directory: "site", source: "owner" })).rejects.toThrow(/OpenAI account is not connected/);
  });

  it("runs on Codex in its own folder, and lands on the record the app reads", async () => {
    const dir = makeGitProject("site");
    signInWithChatGPT();
    const started = await lib.startRun({ task: "add hello.txt", directory: "site", source: "owner" });
    expect(started).toMatchObject({ provider: "openai", requestedModel: "gpt-6-astra" });
    const run = await finished(started.id);

    // What the CLI was handed.
    const argv = handed(run.id, "argv").trim().split("\n");
    expect(argv.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-6-astra");
    expect(argv).toContain('approval_policy="never"');
    expect(argv).toContain('sandbox_mode="danger-full-access"');
    // The owner's default effort, xhigh, as Codex's own word for it.
    expect(argv).toContain('model_reasoning_effort="xhigh"');
    expect(argv.find((a) => a.startsWith("developer_instructions="))).toMatch(/You have no helper agents/);
    expect(argv[argv.length - 1]).toBe("-");
    expect(handed(run.id, "stdin")).toContain("add hello.txt");
    expect(handed(run.id, "cwd").trim()).toBe(fs.realpathSync(run.directory));
    const env = handed(run.id, "env");
    expect(env).toContain(`CODEX_HOME=${path.join(root, "data", "coding-agent-codex")}\n`);
    expect(env).not.toMatch(/^CLAUDE_/m);
    // On the ChatGPT sign-in: no key in the environment at all.
    expect(env).not.toMatch(/^CODEX_API_KEY=/m);
    // The kill fence, as execpolicy rules in that same home.
    expect(fs.readFileSync(path.join(root, "data", "coding-agent-codex", "rules", "clawbox.rules"), "utf8")).toContain('prefix_rule(pattern = ["pkill"], decision = "forbidden"');

    // What the record says.
    expect(run).toMatchObject({
      status: "completed",
      provider: "openai",
      model: "gpt-6-astra",
      modelsUsed: ["gpt-6-astra"],
      sessionId: THREAD,
      commandsRun: 1,
      filesTouched: ["hello.txt"],
      summary: "Added hello.txt.",
      numTurns: 1,
      error: null,
    });
    // Fresh input, the cached prefix and output, billed the way the record bills.
    expect(run.tokenBreakdown).toMatchObject({ input: 4_000, cacheRead: 8_000, output: 500, cacheCreation: 0 });
    expect(run.tokensUsed).toBe(12_500);
    expect(run.progress).toEqual(expect.arrayContaining(["Started with gpt-6-astra", "Thinking…", "$ ls", "Edit hello.txt", "Plan: 2 tasks, 1 done", "Added hello.txt."]));
    expect(run.todos).toEqual([{ content: "Write hello.txt", status: "completed" }, { content: "Say so", status: "pending" }]);
    // Committed like any run's work.
    expect(run.commit).toBeTruthy();
    // (on the run's own branch: a git project's run works in a worktree of its own)
    expect(git(dir, "show", "--name-only", "--format=%s", run.commit!)).toContain("hello.txt");
    // And after a reload.
    expect(lib.getRun(run.id)).toMatchObject({ provider: "openai", sessionId: THREAD, tokensUsed: 12_500 });
  });

  it("goes back into the same Codex thread on a resume, and bills only what it added", async () => {
    makeGitProject("site");
    signInWithChatGPT();
    const first = await finished((await lib.startRun({ task: "add hello.txt", directory: "site", source: "owner" })).id);
    setMode("resume");
    const second = await finished((await lib.startRun({ task: "and say hi", resumeRunId: first.id, source: "owner" })).id);
    const argv = handed(second.id, "argv").trim().split("\n");
    expect(argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(argv.slice(-2)).toEqual([THREAD, "-"]);
    expect(second).toMatchObject({ status: "completed", provider: "openai", sessionId: THREAD, summary: "Followed up." });
    // The thread reported 20k/14k/900 in all; the first run had billed 12k/8k/500.
    expect(second.tokenBreakdown).toMatchObject({ input: 2_000, cacheRead: 6_000, output: 400 });
    expect(second.tokensUsed).toBe(8_400);
  });

  it("is handed the owner's saved key as CODEX_API_KEY, and never lets it onto the record", async () => {
    makeGitProject("site");
    fs.writeFileSync(path.join(root, "data", ".session-secret"), "9d".repeat(32), { mode: 0o600 });
    process.env.SESSION_SECRET = "the-web-servers-secret";
    await (await import("@/lib/coding-openai")).setOpenAIKey(KEY);
    setMode("echo");
    const run = await finished((await lib.startRun({ task: "say your key", directory: "site", source: "owner" })).id);
    expect(handed(run.id, "env")).toContain(`CODEX_API_KEY=${KEY}\n`);
    // Not in argv: argv is world-readable in /proc.
    expect(handed(run.id, "argv")).not.toContain(KEY);
    expect(run.status).toBe("completed");
    expect(JSON.stringify(lib.getRun(run.id))).not.toContain(KEY);
    expect(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf8")).not.toContain(KEY);
  });

  it("remembers OpenAI's usage limit as the provider's, and holds the next run until it is over", async () => {
    makeGitProject("site");
    signInWithChatGPT();
    setMode("limit");
    const run = await finished((await lib.startRun({ task: "add hello.txt", directory: "site", source: "owner" })).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/OpenAI turned this run away at its usage limit/);
    // The thread did start, so it can be carried on once the limit is over.
    expect(run.resumable).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf8")) as Record<string, unknown>;
    const until = config.coding_agent_openai_limited_until as number;
    expect(until).toBeGreaterThan(Date.now() + 100 * 60_000);
    expect((await (await import("@/lib/coding-openai")).getOpenAIConnection()).status).toBe("limited");
    // The next run waits rather than spending itself on the same refusal.
    const next = await lib.startRun({ task: "again", directory: "site", source: "owner" }).then(() => null, (e: unknown) => e);
    expect(next).toBeInstanceOf(lib.CodingAgentError);
    expect((next as InstanceType<Lib["CodingAgentError"]>).kind).toBe("limited");
  });
});
