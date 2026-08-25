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

const getRun = vi.hoisted(() => vi.fn());
const listRuns = vi.hoisted(() => vi.fn());
const waitForRun = vi.hoisted(() => vi.fn());
const stopRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, getRun, listRuns, waitForRun, stopRun };
});

const RUN = { id: "run-k3x9q2ab", status: "completed", summary: "done" };

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let MAX_WAIT_MS: number;
let CodingAgentError: typeof import("@/lib/coding-agent").CodingAgentError;
let session: SessionFixture;

beforeEach(async () => {
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
  GET = (await import("@/app/setup-api/coding-agent/runs/route")).GET;
  POST = (await import("@/app/setup-api/coding-agent/stop/route")).POST;
});

afterEach(() => session.cleanup());

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

describe("POST stop", () => {
  const stop = (body: unknown, auth = true) =>
    POST(new Request("http://localhost/setup-api/coding-agent/stop", {
      method: "POST",
      headers: auth ? { "Content-Type": "application/json", Cookie: session.cookie } : { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

  it("is 401 without a session, and stops nothing", async () => {
    expect((await stop({ id: "run-k3x9q2ab" }, false)).status).toBe(401);
    expect(stopRun).not.toHaveBeenCalled();
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
    stopRun.mockImplementation(() => { throw new CodingAgentError("not_found", "no such run"); });
    const res = await stop({ id: "run-nope0000" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("no such run");
  });
});
