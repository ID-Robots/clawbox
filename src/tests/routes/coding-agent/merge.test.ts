/**
 * /setup-api/coding-agent/merge — the owner's **Bring the work home** for a
 * settled run whose branch the settle could not merge.
 *
 * The session check, the `id` alias and the 404 are the shared lifecycle
 * factory's. What this route adds, and what is pinned here:
 *
 *   - it is the OWNER's, for every run. The factory refuses the MCP bearer
 *     only on a run the owner started; this writes the owner's own project
 *     folder, so the bearer is refused on an agent-started run too.
 *   - and OUR PAGE only, because a cookie travels on a `text/plain` form from
 *     anywhere on the web.
 *   - a blocker that is still there is a 409 with a stable `code` — one per
 *     reason, so the card can say what to do about it in the owner's language
 *     — and the re-read record travels with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const getRun = vi.hoisted(() => vi.fn());
const bringRunWorkHome = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, getRun, bringRunWorkHome };
});

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
const WORKTREE = {
  path: "/home/clawbox/Projects/site/.clawbox/worktrees/run-k3x9q2ab",
  branch: "clawbox/run-k3x9q2ab",
  base: "main",
  project: "/home/clawbox/Projects/site",
  removed: false,
  branchRemoved: false,
  result: null,
};
const AGENT_RUN = { id: "run-k3x9q2ab", status: "completed", source: "agent", worktree: WORKTREE };
const OWNER_RUN = { ...AGENT_RUN, source: "owner" };

type Handler = (req: Request) => Promise<Response>;
let POST: Handler;
let CodingAgentError: typeof import("@/lib/coding-agent").CodingAgentError;
let session: SessionFixture;
let restore: () => void;

/** The success the library reports when the merge landed. */
const MERGED = {
  ok: true as const,
  merged: true,
  base: "main",
  commit: "9f1c0ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
  run: { ...AGENT_RUN, worktree: { ...WORKTREE, removed: true, result: { kind: "merged", reason: null, detail: null, base: "main", commit: "9f1c0ab3d4e5f60718293a4b5c6d7e8f90a1b2c3" } } },
};

/** The refusal it reports when the blocker is still in place. */
const blocked = (reason: string, detail: string) => ({
  ok: false as const,
  reason,
  detail,
  run: { ...AGENT_RUN, worktree: { ...WORKTREE, result: { kind: "unmerged", reason, detail, base: null, commit: null } } },
});

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  getRun.mockReturnValue(AGENT_RUN);
  bringRunWorkHome.mockResolvedValue(MERGED);
  CodingAgentError = (await import("@/lib/coding-agent")).CodingAgentError;
  POST = (await import("@/app/setup-api/coding-agent/merge/route")).POST;
});

afterEach(() => {
  session.cleanup();
  restore();
});

function post(body: unknown, auth: "cookie" | "bearer" | "none" = "cookie", origin?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", host: "localhost" };
  if (auth === "cookie") headers.Cookie = session.cookie;
  if (auth === "bearer") headers.Authorization = `Bearer ${MCP_TOKEN}`;
  if (origin !== undefined) headers.Origin = origin;
  return POST(new Request("http://localhost/setup-api/coding-agent/merge", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

describe("the gate", () => {
  it("is 401 with no session, and merges nothing", async () => {
    expect((await post({ runId: AGENT_RUN.id }, "none")).status).toBe(401);
    expect(bringRunWorkHome).not.toHaveBeenCalled();
  });

  it("needs a run id", async () => {
    expect((await post({})).status).toBe(400);
    expect(bringRunWorkHome).not.toHaveBeenCalled();
  });

  it("takes the `id` alias the other run routes take", async () => {
    expect((await post({ id: AGENT_RUN.id })).status).toBe(200);
    expect(bringRunWorkHome).toHaveBeenCalledWith(AGENT_RUN.id);
  });

  it("is a JSON 404 for a run this box does not have", async () => {
    getRun.mockReturnValue(null);
    const res = await post({ runId: "run-nope0000" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ kind: "not_found" });
    expect(bringRunWorkHome).not.toHaveBeenCalled();
  });

  it("refuses the MCP bearer even for a run the AGENT started", async () => {
    // The factory alone would let this through: the run is the agent's. This
    // route writes the owner's project folder, so the cookie is required for
    // every run, agent-started included.
    const res = await post({ runId: AGENT_RUN.id }, "bearer");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
    expect(bringRunWorkHome).not.toHaveBeenCalled();
  });

  it("refuses the bearer on the owner's own run at the factory's gate", async () => {
    getRun.mockReturnValue(OWNER_RUN);
    const res = await post({ runId: OWNER_RUN.id }, "bearer");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
    expect(bringRunWorkHome).not.toHaveBeenCalled();
  });

  it("refuses another site's page even with the owner's cookie on it", async () => {
    const res = await post({ runId: AGENT_RUN.id }, "cookie", "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_origin" });
    expect(bringRunWorkHome).not.toHaveBeenCalled();
  });

  it("lets this box's own page through", async () => {
    expect((await post({ runId: AGENT_RUN.id }, "cookie", "http://localhost")).status).toBe(200);
    expect(bringRunWorkHome).toHaveBeenCalledWith(AGENT_RUN.id);
  });
});

describe("bringing the work home", () => {
  it("answers where the work went, and the re-read record", async () => {
    const res = await post({ runId: AGENT_RUN.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      merged: true,
      base: "main",
      commit: MERGED.commit,
      run: { worktree: { removed: true, result: { kind: "merged", base: "main" } } },
    });
  });

  it.each([
    ["dirty", "the project folder has uncommitted changes of its own"],
    ["not_on_base", "the project is on release, not on main"],
    ["conflict", "it conflicts with the project's own changes"],
  ])("answers 409 and the %s code when that blocker is still there", async (reason, detail) => {
    bringRunWorkHome.mockResolvedValueOnce(blocked(reason, detail));
    const res = await post({ runId: AGENT_RUN.id });
    expect(res.status).toBe(409);
    const body = await res.json();
    // The code is what the card words in the owner's language; the sentence
    // beside it is the box's own, for a surface with no catalogue.
    expect(body).toMatchObject({ code: reason, kind: "unmerged" });
    expect(String(body.error)).toContain(detail);
    // The record travels with the refusal, so the card redraws from the box.
    expect(body.run.worktree.result).toMatchObject({ kind: "unmerged", reason });
  });

  it("maps the library's own refusals through the one status table", async () => {
    bringRunWorkHome.mockRejectedValueOnce(new CodingAgentError("busy", "A run is still working in that copy of the project."));
    const busy = await post({ runId: AGENT_RUN.id });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ kind: "busy" });

    bringRunWorkHome.mockRejectedValueOnce(new CodingAgentError("invalid", "That run worked in the project folder itself."));
    const invalid = await post({ runId: AGENT_RUN.id });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ kind: "invalid" });
  });
});
