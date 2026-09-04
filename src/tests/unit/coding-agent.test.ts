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
/** One line per spawn — argv.txt is overwritten by each and cannot tell one from two. */
const spawnsFile = () => path.join(base, "spawns.txt");
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
      { type: "tool_use", id: "t_edit", name: "Edit", input: { file_path: "index.html" } },
      { type: "tool_use", id: "t_write", name: "Write", input: { file_path: "__DIR__/style.css" } },
      { type: "tool_use", id: "t_bash", name: "Bash", input: { command: "npm test" } },
    ],
  },
});
const TOOL_RESULTS = JSON.stringify({
  type: "user",
  message: {
    content: [
      { type: "tool_result", tool_use_id: "t_edit", content: "ok" },
      { type: "tool_result", tool_use_id: "t_write", content: "ok" },
      { type: "tool_result", tool_use_id: "t_bash", content: "ok" },
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
  // A write counts only once its result comes back clean, as it does here.
  `echo '${TOOL_RESULTS}'`,
  `echo '${RESULT}'`,
  "exit 0",
].join("\n");

/** HAPPY_BODY, counting the spawn first. */
const countingBody = () => [`echo spawned >> "${spawnsFile()}"`, HAPPY_BODY].join("\n");

/**
 * HAPPY_BODY with a real change on disk, distinct per spawn, so the commit
 * that follows EVERY run of it has something to record — and says so in the
 * progress, which is what a test waits on to know the attempt is over.
 */
const TOUCHING_BODY = ['date +%s%N > "$PWD/touched-$$.txt"', HAPPY_BODY].join("\n");

/** What recordRunWork writes when the commit attempt is over — either way. */
const COMMIT_LINE = /Committed as|Not committed/;

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
  // The checkout lives INSIDE the home, as it does on a real box
  // (/home/clawbox/clawbox). With the two as siblings, every path under the
  // checkout was refused by the "must be inside the home" rule and the
  // checkout guard below it was never reached — so its test passed without
  // ever running the code it names.
  root = path.join(home, "clawbox");
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
  // maxRetries, because this suite has twice failed CI with
  // `ENOTEMPTY: directory not empty, rmdir '.../code-projects/site/.git'`
  // (PRs #643 and #648, both on changes that touch none of this code).
  //
  // The test never creates that .git — the code under test does, through a
  // spawned `git init` — so the directory can still be gaining files at the
  // moment this line runs. Node's rm retries precisely this set of errors
  // (EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM) with a linear backoff, and defaults
  // to not retrying at all.
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    // The message matters as much as the refusal: it is what tells the agent
    // this folder is off limits by rule, not missing.
    await expect(lib.resolveWorkingDirectory({ directory: root }))
      .rejects.toThrow(/checkout itself is off limits/);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    await expect(lib.resolveWorkingDirectory({ directory: path.join(root, "src") }))
      .rejects.toThrow(/checkout itself is off limits/);
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

  it("confines a run to a folder INSIDE the project folder once one is set", async () => {
    // The owner's rule: every run's folder is a project the owner can find
    // again, and the project folder is the shelf they all sit on.
    const projectsDir = path.join(home, "Projects");
    fs.mkdirSync(path.join(projectsDir, "shop"), { recursive: true });
    fs.mkdirSync(path.join(home, "elsewhere"), { recursive: true });
    writeConfig({ coding_agent_default_directory: projectsDir });
    await expect(lib.resolveWorkingDirectory({ directory: path.join(projectsDir, "shop") })).resolves.toMatchObject({ directory: fs.realpathSync(path.join(projectsDir, "shop")) });
    await expect(lib.resolveWorkingDirectory({ directory: "shop" })).resolves.toMatchObject({ directory: fs.realpathSync(path.join(projectsDir, "shop")) });
    await expect(lib.resolveWorkingDirectory({ directory: path.join(home, "elsewhere") })).rejects.toMatchObject({ kind: "invalid", message: expect.stringContaining("inside your project folder") });
    // The project folder itself is not a run's folder either.
    await expect(lib.resolveWorkingDirectory({ directory: projectsDir })).rejects.toMatchObject({ kind: "invalid" });
    // And nothing at all is not "the project folder": it asks for a folder in it.
    await expect(lib.resolveWorkingDirectory({})).rejects.toMatchObject({ kind: "invalid", message: expect.stringContaining(projectsDir) });
    // A code project stays fine wherever it lives.
    fs.mkdirSync(path.join(root, "data", "code-projects", "site"), { recursive: true });
    await expect(lib.resolveWorkingDirectory({ projectId: "site" })).resolves.toMatchObject({ projectId: "site" });
    // Moving the project folder itself is still allowed: the setting is
    // validated as a default, not as a run's folder.
    fs.mkdirSync(path.join(home, "Work"), { recursive: true });
    await expect(lib.setDefaultDirectory(path.join(home, "Work"))).resolves.toBe(fs.realpathSync(path.join(home, "Work")));
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

  it("denies the checkout's own top-level entries — the brief's promise, made true", () => {
    // Everything directly under the checkout except data/, whose entries the
    // pass above already covers one by one: src/, mcp/, scripts/ and
    // package.json were open to Read while the brief told the run they were
    // refused.
    fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "data", "code-projects"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    const rules = lib.fileDenyRules();
    expect(rules).toContain(`Read(/${path.join(root, "src")}/**)`);
    expect(rules).toContain(`Edit(/${path.join(root, "package.json")})`);
    expect(rules).toContain(`Write(/${path.join(root, ".env")})`);
    expect(lib.denyRulesCover(rules, path.join(root, "src", "lib", "auth.ts"))).toBe(true);
    // data/ itself is never denied as a tree — the working folder lives under it.
    expect(rules).not.toContain(`Read(/${path.join(root, "data")}/**)`);
    expect(lib.denyRulesCover(rules, path.join(root, "data", "code-projects", "site"))).toBe(false);
    // A folder outside the checkout is untouched.
    expect(lib.denyRulesCover(rules, path.join(home, "Projects", "my-app"))).toBe(false);
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

    // No price ceiling: --max-budget-usd priced an unknown model name, so it
    // never meant anything here. Steps and (optionally) tokens bound a run now.
    expect(joined).not.toContain("--max-budget-usd");
    expect(joined).toContain(`--max-turns ${lib.DEFAULT_MAX_TURNS}`);
    // Full command access is permanent now, so the allow-list is Bash(*) and
    // the command deny-list is gone. The FILE rules below still ship.
    expect(joined).toContain(`--tools ${lib.toolsFor(true, run.effort)}`);
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Bash(*)");
    // The default effort is ultracode, and ultracode's orchestration tool is
    // listed AND pre-approved — listed alone it is refused headlessly.
    expect(run.effort).toBe(lib.ULTRACODE_EFFORT);
    expect(argv[argv.indexOf("--tools") + 1].split(",")).toContain(lib.WORKFLOW_TOOL);
    expect(argv[argv.indexOf("--allowedTools") + 2]).toBe(lib.WORKFLOW_TOOL);
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("Ultracode is on");
    for (const rule of lib.BASH_DENYLIST) expect(argv).not.toContain(rule);
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("--agents");
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
    // "steps" in the owner's words; the number is the run's own ceiling.
    expect(first.error).toMatch(/60 steps/);
    expect(first.sessionId).toBe("sess-abc-123");

    installFakeWrapper(HAPPY_BODY);
    const resumed = await lib.startRun({ task: "finish the rest", resumeRunId: first.id, source: "agent" });
    expect(resumed.directory).toBe(first.directory);
    expect(resumed.projectId).toBe("site");
    await finished(resumed.id);
    const argv = fs.readFileSync(argvFile(), "utf-8").split("\n");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-abc-123");
  });

  it("does NOT replay a session poisoned by an auth failure — it starts fresh", async () => {
    // Observed on a real box: a transient upstream failure at 09:01 recorded
    // session a5ef1ff6; the run was resumed at 09:05 into that same session
    // and failed identically, because Claude Code persists the failure IN the
    // session. One cloud hiccup became a permanently broken project.
    installFakeWrapper(`echo '${INIT}'\necho '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Failed to authenticate. API Error: Attention Required! | Cloudflare"],"session_id":"sess-abc-123"}'\nexit 0`);
    makeProject("site");
    const first = await finished((await lib.startRun({ task: "build it", projectId: "site", source: "agent" })).id);
    expect(first.status).toBe("failed");
    expect(first.error).toMatch(/authenticate/i);
    // The session exists, but resuming it cannot help.
    expect(first.sessionId).toBe("sess-abc-123");
    expect(first.resumable).toBe(false);

    installFakeWrapper(HAPPY_BODY);
    const second = await lib.startRun({ task: "carry on", resumeRunId: first.id, source: "agent" });
    await finished(second.id);
    const argv = fs.readFileSync(argvFile(), "utf-8").split("\n");
    expect(argv).not.toContain("--resume");
    expect(second.progress.join(" ")).toMatch(/Starting fresh/);
    // Same folder, so the work continues where it was.
    expect(second.directory).toBe(first.directory);
  });

  it("still resumes a run that merely ran out of room", async () => {
    installFakeWrapper(`echo '${INIT}'\necho '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":60,"session_id":"sess-abc-123"}'\nexit 0`);
    makeProject("site");
    const first = await finished((await lib.startRun({ task: "big", projectId: "site", source: "agent" })).id);
    expect(first.resumable).toBe(true);

    installFakeWrapper(HAPPY_BODY);
    await finished((await lib.startRun({ task: "finish it", resumeRunId: first.id, source: "agent" })).id);
    const argv = fs.readFileSync(argvFile(), "utf-8").split("\n");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-abc-123");
  });

  it("does not report a run finished on a result event alone — the process must exit", async () => {
    // A resumed session on a real box (run-qqj1io65) emitted a result-shaped
    // event and then kept working for three minutes; the record said
    // "completed" while files were still being written.
    const flag = path.join(base, "let-the-wrapper-exit");
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${RESULT}'`,
      `while [ ! -f "${flag}" ]; do sleep 0.05; done`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const started = await lib.startRun({ task: "t", projectId: "site", source: "agent" });
    // Wait until the result event has been parsed (its summary lands): the
    // process is still alive, so the run must still say running.
    await vi.waitFor(() => { expect(lib.getRun(started.id)?.summary).toMatch(/Changed/); }, { timeout: 5000 });
    expect(lib.getRun(started.id)?.status).toBe("running");
    fs.writeFileSync(flag, "");
    const run = await finished(started.id);
    expect(run.status).toBe("completed");
    expect(run.numTurns).toBe(3);
  });

  it("tells a resumed session its NEW evidence folder, on stdin with the task", async () => {
    installFakeWrapper(`echo '${INIT}'\necho '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":60,"session_id":"sess-abc-123"}'\nexit 0`);
    makeProject("site");
    const first = await finished((await lib.startRun({ task: "big", projectId: "site", source: "agent" })).id);
    const firstStdin = fs.readFileSync(stdinFile(), "utf-8");
    expect(firstStdin).not.toContain("evidence folder"); // a fresh run gets the bare task

    installFakeWrapper(HAPPY_BODY);
    const resumed = await finished((await lib.startRun({ task: "finish it", resumeRunId: first.id, source: "agent" })).id);
    const stdin = fs.readFileSync(stdinFile(), "utf-8");
    expect(stdin).toContain("finish it");
    expect(stdin).toContain(resumed.id); // the NEW run's folder…
    expect(stdin).not.toContain(first.id); // …not the previous run's
  });

  it("resumes a COMPLETED run's session — a finished conversation is safe to continue", async () => {
    installFakeWrapper(HAPPY_BODY);
    makeProject("site");
    const first = await finished((await lib.startRun({ task: "build", projectId: "site", source: "agent" })).id);
    expect(first.status).toBe("completed");

    const followUp = await finished((await lib.startRun({ task: "polish it", resumeRunId: first.id, source: "agent" })).id);
    const argv = fs.readFileSync(argvFile(), "utf-8").split("\n");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-abc-123");
    expect(followUp.directory).toBe(first.directory);
  });

  describe("the automatic review pass", () => {
    const allRuns = () => JSON.parse(fs.readFileSync(runsFile(), "utf-8")) as { id: string; reviewOf: string | null }[];

    it("follows a completed run with ONE review pass in the same session — and never a second", async () => {
      installFakeClaude();
      installFakeWrapper(TOUCHING_BODY);
      writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true, coding_agent_review_pass: true });
      makeProject("site");
      const first = await finished((await lib.startRun({ task: "build", projectId: "site", source: "agent" })).id);
      expect(first.status).toBe("completed");

      // The pass starts only after the commit attempt has finished either way.
      await vi.waitFor(() => { expect(allRuns().length).toBe(2); }, { timeout: 10_000 });
      const review = await finished(allRuns()[0].id);
      expect(review.reviewOf).toBe(first.id);
      expect(review.status).toBe("completed");
      expect(review.progress.join("\n")).toContain(`Automatic review pass of ${first.id}`);
      const argv = fs.readFileSync(argvFile(), "utf-8").split("\n");
      expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-abc-123");
      expect(fs.readFileSync(stdinFile(), "utf-8")).toContain("Automatic review pass");

      // The review pass itself completed and touched files — and must NOT
      // chain: once ITS commit attempt is over (the moment a follow-up would
      // start), there is still no third run.
      await vi.waitFor(() => { expect(lib.getRun(review.id)?.progress.join("\n")).toMatch(COMMIT_LINE); }, { timeout: 10_000 });
      expect(allRuns().length).toBe(2);
    });

    it("does not start after the owner pressed Stop, even when the run settles completed", async () => {
      // The final result event is applied ahead of the stop so a stop that
      // raced the finish keeps the work — but the owner's gesture still means
      // "no more of this": no automatic follow-up may start.
      installFakeClaude();
      const flag = path.join(base, "reviewed-stop-flag");
      installFakeWrapper([
        `echo '${INIT}'`,
        `echo '${ASSISTANT}' | sed "s|__DIR__|$PWD|"`,
        `echo '${TOOL_RESULTS}'`,
        `echo '${RESULT}'`,
        `while [ ! -f "${flag}" ]; do sleep 0.05; done`,
        "exit 0",
      ].join("\n"));
      writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true, coding_agent_review_pass: true });
      makeProject("site");
      const started = await lib.startRun({ task: "build", projectId: "site", source: "agent" });
      await vi.waitFor(() => { expect(lib.getRun(started.id)?.summary).toMatch(/Changed/); }, { timeout: 5000 });
      await lib.stopRun(started.id);
      const run = await finished(started.id);
      expect(run.status).toBe("completed"); // the raced stop keeps the work…
      // …but no review pass follows a Stop: once the commit attempt is over
      // (the moment a follow-up would start), the run is still alone.
      await vi.waitFor(() => { expect(lib.getRun(started.id)?.progress.join("\n")).toMatch(COMMIT_LINE); }, { timeout: 10_000 });
      expect(allRuns().length).toBe(1);
    });

    it("does nothing while the owner's review switch is off", async () => {
      readyDevice();
      makeProject("site");
      const done = await finished((await lib.startRun({ task: "build", projectId: "site", source: "agent" })).id);
      await vi.waitFor(() => { expect(lib.getRun(done.id)?.progress.join("\n")).toMatch(COMMIT_LINE); }, { timeout: 10_000 });
      expect(allRuns().length).toBe(1);
    });
  });

  describe("the token limit", () => {
    it("settles as stopped, not completed, when the result event beat the kill", async () => {
      installFakeClaude();
      // One turn that alone exceeds the limit, with the result event right
      // behind it in the same write: the process has said "success" before
      // the device's kill lands. The device's verdict must stand — a record
      // that read "completed" beside "Stopped at the token limit" was both.
      const spent = JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 20_000, output_tokens: 10 }, content: [{ type: "text", text: "Done" }] },
      });
      installFakeWrapper([`printf '%s\\n' '${INIT}' '${spent}' '${RESULT}'`, "exit 0"].join("\n"));
      writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true, coding_agent_token_limit: 10_000 });
      makeProject("site");
      const run = await finished((await lib.startRun({ task: "build", projectId: "site", source: "agent" })).id);
      expect(run.status).toBe("stopped");
      expect(run.error).toMatch(/Stopped at the token limit/);
      expect(run.resumable).toBe(true);
      expect(run.progress.join("\n")).toContain("Token limit reached");
    });
  });

  describe("pause, resume, and drafts", () => {
    it("pauses a live run, keeps its session, and resumes it in place", async () => {
      installFakeClaude();
      const flag = path.join(base, "pause-flag");
      installFakeWrapper([
        `echo '${INIT}'`,
        `echo '${ASSISTANT}' | sed "s|__DIR__|$PWD|"`,
        `echo '${TOOL_RESULTS}'`,
        `while [ ! -f "${flag}" ]; do sleep 0.05; done`,
        `echo '${RESULT}'`,
        "exit 0",
      ].join("\n"));
      writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true });
      makeProject("site");
      const started = await lib.startRun({ task: "build", projectId: "site", source: "agent" });
      await vi.waitFor(() => { expect(lib.getRun(started.id)?.commandsRun).toBeGreaterThan(0); }, { timeout: 5000 });
      lib.pauseRun(started.id);
      const paused = await finished(started.id);
      expect(paused.status).toBe("paused");
      expect(paused.resumable).toBe(true);
      expect(paused.error).toBeNull();
      expect(paused.progress.join("\n")).toContain("Paused — resume to continue");
      // A pause is the owner's own gesture, not a finish worth a notice.
      expect(announce).not.toHaveBeenCalled();

      installFakeWrapper(HAPPY_BODY);
      const resumed = await lib.resumeRun(started.id);
      expect(resumed.status).toBe("running");
      const done = await finished(started.id);
      expect(done.status).toBe("completed");
      const argv = fs.readFileSync(argvFile(), "utf-8").split("\n");
      expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-abc-123");
      // The session already holds the task; the resume says what happened instead.
      expect(fs.readFileSync(stdinFile(), "utf-8")).toContain("resumed in the same session");
    });

    it("resumes a paused run exactly once when two resumes arrive together", async () => {
      installFakeClaude();
      const flag = path.join(base, "pause-flag-parallel");
      installFakeWrapper([`echo '${INIT}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
      writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true });
      makeProject("site");
      const started = await lib.startRun({ task: "build", projectId: "site", source: "agent" });
      await vi.waitFor(() => { expect(lib.getRun(started.id)?.sessionId).toBe("sess-abc-123"); }, { timeout: 5000 });
      lib.pauseRun(started.id);
      expect((await finished(started.id)).status).toBe("paused");

      // Both saw "paused"; only one may spawn — the other rides on its transition.
      installFakeWrapper(countingBody());
      const [a, b] = await Promise.all([lib.resumeRun(started.id), lib.resumeRun(started.id)]);
      expect(a.status).toBe("running");
      expect(b.status).toBe("running");
      expect((await finished(started.id)).status).toBe("completed");
      expect(fs.readFileSync(spawnsFile(), "utf-8").trim().split("\n")).toHaveLength(1);
    });

    it("stopping a paused run closes it out without a process", async () => {
      installFakeClaude();
      const flag = path.join(base, "pause-flag-2");
      installFakeWrapper([`echo '${INIT}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
      writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true });
      makeProject("site");
      const started = await lib.startRun({ task: "build", projectId: "site", source: "agent" });
      await vi.waitFor(() => { expect(lib.getRun(started.id)?.sessionId).toBe("sess-abc-123"); }, { timeout: 5000 });
      lib.pauseRun(started.id);
      await finished(started.id);
      const stopped = lib.stopRun(started.id);
      expect(stopped.status).toBe("stopped");
    });

    it("drafts a run, starts it later, and never auto-starts it", async () => {
      readyDevice();
      makeProject("site");
      const draft = await lib.createDraftRun({ task: "later please", projectId: "site", source: "owner" });
      expect(draft.status).toBe("draft");
      expect(lib.getRun(draft.id)?.status).toBe("draft");
      // Drafting spawned nothing: the wrapper never recorded an argv.
      expect(fs.existsSync(argvFile())).toBe(false);

      const started = await lib.startDraftRun(draft.id);
      expect(started.status).toBe("running");
      const done = await finished(draft.id);
      expect(done.status).toBe("completed");
      expect(done.progress.join("\n")).toContain("Started from a draft");
      expect(fs.readFileSync(stdinFile(), "utf-8")).toContain("later please");
    });

    it("starts a draft exactly once when two starts arrive together", async () => {
      readyDevice();
      installFakeWrapper(countingBody());
      makeProject("site");
      const draft = await lib.createDraftRun({ task: "once only", projectId: "site", source: "owner" });
      const [a, b] = await Promise.all([lib.startDraftRun(draft.id), lib.startDraftRun(draft.id)]);
      expect(a.status).toBe("running");
      expect(b.status).toBe("running");
      expect((await finished(draft.id)).status).toBe("completed");
      expect(fs.readFileSync(spawnsFile(), "utf-8").trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(runsFile(), "utf-8"))).toHaveLength(1);
    });

    it("keeps paused runs and drafts across a restart — the validator knows every status it writes", async () => {
      readyDevice();
      makeProject("site");
      const draft = await lib.createDraftRun({ task: "survive restarts", projectId: "site", source: "owner" });
      const flag = path.join(base, "roundtrip-flag");
      installFakeWrapper([`echo '${INIT}'`, `while [ ! -f "${flag}" ]; do sleep 0.05; done`, "exit 0"].join("\n"));
      const started = await lib.startRun({ task: "t", projectId: "site", source: "agent" });
      await vi.waitFor(() => { expect(lib.getRun(started.id)?.sessionId).toBe("sess-abc-123"); }, { timeout: 5000 });
      lib.pauseRun(started.id);
      await finished(started.id);

      // A restart: forget memory, re-read the file. Both records must survive
      // (they vanished here once — RUN_STATUSES had not been widened).
      lib._resetCodingAgentStateForTests();
      expect(lib.getRun(draft.id)?.status).toBe("draft");
      expect(lib.getRun(started.id)?.status).toBe("paused");
      expect(lib.getRun(started.id)?.resumable).toBe(true);
    });

    it("clear-history keeps paused runs and drafts", async () => {
      readyDevice();
      makeProject("site");
      const draft = await lib.createDraftRun({ task: "keep me", projectId: "site", source: "owner" });
      const done = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);
      expect(lib.clearFinishedRuns()).toBe(1);
      expect(lib.getRun(draft.id)?.status).toBe("draft");
      expect(lib.getRun(done.id)).toBeNull();
    });

    it("deletes only drafts — finished runs are history", async () => {
      readyDevice();
      makeProject("site");
      const draft = await lib.createDraftRun({ task: "discard me", projectId: "site", source: "owner" });
      lib.deleteDraftRun(draft.id);
      expect(lib.getRun(draft.id)).toBeNull();

      const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);
      expect(() => lib.deleteDraftRun(run.id)).toThrow(/Only a draft/);
    });
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

describe("what a run can verify with", () => {
  beforeEach(() => readyDevice());

  it("wires the clawbox MCP server in its browser-only profile, with no secret in argv", async () => {
    makeProject("site");
    // Two bearers the runner could reach: the web server's own environment
    // (CLAWBOX_MCP_TOKEN, set in beforeEach) and the file the MCP server
    // reads for itself. Both are seeded so the assertion below has something
    // to catch.
    const onDisk = "the-mcp-bearer-token-on-disk";
    fs.writeFileSync(path.join(root, "data", ".mcp-token"), onDisk, { mode: 0o600 });
    expect(process.env.CLAWBOX_MCP_TOKEN).toBe("the-mcp-bearer-token-value");
    const run = await lib.startRun({ task: "Build it", projectId: "site", source: "agent" });
    await finished(run.id);

    const argv = fs.readFileSync(argvFile(), "utf-8").split("\n").filter(Boolean);
    expect(argv).toContain("--strict-mcp-config");
    const cfg = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]);
    const server = cfg.mcpServers.clawbox;
    expect(server.args.at(-1)).toBe(path.join(root, "mcp", "clawbox-mcp.ts"));
    expect(server.env.CLAWBOX_MCP_PROFILE).toBe("browser");
    expect(server.env.CLAWBOX_RUN_DIR).toBe(run.directory);
    expect(server.env.CLAWBOX_RUN_ARTIFACTS_DIR).toBe(path.join(root, "data", "coding-agent-artifacts", run.id));
    // argv is world-readable in /proc: neither bearer may ride in it, nor in
    // the server's env block inside --mcp-config. What the server is given is
    // the root whose data/.mcp-token it reads through its file fallback — and
    // that file is there to be read.
    for (const bearer of ["the-mcp-bearer-token-value", onDisk]) expect(argv.join(" ")).not.toContain(bearer);
    expect(server.env.CLAWBOX_MCP_TOKEN).toBeUndefined();
    expect(server.env.CLAWBOX_ROOT).toBe(root);
    expect(fs.readFileSync(path.join(server.env.CLAWBOX_ROOT, "data", ".mcp-token"), "utf-8")).toBe(onDisk);

    // The browser family plus the media tools the owner's switches allow, and
    // nothing else MCP: both media switches default ON, so this run has both.
    for (const tool of lib.MCP_BROWSER_TOOLS) expect(argv).toContain(tool);
    expect(argv).toContain(lib.MCP_MEDIA_TOOLS.images);
    expect(argv).toContain(lib.MCP_MEDIA_TOOLS.audio);
    expect(argv.filter((a) => a.startsWith("mcp__"))).toHaveLength(lib.MCP_BROWSER_TOOLS.length + 2);
    // The run's own server is told which of the two it may register; the
    // variable carries no secret, like everything else in this block.
    expect(server.env.CLAWBOX_RUN_MEDIA).toBe("images,audio");

    // The run's own environment names the evidence folder, which exists, and
    // its PATH reaches the snap-installed Chromium.
    const env = Object.fromEntries(
      fs.readFileSync(envFile(), "utf-8").split("\n").filter((l) => l.includes("=")).map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
    expect(env.CLAWBOX_RUN_ARTIFACTS_DIR).toBe(path.join(root, "data", "coding-agent-artifacts", run.id));
    expect(fs.existsSync(env.CLAWBOX_RUN_ARTIFACTS_DIR)).toBe(true);
    expect(env.PATH.split(":")).toContain("/snap/bin");

    // acceptEdits covers only the working folder; the evidence folder must be
    // an additional directory or the run's own Write into it is denied.
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(path.join(root, "data", "coding-agent-artifacts", run.id));
  });

  it("keeps the evidence folder writable under the file deny rules", async () => {
    makeProject("site");
    const run = await lib.startRun({ task: "Build it", projectId: "site", source: "agent" });
    await finished(run.id);
    const rules = lib.fileDenyRules();
    expect(lib.denyRulesCover(rules, path.join(root, "data", "coding-agent-artifacts", run.id, "shot-001.png"))).toBe(false);
    // The neighbours stay closed.
    expect(lib.denyRulesCover(rules, path.join(root, "data", "config.json"))).toBe(true);
  });

  it("removes a cleared run's evidence folder and keeps everything else", async () => {
    const artifactsLib = await import("@/lib/coding-agent-artifacts");
    makeProject("site");
    const run = await lib.startRun({ task: "Build it", projectId: "site", source: "agent" });
    await finished(run.id);
    const dir = artifactsLib.ensureArtifactsDir(run.id);
    fs.writeFileSync(path.join(dir, "shot-001.png"), "png");
    expect(lib.clearFinishedRuns()).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("retrying a transient upstream failure", () => {
  beforeEach(() => readyDevice());

  const CF = "Failed to authenticate. API Error: Attention Required! | Cloudflare";
  const counter = () => path.join(home, "attempts.txt");

  /** Fails the first time with the real Cloudflare text, succeeds the second. */
  function flakyWrapper(extra = ""): void {
    installFakeWrapper([
      `n=$(cat "${counter()}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter()}"`,
      `echo '${INIT}'`,
      extra,
      'if [ "$n" = "1" ]; then',
      `  echo "${CF}" >&2`,
      "  exit 1",
      "fi",
      `echo '{"type":"result","subtype":"success","num_turns":2,"result":"SECOND-TRY-OK"}'`,
      "exit 0",
    ].join("\n"));
  }

  it("starts over once, in a FRESH session, and the run succeeds", async () => {
    flakyWrapper();
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.status).toBe("completed");
    expect(run.summary).toBe("SECOND-TRY-OK");
    expect(run.retries).toBe(1);
    expect(fs.readFileSync(counter(), "utf-8").trim()).toBe("2");
    // The owner is told it happened rather than it being hidden.
    expect(run.progress.join("\n")).toContain("starting over in a fresh session");
    // A resume would have replayed the failure; the retry must not use one.
    expect(fs.readFileSync(argvFile(), "utf-8")).not.toContain("--resume");
  });

  it("retries at most once — a second failure is reported, not looped", async () => {
    installFakeWrapper([`echo '${INIT}'`, `echo "${CF}" >&2`, "exit 1"].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.status).toBe("failed");
    expect(run.retries).toBe(1);
    expect(run.error).toContain("Attention Required");
  });

  it("DOES retry a run that only looked around — a read-only ls is not work", async () => {
    // The exact shape seen on the box: the run did `ls -la`, then died on the
    // provider. The first guard counted that command as work and blocked the
    // retry, which is why it never fired when it was needed.
    const LOOKED = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls -la ." } }] },
    });
    flakyWrapper(`echo '${LOOKED}'`);
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.status).toBe("completed");
    expect(run.retries).toBe(1);
    expect(run.commandsRun).toBeGreaterThan(0);
  });

  it("DOES retry a run that only ran convergent setup — the npm install failure seen on the box", async () => {
    // run-bfghfhyl: a transient proxy failure right after `npm install three
    // esbuild ws` killed the run, because the guard read the install as work
    // it must not repeat. An install converges; the retry is safe.
    const INSTALLED = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "b3", name: "Bash", input: { command: "npm install three esbuild ws" } }] },
    });
    flakyWrapper(`echo '${INSTALLED}'`);
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.status).toBe("completed");
    expect(run.retries).toBe(1);
  });

  it("does NOT retry after a command that could have left something behind", async () => {
    const BUILT = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "npm run build" } }] },
    });
    flakyWrapper(`echo '${BUILT}'`);
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.status).toBe("failed");
    expect(run.retries).toBe(0);
  });

  it("does NOT retry a run that already changed something", async () => {
    // The second attempt would start from the first one's leftovers.
    const WROTE = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "out.txt" } }] },
    });
    flakyWrapper(`echo '${WROTE}'`);
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.status).toBe("failed");
    expect(run.retries).toBe(0);
    // The write was never confirmed by a tool_result, so it is NOT reported as
    // a changed file — but it still blocks the retry, because the file may
    // have been written anyway and a second attempt would start from it.
    expect(run.filesTouched).toEqual([]);
    expect(run.progress.join("\n")).toContain("Write out.txt");
    expect(fs.readFileSync(counter(), "utf-8").trim()).toBe("1");
  });

  it("does retry after a read-only inspection command", async () => {
    const LS = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }] },
    });
    flakyWrapper(`echo '${LS}'`);
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.status).toBe("completed");
    expect(run.retries).toBe(1);
    expect(run.commandsRun).toBe(2);
  });

  it("does NOT retry after a command that may have side effects", async () => {
    const NPM = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
    });
    flakyWrapper(`echo '${NPM}'`);
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.status).toBe("failed");
    expect(run.retries).toBe(0);
    expect(fs.readFileSync(counter(), "utf-8").trim()).toBe("1");
  });

  it("does NOT retry a real refusal — a turn ceiling is an answer, not an accident", async () => {
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '{"type":"result","subtype":"error_max_turns","num_turns":60}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.status).toBe("failed");
    expect(run.retries).toBe(0);
    expect(run.resumable).toBe(true);
  });

  it("does NOT retry a run the owner stopped", async () => {
    installFakeWrapper([`echo '${INIT}'`, "sleep 30", "exit 0"].join("\n"));
    makeProject("site");
    const started = await lib.startRun({ task: "t", projectId: "site", source: "owner" });
    lib.stopRun(started.id);
    const run = await finished(started.id);

    expect(run.status).toBe("stopped");
    expect(run.retries).toBe(0);
  });
});

describe("what a run reports as changed", () => {
  beforeEach(() => readyDevice());

  const WRITE = (id: string, file: string) => JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Write", input: { file_path: file } }] },
  });
  const RESULT = (id: string, isError: boolean) => JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: isError ? "denied" : "ok" }] },
  });

  it("does not claim a file it was REFUSED permission to write", async () => {
    // A real run listed /tmp/check_html.py among its changed files when the
    // write had been denied. The list was built from what it asked to do.
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${WRITE("w1", "index.html")}'`,
      `echo '${RESULT("w1", false)}'`,
      `echo '${WRITE("w2", "/tmp/check_html.py")}'`,
      `echo '${RESULT("w2", true)}'`,
      `echo '{"type":"result","subtype":"success","num_turns":2,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.filesTouched).toEqual(["index.html"]);
    expect(run.filesTouched.join(" ")).not.toContain("check_html");
  });

  it("still shows the attempt in the progress feed", async () => {
    // The owner should see what it tried, even when it was refused — the
    // denial itself is reported separately.
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${WRITE("w1", "/tmp/nope.py")}'`,
      `echo '${RESULT("w1", true)}'`,
      `echo '{"type":"result","subtype":"success","num_turns":1,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.filesTouched).toEqual([]);
    expect(run.progress.join("\n")).toContain("Write");
  });

  it("counts a write whose result never arrives as NOT done", async () => {
    // A run killed mid-write must not claim the file.
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${WRITE("w1", "half.html")}'`,
      `echo '{"type":"result","subtype":"success","num_turns":1,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);
    expect(run.filesTouched).toEqual([]);
  });

  /** A Write into the run's evidence folder — the path the wrapper is handed in its env. */
  const EVIDENCE_WRITE = (id: string) =>
    `echo '${WRITE(id, "__EVIDENCE__/report.md")}' | sed "s|__EVIDENCE__|$CLAWBOX_RUN_ARTIFACTS_DIR|"`;

  it("does not count a write into its own evidence folder as project work", async () => {
    // The brief asks every run to save report.md and its test output there.
    // A review pass that found nothing wrote only its report — and was shown
    // as "1 files changed", the wording used for real edits.
    installFakeWrapper([
      `echo '${INIT}'`,
      EVIDENCE_WRITE("w1"),
      `echo '${RESULT("w1", false)}'`,
      `echo '${WRITE("w2", "index.html")}'`,
      `echo '${RESULT("w2", false)}'`,
      `echo '{"type":"result","subtype":"success","num_turns":2,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.filesTouched).toEqual(["index.html"]);
    // The owner still sees the write happen in the feed.
    expect(run.progress.join("\n")).toContain(`Write ${path.join(root, "data", "coding-agent-artifacts", run.id, "report.md")}`);
  });

  it("does not arm the review pass over a report alone", async () => {
    writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true, coding_agent_review_pass: true });
    installFakeWrapper([
      `echo '${INIT}'`,
      EVIDENCE_WRITE("w1"),
      `echo '${RESULT("w1", false)}'`,
      `echo '{"type":"result","subtype":"success","num_turns":1,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);
    expect(run.filesTouched).toEqual([]);
    // Nothing observable follows a run with no changed files — no commit line
    // and, the point here, no second run — so the follow-up decision is given
    // time to happen before the run is checked to still be alone.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(JSON.parse(fs.readFileSync(runsFile(), "utf-8"))).toHaveLength(1);
  });
});

describe("showing that a quiet run is alive", () => {
  beforeEach(() => readyDevice());

  /** The event Claude Code emits while reasoning, before it has any output. */
  const THINK = (n: number) => JSON.stringify({
    type: "system", subtype: "thinking_tokens", estimated_tokens: n, estimated_tokens_delta: 2,
  });

  it("records reasoning progress, so silence is not mistaken for a hang", async () => {
    // A real run on this box spent 295s on its first turn at effort "max" with
    // nothing in the feed. The assistant read that as stuck and stopped it.
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${THINK(43)}'`,
      `echo '${THINK(120)}'`,
      `echo '${THINK(870)}'`,
      `echo '{"type":"result","subtype":"success","num_turns":1,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "big one", projectId: "site", source: "agent" })).id);

    expect(run.status).toBe("completed");
    expect(run.thinkingTokens).toBe(870);
    // Said ONCE, not once per event — these arrive continuously.
    const said = run.progress.filter((p) => p === "Thinking…");
    expect(said).toHaveLength(1);
  });

  it("never lets the count go backwards on an out-of-order event", async () => {
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${THINK(500)}'`,
      `echo '${THINK(12)}'`,
      `echo '{"type":"result","subtype":"success","num_turns":1,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);
    expect(run.thinkingTokens).toBe(500);
  });

  it("stamps a last-sign-of-life the status can answer 'is it stuck?' with", async () => {
    makeProject("site");
    const before = Date.now();
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);
    expect(run.lastActivityAt).toBeGreaterThanOrEqual(before);
  });
});

describe("counting sub-agents", () => {
  beforeEach(() => readyDevice());

  /** A run that spawns two sub-agents and gets one of them back. */
  const TASK_A = JSON.stringify({
    type: "assistant",
    message: { content: [
      { type: "tool_use", id: "toolu_a", name: "Task", input: { description: "search the tests" } },
      { type: "tool_use", id: "toolu_b", name: "Task", input: { description: "search the docs" } },
    ] },
  });
  const RESULT_A = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "done" }] },
  });

  it("counts them out and back, and never leaves one counted after the run ends", async () => {
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${TASK_A}'`,
      `echo '${RESULT_A}'`,
      `echo '{"type":"result","subtype":"success","num_turns":3,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");

    const started = await lib.startRun({ task: "wide sweep", projectId: "site", source: "agent" });
    const run = await finished(started.id);

    expect(run.status).toBe("completed");
    expect(run.subagentsTotal).toBe(2);
    // One never reported back, but the process tree is gone — nothing it
    // spawned can still be working, so a settled run shows none active.
    expect(run.subagentsActive).toBe(0);
    expect(run.progress.join(" ")).toContain("Sub-agent started: search the tests");
    expect(run.progress.join(" ")).toContain("Sub-agent finished");
  });

  it("does not double-count a repeated tool_result", async () => {
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${TASK_A}'`,
      `echo '${RESULT_A}'`,
      `echo '${RESULT_A}'`,
      `echo '{"type":"result","subtype":"success","num_turns":3,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "sweep", projectId: "site", source: "agent" })).id);
    // Two "started", exactly one "finished" — the duplicate id is ignored.
    const progress = run.progress.join("\n");
    expect(progress.match(/Sub-agent finished/g) ?? []).toHaveLength(1);
    expect(run.subagentsTotal).toBe(2);
  });

  it("records the effort the run started with", async () => {
    writeConfig({
      clawai_token: "claw_test_token",
      clawai_tier: "flash",
      coding_agent_enabled: true,
      coding_agent_effort: "low",
    });
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "quick one", projectId: "site", source: "agent" })).id);
    expect(run.effort).toBe("low");
    // And it actually reached the wrapper's environment.
    expect(fs.readFileSync(envFile(), "utf-8")).toContain("CLAUDE_DS_EFFORT=low");
    // A fixed level is no opt-in to orchestration: no Workflow tool, no
    // pre-approval for it, none of the ultracode brief.
    const argv = fs.readFileSync(argvFile(), "utf-8").split("\n").filter(Boolean);
    expect(argv[argv.indexOf("--tools") + 1].split(",")).not.toContain(lib.WORKFLOW_TOOL);
    expect(argv).not.toContain(lib.WORKFLOW_TOOL);
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).not.toContain("Ultracode is on");
  });

  it("keeps a background helper out until its task_notification, and bills a workflow from it", async () => {
    // Claude Code ≥ 2.1 answers the Agent call with a launch receipt and the
    // helper keeps working; the same for a Workflow. Read as completions, the
    // receipts had every helper "finished" the moment it started.
    const AGENT = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_a", name: "Agent", input: { subagent_type: "explorer", description: "map the router" } }] },
    });
    const AGENT_RECEIPT = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "call_a", content: [{ type: "text", text: "Async agent launched successfully. (This tool result is internal metadata)\nagentId: abc" }] }] },
    });
    const WORKFLOW = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_w", name: "Workflow", input: { script: "export const meta = { name: \"sweep\", description: \"review every page\" }\nreturn 1" } }] },
    });
    const WORKFLOW_RECEIPT = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "call_w", content: "Workflow launched in background. Task ID: t1\nSummary: review every page" }] },
    });
    const AGENT_DONE = JSON.stringify({ type: "system", subtype: "task_notification", task_id: "t0", tool_use_id: "call_a", status: "completed", usage: { total_tokens: 500 } });
    const WORKFLOW_DONE = JSON.stringify({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "call_w", status: "completed", usage: { total_tokens: 2368 } });
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${AGENT}'`,
      `echo '${AGENT_RECEIPT}'`,
      `echo '${WORKFLOW}'`,
      `echo '${WORKFLOW_RECEIPT}'`,
      "sleep 20",
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const started = await lib.startRun({ task: "wide job", projectId: "site", source: "agent" });
    let live = lib.getRun(started.id)!;
    for (let i = 0; i < 60 && live.subagentsTotal < 2; i++) {
      await new Promise((r) => setTimeout(r, 200));
      live = lib.getRun(started.id)!;
    }
    // Both receipts arrived; both helpers are still out.
    expect(live.subagentsTotal).toBe(2);
    expect(live.subagentsByType).toEqual({ explorer: 1, workflow: 1 });
    expect(live.activeSubagents.map((a) => a.type)).toEqual(["explorer", "workflow"]);
    expect(live.activeSubagents[1].description).toBe("review every page");
    expect(live.progress.join("\n")).toContain("Workflow started: review every page");
    expect(live.progress.join("\n")).not.toContain("finished");
    lib.stopRun(started.id);
    await finished(started.id);

    // And the notifications close them — the workflow's spend counted once,
    // the explorer's not (its own turns are on the stream and billed there).
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${AGENT}'`,
      `echo '${AGENT_RECEIPT}'`,
      `echo '${WORKFLOW}'`,
      `echo '${WORKFLOW_RECEIPT}'`,
      `echo '${WORKFLOW_DONE}'`,
      `echo '${AGENT_DONE}'`,
      `echo '${WORKFLOW_DONE}'`,
      `echo '{"type":"result","subtype":"success","num_turns":4,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    const run = await finished((await lib.startRun({ task: "wide job", projectId: "site", source: "agent" })).id);
    expect(run.status).toBe("completed");
    expect(run.subagentsTotal).toBe(2);
    expect(run.subagentsActive).toBe(0);
    expect(run.tokensUsed).toBe(2368);
    const progress = run.progress.join("\n");
    expect(progress.match(/Workflow finished/g) ?? []).toHaveLength(1);
    expect(progress.match(/Sub-agent finished \(explorer\)/g) ?? []).toHaveLength(1);
  });

  it("bills a workflow as it runs, from its task_progress totals, and stops at the ceiling", async () => {
    // The CLI reports a workflow's cumulative spend on every task_progress
    // (0 → 2368 → 2368 in the probe); the ceiling must hold while the
    // fan-out runs, not after it.
    writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true, coding_agent_token_limit: 10_000 });
    const WORKFLOW = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_w", name: "Workflow", input: { script: "export const meta = { name: \"sweep\", description: \"check\" }" } }] },
    });
    const RECEIPT = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call_w", content: "Workflow launched in background. Task ID: t1" }] } });
    const progressAt = (n: number) => JSON.stringify({ type: "system", subtype: "task_progress", task_id: "t1", tool_use_id: "call_w", usage: { total_tokens: n } });
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${WORKFLOW}'`,
      `echo '${RECEIPT}'`,
      `echo '${progressAt(0)}'`,
      `echo '${progressAt(4_000)}'`,
      `echo '${progressAt(4_000)}'`,
      `echo '${progressAt(12_000)}'`,
      "sleep 20",
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "sweep", projectId: "site", source: "agent" })).id);
    expect(run.status).toBe("stopped");
    expect(run.resumable).toBe(true);
    // Deltas, never the running total twice: 0 + 4000 + 0 + 8000.
    expect(run.tokensUsed).toBe(12_000);
    expect(run.error).toMatch(/Stopped at the token limit \(12,000 of 10,000\)/);
    expect(run.progress.join("\n")).toContain("Token limit reached");
  });

  it("takes a refused launch back out of the counts", async () => {
    // Listed without approval, the Workflow tool answers an is_error result
    // ("Review dynamic workflow before running"): a helper that never ran.
    const WORKFLOW = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_w", name: "Workflow", input: { script: "export const meta = { name: \"x\", description: \"probe\" }" } }] },
    });
    const REFUSED = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call_w", is_error: true, content: "Review dynamic workflow before running" }] } });
    const AGENT = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_a", name: "Agent", input: { subagent_type: "explorer", description: "map it" } }] },
    });
    const AGENT_DONE_SYNC = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call_a", content: "found it in a.js" }] } });
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${WORKFLOW}'`,
      `echo '${REFUSED}'`,
      `echo '${AGENT}'`,
      `echo '${AGENT_DONE_SYNC}'`,
      `echo '{"type":"result","subtype":"success","num_turns":3,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "probe", projectId: "site", source: "agent" })).id);
    expect(run.subagentsTotal).toBe(1);
    expect(run.subagentsByType).toEqual({ explorer: 1 });
    const progress = run.progress.join("\n");
    expect(progress).toContain("Workflow refused");
    expect(progress).not.toContain("Workflow finished");
    // An older CLI's synchronous answer still closes the helper as finished.
    expect(progress).toContain("Sub-agent finished (explorer)");
  });

  it("adds up the CLI's continuations: two results, one run", async () => {
    // A -p run restarted by a background helper emits a second init and a
    // second result whose num_turns and permission_denials are per segment
    // (the probe: 4 turns then 1; two denials then none).
    const DENIED = JSON.stringify({
      type: "result", subtype: "success", num_turns: 4, result: "waiting on the helper",
      permission_denials: [{ tool_name: "Workflow", tool_input: { script: "x" } }, { tool_name: "Workflow", tool_input: { script: "y" } }],
    });
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${DENIED}'`,
      `echo '${INIT}'`,
      `echo '{"type":"result","subtype":"success","num_turns":1,"result":"all done","permission_denials":[]}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "two segments", projectId: "site", source: "agent" })).id);
    expect(run.status).toBe("completed");
    expect(run.numTurns).toBe(5);
    expect(run.permissionDenials).toBe(2);
    expect(run.deniedActions).toHaveLength(2);
    expect(run.summary).toBe("all done");
    const progress = run.progress.join("\n");
    expect(progress.match(/Started with/g) ?? []).toHaveLength(1);
    expect(progress).toContain("Continuing after a background helper finished");
  });

  it("bills an API message once, however many content blocks the CLI streams it as", async () => {
    // 2.1.259 sends one assistant event per content block, each with the
    // message's whole usage: thinking, then tool_use. Billed per event a turn
    // cost double and the owner's ceiling tripped at half its number.
    const usage = { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 5_000 };
    const THINK = JSON.stringify({ type: "assistant", message: { id: "msg_1", usage, content: [{ type: "thinking", thinking: "…" }] } });
    const ACT = JSON.stringify({ type: "assistant", message: { id: "msg_1", usage, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } });
    const NEXT = JSON.stringify({ type: "assistant", message: { id: "msg_2", usage, content: [{ type: "text", text: "done" }] } });
    // A helper's own turn: billed, but not the run's command.
    const HELPER = JSON.stringify({ type: "assistant", parent_tool_use_id: "call_a", message: { id: "msg_h", usage, content: [{ type: "tool_use", id: "h1", name: "Bash", input: { command: "npm test" } }, { type: "text", text: "helper says hi" }] } });
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${THINK}'`,
      `echo '${ACT}'`,
      `echo '${NEXT}'`,
      `echo '${HELPER}'`,
      `echo '{"type":"result","subtype":"success","num_turns":2,"result":"done"}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "count", projectId: "site", source: "agent" })).id);
    expect(run.tokensUsed).toBe(3 * 6_100);
    expect(run.commandsRun).toBe(1);
    expect(run.progress.join("\n")).not.toContain("helper says hi");
    expect(run.progress.join("\n")).not.toContain("npm test");
  });

  it("dedupes interleaved helpers' messages, and bills the segment's output from the result", async () => {
    // Two helpers at once interleave their events (A-thinking, B-thinking,
    // A-text, B-text); and through the proxy every assistant event says
    // output_tokens 0 — the segment's result carries the real number.
    const ev = (id: string, parent: string, block: Record<string, unknown>) => JSON.stringify({
      type: "assistant", parent_tool_use_id: parent,
      message: { id, usage: { input_tokens: 5_000, output_tokens: 0 }, content: [block] },
    });
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${ev("msg_a", "call_a", { type: "thinking", thinking: "…" })}'`,
      `echo '${ev("msg_b", "call_b", { type: "thinking", thinking: "…" })}'`,
      `echo '${ev("msg_a", "call_a", { type: "text", text: "a" })}'`,
      `echo '${ev("msg_b", "call_b", { type: "text", text: "b" })}'`,
      `echo '{"type":"result","subtype":"success","num_turns":1,"result":"waiting","usage":{"input_tokens":10000,"output_tokens":700}}'`,
      `echo '${INIT}'`,
      `echo '{"type":"result","subtype":"success","num_turns":1,"result":"done","usage":{"input_tokens":10000,"output_tokens":9}}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "count", projectId: "site", source: "agent" })).id);
    // 5,000 twice (one message each), then 700 + 9 of output the events never carried.
    expect(run.tokensUsed).toBe(10_000 + 700 + 9);
  });

  it("raises the bill to the CLI's own modelUsage total at the end, never lowers it", async () => {
    // A workflow's task_progress totals leave out its agents' cache reads;
    // the result event's modelUsage is the whole process's bill.
    const A = JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 1_000, output_tokens: 0 }, content: [{ type: "text", text: "hi" }] } });
    const RESULT_HIGH = JSON.stringify({
      type: "result", subtype: "success", num_turns: 1, result: "done",
      modelUsage: { "deepseek-v4-pro[1m]": { inputTokens: 1_000, outputTokens: 50, cacheReadInputTokens: 20_000 }, "deepseek-v4-flash": { inputTokens: 3_000, outputTokens: 200, cacheReadInputTokens: 9_000 } },
    });
    installFakeWrapper([`echo '${INIT}'`, `echo '${A}'`, `echo '${RESULT_HIGH}'`, "exit 0"].join("\n"));
    makeProject("site");
    let run = await finished((await lib.startRun({ task: "bill", projectId: "site", source: "agent" })).id);
    expect(run.tokensUsed).toBe(33_250);
    expect(run.modelsUsed).toEqual(["deepseek-v4-flash", "deepseek-v4-pro[1m]"]);

    const RESULT_LOW = JSON.stringify({ type: "result", subtype: "success", num_turns: 1, result: "done", modelUsage: { "deepseek-v4-pro[1m]": { inputTokens: 10 } } });
    installFakeWrapper([`echo '${INIT}'`, `echo '${A}'`, `echo '${RESULT_LOW}'`, "exit 0"].join("\n"));
    run = await finished((await lib.startRun({ task: "bill", projectId: "site", source: "agent" })).id);
    expect(run.tokensUsed).toBe(1_000);
  });
});

describe("clearing the history", () => {
  beforeEach(() => readyDevice());

  it("forgets the finished runs", async () => {
    makeProject("site");
    await finished((await lib.startRun({ task: "one", projectId: "site", source: "agent" })).id);
    await finished((await lib.startRun({ task: "two", projectId: "site", source: "agent" })).id);
    expect(lib.listRuns()).toHaveLength(2);

    expect(lib.clearFinishedRuns()).toBe(2);
    expect(lib.listRuns()).toEqual([]);
    // On disk too, not just in memory.
    expect(JSON.parse(fs.readFileSync(runsFile(), "utf-8"))).toEqual([]);
    // Nothing left to clear says so honestly.
    expect(lib.clearFinishedRuns()).toBe(0);
  });

  it("keeps a run that is still in flight — it is the only handle on the process", async () => {
    installFakeWrapper(`echo '${INIT}'\nsleep 30\nexit 0`);
    makeProject("site");
    const live = await lib.startRun({ task: "slow one", projectId: "site", source: "agent" });
    expect(lib.runningCount()).toBe(1);

    expect(lib.clearFinishedRuns()).toBe(0);
    expect(lib.listRuns().map((r) => r.id)).toEqual([live.id]);
    // Still stoppable, which is the point of keeping it.
    lib.stopRun(live.id);
    const done = await finished(live.id);
    expect(done.status).toBe("stopped");

    // Once settled it is history like any other.
    expect(lib.clearFinishedRuns()).toBe(1);
    expect(lib.listRuns()).toEqual([]);
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
    // Idempotent: the second sweep finds nothing left to settle.
    expect(lib.reconcileAfterRestart()).toBe(0);
    const run = lib.getRun("run-lostrun1");
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/restarted/);
    expect(JSON.parse(fs.readFileSync(runsFile(), "utf-8"))[0].status).toBe("failed");
  });

  it("forgets the process group a settled run left behind, because the restart took it", async () => {
    // The recorded number belonged to the cgroup this restart replaced, and
    // Linux may already have given it to something else — an offer to end a
    // process nobody can still identify is worse than no offer at all.
    fs.writeFileSync(runsFile(), JSON.stringify([{
      id: "run-leftover1",
      task: "left a server listening",
      directory: home,
      projectId: null,
      source: "owner",
      status: "completed",
      startedAt: Date.now() - 60_000,
      completedAt: Date.now() - 30_000,
      sessionId: "sess-left",
      model: null,
      summary: null,
      error: null,
      numTurns: 2,
      filesTouched: [],
      commandsRun: 0,
      permissionDenials: 0,
      progress: [],
      exitCode: 0,
      pgid: 4242,
      leftover: true,
    }]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
    // Nothing was settled, so the operator's count stays at zero.
    expect(lib.reconcileAfterRestart()).toBe(0);
    const run = lib.getRun("run-leftover1");
    expect(run?.pgid).toBeNull();
    expect(run?.leftover).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(runsFile(), "utf-8"))[0];
    expect(onDisk.pgid).toBeNull();
    expect(onDisk.leftover).toBe(false);
  });
});

/**
 * The two counters the media routes spend, and the one property that is not
 * visible from either route: the slot is taken BEFORE the money is, so two
 * calls that overlap cannot both pass a cap with room for one.
 */
describe("the media a run generates", () => {
  const ID = "run-med00001";

  /** A record as the runner keeps it while a run is in flight. */
  async function writeRun(over: Record<string, unknown> = {}): Promise<void> {
    fs.writeFileSync(runsFile(), JSON.stringify([{
      id: ID,
      task: "draw something",
      directory: home,
      projectId: null,
      source: "owner",
      status: "running",
      startedAt: Date.now(),
      completedAt: null,
      sessionId: "sess-media",
      model: null,
      summary: null,
      error: null,
      numTurns: 0,
      filesTouched: [],
      commandsRun: 0,
      permissionDenials: 0,
      progress: [],
      exitCode: null,
      mediaGenerated: { images: 0, audio: 0 },
      ...over,
    }]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
  }

  it("lets only one of two callers take the last slot", async () => {
    await writeRun({ mediaGenerated: { images: lib.MAX_IMAGES_PER_RUN - 1, audio: 0 } });
    const first = lib.reserveRunMedia(ID, "images");
    const second = lib.reserveRunMedia(ID, "images");
    expect(first).toMatchObject({ ok: true, used: lib.MAX_IMAGES_PER_RUN });
    expect(second).toMatchObject({ ok: false, reason: "cap", used: lib.MAX_IMAGES_PER_RUN });
  });

  it("gives a slot back, so a refused generator costs the run nothing", async () => {
    await writeRun();
    expect(lib.reserveRunMedia(ID, "audio")).toMatchObject({ ok: true, used: 1 });
    lib.releaseRunMedia(ID, "audio");
    expect(lib.reserveRunMedia(ID, "audio")).toMatchObject({ ok: true, used: 1 });
  });

  it("spends nothing on a record that is no longer live", async () => {
    // The bearer a run holds outlives the run, and the audio route can be
    // waiting in the speech queue when it settles.
    await writeRun({ status: "completed", completedAt: Date.now() });
    expect(lib.reserveRunMedia(ID, "images")).toMatchObject({ ok: false, reason: "no_run" });
    expect(lib.getRun(ID)?.mediaGenerated.images).toBe(0);
  });

  it("records the file against the live run and nothing against a settled one", async () => {
    await writeRun();
    lib.noteRunMedia(ID, path.join(home, "hero.png"));
    expect(lib.getRun(ID)?.filesTouched).toEqual(["hero.png"]);
    await writeRun({ status: "stopped", completedAt: Date.now() });
    lib.noteRunMedia(ID, path.join(home, "late.png"));
    expect(lib.getRun(ID)?.filesTouched).toEqual([]);
  });
});

describe("the pull request on disk", () => {
  /** A finished record, as an older server wrote it, carrying the `pr` blob under test. */
  function writeRunWithPr(pr: Record<string, unknown>): void {
    fs.writeFileSync(runsFile(), JSON.stringify([{
      id: "run-prblob01",
      task: "opened a pull request",
      directory: home,
      projectId: null,
      source: "owner",
      status: "completed",
      startedAt: Date.now() - 60_000,
      completedAt: Date.now() - 30_000,
      sessionId: "sess-old",
      model: null,
      summary: null,
      error: null,
      numTurns: 2,
      filesTouched: [],
      commandsRun: 0,
      permissionDenials: 0,
      progress: [],
      exitCode: 0,
      pr,
    }]));
  }

  it("repairs a wrong field to its default rather than trusting it", () => {
    // A number that is a string reached `gh pr view` as an argument, and a
    // count that was not a count reached the owner as "undefined of undefined
    // checks". A verdict the record does not carry is not a pass.
    writeRunWithPr({ phase: "waiting", startedAt: 1, number: "7", checks: { total: "x" } });
    const pr = lib.listRuns()[0]?.pr;
    expect(pr).not.toBeNull();
    expect(pr?.phase).toBe("waiting");
    expect(pr?.number).toBeNull();
    expect(pr?.checks).toEqual({ total: 0, passed: 0, failed: 0, pending: 0 });
    expect(pr?.reviewOk).toBe(false);
    // The fields the blob never had are filled in too, so no reader sees undefined.
    expect(pr).toMatchObject({ url: null, branch: null, base: null, detail: null, endedAt: null });
  });

  it("keeps every field of a well-formed blob", () => {
    writeRunWithPr({
      phase: "merged", number: 7, url: "https://github.com/o/r/pull/7", branch: "clawbox/run-prblob01", base: "main",
      checks: { total: 3, passed: 2, failed: 0, pending: 1 }, detail: null, startedAt: 1, endedAt: 2, reviewOk: true,
    });
    expect(lib.listRuns()[0]?.pr).toEqual({
      phase: "merged", number: 7, url: "https://github.com/o/r/pull/7", branch: "clawbox/run-prblob01", base: "main",
      checks: { total: 3, passed: 2, failed: 0, pending: 1 }, detail: null, startedAt: 1, endedAt: 2, reviewOk: true,
    });
  });

  it("drops a blob whose phase is not one of ours — that is not a pull request", () => {
    writeRunWithPr({ phase: "open", startedAt: 1, number: 7, checks: { total: 1, passed: 1, failed: 0, pending: 0 } });
    const run = lib.listRuns()[0];
    expect(run?.id).toBe("run-prblob01");
    expect(run?.pr).toBeNull();
  });

  it("drops a blob without a start, and one that is not an object", () => {
    writeRunWithPr({ phase: "waiting", number: 7 });
    expect(lib.listRuns()[0]?.pr).toBeNull();
    lib._resetCodingAgentStateForTests();
    writeRunWithPr("waiting" as unknown as Record<string, unknown>);
    expect(lib.listRuns()[0]?.pr).toBeNull();
  });
});

describe("naming the sub-agents that are out", () => {
  beforeEach(() => readyDevice());

  const TASK = (id: string, kind: string, what: string) => JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Task", input: { subagent_type: kind, description: what } }] },
  });
  const DONE = (id: string) => JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });

  it("reports which helper is working, not just how many", async () => {
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${TASK("s1", "explorer", "find where the router is wired")}'`,
      `echo '${TASK("s2", "tester", "run the unit tests")}'`,
      `echo '${DONE("s1")}'`,
      "sleep 20",
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const started = await lib.startRun({ task: "wide job", projectId: "site", source: "agent" });

    // While it works: one finished, one still out — and we can say which.
    // Poll rather than guess a delay: spawning through setpriv on a Jetson is
    // not instant, and a fixed sleep makes this test flaky by construction.
    let live = lib.getRun(started.id)!;
    for (let i = 0; i < 60 && live.subagentsTotal < 2; i++) {
      await new Promise((r) => setTimeout(r, 200));
      live = lib.getRun(started.id)!;
    }
    expect(live.subagentsTotal).toBe(2);
    expect(live.activeSubagents.map((a) => a.type)).toEqual(["tester"]);
    expect(live.activeSubagents[0].description).toBe("run the unit tests");
    expect(live.progress.join("\n")).toContain("Sub-agent started (explorer): find where the router is wired");

    lib.stopRun(started.id);
    const done = await finished(started.id);
    // Nothing it spawned can outlive it.
    expect(done.activeSubagents).toEqual([]);
    expect(done.subagentsActive).toBe(0);
  });
});

describe("the report", () => {
  beforeEach(() => readyDevice());

  const reportOf = (id: string) => path.join(root, "data", "coding-agent-artifacts", id, "report.md");

  it("files the closing message as report.md beside the run's evidence", async () => {
    makeProject("site");
    const run = await lib.startRun({ task: "Build it", projectId: "site", source: "agent" });
    const done = await finished(run.id);
    expect(done.status).toBe("completed");
    expect(fs.readFileSync(reportOf(run.id), "utf-8")).toBe(`${done.summary}\n`);
    // Renamed into place: nothing half-written is left beside it.
    expect(fs.readdirSync(path.dirname(reportOf(run.id)))).toEqual(["report.md"]);
    // The listing the app reads carries it as markdown, which is what opens
    // it rendered rather than as plain text.
    const artifactsLib = await import("@/lib/coding-agent-artifacts");
    expect(artifactsLib.listArtifacts(run.id)).toMatchObject([{ name: "report.md", kind: "markdown" }]);
  });

  it("files the closing message of a run that did not finish, too", async () => {
    // A partial account is what the owner reads before deciding whether to
    // resume, so a failure with words still gets its report.
    const failed = JSON.stringify({
      type: "result", subtype: "success", is_error: true, num_turns: 1,
      result: "## Blocked\nThe build needs node 22.",
    });
    installFakeWrapper([`echo '${INIT}'`, `printf '%s\\n' '${failed}'`, "exit 1"].join("\n"));
    makeProject("site");
    const run = await lib.startRun({ task: "Build it", projectId: "site", source: "agent" });
    const done = await finished(run.id);
    expect(done.status).toBe("failed");
    expect(fs.readFileSync(reportOf(run.id), "utf-8")).toBe("## Blocked\nThe build needs node 22.\n");
  });

  it("never files the first attempt's words when the retry dies without any", async () => {
    // A 503 arrives as a RESULT event, so its text lands in the summary
    // before the retry decision. The second attempt exits with no result at
    // all; the report must be empty, not the first attempt's error text
    // filed as though it were this run's account of itself.
    const counter = path.join(home, "attempts.txt");
    const first = JSON.stringify({
      type: "result", subtype: "success", is_error: true, num_turns: 1,
      result: "API Error: 503 Service Unavailable",
    });
    installFakeWrapper([
      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"`,
      `echo '${INIT}'`,
      'if [ "$n" = "1" ]; then',
      `  printf '%s\\n' '${first}'`,
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n"));
    makeProject("site");
    const run = await lib.startRun({ task: "Build it", projectId: "site", source: "agent" });
    const done = await finished(run.id);
    expect(done.retries).toBe(1);
    expect(done.status).toBe("failed");
    expect(done.summary).toBeNull();
    expect(done.error).not.toContain("503");
    expect(fs.existsSync(reportOf(run.id))).toBe(false);
  });

  it("leaves a report the run wrote itself alone", async () => {
    // The brief invites a run to write its own report.md; that file knows
    // more about the work than the closing message does, so it wins.
    installFakeWrapper([
      `echo '${INIT}'`,
      `printf '# Mine\\n' > "$CLAWBOX_RUN_ARTIFACTS_DIR/report.md"`,
      `echo '${RESULT}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await lib.startRun({ task: "Build it", projectId: "site", source: "agent" });
    const done = await finished(run.id);
    expect(done.status).toBe("completed");
    expect(done.summary).toContain("Changed index.html");
    expect(fs.readFileSync(reportOf(run.id), "utf-8")).toBe("# Mine\n");
  });

  it("keeps the run's outcome when the report cannot be written", async () => {
    // The run replaces its own evidence folder with a plain file, so the
    // write fails in a way no permission bit could rescue — and the record
    // must still say what the run did.
    installFakeWrapper([
      `echo '${INIT}'`,
      `rmdir "$CLAWBOX_RUN_ARTIFACTS_DIR" && touch "$CLAWBOX_RUN_ARTIFACTS_DIR"`,
      `echo '${RESULT}'`,
      "exit 0",
    ].join("\n"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      makeProject("site");
      const run = await lib.startRun({ task: "Build it", projectId: "site", source: "agent" });
      const done = await finished(run.id);
      expect(done.status).toBe("completed");
      expect(done.summary).toContain("Changed index.html");
      expect(done.error).toBeNull();
      expect(fs.statSync(path.dirname(reportOf(run.id))).isFile()).toBe(true);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("report.md"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * The run's own plan. Claude Code's TodoWrite tool sends the WHOLE list each
 * time; the record keeps the latest one so the chat card can show what the
 * run is on in its own words — the owner's "show summaries of current tasks".
 */
describe("the run's plan", () => {
  beforeEach(() => readyDevice());

  const TODO = (todos: unknown) => JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t_todo", name: "TodoWrite", input: { todos } }] },
  });
  const DONE = '{"type":"result","subtype":"success","num_turns":2,"result":"done"}';

  it("keeps the latest list, and notes each rewrite as one line in the feed", async () => {
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${TODO([
        { content: "Scaffold the page", status: "completed", activeForm: "Scaffolding the page" },
        { content: "Wire the game loop", status: "in_progress", activeForm: "Wiring the game loop" },
        { content: "Add tests", status: "pending" },
      ])}'`,
      `echo '${TODO([
        { content: "Scaffold the page", status: "completed" },
        { content: "Wire the game loop", status: "completed" },
        { content: "Add tests", status: "in_progress", activeForm: "Adding tests" },
      ])}'`,
      `echo '${DONE}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.todos).toEqual([
      { content: "Scaffold the page", status: "completed" },
      { content: "Wire the game loop", status: "completed" },
      { content: "Add tests", status: "in_progress", activeForm: "Adding tests" },
    ]);
    // One summary line per rewrite — never the list itself in the feed.
    expect(run.progress.filter((p) => p.startsWith("Plan:"))).toEqual(["Plan: 3 tasks, 1 done", "Plan: 3 tasks, 2 done"]);
    expect(run.progress.join("\n")).not.toContain("Wire the game loop");
  });

  it("caps the list, cuts each line, and reads an unknown status as pending", async () => {
    const long = "x".repeat(400);
    const todos = Array.from({ length: 25 }, (_, i) => ({ content: `task ${i} ${long}`, status: i === 0 ? "done" : "pending" }));
    installFakeWrapper([`echo '${INIT}'`, `echo '${TODO(todos)}'`, `echo '${DONE}'`, "exit 0"].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    expect(run.todos).toHaveLength(20);
    expect(run.todos[0].content.length).toBe(160);
    expect(run.todos[0].content.endsWith("…")).toBe(true);
    expect(run.todos[0].status).toBe("pending"); // "done" is not a status the tool defines
    expect(run.progress).toContain("Plan: 20 tasks, 0 done");
  });

  it("ignores a payload that is not a list, and skips items without words", async () => {
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${TODO([{ content: "Real", status: "in_progress" }])}'`,
      `echo '${TODO("not a list")}'`,
      `echo '${TODO([null, 7, { status: "completed" }, { content: "   " }, { content: "Also real" }])}'`,
      `echo '${DONE}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await finished((await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id);

    // The string payload left the good list alone; the mixed list kept its one readable item.
    expect(run.todos).toEqual([{ content: "Also real", status: "pending" }]);
    expect(run.progress.filter((p) => p.startsWith("Plan:"))).toEqual(["Plan: 1 tasks, 0 done", "Plan: 1 tasks, 0 done"]);
    // The unparseable call still shows in the feed as the tool it was.
    expect(run.progress).toContain("TodoWrite");
  });

  it("is on the record on disk and survives a fresh import", async () => {
    installFakeWrapper([
      `echo '${INIT}'`,
      `echo '${TODO([{ content: "Wire it", status: "in_progress", activeForm: "Wiring it" }])}'`,
      `echo '${DONE}'`,
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const id = (await lib.startRun({ task: "t", projectId: "site", source: "agent" })).id;
    await finished(id);

    const onDisk = JSON.parse(fs.readFileSync(runsFile(), "utf-8")) as { id: string; todos: unknown }[];
    expect(onDisk.find((r) => r.id === id)?.todos).toEqual([{ content: "Wire it", status: "in_progress", activeForm: "Wiring it" }]);

    vi.resetModules();
    const fresh: Lib = await import("@/lib/coding-agent");
    expect(fresh.getRun(id)?.todos).toEqual([{ content: "Wire it", status: "in_progress", activeForm: "Wiring it" }]);
    // A record from before the field existed reads as "never planned".
    expect(fresh.parseTodosForTests(undefined)).toBeNull();
  });
});
