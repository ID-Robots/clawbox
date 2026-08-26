/**
 * The coding agent runner (src/lib/coding-agent.ts) against a FAKE claude-ds.
 *
 * The properties pinned here are the ones a reviewer cannot see from the
 * argv alone: that the switch and the readiness checks refuse before anything
 * is spawned, that the working-folder rules keep a run out of the OS checkout
 * and the credential folders, that the run inherits an explicit environment
 * (not the web server's, which carries the session secret), that the task
 * travels on stdin, that Claude Code's stream-json becomes a faithful run
 * record on disk, and that a run the previous server lost is settled as
 * failed instead of being reported as running forever.
 *
 * The fake wrapper is installed at $HOME/.local/bin/claude-ds — the path
 * install.sh uses — so the test also proves the runner looks where the
 * installer puts it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const announce = vi.hoisted(() => vi.fn<(run: unknown) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: announce }));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let restore: () => void;

const argvFile = () => path.join(base, "argv.txt");
const envFile = () => path.join(base, "env.txt");
const stdinFile = () => path.join(base, "stdin.txt");
const runsFile = () => path.join(root, "data", "coding-agent-runs.json");

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/** A stand-in for Claude Code: only has to exist and be executable. */
function installFakeClaude(): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
}

/**
 * A stand-in for the wrapper. Records argv, env and stdin, then runs `body`
 * (bash) which prints whatever stream-json the test wants.
 */
function installFakeWrapper(body: string): void {
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > "${argvFile()}"`,
      `env > "${envFile()}"`,
      `cat > "${stdinFile()}"`,
      "echo 'claude-ds: ClawBox AI (deepseek-v4-flash) — state in /tmp/x' >&2",
      body,
    ].join("\n"),
    { mode: 0o755 },
  );
}

const INIT = '{"type":"system","subtype":"init","session_id":"sess-abc-123","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';
const ASSISTANT = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Working on it" },
      { type: "tool_use", name: "Edit", input: { file_path: "index.html" } },
      { type: "tool_use", name: "Write", input: { file_path: "__DIR__/style.css" } },
      { type: "tool_use", name: "Bash", input: { command: "npm test" } },
    ],
  },
});
const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 3,
  total_cost_usd: 0.12,
  result: "Changed index.html and style.css. Verify by opening index.html.",
  permission_denials: [{ tool_name: "Bash", tool_input: { command: "curl http://example" } }],
  session_id: "sess-abc-123",
});

const HAPPY_BODY = [
  `echo '${INIT}'`,
  `echo '${ASSISTANT}' | sed "s|__DIR__|$PWD|"`,
  `echo '${RESULT}'`,
  "exit 0",
].join("\n");

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

function readyDevice(): void {
  installFakeClaude();
  installFakeWrapper(HAPPY_BODY);
  writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true });
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-"));
  home = path.join(base, "home");
  root = path.join(base, "clawbox");
  binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  // What the web server's own environment carries and a run must not.
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  writeConfig({});
  announce.mockClear();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(() => {
  lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

async function finished(id: string) {
  const run = await lib.waitForRun(id, 15_000);
  if (!run) throw new Error("run vanished");
  return run;
}

describe("readiness", () => {
  it("names each missing piece in the owner's words", async () => {
    const r = await lib.checkReadiness();
    expect(r.ready).toBe(false);
    expect(r.claudeInstalled).toBe(false);
    expect(r.wrapperInstalled).toBe(false);
    expect(r.clawaiConnected).toBe(false);
    expect(r.problems.join("\n")).toMatch(/Claude Code is not installed/);
    expect(r.problems.join("\n")).toMatch(/claude-ds wrapper is missing/);
    expect(r.problems.join("\n")).toMatch(/ClawBox AI is not connected/);
  });

  it("is ready once the installer's files and a ClawBox AI token are there", async () => {
    readyDevice();
    const r = await lib.checkReadiness();
    expect(r).toMatchObject({
      ready: true, claudeInstalled: true, wrapperInstalled: true, clawaiConnected: true,
      capabilityDropAvailable: true, problems: [],
    });
  });

  it("counts the capability stripper among the things a run needs", async () => {
    readyDevice();
    // setpriv is util-linux; if it ever is not here, a run must not start at
    // all rather than start holding the web server's network capabilities.
    expect(await lib.findExecutableOnPath(lib.CAPABILITY_DROP_COMMAND)).toMatch(/\/setpriv$/);
    expect(await lib.findExecutableOnPath("definitely-not-installed-xyz")).toBeNull();
    const r = await lib.checkReadiness();
    expect(r.capabilityDropAvailable).toBe(true);
  });

  it("looks for claude on a login shell's PATH, not the web server's", () => {
    expect(lib.runnerPath().split(":")).toContain(path.join(home, ".local", "bin"));
    expect(lib.wrapperPath()).toBe(path.join(home, ".local", "bin", "claude-ds"));
  });
});

describe("the owner's switch", () => {
  it("is off until the owner turns it on, and the run route's refusal is a 'disabled'", async () => {
    readyDevice();
    writeConfig({ clawai_token: "t", coding_agent_enabled: false });
    expect(await lib.isCodingAgentEnabled()).toBe(false);
    await expect(lib.startRun({ task: "do it", projectId: "p", source: "agent" }))
      .rejects.toMatchObject({ kind: "disabled" });
    await lib.setCodingAgentEnabled(true);
    expect(await lib.isCodingAgentEnabled()).toBe(true);
  });

  it("refuses before spawning when the harness is not ready", async () => {
    writeConfig({ coding_agent_enabled: true });
    installFakeWrapper(HAPPY_BODY);
    await expect(lib.startRun({ task: "do it", projectId: "p", source: "agent" }))
      .rejects.toMatchObject({ kind: "not_ready" });
    expect(fs.existsSync(argvFile())).toBe(false);
  });
});

describe("where a run may work", () => {
  beforeEach(() => readyDevice());

  it("takes a code project by id and records its real absolute folder", async () => {
    const dir = makeProject("notes");
    const run = await lib.startRun({ task: "add a title", projectId: "notes", source: "agent" });
    expect(run.projectId).toBe("notes");
    expect(run.directory).toBe(fs.realpathSync(dir));
    await finished(run.id);
  });

  it("refuses a project that does not exist, and a bad id", async () => {
    await expect(lib.startRun({ task: "x", projectId: "missing", source: "agent" })).rejects.toMatchObject({ kind: "not_found" });
    await expect(lib.startRun({ task: "x", projectId: "../etc", source: "agent" })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("refuses the ClawBox OS checkout itself but allows a project folder under it", async () => {
    await expect(lib.resolveWorkingDirectory({ directory: root })).rejects.toMatchObject({ kind: "invalid" });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    await expect(lib.resolveWorkingDirectory({ directory: path.join(root, "src") })).rejects.toMatchObject({ kind: "invalid" });
    const dir = makeProject("p1");
    await expect(lib.resolveWorkingDirectory({ directory: dir })).resolves.toEqual({ directory: fs.realpathSync(dir), projectId: "p1" });
    // The projects folder itself is not a project.
    await expect(lib.resolveWorkingDirectory({ directory: path.dirname(dir) })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("refuses credential folders, folders outside the home, and relative paths", async () => {
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    fs.mkdirSync(path.join(home, ".openclaw", "workspace"), { recursive: true });
    await expect(lib.resolveWorkingDirectory({ directory: path.join(home, ".ssh") })).rejects.toMatchObject({ kind: "invalid" });
    await expect(lib.resolveWorkingDirectory({ directory: path.join(home, ".openclaw", "workspace") })).rejects.toMatchObject({ kind: "invalid" });
    await expect(lib.resolveWorkingDirectory({ directory: os.tmpdir() })).rejects.toMatchObject({ kind: "invalid" });
    await expect(lib.resolveWorkingDirectory({ directory: "projects/x" })).rejects.toMatchObject({ kind: "invalid" });
    await expect(lib.resolveWorkingDirectory({ directory: path.join(home, "nope") })).rejects.toMatchObject({ kind: "not_found" });
  });

  it("refuses the home directory itself — acceptEdits would auto-approve edits to ~/.bashrc", async () => {
    await expect(lib.resolveWorkingDirectory({ directory: home })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("denies every data/ entry except the public subtrees, and never the working folder", () => {
    fs.mkdirSync(path.join(root, "data", "cloudflared"), { recursive: true });
    fs.mkdirSync(path.join(root, "data", "webapps"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "network.env"), "x");
    const rules = lib.fileDenyRules();
    expect(rules).toContain(`Read(/${path.join(root, "data", "cloudflared")}/**)`);
    expect(rules).toContain(`Edit(/${path.join(root, "data", "network.env")})`);
    expect(rules.some((r) => r.includes(`${path.join(root, "data", "webapps")}`))).toBe(false);
    expect(rules.some((r) => r.includes(`${path.join(root, "data", "code-projects")}`))).toBe(false);
    expect(lib.denyRulesCover(rules, path.join(root, "data", "code-projects", "site"))).toBe(false);
    expect(lib.denyRulesCover(rules, path.join(root, "data", "cloudflared", "cert.pem"))).toBe(true);
  });

  it("allows an ordinary folder in the home", async () => {
    const dir = path.join(home, "projects", "site");
    fs.mkdirSync(dir, { recursive: true });
    await expect(lib.resolveWorkingDirectory({ directory: dir })).resolves.toEqual({ directory: fs.realpathSync(dir), projectId: null });
  });

  it("needs a task", async () => {
    makeProject("p");
    await expect(lib.startRun({ task: "   ", projectId: "p", source: "agent" })).rejects.toMatchObject({ kind: "invalid" });
    await expect(lib.startRun({ task: "x".repeat(lib.MAX_TASK_CHARS + 1), projectId: "p", source: "agent" })).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("a run", () => {
  beforeEach(() => readyDevice());

  it("spawns the wrapper with the headless flags, the task on stdin and an explicit environment", async () => {
    makeProject("site");
    const run = await lib.startRun({ task: "Add a dark mode toggle", projectId: "site", source: "agent" });
    expect(run.status).toBe("running");
    await finished(run.id);

    // What the wrapper received: setpriv strips its own arguments at `--`, so
    // the wrapper still sees exactly the Claude Code flags. That it ran at all
    // is the evidence the setpriv chain is well-formed.
    const argv = fs.readFileSync(argvFile(), "utf-8").split("\n").filter(Boolean);
    const joined = argv.join(" ");
    expect(argv[0]).toBe("-p");
    expect(joined).toContain("--verbose");
    expect(joined).toContain("--output-format stream-json");
    expect(joined).toContain("--permission-mode acceptEdits");
    expect(joined).toContain("--setting-sources user");
    expect(joined).toContain(`--max-turns ${lib.MAX_TURNS}`);
    expect(joined).toContain(`--max-budget-usd ${lib.MAX_BUDGET_USD}`);
    expect(joined).toContain(`--tools ${lib.CLAUDE_TOOLS}`);
    expect(argv).toContain("--allowedTools");
    for (const rule of lib.BASH_ALLOWLIST) expect(argv).toContain(rule);
    expect(argv).toContain("--disallowedTools");
    for (const rule of lib.BASH_DENYLIST) expect(argv).toContain(rule);
    // The credential folders and this checkout's secrets are denied to
    // Read/Edit/Write — but never the run's own folder under data/, because a
    // deny rule outranks acceptEdits and the run could not edit anything.
    expect(argv).toContain(`Read(/${path.join(home, ".ssh")}/**)`);
    expect(argv).toContain(`Write(/${path.join(root, "data", "config.json")})`);
    expect(argv).toContain(`Read(/${path.join(root, "data", ".mcp-token")})`);
    expect(argv).not.toContain(`Write(/${path.join(root, "data")}/**)`);
    const denyRules = argv.slice(argv.indexOf("--disallowedTools") + 1);
    expect(lib.denyRulesCover(denyRules, run.directory)).toBe(false);
    expect(lib.denyRulesCover(denyRules, path.join(root, "data", "config.json"))).toBe(true);
    expect(lib.denyRulesCover(denyRules, path.join(home, ".ssh", "id_ed25519"))).toBe(true);
    expect(argv).not.toContain("--resume");
    // No positional task: it went over stdin.
    expect(fs.readFileSync(stdinFile(), "utf-8")).toBe("Add a dark mode toggle");

    const env = Object.fromEntries(
      fs.readFileSync(envFile(), "utf-8").split("\n").filter((l) => l.includes("=")).map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
    expect(env.HOME).toBe(home);
    expect(env.CLAWBOX_ROOT).toBe(root);
    expect(env.PATH.split(":")).toContain(binDir);
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.CLAWBOX_MCP_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("turns the stream-json into a faithful record and tells the owner", async () => {
    makeProject("site");
    const started = await lib.startRun({ task: "Add a dark mode toggle", projectId: "site", source: "owner" });
    const run = await finished(started.id);

    expect(run.status).toBe("completed");
    expect(run.source).toBe("owner");
    expect(run.sessionId).toBe("sess-abc-123");
    expect(run.model).toBe("deepseek-v4-flash");
    expect(run.summary).toMatch(/Changed index.html/);
    expect(run.numTurns).toBe(3);
    expect(run.costUsd).toBe(0.12);
    expect(run.permissionDenials).toBe(1);
    expect(run.commandsRun).toBe(1);
    expect(run.filesTouched).toEqual(["index.html", "style.css"]);
    expect(run.progress).toContain("$ npm test");
    expect(run.progress.at(-1)).toBe("Finished: completed");
    expect(run.completedAt).not.toBeNull();
    expect(run.exitCode).toBe(0);

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0][0]).toMatchObject({ id: run.id, status: "completed" });
  });

  it("is kept on disk at 0600, newest first, and survives a fresh import", async () => {
    makeProject("site");
    const first = await lib.startRun({ task: "one", projectId: "site", source: "agent" });
    await finished(first.id);
    const second = await lib.startRun({ task: "two", projectId: "site", source: "agent" });
    await finished(second.id);

    expect(fs.statSync(runsFile()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${runsFile()}.tmp`)).toBe(false);
    expect(lib.listRuns().map((r) => r.id)).toEqual([second.id, first.id]);
    expect(first.id).toMatch(lib.RUN_ID_RE);

    lib._resetCodingAgentStateForTests();
    vi.resetModules();
    const again = await import("@/lib/coding-agent");
    expect(again.getRun(first.id)?.summary).toMatch(/Changed/);
    again._resetCodingAgentStateForTests();
  });

  it("reads a corrupt runs file as empty rather than failing", async () => {
    fs.writeFileSync(runsFile(), "{ not json");
    expect(lib.listRuns()).toEqual([]);
    makeProject("site");
    const run = await lib.startRun({ task: "one", projectId: "site", source: "agent" });
    await finished(run.id);
    expect(JSON.parse(fs.readFileSync(runsFile(), "utf-8"))).toHaveLength(1);
  });

  it("allows one run at a time and can be stopped", async () => {
    installFakeWrapper(`echo '${INIT}'\nsleep 30\nexit 0`);
    makeProject("site");
    const run = await lib.startRun({ task: "slow", projectId: "site", source: "agent" });
    await expect(lib.startRun({ task: "another", projectId: "site", source: "agent" })).rejects.toMatchObject({ kind: "busy" });
    expect(lib.runningCount()).toBe(1);

    lib.stopRun(run.id);
    const done = await finished(run.id);
    expect(done.status).toBe("stopped");
    expect(lib.runningCount()).toBe(0);
    // Idempotent on a finished run.
    expect(lib.stopRun(run.id).status).toBe("stopped");
    expect(() => lib.stopRun("run-nope0000")).toThrow(/no coding run/);
  });

  it("reports a turn ceiling as a failure that can be resumed in the same folder", async () => {
    installFakeWrapper(`echo '${INIT}'\necho '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":60,"session_id":"sess-abc-123"}'\nexit 0`);
    makeProject("site");
    const first = await finished((await lib.startRun({ task: "big", projectId: "site", source: "agent" })).id);
    expect(first.status).toBe("failed");
    expect(first.error).toMatch(/60 turns/);
    expect(first.sessionId).toBe("sess-abc-123");

    installFakeWrapper(HAPPY_BODY);
    const resumed = await lib.startRun({ task: "finish the rest", resumeRunId: first.id, source: "agent" });
    expect(resumed.directory).toBe(first.directory);
    expect(resumed.projectId).toBe("site");
    await finished(resumed.id);
    const argv = fs.readFileSync(argvFile(), "utf-8").split("\n");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-abc-123");
  });

  it("surfaces the wrapper's own refusal, minus its banner", async () => {
    installFakeWrapper("echo 'claude-ds: ClawBox AI is not connected yet. Open Settings -> AI Models first.' >&2\nexit 1");
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "x", projectId: "site", source: "agent" })).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/not connected yet/);
    expect(run.error).not.toMatch(/state in/);
    expect(run.exitCode).toBe(1);
  });

  it("fails cleanly when the wrapper is gone by the time it is spawned", async () => {
    makeProject("site");
    // Readiness passes, then the file disappears before spawn: simulate by
    // making the wrapper unexecutable garbage.
    fs.writeFileSync(path.join(binDir, "claude-ds"), "not a script", { mode: 0o755 });
    const run = await finished((await lib.startRun({ task: "x", projectId: "site", source: "agent" })).id);
    expect(run.status).toBe("failed");
    expect(run.error).toBeTruthy();
  });
});

describe("the capabilities a run starts with", () => {
  /**
   * clawbox-setup.service grants the web server CAP_NET_BIND_SERVICE,
   * CAP_NET_ADMIN and CAP_NET_RAW as AMBIENT capabilities, and ambient
   * capabilities are inherited across execve. Measured on a real box before
   * this guard existed: a run asked for `python3 -c "…/proc/self/status…"` —
   * an allow-listed interpreter, so no Claude Code tool policy applied — and
   * printed back CapAmb=0x3400, while the gateway that hosts the agent's own
   * shell tool holds none. This pins the prefix that closes that gap.
   */
  it("is spawned through setpriv, with the ambient and inheritable sets emptied", () => {
    const { bin, argv } = lib.buildSpawnArgv("/usr/bin/setpriv", ["-p", "--verbose"]);
    expect(bin).toBe("/usr/bin/setpriv");
    expect(argv.slice(0, 4)).toEqual(["--ambient-caps=-all", "--inh-caps=-all", "--no-new-privs", "--"]);
    // The wrapper comes after the separator, then its own arguments untouched.
    expect(argv[4]).toBe(lib.wrapperPath());
    expect(argv.slice(5)).toEqual(["-p", "--verbose"]);
  });

  it("puts every capability flag before the separator, or setpriv would pass them to the wrapper", () => {
    const { argv } = lib.buildSpawnArgv("/usr/bin/setpriv", []);
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(0, sep).every((a) => a.startsWith("--"))).toBe(true);
    expect(argv.indexOf(lib.wrapperPath())).toBe(sep + 1);
  });
});

describe("after a restart", () => {
  it("settles a run the previous server left running", async () => {
    fs.writeFileSync(runsFile(), JSON.stringify([{
      id: "run-lostrun1",
      task: "was running",
      directory: home,
      projectId: null,
      source: "agent",
      status: "running",
      startedAt: Date.now() - 60_000,
      completedAt: null,
      sessionId: "sess-old",
      model: null,
      summary: null,
      error: null,
      numTurns: 2,
      costUsd: null,
      filesTouched: [],
      commandsRun: 0,
      permissionDenials: 0,
      progress: [],
      exitCode: null,
    }]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
    // The count is the operator's only signal that a restart killed work.
    expect(lib.reconcileAfterRestart()).toBe(1);
    expect(lib.reconcileAfterRestart()).toBe(1);
    const run = lib.getRun("run-lostrun1");
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/restarted/);
    expect(JSON.parse(fs.readFileSync(runsFile(), "utf-8"))[0].status).toBe("failed");
  });
});
