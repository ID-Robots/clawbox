/**
 * /setup-api/coding-agent/pipeline.
 *
 * A delivery pipeline is mostly something nobody touches: it starts with the
 * run and drives itself. This route is the two moments a person is still in it,
 * so what it has to get right is WHO.
 *
 *  1. **READING is open to the assistant.** It is how a tool call answers "how
 *     is it going", it changes nothing, and every word in it was written by
 *     this box.
 *  2. **THE PRODUCTION BUTTON CARRIES THE WHOLE FENCE**: the owner's cookie,
 *     this box's own origin and an explicit `confirm: true`. Letting the bearer
 *     press it would make the per-project production switch decorative.
 *  3. **THE PER-PROJECT DEFAULT IS THE OWNER'S ALONE** — it is a standing
 *     consent for unattended runs to deploy, so a tool that could turn it on
 *     would make the owner's answer temporary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

const getRun = vi.hoisted(() => vi.fn());
const approvePipelineProduction = vi.hoisted(() => vi.fn());
const stopRunPipeline = vi.hoisted(() => vi.fn());
const resolveProjectScope = vi.hoisted(() => vi.fn());
const resolveWorkingDirectory = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  getRun,
  approvePipelineProduction,
  stopRunPipeline,
  resolveProjectScope,
  resolveWorkingDirectory,
}));

const readPipelineDefault = vi.hoisted(() => vi.fn());
const setPipelineDefault = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-pipeline-store", () => ({ readPipelineDefault, setPipelineDefault }));

const SESSION_SECRET = "a".repeat(64);
const MCP_TOKEN = "c".repeat(48);

const PIPELINE = {
  stage: "deploy_production",
  status: "waiting_owner",
  startedAt: 1,
  endedAt: null,
  round: 0,
  maxRounds: 2,
  deadlineAt: 2,
  verify: { path: "/", expect: ["Invoice"] },
  production: true,
  failure: null,
  productionApprovedAt: null,
  lastVerification: null,
  steps: [],
};

let route: typeof import("@/app/setup-api/coding-agent/pipeline/route");
let restore: () => void;

function ownerCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0)}`;
}

function request(init: {
  method?: string; cookie?: string; bearer?: string; body?: unknown; query?: string; origin?: string | null;
} = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "clawbox.local" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.origin !== null) headers.origin = init.origin ?? "http://clawbox.local";
  const method = init.method ?? "GET";
  return new Request(
    `http://clawbox.local/setup-api/coding-agent/pipeline${init.query ?? "?runId=run-abcd1234"}`,
    { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(init.body ?? {}) }) },
  );
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  getRun.mockReturnValue({ id: "run-abcd1234", status: "completed", task: "build an invoice page", pipeline: PIPELINE });
  approvePipelineProduction.mockResolvedValue({ id: "run-abcd1234", pipeline: { ...PIPELINE, status: "running" } });
  stopRunPipeline.mockReturnValue({ id: "run-abcd1234", pipeline: { ...PIPELINE, status: "stopped" } });
  resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/projects/shop", projectId: null });
  resolveProjectScope.mockResolvedValue("shop");
  readPipelineDefault.mockResolvedValue(false);
  setPipelineDefault.mockResolvedValue(true);
  route = await import("@/app/setup-api/coding-agent/pipeline/route");
});

afterEach(() => restore());

describe("reading one", () => {
  it("answers the owner", async () => {
    const res = await route.GET(request({ cookie: ownerCookie() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ run: { id: "run-abcd1234" }, pipeline: { status: "waiting_owner" } });
  });

  it("answers the ASSISTANT too — it is how a tool call says how the flow is going", async () => {
    const res = await route.GET(request({ bearer: MCP_TOKEN, origin: null }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pipeline: { stage: "deploy_production" } });
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await route.GET(request({}));
    expect(res.status).toBe(401);
  });

  it("is 404 for a run this box does not have", async () => {
    getRun.mockReturnValue(null);
    const res = await route.GET(request({ cookie: ownerCookie() }));
    expect(res.status).toBe(404);
  });

  it("answers the per-project default when no run is named", async () => {
    readPipelineDefault.mockResolvedValue(true);
    const res = await route.GET(request({ cookie: ownerCookie(), query: "?projectId=shop" }));
    expect(await res.json()).toEqual({ scope: "shop", enabled: true });
  });

  it("refuses a folder that is not one of this box's projects", async () => {
    resolveProjectScope.mockResolvedValue(null);
    const res = await route.GET(request({ cookie: ownerCookie(), query: "?directory=/tmp/elsewhere" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("no_project");
  });
});

describe("the production button", () => {
  it("is pressed by the owner, from this box's own pages, with the gesture echoed", async () => {
    const res = await route.POST(request({
      method: "POST", cookie: ownerCookie(),
      body: { runId: "run-abcd1234", action: "approve_production", confirm: true },
    }));
    expect(res.status).toBe(200);
    expect(approvePipelineProduction).toHaveBeenCalledWith("run-abcd1234");
  });

  it("is refused to the MCP bearer — the switch would be decorative otherwise", async () => {
    const res = await route.POST(request({
      method: "POST", bearer: MCP_TOKEN, origin: null,
      body: { runId: "run-abcd1234", action: "approve_production", confirm: true },
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(approvePipelineProduction).not.toHaveBeenCalled();
  });

  it("is refused from another page in the owner's browser", async () => {
    const res = await route.POST(request({
      method: "POST", cookie: ownerCookie(), origin: "https://evil.example",
      body: { runId: "run-abcd1234", action: "approve_production", confirm: true },
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(approvePipelineProduction).not.toHaveBeenCalled();
  });

  it("is refused without the confirmation the card's question stands for", async () => {
    const res = await route.POST(request({
      method: "POST", cookie: ownerCookie(),
      body: { runId: "run-abcd1234", action: "approve_production" },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("not_confirmed");
    expect(approvePipelineProduction).not.toHaveBeenCalled();
  });

  it("carries the device's own refusal through with its status", async () => {
    const { CodingAgentError } = await import("@/lib/coding-agent");
    approvePipelineProduction.mockRejectedValue(new CodingAgentError("invalid", "That pipeline is not waiting for you: it is complete."));
    const res = await route.POST(request({
      method: "POST", cookie: ownerCookie(),
      body: { runId: "run-abcd1234", action: "approve_production", confirm: true },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not waiting for you");
  });
});

describe("stopping one", () => {
  it("is the owner's, and needs no confirmation — it does less, not more", async () => {
    const res = await route.POST(request({
      method: "POST", cookie: ownerCookie(), body: { runId: "run-abcd1234", action: "stop" },
    }));
    expect(res.status).toBe(200);
    expect(stopRunPipeline).toHaveBeenCalledWith("run-abcd1234");
  });

  it("refuses an action this route does not have", async () => {
    const res = await route.POST(request({
      method: "POST", cookie: ownerCookie(), body: { runId: "run-abcd1234", action: "deploy_everything" },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_action");
  });

  it("refuses a body with no run in it", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { action: "stop" } }));
    expect(res.status).toBe(400);
    expect(stopRunPipeline).not.toHaveBeenCalled();
  });
});

describe("the per-project default", () => {
  it("is the owner's to set, from this box's own pages", async () => {
    readPipelineDefault.mockResolvedValue(true);
    const res = await route.PUT(request({
      method: "PUT", cookie: ownerCookie(), body: { projectId: "shop", enabled: true },
    }));
    expect(res.status).toBe(200);
    expect(setPipelineDefault).toHaveBeenCalledWith("shop", true);
    expect(await res.json()).toEqual({ scope: "shop", enabled: true });
  });

  it("cannot be turned on by the assistant", async () => {
    const res = await route.PUT(request({
      method: "PUT", bearer: MCP_TOKEN, origin: null, body: { projectId: "shop", enabled: true },
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(setPipelineDefault).not.toHaveBeenCalled();
  });

  it("cannot be turned on by another page in the owner's browser", async () => {
    const res = await route.PUT(request({
      method: "PUT", cookie: ownerCookie(), origin: "https://evil.example", body: { projectId: "shop", enabled: true },
    }));
    expect(res.status).toBe(403);
    expect(setPipelineDefault).not.toHaveBeenCalled();
  });

  it("is a switch, not a string", async () => {
    const res = await route.PUT(request({
      method: "PUT", cookie: ownerCookie(), body: { projectId: "shop", enabled: "yes" },
    }));
    expect(res.status).toBe(400);
    expect(setPipelineDefault).not.toHaveBeenCalled();
  });
});
