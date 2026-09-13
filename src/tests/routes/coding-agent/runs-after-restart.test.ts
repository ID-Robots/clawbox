/**
 * GET /setup-api/coding-agent/runs, read while the boot hook is still settling
 * what the restart left behind.
 *
 * This is the field sequence rather than a unit of it: the Coding Agent window
 * polls this route every 5 s, so on a box that restarts mid-run the poll lands
 * inside the reattach window by itself — which is exactly the read that used to
 * freeze the record. The route runs against the REAL module here (no mock of
 * `@/lib/coding-agent`), because what is being pinned is what the route's own
 * copy of that module answers after another copy has settled the run.
 *
 * The second copy stands for the boot hook: Next compiles src/instrumentation.ts
 * in a layer of its own, so its `require("./lib/coding-agent")` is a different
 * module from this route's `import` inside the one web-server process. See
 * src/lib/process-store.ts and src/tests/unit/coding-agent-shared-store.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));

type Lib = typeof import("@/lib/coding-agent");

const RUN_ID = "run-restart01";

let base: string;
let home: string;
let root: string;
let shimDir: string;
let projectDir: string;
let restore: () => void;
let GET: (req: Request) => Promise<Response>;
/** The module instance the route above is bound to. */
let routesLib: Lib;

const runsFile = () => path.join(root, "data", "coding-agent-runs.json");
const streamLog = (id: string) => path.join(root, "data", "coding-agent-streams", `${id}.jsonl`);

const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "All done.",
  session_id: "sess-restart-1",
});

function liveRecord(): Record<string, unknown> {
  return {
    id: RUN_ID,
    task: "keep going across the restart",
    directory: projectDir,
    projectId: null,
    source: "owner",
    status: "running",
    startedAt: Date.now() - 60_000,
    completedAt: null,
    sessionId: "sess-restart-1",
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
    unit: "clawbox-run-restart01-abc.scope",
    pgid: null,
    streamOffset: 0,
  };
}

async function readRun(): Promise<Record<string, unknown>> {
  const res = await GET(new Request(`http://localhost/setup-api/coding-agent/runs?id=${RUN_ID}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { run: Record<string, unknown> }).run;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "PATH", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-runs-restart-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  shimDir = path.join(base, "shim");
  projectDir = path.join(home, "Projects", "site");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data", "coding-agent-streams"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  // A systemctl that always says `inactive`, ahead of the machine's own: every
  // run here is one whose scope has already gone.
  fs.writeFileSync(
    path.join(shimDir, "systemctl"),
    ["#!/usr/bin/env bash", 'for a in "$@"; do', '  if [ "$a" = "is-active" ]; then echo inactive; exit 0; fi', "done", "exit 0"].join("\n"),
    { mode: 0o755 },
  );
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
  fs.writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({ clawai_token: "claw_test_token", coding_agent_enabled: true }),
    "utf-8",
  );
  vi.resetModules();
  routesLib = await import("@/lib/coding-agent");
  GET = (await import("@/app/setup-api/coding-agent/runs/route")).GET;
});

afterEach(async () => {
  await routesLib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a run read through the route while the restart is still being reconciled", () => {
  it("answers the settled record once the boot hook has settled it", async () => {
    // The run finished while nobody was watching; its log is the proof.
    fs.writeFileSync(streamLog(RUN_ID), `${RESULT}\n`);
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));

    // The poll that lands inside the reattach window.
    expect((await readRun()).status).toBe("running");

    // The boot hook's own copy of the module, settling what it found.
    vi.resetModules();
    const boot = await import("@/lib/coding-agent");
    expect(await boot.reconcileAfterRestart()).toBe(1);

    const run = await readRun();
    expect(run.status).toBe("completed");
    expect(run.summary).toContain("All done.");
  });

  it("stops counting it as running, so the box does not lose a parallel slot", async () => {
    fs.writeFileSync(streamLog(RUN_ID), `${RESULT}\n`);
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));
    await readRun();

    vi.resetModules();
    const boot = await import("@/lib/coding-agent");
    await boot.reconcileAfterRestart();

    // The status route reads the same count the spawn gate does; a phantom
    // `running` here refused every new run at maxParallelRuns 1.
    const status = await routesLib.getCodingAgentStatus();
    expect(status.running).toBe(0);
    expect(routesLib.listRuns(10).some((r) => r.status === "running")).toBe(false);
  });

  it("still reports a run that did not survive as failed", async () => {
    // No log, so nothing says it finished: the honest ending, which this must
    // not trade away for the one above.
    fs.writeFileSync(runsFile(), JSON.stringify([liveRecord()]));
    expect((await readRun()).status).toBe("running");

    vi.resetModules();
    const boot = await import("@/lib/coding-agent");
    expect(await boot.reconcileAfterRestart()).toBe(1);

    const run = await readRun();
    expect(run.status).toBe("failed");
    expect(String(run.error)).toMatch(/box restarted while the run was live/i);
  });
});
