/**
 * `sendTeamMessage` (src/lib/coding-team.ts) against a LIVE team on a mocked
 * runner: the planner and two workers are real board members whose runs the
 * test holds open, so every rule is exercised the way a run's own MCP server
 * reaches it.
 *
 *   - a sibling message goes through the steering path (`queueRunMessage`),
 *     prefixed `[from <role> <runId>]`, and nowhere else;
 *   - a message to the lead is the board entry and nothing more;
 *   - a message to the box's main agent is `chat.send` into the web chat's
 *     session, prefixed with the team and the run — or a refusal saying why
 *     not (Hermes, no gateway), recorded as undelivered and never an alert;
 *   - every refusal of the SENDER is an alert on the board; the caps answer
 *     RATE_LIMITED with the time the next may go; a sent message never moves
 *     the alert count; the sender's own feed gets the line;
 *   - a late answer to a sibling that has already finished (SETTLED) is still
 *     refused, but logged as a note and counted undelivered, never an alert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return { ...actual, get DATA_DIR() { return path.join(root, "data"); } };
});

const runner = vi.hoisted(() => ({
  startRun: vi.fn(),
  waitForRun: vi.fn(),
  getRun: vi.fn(),
  stopRun: vi.fn(),
  resolveWorkingDirectory: vi.fn(),
  isCodingAgentEnabled: vi.fn(),
  queueRunMessage: vi.fn(),
  noteTeamMessageSent: vi.fn(),
}));
vi.mock("@/lib/coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-agent")>();
  return { ...actual, ...runner };
});
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/coding-team-worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-team-worktree")>();
  return {
    ...actual,
    ensureTeamBranch: vi.fn(async (_dir: string, teamId: string) => ({ ok: true, branch: `clawbox/${teamId}`, base: "master" })),
    addWorkerWorktree: vi.fn(async (dir: string, teamId: string, taskId: string, attempt: number) => ({ ok: true, path: `${dir}/.clawbox/worktrees/${taskId}-${attempt}`, branch: `clawbox/${teamId}-${taskId}-${attempt}` })),
    mergeWorkerBranch: vi.fn(async () => ({ ok: true, merged: true })),
    removeWorktree: vi.fn(async () => undefined),
    changedFiles: vi.fn(async () => []),
  };
});
const harness = vi.hoisted(() => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/harness")>()), ...harness }));
// The gateway link, mocked: the one call the owner_agent path makes. The
// error classes stay the real ones, so the path's own `instanceof` is tested.
const gateway = vi.hoisted(() => ({ gatewayWsChatSendMain: vi.fn() }));
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()), ...gateway }));

type Team = typeof import("@/lib/coding-team");
let team: Team;
let TeamMessageError: typeof import("@/lib/coding-team-messages").TeamMessageError;
let runs: Map<string, Record<string, unknown>>;
let seq: number;
let teams: string[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "team-message-send-"));
  runs = new Map();
  seq = 0;
  teams = [];
  vi.resetModules();
  vi.clearAllMocks();
  runner.isCodingAgentEnabled.mockResolvedValue(true);
  runner.resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/Projects/shop", projectId: null });
  runner.startRun.mockImplementation(async (input: Record<string, unknown>) => {
    seq += 1;
    const run = { id: `run-${String(seq).padStart(8, "0")}`, status: "running", team: input.team ?? null, summary: null, error: null, filesTouched: [], permissionDenials: 0, deniedActions: [] };
    runs.set(run.id, run);
    return run;
  });
  // Runs stay open until the test settles them: the orchestrator looks again
  // every few milliseconds, the way it polls a real one.
  runner.waitForRun.mockImplementation(async (id: string) => {
    await sleep(5);
    return runs.get(id) ?? null;
  });
  runner.getRun.mockImplementation((id: string) => runs.get(id) ?? null);
  runner.stopRun.mockImplementation((id: string) => {
    const run = runs.get(id);
    if (run && run.status === "running") run.status = "stopped";
    return run;
  });
  runner.queueRunMessage.mockReturnValue({ run: {}, delivered: true });
  harness.getActiveHarness.mockResolvedValue("openclaw");
  gateway.gatewayWsChatSendMain.mockResolvedValue({ sessionKey: "agent:main:main" });
  team = await import("@/lib/coding-team");
  TeamMessageError = (await import("@/lib/coding-team-messages")).TeamMessageError;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of teams) {
    try { team.stopTeam(id); } catch { /* already settled */ }
  }
  await sleep(40);
  fs.rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A team whose planner is running (run-00000001). */
async function startTeam(): Promise<{ id: string; planner: string }> {
  const view = await team.startTeam({ goal: "Build the shop", directory: "/home/clawbox/Projects/shop", source: "agent" });
  teams.push(view.id);
  await until(() => team.getTeam(view.id)?.plannerRunId !== null, "the planner");
  return { id: view.id, planner: team.getTeam(view.id)!.plannerRunId! };
}

/** …and past the planner: two independent tasks, both workers running. */
async function startWorkers(): Promise<{ id: string; planner: string; a: string; b: string }> {
  const started = await startTeam();
  Object.assign(runs.get(started.planner)!, {
    status: "completed",
    summary: JSON.stringify([
      { task_description: "Build the cart", files_hint: ["cart.js"] },
      { task_description: "Build the checkout", files_hint: ["checkout.js"] },
    ]),
  });
  await until(() => (team.getTeam(started.id)?.runs.filter((r) => r.role === "worker").length ?? 0) === 2, "two workers");
  const [a, b] = team.getTeam(started.id)!.runs.filter((r) => r.role === "worker").map((r) => r.id);
  return { ...started, a, b };
}

async function refusal(promise: Promise<unknown>): Promise<InstanceType<typeof TeamMessageError>> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TeamMessageError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

const messagesOf = (id: string) => team.getTeam(id)!.log.filter((e) => e.type === "message");
const alertsOf = (id: string) => team.getTeam(id)!.log.filter((e) => e.type === "alert").map((e) => e.message);

describe("the three ways a message goes", () => {
  it("a planner tells the lead: an entry on the board, a line on its own feed, nothing else", async () => {
    const { id, planner } = await startTeam();
    const text = "The goal names checkout.ts; the folder has no such file.";
    const sent = await team.sendTeamMessage({ teamId: id, fromRunId: planner, role: "planner", to: "lead", text });
    expect(sent).toMatchObject({ to: "lead", toRunId: null, delivered: true, left: 11 });
    expect(messagesOf(id)).toEqual([
      expect.objectContaining({ actor: { kind: "planner" }, payload: { from: planner, to: "lead", text } }),
    ]);
    expect(runner.noteTeamMessageSent).toHaveBeenCalledWith(planner, `Team message to the lead: ${text}`);
    expect(runner.queueRunMessage).not.toHaveBeenCalled();
    expect(gateway.gatewayWsChatSendMain).not.toHaveBeenCalled();
    expect(team.getTeam(id)!.alerts).toBe(0);
  });

  it("a worker reaches a sibling through the steering path, prefixed with who it is — and it goes nowhere else", async () => {
    const { id, a, b } = await startWorkers();
    runner.queueRunMessage.mockReturnValueOnce({ run: {}, delivered: false });
    const sent = await team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: b, text: "I need your checkout total() first — what does it return?" });
    expect(runner.queueRunMessage).toHaveBeenCalledTimes(1);
    expect(runner.queueRunMessage).toHaveBeenCalledWith(b, `[from worker ${a}] I need your checkout total() first — what does it return?`);
    expect(sent).toMatchObject({ to: "sibling", toRunId: b, delivered: false });
    expect(messagesOf(id).at(-1)).toMatchObject({ actor: { kind: "worker", id: a }, task_id: "t1", payload: { from: a, to: "sibling", toRunId: b } });
    expect(runner.noteTeamMessageSent).toHaveBeenCalledWith(a, `Team message to ${b}: I need your checkout total() first — what does it return?`);
    expect(gateway.gatewayWsChatSendMain).not.toHaveBeenCalled();
    expect(team.getTeam(id)!.alerts).toBe(0);
  });

  it("owner_agent posts into the web chat's session, prefixed with the team and the run", async () => {
    const { id, planner } = await startTeam();
    const sent = await team.sendTeamMessage({ teamId: id, fromRunId: planner, role: "planner", to: "owner_agent", text: "Stripe or PayPal?" });
    expect(gateway.gatewayWsChatSendMain).toHaveBeenCalledWith(
      `[Coding team ${id} · planner ${planner}] Stripe or PayPal?`,
      { idempotencyKey: expect.any(String), timeoutMs: team.OWNER_AGENT_TIMEOUT_MS },
    );
    expect(sent).toMatchObject({ to: "owner_agent", delivered: true, sessionKey: "agent:main:main" });
    expect(messagesOf(id).at(-1)?.payload).toEqual({ from: planner, to: "owner_agent", text: "Stripe or PayPal?" });
    expect(runner.noteTeamMessageSent).toHaveBeenCalledWith(planner, "Team message to the assistant: Stripe or PayPal?");
  });
});

describe("when the box cannot hand it on", () => {
  it("answers UNSUPPORTED on Hermes, records it as undelivered, and raises no alert", async () => {
    harness.getActiveHarness.mockResolvedValue("hermes");
    const { id, planner } = await startTeam();
    const err = await refusal(team.sendTeamMessage({ teamId: id, fromRunId: planner, role: "planner", to: "owner_agent", text: "Stripe or PayPal?" }));
    expect(err.code).toBe("UNSUPPORTED");
    expect(gateway.gatewayWsChatSendMain).not.toHaveBeenCalled();
    expect(messagesOf(id).at(-1)?.payload).toMatchObject({ to: "owner_agent", delivered: false, code: "UNSUPPORTED" });
    expect(team.getTeam(id)!.alerts).toBe(0);
    expect(runner.noteTeamMessageSent).not.toHaveBeenCalled();
  });

  it("answers NO_SESSION, never a silent drop, when there is no gateway session to post into", async () => {
    const { GatewayWsUnavailableError, GatewayRpcError } = await import("@/lib/openclaw-gateway-ws");
    gateway.gatewayWsChatSendMain.mockRejectedValueOnce(new GatewayWsUnavailableError("connect ECONNREFUSED"));
    const { id, planner } = await startTeam();
    const err = await refusal(team.sendTeamMessage({ teamId: id, fromRunId: planner, role: "planner", to: "owner_agent", text: "Which database?" }));
    expect(err.code).toBe("NO_SESSION");
    expect(err.message).toMatch(/not delivered/);
    expect(messagesOf(id).at(-1)?.payload).toMatchObject({ delivered: false, code: "NO_SESSION" });

    gateway.gatewayWsChatSendMain.mockRejectedValueOnce(new GatewayRpcError("session is busy", "BUSY"));
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: planner, role: "planner", to: "owner_agent", text: "Which database?" }))).code).toBe("NOT_DELIVERED");
    expect(team.getTeam(id)!.alerts).toBe(0);
  });
});

describe("who may speak", () => {
  it("refuses a run speaking as another role, or as a run the team does not have — each an alert", async () => {
    const { id, a } = await startWorkers();
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "planner", to: "lead", text: "I am the planner now" }))).code).toBe("FORBIDDEN");
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: "run-zzzzzzzz", role: "worker", to: "lead", text: "hello" }))).code).toBe("FORBIDDEN");
    expect(messagesOf(id)).toHaveLength(0);
    expect(alertsOf(id)).toEqual([
      expect.stringMatching(new RegExp(`^ALERT: Refused message from planner: FORBIDDEN: ${a} is not a running planner`)),
      expect.stringMatching(/^ALERT: Refused message from worker run-zzzzzzzz: FORBIDDEN/),
    ]);
  });

  it("refuses a run that is not running any more", async () => {
    const { id, a } = await startWorkers();
    runs.get(a)!.status = "paused";
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "lead", text: "hello" }))).code).toBe("FORBIDDEN");
  });

  it("answers NOT_FOUND for a team that never was, and SETTLED once the team has stopped", async () => {
    expect((await refusal(team.sendTeamMessage({ teamId: "team-00000000", fromRunId: "run-aaaaaaaa", role: "worker", to: "lead", text: "hi" }))).code).toBe("NOT_FOUND");
    const { id, planner } = await startTeam();
    team.stopTeam(id);
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: planner, role: "planner", to: "lead", text: "hi" }))).code).toBe("SETTLED");
  });

  it("answers INVALID for a request that is not a team message at all, before anything is logged", async () => {
    const { id, a } = await startWorkers();
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "sibling", text: "hi" }))).code).toBe("INVALID");
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "boss", to: "lead", text: "hi" }))).code).toBe("INVALID");
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "everyone", text: "hi" }))).code).toBe("INVALID");
    expect((await refusal(team.sendTeamMessage({ teamId: "../etc", fromRunId: a, role: "worker", to: "lead", text: "hi" }))).code).toBe("INVALID");
    expect(team.getTeam(id)!.alerts).toBe(0);
  });
});

describe("whom it may reach, and what", () => {
  it("refuses a message to itself and to a run outside the team — naming the runs it could reach", async () => {
    const { id, a, b } = await startWorkers();
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: a, text: "note to self" }))).code).toBe("SELF");
    const outside = await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: "run-zzzzzzzz", text: "hi" }));
    expect(outside.code).toBe("NOT_IN_TEAM");
    // The settled planner is not offered; the running sibling is, with its task.
    expect(outside.message).toMatch(new RegExp(`Its runs at work now: ${b} \\(worker, t2\\)\\.$`));
    expect(runner.queueRunMessage).not.toHaveBeenCalled();
    expect(team.getTeam(id)!.alerts).toBe(2);
  });

  it("refuses a sibling that has settled, and one whose queue is full", async () => {
    const { id, a, b } = await startWorkers();
    const { RunMessageError } = await import("@/lib/coding-run-messages");
    runner.queueRunMessage.mockImplementationOnce(() => { throw new RunMessageError("queue_full", "full"); });
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: b, text: "hi" }))).code).toBe("QUEUE_FULL");
    runs.get(b)!.status = "gave_up";
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: b, text: "hi" }))).code).toBe("SETTLED");
    expect(messagesOf(id)).toHaveLength(0);
  });

  it("refuses text that is empty or too long", async () => {
    const { id, planner } = await startTeam();
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: planner, role: "planner", to: "lead", text: "  " }))).code).toBe("EMPTY");
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: planner, role: "planner", to: "lead", text: "x".repeat(1_501) }))).code).toBe("TOO_LONG");
  });
});

describe("a late answer to a sibling that has finished (TASK-1239)", () => {
  const notesOf = (id: string) => team.getTeam(id)!.log.filter((e) => e.type === "note" && e.payload?.undelivered);

  it("is a note with the refusal's words, counted undelivered — the alert count does not move, and the sender still hears SETTLED", async () => {
    const { id, a, b } = await startWorkers();
    runs.get(a)!.status = "completed";
    const before = team.getTeam(id)!;
    const err = await refusal(team.sendTeamMessage({ teamId: id, fromRunId: b, role: "worker", to: "sibling", toRunId: a, text: "total() returns cents, as an integer." }));
    // The sender's answer is unchanged: not delivered, and why.
    expect(err.code).toBe("SETTLED");
    expect(err.message).toBe(`${a} has finished; there is nothing left to tell it.`);
    const after = team.getTeam(id)!;
    expect(after.alerts).toBe(before.alerts);
    expect(notesOf(id)).toEqual([
      expect.objectContaining({
        actor: { kind: "system" },
        message: `Refused message from worker ${b}: SETTLED: ${a} has finished; there is nothing left to tell it.`,
        payload: { undelivered: { code: "SETTLED", from: b, role: "worker", to: "sibling", toRunId: a } },
      }),
    ]);
    expect(alertsOf(id).filter((m) => m.includes("Refused message"))).toEqual([]);
    expect(after.metrics.messagesUndelivered).toBe(before.metrics.messagesUndelivered + 1);
    expect(after.metrics.messagesSent).toBe(before.metrics.messagesSent + 1);
    expect(messagesOf(id)).toHaveLength(0);
    expect(runner.queueRunMessage).not.toHaveBeenCalled();
    expect(runner.noteTeamMessageSent).not.toHaveBeenCalled();
  });

  it("is a note too when the sibling finishes between the check and the hand-over", async () => {
    const { id, a, b } = await startWorkers();
    const { RunMessageError } = await import("@/lib/coding-run-messages");
    runner.queueRunMessage.mockImplementationOnce(() => { throw new RunMessageError("settled", "The run has finished."); });
    const before = team.getTeam(id)!;
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: b, text: "hi" }))).code).toBe("SETTLED");
    const after = team.getTeam(id)!;
    expect(after.alerts).toBe(before.alerts);
    expect(notesOf(id)).toHaveLength(1);
    expect(after.metrics.messagesUndelivered).toBe(before.metrics.messagesUndelivered + 1);
  });

  it("never adds up to MAX_ALERTS: three late answers leave a working team working", async () => {
    const { id, a, b } = await startWorkers();
    runs.get(b)!.status = "completed";
    for (let i = 0; i < team.MAX_ALERTS; i++) {
      expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: b, text: `answer ${i}` }))).code).toBe("SETTLED");
    }
    await sleep(30);
    const view = team.getTeam(id)!;
    expect(notesOf(id)).toHaveLength(team.MAX_ALERTS);
    expect(alertsOf(id).filter((m) => m.includes("Refused message"))).toEqual([]);
    expect(view.status).not.toBe("failed");
    expect(view.metrics.messagesUndelivered).toBe(team.MAX_ALERTS);
  });

  it("leaves a message to a run the team does not have an alert, as before", async () => {
    const { id, a } = await startWorkers();
    const before = team.getTeam(id)!;
    expect((await refusal(team.sendTeamMessage({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: "run-zzzzzzzz", text: "hi" }))).code).toBe("NOT_IN_TEAM");
    const after = team.getTeam(id)!;
    expect(after.alerts).toBe(before.alerts + 1);
    expect(alertsOf(id).at(-1)).toMatch(new RegExp(`^ALERT: Refused message from worker ${a}: NOT_IN_TEAM: run-zzzzzzzz is not a run of team ${id}`));
    expect(notesOf(id)).toHaveLength(0);
    expect(after.metrics.messagesUndelivered).toBe(before.metrics.messagesUndelivered);
  });
});

describe("the caps", () => {
  it("holds a run to four in five minutes and twelve in all, with the time the next may go — and a message never raises an alert", async () => {
    const { id, planner } = await startTeam();
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const say = (text: string) => team.sendTeamMessage({ teamId: id, fromRunId: planner, role: "planner", to: "lead", text });

    const first = clock;
    for (let i = 1; i <= 4; i++) {
      await say(`note ${i}`);
      clock += 1_000;
    }
    const limited = await refusal(say("note 5"));
    expect(limited).toMatchObject({ code: "RATE_LIMITED", nextAllowedAt: first + 5 * 60_000 });
    expect(limited.message).toContain(new Date(first + 5 * 60_000).toISOString());
    expect(messagesOf(id)).toHaveLength(4);

    for (let window = 0; window < 2; window++) {
      clock += 5 * 60_000;
      for (let i = 0; i < 4; i++) {
        await say(`window ${window} note ${i}`);
        clock += 1_000;
      }
    }
    expect(messagesOf(id)).toHaveLength(12);
    const spent = await refusal(say("note 13"));
    expect(spent).toMatchObject({ code: "RATE_LIMITED", nextAllowedAt: null });
    // Twelve messages, two refusals: only the refusals are alerts.
    expect(team.getTeam(id)!.alerts).toBe(2);
  });
});

describe("how a worker learns whom it can reach", () => {
  it("lists the teammates at work, by run id, in a worker's task text", async () => {
    const boardLib = await import("@/lib/coding-team-board");
    const board = boardLib.createBoard({ goal: "Build the shop", projectId: null, directory: "/p", source: "agent" }, { kind: "system" });
    for (const description of ["Build the cart API", "Build the checkout page", "Write the README"]) boardLib.postTask(board, { kind: "planner" }, { task_description: description });
    boardLib.assignTask(board, { kind: "system" }, "t1", "run-aaaaaaaa");
    boardLib.updateStatus(board, { kind: "worker", id: "run-aaaaaaaa" }, "t1", "in_progress");
    const text = team.workerTask(board, board.tasks[1]);
    expect(text).toContain('Teammates at work now (reach one with team_message, to="sibling"):\n- run-aaaaaaaa on t1: Build the cart API');
    // Not itself, and not a task nobody is on.
    expect(text).not.toContain("on t2:");
    expect(text).not.toContain("on t3:");
    expect(team.workerTask(board, board.tasks[0])).not.toContain("Teammates at work now");
  });

  it("never lets the list push a retry's rejection note out of the capped task text", async () => {
    const boardLib = await import("@/lib/coding-team-board");
    const board = boardLib.createBoard({ goal: `Build the shop. ${"Every page must work offline. ".repeat(110)}`, projectId: null, directory: "/p", source: "agent" }, { kind: "system" });
    for (const description of [`Build the cart API. ${"x".repeat(900)}`, `Build the checkout page. ${"y".repeat(900)}`, "Fix the cart badge"]) boardLib.postTask(board, { kind: "planner" }, { task_description: description });
    for (const [taskId, runId] of [["t1", "run-aaaaaaaa"], ["t2", "run-bbbbbbbb"]] as const) {
      boardLib.assignTask(board, { kind: "system" }, taskId, runId);
      boardLib.updateStatus(board, { kind: "worker", id: runId }, taskId, "in_progress");
    }
    const retry = board.tasks[2];
    Object.assign(retry, { attempts: 1, review: { verdict: "rejected", notes: "The badge still counts removed items.", at: 1 } });
    const text = team.workerTask(board, retry);
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).toContain("A previous attempt was rejected: The badge still counts removed items.");
    expect(text).toContain("run-aaaaaaaa on t1");
  });
});
