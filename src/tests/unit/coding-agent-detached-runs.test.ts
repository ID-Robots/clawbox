/**
 * A run in its own systemd scope, and what a restart does to it.
 *
 * Before this, a coding run was a plain child of `clawbox-setup`: the
 * `systemctl restart` at the end of every in-app update killed the whole cgroup
 * and a forty-minute run died at minute thirty-nine with "the web server
 * restarted". `systemd-run --user --scope` puts the harness in a cgroup outside
 * the service's, so the restart reaches the web server and nothing else — and
 * the next server has to be able to find the survivor again.
 *
 * Every systemd call here is a PATH shim: a script that records its own argv and
 * answers what the test wants, so the two things worth pinning — what the box
 * actually asks systemd for, and what it concludes from the answer — are pinned
 * without needing a user manager on the machine running the suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

// Starts real processes (bash, setpriv, git): vitest's 5 s test default is not
// enough on a loaded runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

const announce = vi.hoisted(() => vi.fn<(run: unknown) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: announce }));

const closeSessionsForRun = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun }));

const ensureProjectIcon = vi.hoisted(() => vi.fn(async () => ({ icon: "skipped", favicon: false })));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon }));

type Lib = typeof import("@/lib/coding-agent");
type UnitLib = typeof import("@/lib/coding-run-unit");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let shimDir: string;
let restore: () => void;
/** Bus sockets a test opened, closed in teardown so no worker keeps a listener. */
let listening: net.Server[] = [];

const runsFile = () => path.join(root, "data", "coding-agent-runs.json");
const streamLog = (id: string) => path.join(root, "data", "coding-agent-streams", `${id}.jsonl`);
/** Every argv the fake systemd-run was called with, one per line. */
const systemdRunLog = () => path.join(base, "systemd-run.log");
/** Every argv the fake systemctl was called with, one per line. */
const systemctlLog = () => path.join(base, "systemctl.log");
/** What the fake systemctl answers `is-active` with. */
const activeState = () => path.join(base, "is-active");

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

function installWrapper(body: string): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    ["#!/usr/bin/env bash", "cat > /dev/null", body].join("\n"),
    { mode: 0o755 },
  );
}

/**
 * A `systemd-run` that records what it was asked for and then does what the real
 * one does: exec whatever follows the `--`, in this very process, so the pid the
 * web server holds is the harness's own.
 */
function installSystemdRun(): void {
  fs.writeFileSync(
    path.join(shimDir, "systemd-run"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(systemdRunLog())}`,
      "rest=()",
      "seen=0",
      'for a in "$@"; do',
      '  if [ "$seen" = 1 ]; then rest+=("$a"); continue; fi',
      '  if [ "$a" = "--" ]; then seen=1; fi',
      "done",
      '[ "${#rest[@]}" -eq 0 ] && exit 0',
      'exec "${rest[@]}"',
    ].join("\n"),
    { mode: 0o755 },
  );
}

/**
 * A `systemd-run` that refuses the way a box with no working user manager does —
 * loudly, on stderr, after the spawn has already happened. That is the ONLY way
 * this failure can be found out: the probe looks at the user bus rather than
 * creating a throwaway scope, so the box learns the rest from a real spawn.
 */
function installRefusingSystemdRun(): void {
  fs.writeFileSync(
    path.join(shimDir, "systemd-run"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(systemdRunLog())}`,
      "echo 'Failed to start transient scope unit: Access denied' >&2",
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/**
 * Point the probe's user-bus check at a directory with no `bus` in it, which is
 * what a user with no systemd manager has.
 */
function withoutUserManager(): void {
  process.env.XDG_RUNTIME_DIR = path.join(base, "no-runtime");
  fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
}

/** A runtime directory with a real `bus` socket in it, the way a lingering user has. */
function withUserManager(): void {
  const dir = path.join(base, "runtime");
  fs.mkdirSync(dir, { recursive: true });
  const bus = path.join(dir, "bus");
  if (!fs.existsSync(bus)) {
    // A real AF_UNIX socket, because the probe asks `isSocket()` and a plain
    // file would be the wrong answer to the right question.
    const server = net.createServer();
    server.listen(bus);
    listening.push(server);
  }
  process.env.XDG_RUNTIME_DIR = dir;
}

function installSystemctl(state: "active" | "inactive" | "failed"): void {
  fs.writeFileSync(activeState(), state, "utf-8");
  fs.writeFileSync(
    path.join(shimDir, "systemctl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog())}`,
      'for a in "$@"; do',
      `  if [ "$a" = "is-active" ]; then cat ${JSON.stringify(activeState())}; exit 0; fi`,
      "done",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/**
 * A `systemctl` whose `stop` FAILS, so the fallback can be watched. Everything
 * else answers as usual, because `is-active` is what keeps a reattached run
 * from settling under the test.
 */
function installSystemctlThatCannotStop(state: "active" | "inactive"): void {
  fs.writeFileSync(activeState(), state, "utf-8");
  fs.writeFileSync(
    path.join(shimDir, "systemctl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog())}`,
      'for a in "$@"; do',
      `  if [ "$a" = "is-active" ]; then cat ${JSON.stringify(activeState())}; exit 0; fi`,
      '  if [ "$a" = "stop" ]; then echo "Failed to stop unit: Access denied" >&2; exit 1; fi',
      "done",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function shimCalls(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * The systemd-run calls that SPAWNED something, with the readiness probe's own
 * throwaway scope left out — it names `clawbox-run-probe-…` and runs /bin/true.
 */
function spawnCalls(): string[] {
  return shimCalls(systemdRunLog()).filter((line) => !line.includes("clawbox-run-probe-"));
}

const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "All done.",
  session_id: "sess-detached-1",
});

/** A run record as the previous web server would have left it: live, in a scope. */
function liveRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-detach01",
    task: "keep going across the restart",
    directory: path.join(home, "Projects", "site"),
    projectId: null,
    source: "owner",
    status: "running",
    startedAt: Date.now() - 60_000,
    completedAt: null,
    sessionId: "sess-detached-1",
    provider: "clawbox-ai",
    requestedModel: null,
    model: null,
    summary: null,
    error: null,
    numTurns: 1,
    filesTouched: [],
    commandsRun: 0,
    permissionDenials: 0,
    progress: [],
    progressAt: [],
    exitCode: null,
    effort: "max",
    maxTurns: 150,
    lastActivityAt: Date.now(),
    unit: "clawbox-run-detach01-abc.scope",
    // Deliberately null: a fixture pgid would have the signal path aiming at
    // whatever real process group the machine has given that number to.
    pgid: null,
    streamOffset: 0,
    ...over,
  };
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "PATH", "XDG_RUNTIME_DIR", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  listening = [];
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-detached-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  shimDir = path.join(base, "shim");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(path.join(home, "Projects", "site"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  // The shims come first, so nothing here can reach the machine's own systemd.
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
  writeConfig({});
  announce.mockClear();
  closeSessionsForRun.mockClear();
  ensureProjectIcon.mockClear();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  for (const server of listening) server.close();
  listening = [];
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the scope prefix", () => {
  it("carries the memory caps and leaves the capability drop untouched behind the --", async () => {
    const units: UnitLib = await import("@/lib/coding-run-unit");
    const { bin, argv } = units.buildScopeArgv(
      "/usr/bin/systemd-run",
      "clawbox-run-abc123.scope",
      "/usr/bin/setpriv",
      ["--ambient-caps=-all", "/home/clawbox/.local/bin/claude-ds", "-p"],
    );
    expect(bin).toBe("/usr/bin/systemd-run");
    expect(argv.slice(0, argv.indexOf("--"))).toEqual([
      "--user",
      "--scope",
      "--unit=clawbox-run-abc123",
      "--collect",
      "--quiet",
      "-p",
      `MemoryHigh=${units.RUN_MEMORY_HIGH}`,
      "-p",
      `MemoryMax=${units.RUN_MEMORY_MAX}`,
    ]);
    // The security boundary is what follows: the cgroup prefix must not have
    // reordered, dropped or wrapped any of it.
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual([
      "/usr/bin/setpriv",
      "--ambient-caps=-all",
      "/home/clawbox/.local/bin/claude-ds",
      "-p",
    ]);
  });

  it("names only units built from the run-id alphabet", async () => {
    const units: UnitLib = await import("@/lib/coding-run-unit");
    expect(units.runScopeUnit("run-abc123")).toBe("clawbox-run-run-abc123.scope");
    expect(units.runScopeUnit("run abc")).toBeNull();
    expect(units.runScopeUnit("run;rm -rf /")).toBeNull();
    expect(units.runScopeUnit("")).toBeNull();
    expect(units.isRunScopeUnit("clawbox-run-abc.scope")).toBe(true);
    expect(units.isRunScopeUnit("clawbox-run-a b.scope")).toBe(false);
    expect(units.isRunScopeUnit("sshd.service")).toBe(false);
  });

  it("drops a unit name a hand-edited record carries", async () => {
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({ status: "completed", unit: "sshd.service" })]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
    expect(lib.getRun("run-detach01")?.unit).toBeNull();
  });
});

describe("the reattach step on the timeline", () => {
  it("carries a label key, so a localised page does not draw the runner's English", async () => {
    const { describeProgressLine, RUNNER_STEP } = await import("@/lib/coding-agent-progress");
    // The pattern is anchored to the sentence the runner writes, so this fails
    // the moment either side is reworded without the other.
    expect(describeProgressLine(RUNNER_STEP.reattached)).toMatchObject({ labelKey: "reattached", icon: "link" });
  });
});

describe("the stream log", () => {
  it("is denied to the run whose output it holds, even on the very first spawn", () => {
    // The directory is created by the first spawn, AFTER that spawn's deny
    // rules have been computed from what was on disk — so discovery alone would
    // leave it open for one run, and a team runs three workers side by side.
    const denied = lib.buildRunArgs({ resumeSessionId: null }).join(" ");
    const streams = path.join(root, "data", "coding-agent-streams");
    for (const tool of ["Read", "Write", "Glob", "Grep"]) {
      expect(denied).toContain(`${tool}(/${streams}/**)`);
    }
  });
});

describe("readiness", () => {
  it("says runs are detached when the binary is there and this user has a manager", async () => {
    installSystemdRun();
    withUserManager();
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    installWrapper("exit 0");
    const readiness = await lib.checkReadiness();
    expect(readiness.detachedRuns).toBe(true);
    expect(readiness.detachedRunsDetail).toBeNull();
  });

  it("says why not, and does not make it a problem that refuses runs", async () => {
    installSystemdRun();
    withoutUserManager();
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    installWrapper("exit 0");
    const readiness = await lib.checkReadiness();
    expect(readiness.detachedRuns).toBe(false);
    expect(readiness.detachedRunsDetail).toMatch(/enable-linger/);
    // A degradation, never a blocker: the run still happens as a plain child.
    expect(readiness.problems.join(" ")).not.toMatch(/systemd/i);
    expect(readiness.ready).toBe(true);
  });

  it("says runs are not detached when systemd-run is not installed at all", async () => {
    // Nothing but the (empty) shim directory: the machine running the suite may
    // well have systemd-run of its own, and this test is about a box that does not.
    process.env.PATH = shimDir;
    withUserManager();
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    installWrapper("exit 0");
    const readiness = await lib.checkReadiness();
    expect(readiness.detachedRuns).toBe(false);
    expect(readiness.detachedRunsDetail).toMatch(/not installed/);
  });

  it("spawns nothing to answer, so a caller that stubbed child_process cannot hang on it", async () => {
    // The probe used to create a throwaway scope around `true`. Several route
    // handlers reach readiness with `child_process` mocked, and a mocked
    // execFile never calls back — so the probe hung until its own deadline and
    // took the request with it. It asks the filesystem now.
    installSystemdRun();
    withUserManager();
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    installWrapper("exit 0");
    expect((await lib.checkReadiness()).detachedRuns).toBe(true);
    expect(shimCalls(systemdRunLog())).toHaveLength(0);
  });
});

describe("spawning", () => {
  it("puts the run in a scope of its own and records the unit while it works", async () => {
    installSystemdRun();
    installSystemctl("active");
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    // Long enough to be looked at mid-run, then a clean result.
    installWrapper(`sleep 3\necho '${RESULT}'\nexit 0`);
    const started = await lib.startRun({ task: "Build it", directory: path.join(home, "Projects", "site"), source: "owner" });

    const live = lib.getRun(started.id);
    expect(live?.status).toBe("running");
    expect(live?.unit).toMatch(new RegExp(`^clawbox-run-${started.id}-[a-z0-9]+\\.scope$`));

    // Waited for: `spawn` returns before the shell it started has run a line.
    await vi.waitFor(() => expect(spawnCalls()).toHaveLength(1), { timeout: 10_000 });
    const asked = spawnCalls();
    expect(asked[0]).toContain("--user --scope");
    expect(asked[0]).toContain(`--unit=clawbox-run-${started.id}-`);
    expect(asked[0]).toContain("MemoryHigh=3G");
    expect(asked[0]).toContain("MemoryMax=4G");
    expect(asked[0]).toContain("--collect");

    const settled = await lib.waitForRun(started.id, 25_000);
    expect(settled?.status).toBe("completed");
    // The harness's own words reached the record through the LOG, not a pipe.
    expect(settled?.summary).toContain("All done.");
    // And the plumbing is cleared up: a log kept past the settle is disk
    // nobody asked to spend.
    expect(fs.existsSync(streamLog(started.id))).toBe(false);
  });

  it("falls back to a plain child when this user has no systemd manager", async () => {
    installSystemdRun();
    withoutUserManager();
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    installWrapper(`echo '${RESULT}'\nexit 0`);
    const started = await lib.startRun({ task: "Build it", directory: path.join(home, "Projects", "site"), source: "owner" });
    const settled = await lib.waitForRun(started.id, 25_000);
    expect(settled?.status).toBe("completed");
    expect(settled?.summary).toContain("All done.");
    // Asserted after the run has settled, so there was time for it to have.
    expect(spawnCalls()).toHaveLength(0);
    expect(settled?.unit).toBeNull();
  });

  it("learns from a scope systemd turns away: retries directly, and says so in readiness", async () => {
    // The probe cannot find this out by looking — the binary is there and the
    // user bus is there, and systemd still says no. So the box learns it from the
    // spawn that failed: the one automatic retry goes without a scope (nothing
    // happened that it could trip over, because the harness never ran), and
    // readiness reports systemd's own words until a scope demonstrably works.
    installRefusingSystemdRun();
    withUserManager();
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    installWrapper(`echo '${RESULT}'\nexit 0`);
    const started = await lib.startRun({ task: "Build it", directory: path.join(home, "Projects", "site"), source: "owner" });
    const settled = await lib.waitForRun(started.id, 25_000);
    // The retry ran the harness directly and it finished.
    expect(settled?.status).toBe("completed");
    expect(settled?.summary).toContain("All done.");
    expect(settled?.retries).toBe(1);
    expect(settled?.unit).toBeNull();
    // Exactly one attempt went through systemd-run; the retry did not.
    expect(spawnCalls()).toHaveLength(1);

    const readiness = await lib.checkReadiness();
    expect(readiness.detachedRuns).toBe(false);
    expect(readiness.detachedRunsDetail).toMatch(/Access denied/);
    // Still not a blocker — the run just finished.
    expect(readiness.ready).toBe(true);
  });
});

describe("after a restart", () => {
  it("reattaches to a run whose scope is still active, and settles nothing", async () => {
    installSystemdRun();
    installSystemctl("active");
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    expect(await lib.reconcileAfterRestart()).toBe(0);
    const run = lib.getRun("run-detach01");
    expect(run?.status).toBe("running");
    // The handles on it are kept, because they still name something real.
    expect(run?.unit).toBe("clawbox-run-detach01-abc.scope");
    expect(run?.progress.join(" ")).toMatch(/picked back up/i);
    expect(shimCalls(systemctlLog()).join("\n")).toContain("--user is-active clawbox-run-detach01-abc.scope");
  });

  it("starts the idle clock at the reattach, not at what the last server saw", async () => {
    // The watchdog is armed against `lastActivityAt`. Judged on the PREVIOUS
    // server's last event, a run that outlived a restart longer than the idle
    // timeout would be killed on its first check — about a minute after boot,
    // with "no sign of life" on the record — while working perfectly well. This
    // process saw nothing during the gap and may not hold the run to it.
    installSystemdRun();
    installSystemctl("active");
    const longAgo = Date.now() - 6 * 60 * 60_000;
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({ lastActivityAt: longAgo, startedAt: longAgo })]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    const before = Date.now();
    expect(await lib.reconcileAfterRestart()).toBe(0);
    const run = lib.getRun("run-detach01");
    expect(run?.status).toBe("running");
    expect(run?.lastActivityAt).toBeGreaterThanOrEqual(before);
  });

  it("keeps following the log of a reattached run from where the last server stopped", async () => {
    installSystemdRun();
    installSystemctl("active");
    fs.mkdirSync(path.join(root, "data", "coding-agent-streams"), { recursive: true });
    // The first server read the init event and got no further; the tail is the
    // part this server has to pick up.
    const first = `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-detached-1" })}\n`;
    const second = `${JSON.stringify({ type: "assistant", message: { id: "msg-1", content: [{ type: "text", text: "carrying on" }] } })}\n`;
    fs.writeFileSync(streamLog("run-detach01"), first + second);
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({ streamOffset: Buffer.byteLength(first) })]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    expect(await lib.reconcileAfterRestart()).toBe(0);
    await vi.waitFor(
      () => expect(lib.getRun("run-detach01")?.streamOffset).toBe(Buffer.byteLength(first + second)),
      { timeout: 5_000 },
    );
  });

  it("settles a reattached run whose harness has gone, even while its scope lives on", async () => {
    // A run that left a server listening — the pattern the orientation guide
    // documents — keeps its cgroup alive after the harness has finished. Waiting
    // for the cgroup would leave a settled run showing "running" until the idle
    // timeout killed it and the server with it.
    installSystemdRun();
    installSystemctl("active");
    const { spawnSync } = await import("child_process");
    // A pid that has just been reaped: Linux hands them out in order, so it is
    // gone and is not about to belong to something else.
    const dead = spawnSync("/bin/true");
    expect(dead.pid).toBeTypeOf("number");
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({ pgid: dead.pid })]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    expect(await lib.reconcileAfterRestart()).toBe(0);
    expect(lib.getRun("run-detach01")?.status).toBe("running");
    await vi.waitFor(
      () => expect(lib.getRun("run-detach01")?.status).toBe("failed"),
      { timeout: 15_000, interval: 250 },
    );
    // Nothing in its log said it finished, so this is the honest ending.
    expect(lib.getRun("run-detach01")?.error).toMatch(/before reporting a result|restarted/i);
  });

  it("settles a run whose scope is gone as lost to the restart", async () => {
    installSystemdRun();
    installSystemctl("inactive");
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    expect(await lib.reconcileAfterRestart()).toBe(1);
    const run = lib.getRun("run-detach01");
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/box restarted while the run was live/i);
    // Nothing may be signalled in its name: the cgroup took the group with it.
    expect(run?.unit).toBeNull();
    expect(run?.pgid).toBeNull();
  });

  it("settles a run whose scope is gone as COMPLETED when its log says it finished", async () => {
    // The run outlived the web server, finished properly while nobody was
    // watching, and its scope was collected before this server booted. The log
    // is the only record of that, and reporting it as "the box restarted" would
    // throw away finished work.
    installSystemdRun();
    installSystemctl("inactive");
    fs.mkdirSync(path.join(root, "data", "coding-agent-streams"), { recursive: true });
    fs.writeFileSync(streamLog("run-detach01"), `${RESULT}\n`);
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    expect(await lib.reconcileAfterRestart()).toBe(1);
    const run = lib.getRun("run-detach01");
    expect(run?.status).toBe("completed");
    expect(run?.summary).toContain("All done.");
  });

  it("keeps a settled run's scope while it is still up, so Kill still names what it named", async () => {
    // A pid may since have been handed to a stranger, which is why it is
    // forgotten; a unit name is never handed to anybody, so it survives.
    installSystemdRun();
    installSystemctl("active");
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({
      status: "completed",
      completedAt: Date.now() - 1_000,
      pgid: 424242,
      leftover: true,
    })]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    expect(await lib.reconcileAfterRestart()).toBe(0);
    const run = lib.getRun("run-detach01");
    expect(run?.unit).toBe("clawbox-run-detach01-abc.scope");
    expect(run?.leftover).toBe(true);
    expect(run?.pgid).toBeNull();
  });

  it("forgets a settled run's scope once it has gone", async () => {
    installSystemdRun();
    installSystemctl("inactive");
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({
      status: "completed",
      completedAt: Date.now() - 1_000,
      pgid: 424242,
      leftover: true,
    })]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    expect(await lib.reconcileAfterRestart()).toBe(0);
    const run = lib.getRun("run-detach01");
    expect(run?.unit).toBeNull();
    expect(run?.leftover).toBe(false);
    expect(run?.pgid).toBeNull();
  });

  it("treats a run from before scopes existed exactly as it always did", async () => {
    installSystemdRun();
    installSystemctl("active");
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({ unit: undefined, pgid: undefined })]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    expect(await lib.reconcileAfterRestart()).toBe(1);
    expect(lib.getRun("run-detach01")?.status).toBe("failed");
    // No unit to ask about, so systemd was never asked.
    expect(shimCalls(systemctlLog())).toHaveLength(0);
  });
});

describe("the review loop across a restart", () => {
  it("does not start polling beside a fix turn the restart did not kill", async () => {
    // The origin run's review says "working", which used to mean one thing only:
    // the fix turn died with the previous server, so nothing would ever come
    // back and polling is the only way on. A reattached fix turn will come back
    // itself, and driving the loop from both ends opens a round over a fix that
    // is still being written.
    installSystemdRun();
    installSystemctl("active");
    const origin = {
      ...liveRecord({ id: "run-origin01", status: "completed", completedAt: Date.now() - 5_000, unit: undefined }),
      review: {
        prNumber: 7,
        url: "https://example.invalid/pr/7",
        base: "main",
        round: 1,
        maxRounds: 3,
        state: "working",
        checks: [],
        unresolvedThreads: 0,
        reviewDecision: null,
        lastPolledAt: null,
        roundStartedAt: Date.now() - 30_000,
        detail: null,
        fixRunId: "run-fixturn1",
      },
      pr: {
        phase: "waiting",
        number: 7,
        url: "https://example.invalid/pr/7",
        branch: "clawbox/run-origin01",
        base: "main",
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        detail: null,
        startedAt: Date.now() - 60_000,
        endedAt: null,
        reviewOk: true,
      },
    };
    const fix = liveRecord({ id: "run-fixturn1", reviewLoopOf: "run-origin01" });
    fs.writeFileSync(runsFile(), JSON.stringify([origin, fix]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    // The fix turn is reattached, so nothing is settled.
    expect(await lib.reconcileAfterRestart()).toBe(0);
    expect(lib.getRun("run-fixturn1")?.status).toBe("running");

    lib.resumePullRequestWatches();
    // Left alone: the reattached turn's own settle carries the loop on.
    expect(lib.getRun("run-origin01")?.review?.state).toBe("working");
  });
});

describe("ending a run", () => {
  /**
   * The signals, with the process group of a live `sleep` standing in for a run's.
   *
   * A spy rather than a real kill of a fixture number: the pgid on a record read
   * off disk may name whatever the machine has since given that pid to, which is
   * why the production code forgets it across a restart — and a test must not be
   * the one thing that signals it.
   */
  function watchSignals(): { calls: Array<{ pid: number; signal: unknown }>; restoreKill: () => void } {
    const calls: Array<{ pid: number; signal: unknown }> = [];
    const real = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: unknown) => {
      // Signal 0 only ASKS whether a group is there; the production code uses it
      // for exactly that and must keep getting a real answer.
      if (signal === 0) return real(pid, 0 as never);
      calls.push({ pid, signal });
      return true;
    }) as typeof process.kill);
    return { calls, restoreKill: () => spy.mockRestore() };
  }

  it("asks systemd to stop the scope AND still signals the group when that fails", async () => {
    installSystemdRun();
    // A stop that systemd refuses: the scope is not what ends this run, so the
    // signal has to. Without the fallback the run would be left going.
    installSystemctlThatCannotStop("active");
    // A real live process group to aim at, so the ordering is observed against
    // something that genuinely exists.
    const sleeper = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    sleeper.unref();
    const pgid = sleeper.pid as number;
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({ pgid })]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
    await lib.reconcileAfterRestart();

    const { calls, restoreKill } = watchSignals();
    try {
      lib.stopRun("run-detach01");
      // BOTH, and deliberately no assertion about which lands first: the unit
      // stop is issued first but is NOT awaited, because making the signal wait
      // on a bus round trip would delay ending every run. What matters is that
      // the scope is asked (it reaches a grandchild in its own process group)
      // and that a refused stop does not leave the run going.
      await vi.waitFor(
        () => expect(shimCalls(systemctlLog()).join("\n")).toContain("--user stop clawbox-run-detach01-abc.scope"),
        { timeout: 5_000 },
      );
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 5_000 });
      // The whole group, never one pid.
      expect(calls[0]).toEqual({ pid: -pgid, signal: "SIGTERM" });
    } finally {
      restoreKill();
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("stops the scope and signals the group when the owner ends what a finished run left behind", async () => {
    installSystemdRun();
    installSystemctlThatCannotStop("active");
    const sleeper = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    sleeper.unref();
    const pgid = sleeper.pid as number;
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({
      status: "completed",
      completedAt: Date.now() - 1_000,
      pgid,
      leftover: true,
    })]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    const { calls, restoreKill } = watchSignals();
    try {
      const killed = lib.killRunLeftovers("run-detach01");
      expect(killed.leftover).toBe(false);
      expect(killed.unit).toBeNull();
      await vi.waitFor(
        () => expect(shimCalls(systemctlLog()).join("\n")).toContain("--user stop clawbox-run-detach01-abc.scope"),
        { timeout: 5_000 },
      );
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 5_000 });
      expect(calls[0]).toEqual({ pid: -pgid, signal: "SIGTERM" });
    } finally {
      restoreKill();
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});
