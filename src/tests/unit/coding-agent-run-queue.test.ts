/**
 * A run beyond the owner's `coding_agent_max_parallel_runs` is QUEUED, not
 * refused (owner's brief, 2026-10-11): persisted, started by the box itself in
 * the order asked when a slot frees — under the id the caller was given —
 * across a web-server restart, and taken out of the queue by the owner alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let projects: string;
let flag: string;
let restore: () => void;

const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, session_id: "sess-1" });

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/** Every run waits for the flag file, so the ones started are genuinely live until the test lets them go. */
function installWrapper(): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    ["#!/usr/bin/env bash", readFirstTurn(), `while [ ! -f "${flag}" ]; do sleep 0.05; done`, `echo '${result("done")}'`, "exit 0"].join("\n"),
    { mode: 0o755 },
  );
}

function folder(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

async function finished(id: string) {
  const run = await lib.waitForRun(id, 20_000);
  if (!run) throw new Error("run vanished");
  return run;
}

const onDisk = () => JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8")) as Array<{ id: string; status: string; queued?: { at: number; start?: { kind: string; task?: string } } | null }>;

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-queue-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  flag = path.join(base, "go");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  // One run at a time: the second ask is the queue's.
  writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects, coding_agent_max_parallel_runs: 1 });
  installWrapper();
  for (const name of ["alpha", "beta", "gamma", "delta"]) folder(name);
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  fs.writeFileSync(flag, "go");
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a run beyond the limit", () => {
  it("is queued rather than refused, on disk, with its place — and starts under the same id when the slot frees", async () => {
    const a = await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    expect(a.queued).toBe(false);
    const b = await lib.startOrQueueRun({ task: "two", directory: "beta", source: "agent" });
    expect(b.queued).toBe(true);
    expect(b.run).toMatchObject({ status: "queued", source: "agent", task: "two", queued: { position: 1 } });
    expect(b.run.progress).toContain("Queued — number 1 in line for a slot");
    // Persisted with the request it is started with.
    expect(onDisk().find((r) => r.id === b.run.id)).toMatchObject({ status: "queued", queued: { start: { kind: "new", task: "two" } } });
    // Not live: nothing spawned for it, no slot taken.
    expect(lib.runningCount()).toBe(1);

    fs.writeFileSync(flag, "go");
    await finished(a.run.id);
    await vi.waitFor(() => { expect(lib.getRun(b.run.id)?.status).not.toBe("queued"); }, { timeout: 15_000 });
    const done = await finished(b.run.id);
    expect(done.status).toBe("completed");
    expect(done.progress).toEqual(expect.arrayContaining(["Queued — number 1 in line for a slot", "Started from the queue"]));
    expect(done.queued ?? null).toBeNull();
    // One record, never a second row beside it.
    expect(lib.listRuns().filter((r) => r.id === b.run.id)).toHaveLength(1);
  });

  it("starts the queue in the order asked, and a new ask goes behind it even as a slot frees", async () => {
    const a = await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    const q1 = await lib.startOrQueueRun({ task: "two", directory: "beta", source: "owner" });
    const q2 = await lib.startOrQueueRun({ task: "three", directory: "gamma", source: "owner" });
    expect([q1.run.queued?.position, q2.run.queued?.position]).toEqual([1, 2]);
    expect(lib.queuePosition(q2.run.id)).toBe(2);
    fs.writeFileSync(flag, "go");
    await finished(a.run.id);
    const q3 = await lib.startOrQueueRun({ task: "four", directory: "delta", source: "owner" });
    const runs = [q1, q2, q3].map((x) => x.run.id);
    for (const id of runs) {
      await vi.waitFor(() => { expect(lib.getRun(id)?.status).toBe("completed"); }, { timeout: 20_000 });
    }
    const started = runs.map((id) => lib.getRun(id)!.startedAt);
    expect([...started].sort((x, y) => x - y)).toEqual(started);
  });

  it("is never stopped by a caller — only the owner's cancel takes it out of the queue", async () => {
    await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    const q = await lib.startOrQueueRun({ task: "two", directory: "beta", source: "agent" });
    expect(() => lib.stopRun(q.run.id)).toThrow(/only the owner can cancel a queued run/i);
    const canceled = await lib.cancelQueuedRun(q.run.id);
    expect(canceled).toMatchObject({ status: "stopped", error: "Canceled by the owner before it started.", queued: null });
    expect(canceled.progress).toContain("Canceled by the owner before it started");
    fs.writeFileSync(flag, "go");
    await lib.pumpRunQueue();
    expect(lib.getRun(q.run.id)?.status).toBe("stopped");
  });

  it("is started by the boot's pump when it was still waiting at the restart", async () => {
    const a = await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    const q = await lib.startOrQueueRun({ task: "two", directory: "beta", source: "owner" });
    // Gone with the old server before its slot freed: a's record is settled at
    // boot, and the queued one waits on disk for the pump.
    await lib._resetCodingAgentStateForTests();
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
    // The boot, in its order (src/instrumentation.ts): settle what the old
    // server held, then pump the queue.
    await lib.reconcileAfterRestart();
    expect(lib.getRun(q.run.id)).toMatchObject({ status: "queued", queued: { position: 1 } });
    expect(lib.getRun(a.run.id)?.status).not.toBe("running");
    fs.writeFileSync(flag, "go");
    expect(await lib.pumpRunQueue()).toEqual([q.run.id]);
    expect((await finished(q.run.id)).status).toBe("completed");
  });

  it("hands what it was told while it waited to the run when it starts", async () => {
    const a = await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    const q = await lib.startOrQueueRun({ task: "two", directory: "beta", source: "owner" });
    const told = lib.queueRunMessage(q.run.id, "use tabs");
    expect(told.delivery).toBe("next_start");
    fs.writeFileSync(flag, "go");
    await finished(a.run.id);
    await vi.waitFor(() => { expect(lib.getRun(q.run.id)?.status).toBe("completed"); }, { timeout: 15_000 });
    const done = lib.getRun(q.run.id)!;
    expect(done.messages[0]).toMatchObject({ text: "use tabs" });
    expect(typeof done.messages[0].deliveredAt).toBe("number");
  });

  it("settles a queued run whose folder went away when its turn came, and starts the next one", async () => {
    const a = await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    const gone = await lib.startOrQueueRun({ task: "two", directory: "beta", source: "owner" });
    const next = await lib.startOrQueueRun({ task: "three", directory: "gamma", source: "owner" });
    fs.rmSync(path.join(projects, "beta"), { recursive: true, force: true });
    fs.writeFileSync(flag, "go");
    await finished(a.run.id);
    await vi.waitFor(() => { expect(lib.getRun(next.run.id)?.status).toBe("completed"); }, { timeout: 20_000 });
    const failed = lib.getRun(gone.run.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/^Its turn in the queue came, and it could not start: /);
  });

  it("refuses what a start would refuse, at once, rather than queueing it", async () => {
    await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    await expect(lib.startOrQueueRun({ task: "two", directory: "/etc", source: "owner" })).rejects.toMatchObject({ kind: "invalid" });
    await expect(lib.startOrQueueRun({ task: "   ", directory: "beta", source: "owner" })).rejects.toBeTruthy();
    expect(lib.listRuns().filter((r) => r.status === "queued")).toHaveLength(0);
  });

  it("holds at most MAX_QUEUED_RUNS waiting", async () => {
    await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    for (let i = 0; i < lib.MAX_QUEUED_RUNS; i++) {
      expect((await lib.startOrQueueRun({ task: `waiting ${i}`, directory: "beta", source: "owner" })).queued).toBe(true);
    }
    await expect(lib.startOrQueueRun({ task: "one too many", directory: "beta", source: "owner" })).rejects.toMatchObject({ kind: "busy" });
  });
});

describe("a draft the owner starts while every slot is taken", () => {
  it("waits in the queue as itself and starts in its turn", async () => {
    const a = await lib.startOrQueueRun({ task: "one", directory: "alpha", source: "owner" });
    const draft = await lib.createDraftRun({ task: "drafted", directory: "beta", source: "owner" });
    const asked = await lib.startDraftRun(draft.id);
    expect(asked).toMatchObject({ id: draft.id, status: "queued", queued: { position: 1 } });
    fs.writeFileSync(flag, "go");
    await finished(a.run.id);
    await vi.waitFor(() => { expect(lib.getRun(draft.id)?.status).toBe("completed"); }, { timeout: 15_000 });
    expect(lib.getRun(draft.id)!.progress).toEqual(expect.arrayContaining(["Started from the queue"]));
  });
});

describe("a Fix CI continuation that waits in the queue", () => {
  it("gives the failure back when the owner cancels it, so Fix CI can be offered again", async () => {
    // A finished run whose pull request's CI failed.
    fs.writeFileSync(flag, "go");
    const p = await lib.startOrQueueRun({ task: "build it", directory: "alpha", source: "owner" });
    await finished(p.run.id);
    const file = path.join(root, "data", "coding-agent-runs.json");
    const list = JSON.parse(fs.readFileSync(file, "utf-8")) as Array<Record<string, unknown>>;
    for (const r of list) if (r.id === p.run.id) r.ci = { prNumber: 7, at: 1, checks: ["test"], tests: [], files: [], excerpt: "", unread: [], attempt: 0, fixRunId: null };
    fs.writeFileSync(file, JSON.stringify(list), "utf-8");
    await lib._resetCodingAgentStateForTests();
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
    fs.rmSync(flag, { force: true });

    // The box is full, so the Fix CI waits — and claims the failure while it does.
    await lib.startOrQueueRun({ task: "busy", directory: "beta", source: "owner" });
    const fix = await lib.startOrQueueRun({ task: "Fix the CI.", resumeRunId: p.run.id, source: "owner", fixCi: true });
    expect(fix.queued).toBe(true);
    expect(lib.getRun(p.run.id)?.ci?.fixRunId).toBe(fix.run.id);

    await lib.cancelQueuedRun(fix.run.id);
    // Never started: the failure is free again, and a new Fix CI is not refused.
    expect(lib.getRun(p.run.id)?.ci?.fixRunId).toBeNull();
    expect(lib.ciFixAttempt(lib.getRun(p.run.id)!, null)).toBe(1);
  });
});

/**
 * F-N4: a settling run's OWN follow-ups — another go at its deliverable, the
 * automatic review pass — need a slot, and the run that frees one is the run
 * they belong to. The queue's pump at settle used to take that slot first, so
 * the follow-up was refused ("Another attempt could not be started", a review
 * pass logged as refused) and never tried again. The slot is held for them
 * from the settle until the settle has decided; the queue goes after.
 */
describe("a settling run's own follow-ups", () => {
  let hold: string;
  const INIT = '{"type":"system","subtype":"init","session_id":"sess-1","model":"m","permissionMode":"acceptEdits"}';
  const WROTE = [
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Write","input":{"file_path":"app.js"}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1"}]}}',
  ];

  /** Every run waits for the flag; a run whose task says HOLD-B also waits for `hold`, so it keeps its slot while the test looks. */
  function installHoldingWrapper(lines: string[]): void {
    fs.writeFileSync(
      path.join(binDir, "claude-ds"),
      [
        "#!/usr/bin/env bash",
        "TURN=$(head -n 1)",
        `case "$TURN" in *HOLD-B*) while [ ! -f "${hold}" ]; do sleep 0.05; done ;; esac`,
        `while [ ! -f "${flag}" ]; do sleep 0.05; done`,
        `printf '%s\\n' ${[INIT, ...lines, result("done")].map((l) => `'${l}'`).join(" ")}`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  beforeEach(() => {
    hold = path.join(base, "hold");
  });

  afterEach(() => {
    fs.writeFileSync(hold, "go");
  });

  /** The queue still drains afterwards: with one slot, a reservation that leaked would leave C queued for good. */
  async function expectQueueDrains(): Promise<void> {
    const c = await lib.startOrQueueRun({ task: "after", directory: "gamma", source: "owner" });
    fs.writeFileSync(hold, "go");
    await vi.waitFor(() => { expect(lib.getRun(c.run.id)?.status).toBe("completed"); }, { timeout: 20_000 });
  }

  it("keeps the slot for another go at the deliverable, and the queued run waits for it", async () => {
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects, coding_agent_max_parallel_runs: 1, coding_agent_completion_attempts: 2 });
    installHoldingWrapper([]);
    const a = await lib.startOrQueueRun({ task: "build it", directory: "alpha", source: "owner", deliverable: { kind: "paths", paths: ["never.txt"] } });
    const b = await lib.startOrQueueRun({ task: "HOLD-B next", directory: "beta", source: "owner" });
    expect(b.queued).toBe(true);

    fs.writeFileSync(flag, "go");
    await vi.waitFor(() => { expect(lib.getRun(a.run.id)?.status).toBe("gave_up"); }, { timeout: 20_000 });
    await vi.waitFor(() => { expect(lib.getRun(b.run.id)?.status).toBe("running"); }, { timeout: 20_000 });

    const done = lib.getRun(a.run.id)!;
    // Both attempts made: the second was not refused for want of the slot it had just freed.
    expect(done.error ?? "").not.toMatch(/could not be started/);
    expect(done.attempts).toHaveLength(2);
    // …and the queued run started only once the second attempt was under way.
    expect(lib.getRun(b.run.id)!.startedAt).toBeGreaterThanOrEqual(done.attempts[1].startedAt);

    await expectQueueDrains();
  });

  it("gives the slot back to the queue when no follow-up turns out to be needed", async () => {
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects, coding_agent_max_parallel_runs: 1, coding_agent_completion_attempts: 2 });
    installHoldingWrapper([]);
    // Held at settle, because the gate MAY send it back — and then the deliverable is already there.
    const a = await lib.startOrQueueRun({ task: "build it", directory: "alpha", source: "owner", deliverable: { kind: "paths", paths: ["README.md"] } });
    const b = await lib.startOrQueueRun({ task: "next", directory: "beta", source: "owner" });
    expect(b.queued).toBe(true);

    fs.writeFileSync(flag, "go");
    await vi.waitFor(() => { expect(lib.getRun(b.run.id)?.status).toBe("completed"); }, { timeout: 20_000 });
    expect(lib.getRun(a.run.id)).toMatchObject({ status: "completed", attempts: [expect.objectContaining({ reason: null })] });

    await expectQueueDrains();
  });

  it("keeps the slot for the automatic review pass, and the queued run waits for it", async () => {
    writeConfig({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects, coding_agent_max_parallel_runs: 1, coding_agent_review_pass: true });
    installHoldingWrapper(WROTE);
    const a = await lib.startOrQueueRun({ task: "build it", directory: "alpha", source: "owner" });
    const b = await lib.startOrQueueRun({ task: "HOLD-B next", directory: "beta", source: "owner" });
    expect(b.queued).toBe(true);

    fs.writeFileSync(flag, "go");
    await vi.waitFor(() => { expect(lib.getRun(b.run.id)?.status).toBe("running"); }, { timeout: 20_000 });

    const review = lib.listRuns().find((r) => r.reviewOf === a.run.id);
    // The review pass ran, in the slot its run freed, before the queue's turn.
    expect(review).toBeTruthy();
    expect(review!.status).toBe("completed");
    expect(lib.getRun(b.run.id)!.startedAt).toBeGreaterThanOrEqual(review!.startedAt);

    await expectQueueDrains();
  });
});
