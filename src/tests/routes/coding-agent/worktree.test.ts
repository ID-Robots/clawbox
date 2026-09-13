/**
 * POST /setup-api/coding-agent/worktree — the owner's Remove for a run's own
 * copy of the project.
 *
 * The route is the shared lifecycle factory, so what is pinned here is that it
 * IS that factory (no session, no id, an unknown run, the owner gate by
 * source) plus the one thing this route adds: the library's refusals reach the
 * caller through the one status table, and the record comes back so the card
 * can redraw from the answer rather than from a second poll.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const getRun = vi.hoisted(() => vi.fn());
const removeRunWorktreeFor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, getRun, removeRunWorktreeFor };
});

const WORKTREE = {
  path: "/home/clawbox/Projects/site/.clawbox/worktrees/run-k3x9q2ab",
  branch: "clawbox/run-k3x9q2ab",
  base: "main",
  project: "/home/clawbox/Projects/site",
  removed: false,
};
const RUN = { id: "run-k3x9q2ab", status: "completed", source: "agent", worktree: WORKTREE };
const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";

type Handler = (req: Request) => Promise<Response>;
let post: Handler;
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
  removeRunWorktreeFor.mockResolvedValue({ ...RUN, worktree: { ...WORKTREE, removed: true } });
  CodingAgentError = (await import("@/lib/coding-agent")).CodingAgentError;
  post = (await import("@/app/setup-api/coding-agent/worktree/route")).POST;
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

const call = (body: unknown, auth: "cookie" | "bearer" | "none" = "cookie") =>
  post(new Request("http://localhost/setup-api/coding-agent/worktree", { method: "POST", headers: headers(auth), body: JSON.stringify(body) }));

describe("removing a run's copy of the project", () => {
  it("is 401 without a session, and touches nothing", async () => {
    expect((await call({ runId: RUN.id }, "none")).status).toBe(401);
    expect(removeRunWorktreeFor).not.toHaveBeenCalled();
  });

  it("needs a run id", async () => {
    expect((await call({})).status).toBe(400);
    expect(removeRunWorktreeFor).not.toHaveBeenCalled();
  });

  it("answers a JSON 404 for a run that is not there", async () => {
    getRun.mockReturnValue(null);
    const res = await call({ runId: "run-nope0000" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ kind: "not_found" });
    expect(removeRunWorktreeFor).not.toHaveBeenCalled();
  });

  it("removes it and answers the re-read record", async () => {
    const res = await call({ runId: RUN.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ run: { worktree: { removed: true, branch: "clawbox/run-k3x9q2ab" } } });
    expect(removeRunWorktreeFor).toHaveBeenCalledWith(RUN.id);
  });

  it("takes the `id` alias, like every other run route", async () => {
    expect((await call({ id: RUN.id })).status).toBe(200);
    expect(removeRunWorktreeFor).toHaveBeenCalledWith(RUN.id);
  });

  it("refuses the agent's bearer for a run the OWNER started", async () => {
    getRun.mockReturnValue({ ...RUN, source: "owner" });
    const res = await call({ runId: RUN.id }, "bearer");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
    expect(removeRunWorktreeFor).not.toHaveBeenCalled();
    // The owner's own cookie passes both checks.
    expect((await call({ runId: RUN.id })).status).toBe(200);
  });

  it("maps the library's refusals through the one status table", async () => {
    removeRunWorktreeFor.mockRejectedValueOnce(new CodingAgentError("busy", "A run is still working in that copy of the project."));
    const busy = await call({ runId: RUN.id });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ kind: "busy" });

    removeRunWorktreeFor.mockRejectedValueOnce(new CodingAgentError("invalid", "That run worked in the project folder itself."));
    const invalid = await call({ runId: RUN.id });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ kind: "invalid" });
  });
});
