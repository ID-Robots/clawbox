/**
 * The run-lifecycle routes built on src/lib/coding-agent-route.ts — pause,
 * resume, start-a-draft and discard-a-draft (stop has its own suite beside
 * the runs listing). What is pinned is the factory's contract: the `id`
 * alias, a JSON 404, the owner gate by SOURCE alone, and one status table
 * for every CodingAgentError.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const getRun = vi.hoisted(() => vi.fn());
const pauseRun = vi.hoisted(() => vi.fn());
const resumeRun = vi.hoisted(() => vi.fn());
const startDraftRun = vi.hoisted(() => vi.fn());
const deleteDraftRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, getRun, pauseRun, resumeRun, startDraftRun, deleteDraftRun };
});

const RUN = { id: "run-k3x9q2ab", status: "running", source: "agent" };
const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";

type Handler = (req: Request) => Promise<Response>;
let pause: Handler;
let resume: Handler;
let start: Handler;
let discard: Handler;
let CodingAgentError: typeof import("@/lib/coding-agent").CodingAgentError;
let readRunId: typeof import("@/lib/coding-agent-route").readRunId;
let session: SessionFixture;
let restore: () => void;

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  getRun.mockReturnValue(RUN);
  pauseRun.mockReturnValue({ ...RUN, status: "paused" });
  resumeRun.mockResolvedValue({ ...RUN, status: "running" });
  startDraftRun.mockResolvedValue({ ...RUN, status: "running" });
  CodingAgentError = (await import("@/lib/coding-agent")).CodingAgentError;
  readRunId = (await import("@/lib/coding-agent-route")).readRunId;
  pause = (await import("@/app/setup-api/coding-agent/pause/route")).POST;
  resume = (await import("@/app/setup-api/coding-agent/resume/route")).POST;
  start = (await import("@/app/setup-api/coding-agent/start/route")).POST;
  discard = (await import("@/app/setup-api/coding-agent/draft/route")).DELETE;
});

afterEach(() => {
  session.cleanup();
  restore();
});

function headers(auth: "cookie" | "bearer" | "none"): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (auth === "cookie") h.Cookie = session.cookie;
  if (auth === "bearer") h.Authorization = `Bearer ${MCP_TOKEN}`;
  return h;
}

const post = (handler: Handler, body: unknown, auth: "cookie" | "bearer" | "none" = "cookie") =>
  handler(new Request("http://localhost/setup-api/coding-agent/x", { method: "POST", headers: headers(auth), body: JSON.stringify(body) }));

const del = (query: string, auth: "cookie" | "bearer" | "none" = "cookie") =>
  discard(new Request(`http://localhost/setup-api/coding-agent/draft${query}`, { method: "DELETE", headers: headers(auth) }));

describe("readRunId", () => {
  it("takes runId, falls back to the id alias, trims, and answers '' for anything else", () => {
    expect(readRunId({ runId: " run-a " })).toBe("run-a");
    expect(readRunId({ id: "run-b" })).toBe("run-b");
    expect(readRunId({ runId: 7, id: "run-c" })).toBe("run-c");
    expect(readRunId({})).toBe("");
    expect(readRunId("run-d")).toBe("");
    expect(readRunId(null)).toBe("");
  });
});

describe("the shared shape", () => {
  it("is 401 without a session, and touches nothing", async () => {
    expect((await post(pause, { runId: RUN.id }, "none")).status).toBe(401);
    expect((await del(`?runId=${RUN.id}`, "none")).status).toBe(401);
    expect(pauseRun).not.toHaveBeenCalled();
    expect(deleteDraftRun).not.toHaveBeenCalled();
  });

  it("needs an id — from the body for POST, from ?runId= for DELETE", async () => {
    expect((await post(resume, {})).status).toBe(400);
    expect((await post(resume, { id: 7 })).status).toBe(400);
    expect((await del("")).status).toBe(400);
    expect((await del("?runId=%20")).status).toBe(400);
  });

  it("answers a JSON 404 for an unknown run — the MCP reads a bodiless one as 'no such tool'", async () => {
    getRun.mockReturnValue(null);
    const res = await post(start, { runId: "run-nope0000" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "There is no coding run with that id.", kind: "not_found" });
    expect(startDraftRun).not.toHaveBeenCalled();
  });

  it("refuses the agent's bearer for an owner's run WHATEVER its state — the gate is by source", async () => {
    for (const status of ["running", "paused", "draft", "completed"]) {
      getRun.mockReturnValue({ ...RUN, status, source: "owner" });
      for (const handler of [pause, resume, start]) {
        const res = await post(handler, { runId: RUN.id }, "bearer");
        expect(res.status, status).toBe(403);
        expect((await res.json()).kind).toBe("owner_only");
      }
      const res = await del(`?runId=${RUN.id}`, "bearer");
      expect(res.status, status).toBe(403);
      expect((await res.json()).error).toMatch(/draft is the owner's; only they can discard it/);
    }
    expect(pauseRun).not.toHaveBeenCalled();
    expect(resumeRun).not.toHaveBeenCalled();
    expect(startDraftRun).not.toHaveBeenCalled();
    expect(deleteDraftRun).not.toHaveBeenCalled();
  });

  it("lets the agent act on its own runs, and the owner's cookie on either kind", async () => {
    expect((await post(pause, { id: RUN.id }, "bearer")).status).toBe(200);
    expect(pauseRun).toHaveBeenCalledWith(RUN.id);
    getRun.mockReturnValue({ ...RUN, status: "paused", source: "owner" });
    const res = await post(resume, { runId: RUN.id }, "cookie");
    expect(res.status).toBe(202);
    expect((await res.json()).run.status).toBe("running");
    expect(resumeRun).toHaveBeenCalledWith(RUN.id);
  });

  it("maps a CodingAgentError through the one status table", async () => {
    resumeRun.mockRejectedValue(new CodingAgentError("invalid", "Only a paused run can be resumed in place."));
    expect((await post(resume, { runId: RUN.id })).status).toBe(400);
    startDraftRun.mockRejectedValue(new CodingAgentError("busy", "A coding run is already in progress."));
    const busy = await post(start, { runId: RUN.id });
    expect(busy.status).toBe(409);
    expect((await busy.json()).kind).toBe("busy");
    deleteDraftRun.mockImplementation(() => { throw new CodingAgentError("not_found", "gone"); });
    expect((await del(`?runId=${RUN.id}`)).status).toBe(404);
    deleteDraftRun.mockImplementation(() => { throw new Error("disk"); });
    expect((await del(`?runId=${RUN.id}`)).status).toBe(500);
  });

  it("starts a draft with a 202 and discards one with { ok: true }", async () => {
    getRun.mockReturnValue({ ...RUN, status: "draft" });
    expect((await post(start, { runId: RUN.id })).status).toBe(202);
    deleteDraftRun.mockImplementation(() => undefined);
    const res = await del(`?runId=${RUN.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteDraftRun).toHaveBeenCalledWith(RUN.id);
  });
});
