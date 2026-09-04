/**
 * What a run leaves behind when it settles.
 *
 * A run is not just a process: it holds a tab in the desktop's Chromium, a
 * couple of timers, and whatever its Bash started. Before this, none of it was
 * released — the tab sat on the last file:// it rendered until a ten-minute
 * sweep closed it (and the sweep could not tell the run's tab from the
 * owner's), and a background server outlived every run that ever started one.
 *
 * The one decision here that is not obvious is the process group, and it goes
 * BOTH ways:
 *
 *   - a run that finished on its own keeps it. The orientation guide tells a
 *     run to leave its app's server listening so the desktop can reach it, and
 *     a settle that killed the group would break the one pattern the device
 *     documents. What survived is RECORDED, and the owner ends it.
 *   - a run that was stopped, failed or timed out does not: nothing it left is
 *     wanted, and "the run is over" has to mean the machine is quiet again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const announce = vi.hoisted(() => vi.fn<(run: unknown) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: announce }));

const closeSessionsForRun = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun }));

// Drawing the project's icon is a fire-and-forget of its own; it has its own
// test, and a real generation attempt here would only be a network call that
// cannot happen.
const ensureProjectIcon = vi.hoisted(() => vi.fn(async () => ({ icon: "skipped", favicon: false })));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon }));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let restore: () => void;

const runsFile = () => path.join(root, "data", "coding-agent-runs.json");

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/**
 * A wrapper that leaves a grandchild behind, the way `npm run dev &` does —
 * the shape the whole process-group decision is about. It prints a result and
 * exits; the sleeper carries on holding the group open.
 */
function installWrapper(body: string): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    ["#!/usr/bin/env bash", "cat > /dev/null", body].join("\n"),
    { mode: 0o755 },
  );
}

const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "Serving the app on port 5173.",
  session_id: "sess-abc-123",
});

/** Start a server that outlives the wrapper, then finish cleanly. */
const LEAVES_A_SERVER = [
  "sleep 60 &",
  `echo '${RESULT}'`,
  "exit 0",
].join("\n");

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  return dir;
}

function readyDevice(body: string): void {
  installWrapper(body);
  writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true });
}

async function finished(id: string) {
  const run = await lib.waitForRun(id, 15_000);
  if (!run) throw new Error("run vanished");
  return run;
}

/** Is anything still alive in that group? Signal 0 asks without delivering. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-cleanup-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({});
  announce.mockClear();
  closeSessionsForRun.mockClear();
  ensureProjectIcon.mockClear();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(() => {
  lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the browser tab a run opened", () => {
  it("is closed when the run settles, by run id", async () => {
    readyDevice(`echo '${RESULT}'\nexit 0`);
    makeProject("site");
    const run = await lib.startRun({ task: "Build it", projectId: "site", source: "agent" });
    await finished(run.id);
    expect(closeSessionsForRun).toHaveBeenCalledWith(run.id);
  });

  it("is closed when the owner stops a run the server no longer holds", () => {
    // A record left "running" by a previous web server: nothing settles it
    // through finishRun, so the stop path has to release what it can.
    fs.writeFileSync(runsFile(), JSON.stringify([{
      id: "run-abc12345", task: "t", directory: path.join(home, "Projects", "site"), projectId: null,
      source: "owner", status: "running", startedAt: Date.now(), completedAt: null, sessionId: null,
      model: null, summary: null, error: null, numTurns: 0, filesTouched: [], commandsRun: 0,
      permissionDenials: 0, deniedActions: [], effort: "max", subagentsActive: 0, activeSubagents: [],
      subagentsTotal: 0, subagentsByType: {}, modelsUsed: [], commit: null, maxTurns: 150, tokensUsed: 0,
      tokenLimit: null, thinkingTokens: 0, lastActivityAt: Date.now(), retries: 0, resumable: false,
      reviewOf: null, pr: null, progress: [], todos: [], exitCode: null,
    }]));
    const stopped = lib.stopRun("run-abc12345");
    expect(stopped.status).toBe("stopped");
    expect(closeSessionsForRun).toHaveBeenCalledWith("run-abc12345");
  });
});

describe("what a run left running", () => {
  it("is kept — and recorded — when the run finished on its own", async () => {
    readyDevice(LEAVES_A_SERVER);
    makeProject("site");
    const run = await lib.startRun({ task: "Serve it", projectId: "site", source: "agent" });
    const settled = await finished(run.id);
    expect(settled.status).toBe("completed");
    // The sleeper is still there: an app that serves itself on a port is
    // meant to stay up, and the desktop reaches it at that port.
    expect(settled.pgid).toBeTruthy();
    expect(settled.leftover).toBe(true);
    expect(groupAlive(settled.pgid as number)).toBe(true);
    expect(settled.progress.join(" ")).toMatch(/still running/i);

    // ...until the owner asks. That is the whole point of recording it.
    const killed = lib.killRunLeftovers(run.id);
    expect(killed.leftover).toBe(false);
    await vi.waitFor(() => expect(groupAlive(settled.pgid as number)).toBe(false), { timeout: 8_000 });
  });

  it("is ended when the owner stops the run, because nothing it left is wanted", async () => {
    readyDevice(["sleep 60 &", "sleep 30", "exit 0"].join("\n"));
    makeProject("site");
    const run = await lib.startRun({ task: "Serve it", projectId: "site", source: "agent" });
    // Give the wrapper a moment to reach its `sleep 60 &`.
    await new Promise((r) => setTimeout(r, 400));
    const pgid = lib.getRun(run.id)?.pgid;
    expect(pgid).toBeTruthy();
    lib.stopRun(run.id);
    const settled = await finished(run.id);
    expect(settled.status).toBe("stopped");
    expect(settled.leftover).toBe(false);
    await vi.waitFor(() => expect(groupAlive(pgid as number)).toBe(false), { timeout: 8_000 });
  }, 20_000);

  it("refuses the Kill gesture on a run that is still going — that is Stop's job", async () => {
    readyDevice(["sleep 30", "exit 0"].join("\n"));
    makeProject("site");
    const run = await lib.startRun({ task: "Work", projectId: "site", source: "agent" });
    expect(() => lib.killRunLeftovers(run.id)).toThrow(lib.CodingAgentError);
    lib.stopRun(run.id);
    await finished(run.id);
  }, 20_000);

  it("refuses the Kill gesture on a paused run — what it left listening is what a resume carries on against", async () => {
    readyDevice(["sleep 30", "exit 0"].join("\n"));
    makeProject("site");
    const run = await lib.startRun({ task: "Work", projectId: "site", source: "agent" });
    await lib.pauseRun(run.id);
    expect(() => lib.killRunLeftovers(run.id)).toThrow(lib.CodingAgentError);
    lib.stopRun(run.id);
  }, 20_000);

  it("answers rather than throws for a run whose group is long gone", async () => {
    readyDevice(`echo '${RESULT}'\nexit 0`);
    makeProject("site");
    const run = await lib.startRun({ task: "Build it", projectId: "site", source: "agent" });
    await finished(run.id);
    // Idempotent: "nothing is running" is the state the caller wanted either way.
    expect(lib.killRunLeftovers(run.id).leftover).toBe(false);
    expect(lib.killRunLeftovers(run.id).leftover).toBe(false);
  });
});

describe("the group check itself", () => {
  it("sees a live group and stops seeing it once the group is gone", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    child.unref();
    const pgid = child.pid as number;
    expect(groupAlive(pgid)).toBe(true);
    expect(lib.killRunGroup(pgid)).toBe(true);
    await vi.waitFor(() => expect(groupAlive(pgid)).toBe(false), { timeout: 8_000 });
    // Nothing there any more: the answer is "no", not an error.
    expect(lib.killRunGroup(pgid)).toBe(false);
    expect(lib.killRunGroup(null)).toBe(false);
  });
});
