/**
 * POST /setup-api/coding-agent/team/message — a team run saying something.
 *
 * Driven end to end through the REAL orchestrator (src/lib/coding-team.ts)
 * and a live team on a mocked runner, because what this route promises is the
 * orchestrator's rules as HTTP: a run speaks only as itself (checked against
 * the board), never to itself, never outside its team, never to a run that
 * has finished, and within its caps — each refusal a stable `code` with its
 * status. Around that, the gate every coding-agent route has (a session: the
 * owner's cookie or the MCP bearer) and the same-origin fence of the message
 * route it sits beside.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let session: SessionFixture;
vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return { ...actual, get DATA_DIR() { return path.join(session.root, "data"); } };
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
vi.mock("@/lib/coding-agent", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/coding-agent")>()), ...runner }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/coding-team-worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-team-worktree")>()),
  ensureTeamBranch: vi.fn(async (_dir: string, teamId: string) => ({ ok: true, branch: `clawbox/${teamId}`, base: "master" })),
  addWorkerWorktree: vi.fn(async (dir: string, teamId: string, taskId: string, attempt: number) => ({ ok: true, path: `${dir}/.clawbox/worktrees/${taskId}-${attempt}`, branch: `clawbox/${teamId}-${taskId}-${attempt}` })),
  mergeWorkerBranch: vi.fn(async () => ({ ok: true, merged: true })),
  removeWorktree: vi.fn(async () => undefined),
  changedFiles: vi.fn(async () => []),
}));
const harness = vi.hoisted(() => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/harness")>()), ...harness }));
const gateway = vi.hoisted(() => ({ gatewayWsChatSendMain: vi.fn() }));
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()), ...gateway }));

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
let POST: (req: Request) => Promise<Response>;
let team: typeof import("@/lib/coding-team");
let runs: Map<string, Record<string, unknown>>;
let seq: number;
let teams: string[];
let restore: () => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
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
  POST = (await import("@/app/setup-api/coding-agent/team/message/route")).POST;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of teams) {
    try { team.stopTeam(id); } catch { /* settled */ }
  }
  await sleep(40);
  session.cleanup();
  restore();
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A live team past its planner, with two workers running. */
async function liveTeam(): Promise<{ id: string; planner: string; a: string; b: string }> {
  const view = await team.startTeam({ goal: "Build the shop", directory: "/home/clawbox/Projects/shop", source: "owner" });
  teams.push(view.id);
  await until(() => team.getTeam(view.id)?.plannerRunId !== null, "the planner");
  const planner = team.getTeam(view.id)!.plannerRunId!;
  Object.assign(runs.get(planner)!, {
    status: "completed",
    summary: JSON.stringify([{ task_description: "Build the cart", files_hint: ["cart.js"] }, { task_description: "Build the checkout", files_hint: ["checkout.js"] }]),
  });
  await until(() => (team.getTeam(view.id)?.runs.filter((r) => r.role === "worker").length ?? 0) === 2, "two workers");
  const [a, b] = team.getTeam(view.id)!.runs.filter((r) => r.role === "worker").map((r) => r.id);
  return { id: view.id, planner, a, b };
}

function post(body: unknown, auth: "cookie" | "bearer" | "none" = "bearer", origin?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", host: "localhost" };
  if (auth === "cookie") headers.Cookie = session.cookie;
  if (auth === "bearer") headers.Authorization = `Bearer ${MCP_TOKEN}`;
  if (origin !== undefined) headers.Origin = origin;
  return POST(new Request("http://localhost/setup-api/coding-agent/team/message", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

describe("the gate", () => {
  it("is 401 with no session, and says nothing to anyone", async () => {
    const res = await post({ teamId: "team-aaaaaaaa", fromRunId: "run-aaaaaaaa", role: "worker", to: "lead", text: "hi" }, "none");
    expect(res.status).toBe(401);
    expect(runner.queueRunMessage).not.toHaveBeenCalled();
  });

  it("refuses another site's page even with the owner's cookie on it", async () => {
    const res = await post({ teamId: "team-aaaaaaaa", fromRunId: "run-aaaaaaaa", role: "worker", to: "lead", text: "hi" }, "cookie", "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_origin" });
  });

  it("answers 400 INVALID for a body that is not JSON, or not a team message", async () => {
    expect((await post("{not json")).status).toBe(400);
    const res = await post({ teamId: "team-aaaaaaaa", fromRunId: "run-aaaaaaaa", role: "worker", to: "everyone", text: "hi" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID" });
  });

  it("answers 404 NOT_FOUND for a team that does not exist", async () => {
    const res = await post({ teamId: "team-00000000", fromRunId: "run-aaaaaaaa", role: "worker", to: "lead", text: "hi" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a message that goes", () => {
  it("reaches a sibling through the steering path, from the MCP bearer, on an owner's team", async () => {
    const { id, a, b } = await liveTeam();
    const res = await post({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: b, text: "I need your total() first" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, to: "sibling", toRunId: b, delivered: true, left: 11, limits: { maxChars: 1500, perRun: 12, perWindow: 4, windowMinutes: 5 } });
    expect(runner.queueRunMessage).toHaveBeenCalledWith(b, `[from worker ${a}] I need your total() first`);
  });

  it("posts to the assistant's chat with the team's prefix", async () => {
    const { id, b } = await liveTeam();
    const res = await post({ teamId: id, fromRunId: b, role: "worker", to: "owner_agent", text: "Stripe or PayPal?" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ to: "owner_agent", sessionKey: "agent:main:main" });
    expect(gateway.gatewayWsChatSendMain).toHaveBeenCalledWith(`[Coding team ${id} · worker ${b}] Stripe or PayPal?`, expect.objectContaining({ idempotencyKey: expect.any(String) }));
  });

  it("answers 501 UNSUPPORTED for the assistant on a Hermes box", async () => {
    harness.getActiveHarness.mockResolvedValue("hermes");
    const { id, a } = await liveTeam();
    const res = await post({ teamId: id, fromRunId: a, role: "worker", to: "owner_agent", text: "Stripe or PayPal?" });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: "UNSUPPORTED" });
  });
});

describe("a message that is refused", () => {
  it("403 FORBIDDEN: a run speaking as another role, or as a run the team does not have", async () => {
    const { id, a } = await liveTeam();
    const asPlanner = await post({ teamId: id, fromRunId: a, role: "planner", to: "lead", text: "I plan now" });
    expect(asPlanner.status).toBe(403);
    expect(await asPlanner.json()).toMatchObject({ code: "FORBIDDEN" });
    const stranger = await post({ teamId: id, fromRunId: "run-zzzzzzzz", role: "worker", to: "lead", text: "hi" });
    expect(stranger.status).toBe(403);
    // Both on the board as alerts.
    expect(team.getTeam(id)!.log.filter((e) => e.type === "alert" && /FORBIDDEN/.test(e.message))).toHaveLength(2);
  });

  it("404 NOT_IN_TEAM and 400 SELF: whom a run may not message", async () => {
    const { id, a } = await liveTeam();
    const outside = await post({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: "run-zzzzzzzz", text: "hi" });
    expect(outside.status).toBe(404);
    expect(await outside.json()).toMatchObject({ code: "NOT_IN_TEAM" });
    const self = await post({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: a, text: "hi" });
    expect(self.status).toBe(400);
    expect(await self.json()).toMatchObject({ code: "SELF" });
  });

  it("409 SETTLED: a sibling that has finished", async () => {
    const { id, a, planner } = await liveTeam();
    const res = await post({ teamId: id, fromRunId: a, role: "worker", to: "sibling", toRunId: planner, text: "thanks for the plan" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SETTLED" });
    expect(runner.queueRunMessage).not.toHaveBeenCalled();
  });

  it("429 RATE_LIMITED past four in five minutes, with the time the next may go", async () => {
    const { id, a } = await liveTeam();
    for (let i = 0; i < 4; i++) {
      expect((await post({ teamId: id, fromRunId: a, role: "worker", to: "lead", text: `note ${i}` })).status).toBe(200);
    }
    const res = await post({ teamId: id, fromRunId: a, role: "worker", to: "lead", text: "note 5" });
    expect(res.status).toBe(429);
    const body = await res.json() as { code: string; nextAllowedAt: number; error: string };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.nextAllowedAt).toBeGreaterThan(Date.now());
    expect(body.nextAllowedAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(team.getTeam(id)!.log.filter((e) => e.type === "message")).toHaveLength(4);
  });

  it("413 TOO_LONG past 1,500 characters", async () => {
    const { id, a } = await liveTeam();
    const res = await post({ teamId: id, fromRunId: a, role: "worker", to: "lead", text: "x".repeat(1_501) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "TOO_LONG" });
  });
});
