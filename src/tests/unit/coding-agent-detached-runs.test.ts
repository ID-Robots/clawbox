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
import fs from "fs";
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

/** A `systemd-run` that refuses, the way a box with no user manager does. */
function installBrokenSystemdRun(): void {
  fs.writeFileSync(
    path.join(shimDir, "systemd-run"),
    ["#!/usr/bin/env bash", "echo 'Failed to connect to bus: No medium found' >&2", "exit 1"].join("\n"),
    { mode: 0o755 },
  );
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
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "PATH", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
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
  it("says runs are detached when systemd-run works for this user", async () => {
    installSystemdRun();
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    installWrapper("exit 0");
    const readiness = await lib.checkReadiness();
    expect(readiness.detachedRuns).toBe(true);
    expect(readiness.detachedRunsDetail).toBeNull();
  });

  it("says why not, and does not make it a problem that refuses runs", async () => {
    installBrokenSystemdRun();
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    installWrapper("exit 0");
    const readiness = await lib.checkReadiness();
    expect(readiness.detachedRuns).toBe(false);
    // systemd's own reason, kept: "no bus" and "authentication required" need
    // different answers from the operator.
    expect(readiness.detachedRunsDetail).toMatch(/Failed to connect to bus/);
    // A degradation, never a blocker: the run still happens as a plain child.
    expect(readiness.problems.join(" ")).not.toMatch(/systemd/i);
    expect(readiness.ready).toBe(true);
  });

  it("says runs are not detached when systemd-run is not installed at all", async () => {
    // Nothing but the (empty) shim directory: the machine running the suite may
    // well have systemd-run of its own, and this test is about a box that does not.
    process.env.PATH = shimDir;
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    installWrapper("exit 0");
    const readiness = await lib.checkReadiness();
    expect(readiness.detachedRuns).toBe(false);
    expect(readiness.detachedRunsDetail).toMatch(/not installed/);
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

  it("falls back to a plain child when the box cannot give it a scope", async () => {
    installBrokenSystemdRun();
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
    installWrapper(`echo '${RESULT}'\nexit 0`);
    const started = await lib.startRun({ task: "Build it", directory: path.join(home, "Projects", "site"), source: "owner" });
    const settled = await lib.waitForRun(started.id, 25_000);
    expect(settled?.status).toBe("completed");
    expect(settled?.summary).toContain("All done.");
    // The refusing shim records nothing, and the spawn never went near it —
    // asserted after the run has settled, so there was time for it to have.
    expect(spawnCalls()).toHaveLength(0);
    expect(settled?.unit).toBeNull();
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

describe("ending a run", () => {
  it("stops the scope, not only the process group", async () => {
    installSystemdRun();
    installSystemctl("active");
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
    await lib.reconcileAfterRestart();

    lib.stopRun("run-detach01");
    await vi.waitFor(
      () => expect(shimCalls(systemctlLog()).join("\n")).toContain("--user stop clawbox-run-detach01-abc.scope"),
      { timeout: 5_000 },
    );
  });

  it("stops the scope when the owner ends what a finished run left behind", async () => {
    installSystemdRun();
    installSystemctl("active");
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({
      status: "completed",
      completedAt: Date.now() - 1_000,
      leftover: true,
    })]));
    vi.resetModules();
    lib = await import("@/lib/coding-agent");

    const killed = lib.killRunLeftovers("run-detach01");
    expect(killed.leftover).toBe(false);
    expect(killed.unit).toBeNull();
    await vi.waitFor(
      () => expect(shimCalls(systemctlLog()).join("\n")).toContain("--user stop clawbox-run-detach01-abc.scope"),
      { timeout: 5_000 },
    );
  });
});
