/**
 * POST /setup-api/coding-agent/run — starting a run.
 *
 * Pins the status vocabulary the MCP layer depends on: 409 (never 403 or 500)
 * while the owner's switch is off or the harness is busy, because
 * mcp/lib/errors.ts maps 409 to CONFLICT / do-not-retry and everything else
 * to "the device needs a restart" or "retry once". Also that the route is
 * gated in-handler (a 401 without a session, no first-boot carve-out), that
 * it answers 202 at once rather than waiting for the run, and that it labels
 * who asked — the owner's cookie or the agent's bearer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const startRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, startRun };
});

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";

let POST: (req: Request) => Promise<Response>;
let CodingAgentError: typeof import("@/lib/coding-agent").CodingAgentError;
let ProviderChoiceError: typeof import("@/lib/coding-agent").ProviderChoiceError;
let MAX_TASK_CHARS: number;
let session: SessionFixture;
let restore: () => void;

const RUN = { id: "run-k3x9q2ab", status: "running", directory: "/home/clawbox/clawbox/data/code-projects/site", projectId: "site" };

function req(init: { auth?: "cookie" | "bearer" | "none"; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = init.auth ?? "cookie";
  if (auth === "cookie") headers.Cookie = session.cookie;
  if (auth === "bearer") headers.Authorization = `Bearer ${MCP_TOKEN}`;
  return new Request("http://localhost/setup-api/coding-agent/run", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(init.body ?? { task: "Add a dark mode toggle", projectId: "site" }),
  });
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  startRun.mockResolvedValue(RUN);
  const lib = await import("@/lib/coding-agent");
  CodingAgentError = lib.CodingAgentError;
  ProviderChoiceError = lib.ProviderChoiceError;
  MAX_TASK_CHARS = lib.MAX_TASK_CHARS;
  const route = await import("@/app/setup-api/coding-agent/run/route");
  POST = route.POST;
});

afterEach(() => {
  session.cleanup();
  restore();
});

describe("the gate", () => {
  it("is 401 without a session, and starts nothing", async () => {
    const res = await POST(req({ auth: "none" }));
    expect(res.status).toBe(401);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("is 401 during the first-boot window too — there is no bootstrap carve-out", async () => {
    session.cleanup();
    session = installSessionFixture({ passwordConfigured: false });
    const res = await POST(req({ auth: "none" }));
    expect(res.status).toBe(401);
  });

  it("accepts the agent's bearer and labels the run as the agent's", async () => {
    const res = await POST(req({ auth: "bearer" }));
    expect(res.status).toBe(202);
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ source: "agent", projectId: "site" }));
  });

  it("labels a run started from the owner's browser as the owner's", async () => {
    const res = await POST(req({ auth: "cookie" }));
    expect(res.status).toBe(202);
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ source: "owner" }));
  });
});

describe("the answer", () => {
  it("is 202 with the run record, at once", async () => {
    const res = await POST(req());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: true, run: RUN });
  });

  it("passes the folder and resume id through untouched", async () => {
    await POST(req({ body: { task: "t", directory: "/home/clawbox/projects/x", resumeRunId: "run-aaaaaaaa" } }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      task: "t", directory: "/home/clawbox/projects/x", resumeRunId: "run-aaaaaaaa", projectId: null,
    }));
  });
});

describe("refusals the agent must be able to tell apart", () => {
  it("answers 409 with the kind while the switch is off", async () => {
    startRun.mockRejectedValue(new CodingAgentError("disabled", "switched off"));
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "switched off", kind: "disabled" });
  });

  it("answers 409 when the harness is not ready or busy", async () => {
    startRun.mockRejectedValueOnce(new CodingAgentError("not_ready", "no token"));
    expect((await POST(req())).status).toBe(409);
    startRun.mockRejectedValueOnce(new CodingAgentError("busy", "one already"));
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("busy");
  });

  it("answers 404 for a missing project and 400 for a bad folder", async () => {
    startRun.mockRejectedValueOnce(new CodingAgentError("not_found", "no project"));
    expect((await POST(req())).status).toBe(404);
    startRun.mockRejectedValueOnce(new CodingAgentError("invalid", "outside home"));
    expect((await POST(req())).status).toBe(400);
  });

  it("rejects an empty task and an oversized one before touching the runner", async () => {
    expect((await POST(req({ body: { task: "   ", projectId: "site" } }))).status).toBe(400);
    expect((await POST(req({ body: { task: "x".repeat(MAX_TASK_CHARS + 1), projectId: "site" } }))).status).toBe(413);
    expect((await POST(req({ raw: "nope" }))).status).toBe(400);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("turns an unexpected failure into a 500 with a plain message", async () => {
    startRun.mockRejectedValue(new Error("spawn EACCES"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("spawn EACCES");
  });
});

/**
 * WHICH ACCOUNT PAYS. The route does not decide — `startRun` does, from the
 * owner's stored default — so what is pinned here is that a caller's choice
 * arrives UNTOUCHED (a route that coerced it would be a second, quieter
 * validator beside src/lib/coding-provider.ts) and that the refusals keep the
 * status codes the MCP layer reads.
 */
describe("provider and model", () => {
  it("passes both through exactly as the caller sent them", async () => {
    await POST(req({ body: { task: "Do the thing", projectId: "site", provider: "anthropic", model: "claude-sonnet-5" } }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-5" }));
  });

  it("passes `undefined` when the caller named neither, so the owner's default stands", async () => {
    // NOT a default invented here: this process would be guessing, and a
    // guess that disagreed with the stored setting would silently move a run
    // onto the wrong bill.
    await POST(req());
    const input = startRun.mock.calls[0][0] as { provider?: unknown; model?: unknown };
    expect(input.provider).toBeUndefined();
    expect(input.model).toBeUndefined();
  });

  it("hands a junk provider to the runner rather than filtering it out", async () => {
    // The refusal belongs to the one validator. Dropping the field here would
    // turn "that provider does not exist" into a run on the default — the
    // caller's mistake, silently honoured as something else.
    await POST(req({ body: { task: "t", projectId: "site", provider: "openai" } }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai" }));
  });

  it("answers 400 when the runner refuses the pair", async () => {
    startRun.mockRejectedValueOnce(new CodingAgentError("invalid", "Unknown provider. Use one of: clawbox-ai, anthropic."));
    const res = await POST(req({ body: { task: "t", projectId: "site", provider: "openai" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/clawbox-ai, anthropic/);
  });

  it("marks a refused pair with a code, so a caller can tell it from a refused folder", async () => {
    // Both are 400 `kind: "invalid"`, and they want opposite advice: the folder
    // refusal says "use another folder", the pair refusal says "leave the
    // folder alone". Without the code the MCP tool gave the folder advice to a
    // caller whose folder was fine.
    startRun.mockRejectedValueOnce(new ProviderChoiceError('ClawBox AI chooses its own model; name a model only with the "anthropic" provider.'));
    const res = await POST(req({ body: { task: "t", projectId: "site", model: "claude-opus-5" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.kind).toBe("invalid");
    expect(body.code).toBe("provider");
  });

  it("leaves a folder refusal without a code", async () => {
    startRun.mockRejectedValueOnce(new CodingAgentError("invalid", "That folder holds credentials."));
    const res = await POST(req({ body: { task: "t", directory: "/home/clawbox/clawbox/data" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).not.toHaveProperty("code");
  });

  it("answers 409 — never 403 or 500 — when that account is not connected", async () => {
    // mcp/lib/errors.ts maps 409 to CONFLICT / do-not-retry. Anything else
    // reads as "the device needs a restart", and the agent retries a refusal
    // only the owner can clear.
    startRun.mockRejectedValueOnce(new CodingAgentError("not_ready", "Your Anthropic account is not connected."));
    const res = await POST(req({ body: { task: "t", projectId: "site", provider: "anthropic" } }));
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("not_ready");
  });
});
