/**
 * A budgeted coding run's deadline, held by the SERVER (src/lib/coding-agent.ts
 * — the "Time budget" section): the brief that names it, the time record that
 * follows the run (src/lib/coding-time-record.ts), the margin's message, the
 * stop at the deadline, the spend ceilings, a pause and a resume against the
 * same deadline, and a restart that arms the clock again from the record.
 *
 * Real processes through a FAKE claude-ds, like coding-agent.test.ts: a run
 * here is genuinely live until the box ends it, so a stop is the box's own.
 * Deadlines are a few seconds out; a budget is read as it is stored, so a
 * deadline that close is still one the runner holds a run to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";
import type { TimeBudget, TimeRecordSummary } from "@/lib/coding-time-budget";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));
// The box's zone, not the machine running the suite.
vi.mock("@/lib/timezone", () => ({ readOsTimeZone: async () => "Europe/Sofia" }));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let restore: () => void;

const INIT = '{"type":"system","subtype":"init","session_id":"sess-abc-123","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';
const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  result: "Built the page. Verify by opening index.html.",
  session_id: "sess-abc-123",
});

const argvFile = () => path.join(base, "argv.txt");
const flagFile = () => path.join(base, "go");

function assistantText(text: string, usage?: Record<string, number>, id = "msg_1"): string {
  return JSON.stringify({ type: "assistant", message: { id, model: "deepseek-v4-flash", ...(usage ? { usage } : {}), content: [{ type: "text", text }] } });
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/**
 * A wrapper that records its argv, prints `events`, and then — with `wait` —
 * stays alive until the test's flag file appears (or the box ends it), else
 * prints the closing result and exits.
 */
function installWrapper(events: string[], opts: { wait?: boolean } = {}): void {
  const eventsFile = path.join(base, `events-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(eventsFile, events.length ? `${events.join("\n")}\n` : "");
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > "${argvFile()}"`,
      readFirstTurn(),
      `echo '${INIT}'`,
      `cat "${eventsFile}"`,
      ...(opts.wait ? [`while [ ! -f "${flagFile()}" ]; do sleep 0.05; done`] : []),
      `echo '${RESULT}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

function ready(extra: Record<string, unknown> = {}): void {
  writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true, ...extra });
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** A budget `aheadMs` from now that began `sinceMs` ago — the clock reads it as stored. */
function budget(aheadMs: number, sinceMs: number, extra: Partial<TimeBudget> = {}): TimeBudget {
  return { deadline: iso(aheadMs), label: "Until the test is over", preset: "custom", source: "picker", setAt: iso(-sinceMs), ...extra };
}

async function settled(id: string) {
  const run = await lib.waitForRun(id, 15_000);
  if (!run) throw new Error("run vanished");
  return run;
}

/** The run's time record as a route answers it. */
function record(id: string): TimeRecordSummary | undefined {
  return lib.getRun(id)?.timeRecord;
}

const kinds = (id: string) => (record(id)?.records ?? []).map((r) => r.kind);
const notes = (id: string) => (record(id)?.records ?? []).filter((r) => r.kind === "note").map((r) => r.text);

async function startLive(name: string, timeBudget: TimeBudget | undefined): Promise<string> {
  makeProject(name);
  const started = await lib.startRun({ task: "build the page", projectId: name, source: "owner", ...(timeBudget ? { timeBudget } : {}) });
  await vi.waitFor(() => { expect(lib.getRun(started.id)?.sessionId).toBe("sess-abc-123"); }, { timeout: 5000 });
  return started.id;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-budget-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  writeConfig({});
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the budget brief", () => {
  const now = Date.parse("2026-10-14T15:00:00.000Z");
  const thirty: TimeBudget = { deadline: "2026-10-14T15:30:00.000Z", label: "30 minutes", preset: "30m", source: "picker", setAt: "2026-10-14T15:00:00.000Z" };

  it("names the deadline on the box's clock and zone, the time left, the margin's start, and asks for the estimate first", () => {
    const brief = lib.budgetBrief(thirty, now, "Europe/Sofia");
    expect(brief).toMatch(/^TIME BUDGET\./);
    // 15:30 UTC is 18:30 in Sofia (UTC+3 in October).
    expect(brief).toContain("the deadline is Wed 14 Oct, 18:30");
    expect(brief).toContain("(Europe/Sofia)");
    expect(brief).toContain("30 minutes left");
    // 30 minutes: the margin is its 10-minute floor, so nothing new after 18:20.
    expect(brief).toContain("start nothing new after Wed 14 Oct, 18:20 (20 minutes from now)");
    expect(brief).toContain('"ESTIMATE: 20 min"');
    expect(brief).toContain('"SKIPPED: <what> — <why>"');
    expect(brief).toMatch(/at the deadline the run is stopped/);
  });

  it("tells a short budget to skip e2e suites and polish, and a long one to build and test its tools first", () => {
    expect(lib.budgetBrief(thirty, now, "UTC")).toMatch(/short budget: skip end-to-end suites/);
    const night: TimeBudget = { ...thirty, deadline: "2026-10-15T05:00:00.000Z", preset: "morning", label: "Until tomorrow morning" };
    const long = lib.budgetBrief(night, now, "UTC");
    expect(long).toMatch(/long budget: first build the tools the job needs/);
    expect(long).not.toMatch(/short budget/);
  });

  it("does not ask again for an estimate the record already has, and says so when the margin has begun", () => {
    const late = lib.budgetBrief(thirty, Date.parse("2026-10-14T15:25:00.000Z"), "UTC", { askEstimate: false });
    expect(late).not.toContain("ESTIMATE");
    expect(late).toContain("You are already inside the safety margin");
  });

  it("goes into the system prompt only when given, so a run without a budget is briefed byte for byte as before", () => {
    const prompt = (args: string[]) => args[args.indexOf("--append-system-prompt") + 1];
    const plain = lib.buildRunArgs({ resumeSessionId: null, effort: "max" });
    const budgeted = lib.buildRunArgs({ resumeSessionId: null, effort: "max", timeBrief: "TIME BUDGET. x" });
    expect(lib.buildRunArgs({ resumeSessionId: null, effort: "max", timeBrief: null })).toEqual(plain);
    expect(prompt(budgeted)).toBe(`${prompt(plain)}\n\nTIME BUDGET. x`);
  });
});

describe("reading a reply's budget lines", () => {
  it("takes the first ESTIMATE line's estimate, in the shapes a model writes it", () => {
    expect(lib.readBudgetLines("ESTIMATE: 20 min\nOn it.").estimateMs).toBe(20 * 60_000);
    expect(lib.readBudgetLines("- **ESTIMATE:** ~1 h 30 min").estimateMs).toBe(90 * 60_000);
    expect(lib.readBudgetLines("ESTIMATE: 25 minutes (fits before the margin)").estimateMs).toBe(25 * 60_000);
    expect(lib.readBudgetLines("ESTIMATE: 12 min — tight\nESTIMATE: 40 min").estimateMs).toBe(12 * 60_000);
  });

  it("is not fooled by a sentence about an estimate, or one it cannot read", () => {
    expect(lib.readBudgetLines("My estimate: 20 min").estimateMs).toBeNull();
    expect(lib.readBudgetLines("ESTIMATE: soon").estimateMs).toBeNull();
  });

  it("collects each SKIPPED line", () => {
    expect(lib.readBudgetLines("ESTIMATE: 20 min\nSKIPPED: the e2e suite — no time\n* SKIPPED: polish").skipped).toEqual(["the e2e suite — no time", "polish"]);
  });
});

describe("a budgeted run that finishes", () => {
  it("keeps a time record from its budget to its stop, and adds how the estimate held to report.md", async () => {
    ready();
    installWrapper([assistantText("ESTIMATE: 15 min\nSKIPPED: the e2e suite — the budget is short\nStarting now.")]);
    makeProject("site");
    const started = await lib.startRun({ task: "build the page", projectId: "site", source: "owner", timeBudget: budget(30 * 60_000, 0) });
    const run = await settled(started.id);
    expect(run.status).toBe("completed");

    await vi.waitFor(() => { expect(record(run.id)?.stopReason).toBe("done"); }, { timeout: 5000 });
    const summary = record(run.id)!;
    expect(summary.records.map((r) => r.kind)).toEqual(["budget", "start", "plan", "skip", "finish", "stop"]);
    expect(summary.estimateMs).toBe(15 * 60_000);
    expect(summary.skipped).toEqual(["the e2e suite — the budget is short"]);
    expect(summary.records[0].text).toMatch(/^Budget set when the run was started: Until the test is over/);
    expect(summary.records[0].text).toContain("(Europe/Sofia)");
    expect(summary.records.find((r) => r.kind === "plan")?.text).toMatch(/it fits the/);
    const finish = summary.records.find((r) => r.kind === "finish")!;
    expect(finish.runId).toBe(run.id);
    expect(typeof finish.actualMs).toBe("number");

    // Its brief named the budget; the run's words went to report.md first.
    const argv = fs.readFileSync(argvFile(), "utf-8");
    expect(argv).toContain("TIME BUDGET. This run has a time budget: Until the test is over");
    expect(argv).toContain("Europe/Sofia");
    await vi.waitFor(() => {
      const report = fs.readFileSync(path.join(root, "data", "coding-agent-artifacts", run.id, "report.md"), "utf-8");
      expect(report).toMatch(/^Built the page\./);
      expect(report).toContain("## Time budget");
      expect(report).toContain("- Stopped: the work was done (done)");
      expect(report).toMatch(/- Estimates: the whole work, estimated 15 minutes, took \d+ minutes? \(-\d+%\)/);
      expect(report).toContain("- Skipped: the e2e suite — the budget is short");
    }, { timeout: 5000 });
    // The text log beside the JSON.
    const log = fs.readFileSync(path.join(root, "data", "coding-agent-artifacts", run.id, "time-record.log"), "utf-8");
    expect(log).toMatch(/\[plan\] .*~15 minutes/);
    expect(log).toMatch(/\[stop\] .*reason: done/);
  });

  it("changes nothing for a run without a budget: no brief, no record, no timeRecord key", async () => {
    ready();
    installWrapper([assistantText("ESTIMATE: 20 min")]);
    makeProject("site");
    const started = await lib.startRun({ task: "build the page", projectId: "site", source: "owner" });
    const run = await settled(started.id);
    expect(run.status).toBe("completed");
    expect(run).not.toHaveProperty("timeBudget");
    expect(run).not.toHaveProperty("timeRecord");
    expect(lib.listRuns()[0]).not.toHaveProperty("timeRecord");
    expect(fs.readFileSync(argvFile(), "utf-8")).not.toContain("TIME BUDGET");
    expect(fs.existsSync(path.join(root, "data", "coding-agent-artifacts", run.id, "time-record.json"))).toBe(false);
    const report = fs.readFileSync(path.join(root, "data", "coding-agent-artifacts", run.id, "report.md"), "utf-8");
    expect(report).not.toContain("Time budget");
  });

  it("carries its time record on the list the runs route answers with", async () => {
    ready();
    installWrapper([]);
    makeProject("site");
    const started = await lib.startRun({ task: "build the page", projectId: "site", source: "owner", timeBudget: budget(30 * 60_000, 0) });
    await settled(started.id);
    await vi.waitFor(() => { expect(lib.listRuns().find((r) => r.id === started.id)?.timeRecord?.stopReason).toBe("done"); }, { timeout: 5000 });
    expect(lib.getRun(started.id)?.timeRecord?.omittedRecords).toBe(0);
  });
});

describe("the deadline, enforced", () => {
  it("stops a run that is still working at its deadline, cleanly, with time as the reason", async () => {
    ready();
    installWrapper([], { wait: true });
    // Begun half an hour ago, so the margin is already behind it: its brief says so.
    const id = await startLive("site", budget(3_000, 30 * 60_000));
    expect(fs.readFileSync(argvFile(), "utf-8")).toContain("You are already inside the safety margin");

    const run = await settled(id);
    expect(run.status).toBe("stopped");
    expect(run.resumable).toBe(true);
    expect(run.error).toMatch(/^Stopped at its time budget's deadline \(.+\)\. Its work so far is kept/);
    // Told why first, through the same queue the owner's messages take.
    expect(run.messages.some((m) => /the deadline \(.+\) is here\. Stop now/.test(m.text))).toBe(true);
    await vi.waitFor(() => { expect(record(id)?.stopReason).toBe("time"); }, { timeout: 5000 });
    expect(notes(id).some((t) => /^Safety margin: the run started inside it/.test(t))).toBe(true);
    expect(record(id)?.leftMs).toBeLessThanOrEqual(0);
  });

  it("tells the run to commit and finish its step when the margin begins", async () => {
    ready();
    installWrapper([], { wait: true });
    // 30 minutes long, 20 gone: the 10-minute margin begins in ~2.5 s.
    const id = await startLive("site", budget(10 * 60_000 + 2_500, 20 * 60_000));
    expect(lib.getRun(id)?.messages ?? []).toHaveLength(0);
    await vi.waitFor(() => {
      expect(lib.getRun(id)?.messages.some((m) => /^Time budget: the safety margin has begun — 10 minutes left/.test(m.text))).toBe(true);
    }, { timeout: 8000 });
    expect(lib.getRun(id)?.status).toBe("running");
    await vi.waitFor(() => { expect(notes(id).some((t) => /^Safety margin: began with 10 minutes left; the run was told/.test(t))).toBe(true); }, { timeout: 5000 });

    lib.stopRun(id);
    await settled(id);
    await vi.waitFor(() => { expect(record(id)?.stopReason).toBe("stopped"); }, { timeout: 5000 });
  });

  it("writes a checkpoint with the time used and left while the run works", async () => {
    ready();
    lib._setBudgetCheckpointMsForTests(300);
    installWrapper([], { wait: true });
    const id = await startLive("site", budget(60 * 60_000, 60_000));
    await vi.waitFor(() => {
      expect(notes(id).filter((t) => /^Checkpoint: \d+ minutes? used, \d+ (minutes|h \d+ min|hours?) left$/.test(t)).length).toBeGreaterThanOrEqual(2);
    }, { timeout: 8000 });
    const checkpoint = record(id)!.records.find((r) => r.kind === "note" && r.text.startsWith("Checkpoint:"))!;
    expect(typeof checkpoint.tokensUsed).toBe("number");
    lib.stopRun(id);
    await settled(id);
  });

  it("stops at the budget's own spend ceiling, recorded as cost", async () => {
    ready();
    installWrapper([assistantText("working", { input_tokens: 60_000, output_tokens: 10 })], { wait: true });
    makeProject("site");
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", timeBudget: budget(30 * 60_000, 0, { tokenCap: 20_000 }) });
    const run = await settled(started.id);
    expect(run.status).toBe("stopped");
    expect(run.error).toMatch(/^Stopped at its time budget's spend ceiling \(60,010 of 20,000 tokens\)/);
    await vi.waitFor(() => { expect(record(run.id)?.stopReason).toBe("cost"); }, { timeout: 5000 });
  });

  it("records the owner's token limit as token_cap when it is the ceiling that stops a budgeted run", async () => {
    ready({ coding_agent_token_limit: 10_000 });
    installWrapper([assistantText("working", { input_tokens: 60_000, output_tokens: 10 })], { wait: true });
    makeProject("site");
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", timeBudget: budget(30 * 60_000, 0, { tokenCap: 50_000 }) });
    const run = await settled(started.id);
    expect(run.status).toBe("stopped");
    expect(run.error).toMatch(/^Stopped at the token limit/);
    await vi.waitFor(() => { expect(record(run.id)?.stopReason).toBe("token_cap"); }, { timeout: 5000 });
  });
});

describe("a deadline that has passed before the run starts", () => {
  it("lets a run handed one go on unenforced, its record closed as it starts", async () => {
    ready();
    installWrapper([]);
    makeProject("site");
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", timeBudget: budget(-60_000, 2 * 60 * 60_000) });
    const run = await settled(started.id);
    expect(run.status).toBe("completed");
    expect(fs.readFileSync(argvFile(), "utf-8")).not.toContain("TIME BUDGET");
    await vi.waitFor(() => { expect(notes(run.id)).toContain("After the deadline, the run ended completed"); }, { timeout: 5000 });
    expect(record(run.id)?.stopReason).toBe("time");
    expect(notes(run.id).some((t) => /^Started after the deadline \(.+\); it runs without a time limit$/.test(t))).toBe(true);
  });

  it("does not start a queued run whose deadline passed while it waited, and says why", async () => {
    // One run at a time, so the second waits its turn.
    ready({ coding_agent_max_parallel_runs: 1 });
    installWrapper([], { wait: true });
    makeProject("alpha");
    makeProject("beta");
    const first = await lib.startOrQueueRun({ task: "one", projectId: "alpha", source: "owner" });
    expect(first.queued).toBe(false);
    const second = await lib.startOrQueueRun({ task: "two", projectId: "beta", source: "owner", timeBudget: budget(1_500, 30 * 60_000) });
    expect(second.queued).toBe(true);
    await new Promise((r) => setTimeout(r, 2_000));
    fs.writeFileSync(flagFile(), "go");
    await settled(first.run.id);
    // A queued run is answered as it stands; its turn comes once the first settles.
    await vi.waitFor(() => { expect(lib.getRun(second.run.id)?.status).toBe("failed"); }, { timeout: 10_000 });
    const late = lib.getRun(second.run.id)!;
    expect(late.error).toMatch(/Its time budget ended while it waited in the queue \(the deadline was .+\)\. Start it again with a new budget\./);
    await vi.waitFor(() => { expect(record(late.id)?.stopReason).toBe("time"); }, { timeout: 5000 });
    expect(kinds(late.id)).toEqual(["budget", "stop"]);
  });
});

describe("a pause, a resume and a restart against the same deadline", () => {
  it("notes a pause, keeps the deadline through a resume, and enforces it again", async () => {
    ready();
    installWrapper([assistantText("ESTIMATE: 10 min")], { wait: true });
    const b = budget(60 * 60_000, 60_000);
    const id = await startLive("site", b);
    lib.pauseRun(id);
    expect((await settled(id)).status).toBe("paused");
    await vi.waitFor(() => { expect(notes(id).some((t) => /^Paused; the deadline still stands, (\d+ minutes|1 hour) before the deadline$/.test(t))).toBe(true); }, { timeout: 5000 });
    expect(record(id)?.stopReason).toBeNull();

    const resumed = await lib.resumeRun(id);
    expect(resumed.status).toBe("running");
    expect(resumed.timeBudget).toEqual(b);
    await vi.waitFor(() => { expect(notes(id).some((t) => /^Resumed by the owner, (\d+ minutes|1 hour) before the same deadline$/.test(t))).toBe(true); }, { timeout: 5000 });
    // Still briefed against the same deadline — and not asked again for the estimate it gave.
    await vi.waitFor(() => { expect(fs.readFileSync(argvFile(), "utf-8")).toContain("--resume"); }, { timeout: 5000 });
    const argv = fs.readFileSync(argvFile(), "utf-8");
    expect(argv).toContain("TIME BUDGET.");
    expect(argv).not.toContain('"ESTIMATE: 20 min"');

    lib.stopRun(id);
    await settled(id);
    await vi.waitFor(() => { expect(record(id)?.stopReason).toBe("stopped"); }, { timeout: 5000 });
    expect(kinds(id).filter((k) => k === "stop")).toHaveLength(1);
  });

  it("closes a paused run's record at the deadline, and lets the owner's resume past it go on unenforced", async () => {
    ready();
    installWrapper([], { wait: true });
    const id = await startLive("site", budget(5_000, 30 * 60_000));
    lib.pauseRun(id);
    expect((await settled(id)).status).toBe("paused");
    // The deadline comes while it waits: the owner's pause is what ended it.
    await vi.waitFor(() => { expect(record(id)?.stopReason).toBe("stopped"); }, { timeout: 10_000 });
    expect(lib.getRun(id)?.status).toBe("paused");

    const resumed = await lib.resumeRun(id);
    expect(resumed.status).toBe("running");
    await vi.waitFor(() => { expect(notes(id).some((t) => /^Resumed by the owner after the deadline \(.+\); it carries on without a time limit$/.test(t))).toBe(true); }, { timeout: 5000 });
    // Past its deadline and nobody stops it: the owner chose to go on.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(lib.getRun(id)?.status).toBe("running");
    await vi.waitFor(() => { expect(fs.readFileSync(argvFile(), "utf-8")).not.toContain("TIME BUDGET."); }, { timeout: 5000 });

    lib.stopRun(id);
    await settled(id);
    await vi.waitFor(() => { expect(notes(id)).toContain("After the deadline, the run ended stopped"); }, { timeout: 5000 });
    expect(kinds(id).filter((k) => k === "stop")).toHaveLength(1);
  });

  it("records the provider's usage limit as quota when the deadline finds the run waiting on it", async () => {
    ready();
    installWrapper([], { wait: true });
    const id = await startLive("site", budget(5_000, 30 * 60_000));
    lib.noteAllowanceRefusal(id, "images", { resetsAt: null, message: "You have used up today's pictures." });
    lib.pauseRun(id);
    expect((await settled(id)).pauseReason).toMatchObject({ kind: "allowance" });
    await vi.waitFor(() => { expect(notes(id).some((t) => /^Paused by the provider's usage limit \(images\)/.test(t))).toBe(true); }, { timeout: 5000 });
    await vi.waitFor(() => { expect(record(id)?.stopReason).toBe("quota"); }, { timeout: 10_000 });
  });

  it("arms the clock again after a restart, from the deadline on the record", async () => {
    ready();
    installWrapper([], { wait: true });
    const id = await startLive("site", budget(4_000, 30 * 60_000));
    lib.pauseRun(id);
    await settled(id);
    await vi.waitFor(() => { expect(notes(id).some((t) => t.startsWith("Paused;"))).toBe(true); }, { timeout: 5000 });

    // The web server goes: every clock with it. The record and the runs file stay.
    await lib._resetCodingAgentStateForTests();
    await lib.reconcileAfterRestart();
    await vi.waitFor(() => { expect(record(id)?.stopReason).toBe("stopped"); }, { timeout: 8000 });
  });
});

describe("wrapUpRun", () => {
  it("tells a run without a budget why, then stops it cleanly — what a team calls at its deadline", async () => {
    ready();
    installWrapper([], { wait: true });
    const id = await startLive("site", undefined);
    const answered = await lib.wrapUpRun(id, "time");
    expect(answered?.id).toBe(id);
    const run = await settled(id);
    expect(run.status).toBe("stopped");
    expect(run.resumable).toBe(true);
    expect(run.error).toMatch(/^Stopped: the time budget for this work ended\./);
    expect(run.messages.some((m) => m.text.startsWith("Time is up: the time budget for this work has ended."))).toBe(true);
    expect(run).not.toHaveProperty("timeRecord");
  });

  it("answers null for an id that is no run, and leaves a settled run as it is", async () => {
    expect(await lib.wrapUpRun("run-zzzzzzzz", "time")).toBeNull();
    ready();
    installWrapper([]);
    makeProject("site");
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    const done = await settled(started.id);
    expect((await lib.wrapUpRun(done.id, "time"))?.status).toBe("completed");
  });
});

describe("the budget's part of report.md", () => {
  it("says what the budget was, what was used, why it stopped and how the estimate held", () => {
    const b: TimeBudget = { deadline: "2026-10-14T15:30:00.000Z", label: "30 minutes", preset: "30m", source: "picker", setAt: "2026-10-14T15:00:00.000Z" };
    const section = lib.budgetReportSection({
      budget: b,
      estimateMs: 20 * 60_000,
      tasks: [],
      startedAt: "2026-10-14T15:00:00.000Z",
      finishedAt: "2026-10-14T15:24:00.000Z",
      usedMs: 24 * 60_000,
      leftMs: 6 * 60_000,
      stopReason: "done",
      tokenCap: null,
      tokensUsed: 1000,
      extras: [],
      skipped: [],
      records: [],
    }, "Europe/Sofia");
    expect(section.split("\n")).toEqual([
      "## Time budget",
      "",
      "- Budget: 30 minutes, until Wed 14 Oct, 18:30 (Europe/Sofia)",
      "- Used: 24 minutes, 6 minutes before the deadline",
      "- Stopped: the work was done (done)",
      "- Estimates: the whole work, estimated 20 minutes, took 24 minutes (+20%)",
    ]);
  });
});
