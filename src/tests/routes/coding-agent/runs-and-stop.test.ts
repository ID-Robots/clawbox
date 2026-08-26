/**
 * GET /setup-api/coding-agent/runs and POST /setup-api/coding-agent/stop.
 *
 * The 404 for an unknown run MUST carry a JSON { error } body: the MCP
 * classifier reads a bodiless 404 as "this route does not exist on this
 * edition" and tells the agent never to call the tool again. `wait` is
 * clamped to the server's ceiling so a caller cannot hold a request open for
 * an hour. Stop is gated in-handler like every other state change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const getRun = vi.hoisted(() => vi.fn());
const clearFinishedRuns = vi.hoisted(() => vi.fn());
const listRuns = vi.hoisted(() => vi.fn());
const waitForRun = vi.hoisted(() => vi.fn());
const stopRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, getRun, listRuns, waitForRun, stopRun, clearFinishedRuns };
});

const RUN = { id: "run-k3x9q2ab", status: "completed", summary: "done", source: "agent" };
const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";

let GET: (req: Request) => Promise<Response>;
let DELETE: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let MAX_WAIT_MS: number;
let CodingAgentError: typeof import("@/lib/coding-agent").CodingAgentError;
let session: SessionFixture;
let restore: () => void;

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  getRun.mockReturnValue(RUN);
  listRuns.mockReturnValue([RUN]);
  waitForRun.mockResolvedValue(RUN);
  stopRun.mockReturnValue({ ...RUN, status: "stopped" });
  const lib = await import("@/lib/coding-agent");
  MAX_WAIT_MS = lib.MAX_WAIT_MS;
  CodingAgentError = lib.CodingAgentError;
  clearFinishedRuns.mockReturnValue(2);
  const runsRoute = await import("@/app/setup-api/coding-agent/runs/route");
  GET = runsRoute.GET;
  DELETE = runsRoute.DELETE;
  POST = (await import("@/app/setup-api/coding-agent/stop/route")).POST;
});

afterEach(() => {
  session.cleanup();
  restore();
});

describe("GET runs", () => {
  it("lists recent runs with a bounded limit", async () => {
    const res = await GET(new Request("http://localhost/setup-api/coding-agent/runs?limit=999"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [RUN] });
    expect(listRuns).toHaveBeenCalledWith(30);
  });

  it("returns one run by id without waiting when wait is absent", async () => {
    const res = await GET(new Request("http://localhost/setup-api/coding-agent/runs?id=run-k3x9q2ab"));
    expect(await res.json()).toEqual({ run: RUN });
    expect(waitForRun).not.toHaveBeenCalled();
  });

  it("blocks on wait, clamped to the ceiling", async () => {
    await GET(new Request("http://localhost/setup-api/coding-agent/runs?id=run-k3x9q2ab&wait=9999"));
    expect(waitForRun).toHaveBeenCalledWith("run-k3x9q2ab", MAX_WAIT_MS);
    await GET(new Request("http://localhost/setup-api/coding-agent/runs?id=run-k3x9q2ab&wait=5"));
    expect(waitForRun).toHaveBeenLastCalledWith("run-k3x9q2ab", 5_000);
  });

  it("answers an unknown id with a JSON 404 the MCP reads as resource-level", async () => {
    getRun.mockReturnValue(null);
    const res = await GET(new Request("http://localhost/setup-api/coding-agent/runs?id=run-nope0000"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.kind).toBe("not_found");
  });
});

describe("DELETE runs — clearing the history", () => {
  const del = (auth: "cookie" | "bearer" | "none") => {
    const headers: Record<string, string> = {};
    if (auth === "cookie") headers.Cookie = session.cookie;
    if (auth === "bearer") headers.Authorization = `Bearer ${MCP_TOKEN}`;
    return DELETE(new Request("http://localhost/setup-api/coding-agent/runs", { method: "DELETE", headers }));
  };

  it("refuses the agent's bearer — these records are the account of what it did", async () => {
    const res = await del("bearer");
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(clearFinishedRuns).not.toHaveBeenCalled();
  });

  it("refuses a caller with no credential, identically", async () => {
    const bearer = await del("bearer");
    const bare = await del("none");
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual(await bearer.json());
    expect(clearFinishedRuns).not.toHaveBeenCalled();
  });

  it("clears for the owner and says how many went", async () => {
    const res = await del("cookie");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 2 });
    expect(clearFinishedRuns).toHaveBeenCalledTimes(1);
  });
});

describe("POST stop", () => {
  const stop = (body: unknown, auth: "cookie" | "bearer" | "none" = "cookie") => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth === "cookie") headers.Cookie = session.cookie;
    if (auth === "bearer") headers.Authorization = `Bearer ${MCP_TOKEN}`;
    return POST(new Request("http://localhost/setup-api/coding-agent/stop", { method: "POST", headers, body: JSON.stringify(body) }));
  };

  it("is 401 without a session, and stops nothing", async () => {
    expect((await stop({ id: "run-k3x9q2ab" }, "none")).status).toBe(401);
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("lets the agent stop a run the agent started", async () => {
    getRun.mockReturnValue({ ...RUN, status: "running", source: "agent" });
    const res = await stop({ id: "run-k3x9q2ab" }, "bearer");
    expect(res.status).toBe(200);
    expect(stopRun).toHaveBeenCalledWith("run-k3x9q2ab");
  });

  it("refuses the agent's bearer for a run the owner started — that one is the owner's to stop", async () => {
    getRun.mockReturnValue({ ...RUN, status: "running", source: "owner" });
    const res = await stop({ id: "run-k3x9q2ab" }, "bearer");
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("lets the owner's browser session stop either kind of run", async () => {
    getRun.mockReturnValue({ ...RUN, status: "running", source: "owner" });
    expect((await stop({ id: "run-k3x9q2ab" }, "cookie")).status).toBe(200);
    expect(stopRun).toHaveBeenCalledWith("run-k3x9q2ab");
  });

  it("needs an id", async () => {
    expect((await stop({})).status).toBe(400);
    expect((await stop({ id: 7 })).status).toBe(400);
  });

  it("stops the run and answers its record", async () => {
    const res = await stop({ id: "run-k3x9q2ab" });
    expect(res.status).toBe(200);
    expect((await res.json()).run.status).toBe("stopped");
    expect(stopRun).toHaveBeenCalledWith("run-k3x9q2ab");
  });

  it("answers a JSON 404 for an unknown run", async () => {
    getRun.mockReturnValue(null);
    const res = await stop({ id: "run-nope0000" });
    expect(res.status).toBe(404);
    expect(typeof (await res.json()).error).toBe("string");
    expect(stopRun).not.toHaveBeenCalled();

    getRun.mockReturnValue({ ...RUN, status: "running" });
    stopRun.mockImplementation(() => { throw new CodingAgentError("not_found", "no such run"); });
    const raced = await stop({ id: "run-k3x9q2ab" });
    expect(raced.status).toBe(404);
    expect((await raced.json()).error).toBe("no such run");
  });
});
