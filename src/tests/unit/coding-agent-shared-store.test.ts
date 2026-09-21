/**
 * The runs store is ONE per process, however many times this module is compiled
 * into it.
 *
 * WHAT THIS IS FOR. Next compiles `src/instrumentation.ts` — the boot hook that
 * settles and reattaches runs after a restart — in a layer of its own, so its
 * `require("./lib/coding-agent")` and a route handler's
 * `import "@/lib/coding-agent"` are two DIFFERENT modules inside the one
 * web-server process. Read off the production build: this file is emitted twice,
 * with two module ids, and Turbopack's module cache is keyed by that id.
 *
 * With the state per module copy, a restart mid-run came apart on the rig
 * (2026-09-13, two boards, 2/2, and it needed an API read to reproduce):
 *
 *   1. a run is going; the web server restarts; the run survives in its scope;
 *   2. the Coding Agent window polls the runs route — the routes' copy loads the
 *      file and freezes the record as it was DURING the reattach;
 *   3. the boot hook's copy settles the run on its own array and writes it;
 *   4. the routes' copy answers `running`, `commit: null` for ever — costing a
 *      parallel slot, so at `maxParallelRuns: 1` the box refused every new run;
 *   5. and its next write — an unrelated run being started — put that older
 *      snapshot back over the settled record on disk, after which the next boot
 *      settled a finished run as "the box restarted while the run was live".
 *
 * `vi.resetModules()` between two imports is exactly that split: two live
 * instances of the module in one process. Every test below drives the two
 * copies by the names of the two layers they stand for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const announce = vi.hoisted(() => vi.fn<(run: unknown) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: announce }));

const closeSessionsForRun = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun }));

const ensureProjectIcon = vi.hoisted(() => vi.fn(async () => ({ icon: "skipped", favicon: false })));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon }));

type Lib = typeof import("@/lib/coding-agent");

let base: string;
let home: string;
let root: string;
let shimDir: string;
let projectDir: string;
let restore: () => void;
/** The copy the route handlers hold; the one whose cache the field poll froze. */
let routes: Lib;

const runsFile = () => path.join(root, "data", "coding-agent-runs.json");
const streamLog = (id: string) => path.join(root, "data", "coding-agent-streams", `${id}.jsonl`);

const RUN_ID = "run-shared01";

function writeConfig(cfg: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({
      clawai_token: "claw_test_token",
      coding_agent_enabled: true,
      coding_agent_default_directory: path.join(home, "Projects"),
      ...cfg,
    }),
    "utf-8",
  );
}

/**
 * A `systemctl` that answers `is-active` with `inactive` and records nothing:
 * every run below is one whose scope is already gone, which is what makes the
 * settle synchronous enough to assert on.
 */
function installSystemctl(): void {
  fs.writeFileSync(
    path.join(shimDir, "systemctl"),
    ["#!/usr/bin/env bash", 'for a in "$@"; do', '  if [ "$a" = "is-active" ]; then echo inactive; exit 0; fi', "done", "exit 0"].join("\n"),
    { mode: 0o755 },
  );
}

const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "All done.",
  session_id: "sess-shared-1",
});

/** A run record as the previous web server left it: live, in a scope of its own. */
function liveRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    task: "keep going across the restart",
    directory: projectDir,
    projectId: null,
    source: "owner",
    status: "running",
    startedAt: Date.now() - 60_000,
    completedAt: null,
    sessionId: "sess-shared-1",
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
    unit: "clawbox-run-shared01-abc.scope",
    // Never a real pgid in a fixture: the signal path would aim at whatever
    // process group this machine has since given that number to.
    pgid: null,
    streamOffset: 0,
    ...over,
  };
}

/** What is actually on disk, which is what the next boot will read. */
function onDisk(): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(runsFile(), "utf-8")) as Array<Record<string, unknown>>;
}

/**
 * The boot hook's own copy of the module — a SECOND live instance, the way Next
 * gives the instrumentation layer one. Imported after the routes' copy has
 * already cached the file, because that order is the defect.
 */
async function bootHookCopy(): Promise<Lib> {
  vi.resetModules();
  return await import("@/lib/coding-agent");
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "PATH", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-shared-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  shimDir = path.join(base, "shim");
  projectDir = path.join(home, "Projects", "site");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  // Ahead of the machine's own, so nothing here can reach a real systemd.
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
  installSystemctl();
  writeConfig();
  announce.mockClear();
  vi.resetModules();
  routes = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await routes._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a run settled by the boot hook's copy of this module", () => {
  it("is settled in the routes' copy too, even when a poll cached the record first", async () => {
    // The run finished while nobody was watching and its scope was collected
    // before this server booted; the log is the proof, and the boot hook is
    // what reads it.
    fs.mkdirSync(path.join(root, "data", "coding-agent-streams"), { recursive: true });
    fs.writeFileSync(streamLog(RUN_ID), `${RESULT}\n`);
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));

    // Step 4 of the field reproduction: the window polls during the window.
    expect(routes.getRun(RUN_ID)?.status).toBe("running");
    expect(routes.runningCount()).toBe(1);

    const boot = await bootHookCopy();
    expect(await boot.reconcileAfterRestart()).toBe(1);
    expect(boot.getRun(RUN_ID)?.status).toBe("completed");

    // …and the copy every route answers from says the same thing.
    const seen = routes.getRun(RUN_ID);
    expect(seen?.status).toBe("completed");
    expect(seen?.summary).toContain("All done.");
    // The parallel slot is given back: with `maxParallelRuns: 1` a phantom here
    // refused every new run until the next restart.
    expect(routes.runningCount()).toBe(0);
  });

  it("is not put back to running by a later write from the routes' copy", async () => {
    fs.mkdirSync(path.join(root, "data", "coding-agent-streams"), { recursive: true });
    fs.writeFileSync(streamLog(RUN_ID), `${RESULT}\n`);
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));
    expect(routes.getRun(RUN_ID)?.status).toBe("running");

    const boot = await bootHookCopy();
    await boot.reconcileAfterRestart();

    // The field trigger: an unrelated run is started through a route, which
    // writes the whole list. On the rig this is the moment `completed` + its
    // commit went back to `running` + null on disk.
    await routes.createDraftRun({ task: "something else entirely", directory: projectDir, source: "owner" });

    const settled = onDisk().find((r) => r.id === RUN_ID);
    expect(settled?.status).toBe("completed");
    expect(onDisk().some((r) => r.status === "draft")).toBe(true);
  });

  it("still settles a run that did NOT survive as failed, in both copies", async () => {
    // The opposite defect, which this must not trade for: a run whose scope is
    // gone and whose log says nothing is lost to the restart, and says so.
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));
    expect(routes.getRun(RUN_ID)?.status).toBe("running");

    const boot = await bootHookCopy();
    expect(await boot.reconcileAfterRestart()).toBe(1);

    const seen = routes.getRun(RUN_ID);
    expect(seen?.status).toBe("failed");
    expect(seen?.error).toMatch(/box restarted while the run was live/i);
    // Nothing may be signalled in its name: the cgroup took the group with it.
    expect(seen?.unit).toBeNull();
    expect(seen?.pgid).toBeNull();
    expect(routes.runningCount()).toBe(0);
  });
});

describe("the floor under that: what is written over what", () => {
  it("never writes a run that is still going over one the file already settled", async () => {
    // Not the two-copies case — that is one store now — but the one the module
    // has always known it cannot rule out: a SECOND WRITER (a script, a test
    // worker, a server that outlived its restart). Whatever it is, a record
    // that says `completed` on disk must not be demoted to `running` by a
    // snapshot that predates it.
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));
    expect(routes.getRun(RUN_ID)?.status).toBe("running");

    // Somebody else finishes it, behind this copy's back.
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord({
      status: "completed",
      completedAt: Date.now(),
      summary: "All done.",
      commit: "abc1234",
      unit: null,
    })]));

    // Anything at all that makes this copy write its own list out.
    await routes.createDraftRun({ task: "an unrelated run", directory: projectDir, source: "owner" });

    const settled = onDisk().find((r) => r.id === RUN_ID);
    expect(settled?.status).toBe("completed");
    expect(settled?.commit).toBe("abc1234");
    // And the repair reaches the array this process answers from, not just the
    // bytes on their way out.
    expect(routes.getRun(RUN_ID)?.status).toBe("completed");
    expect(routes.runningCount()).toBe(0);
  });

  it("leaves a settled record this copy has advanced alone", async () => {
    // The ordinary direction, which the guard must not touch: this process
    // settles a run and the file has not caught up yet. Nothing else writes the
    // file, so the signature matches and the guard never looks.
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));
    const boot = await bootHookCopy();
    await boot.reconcileAfterRestart();
    expect(onDisk().find((r) => r.id === RUN_ID)?.status).toBe("failed");
  });
});
