/**
 * /setup-api/coding-agent/vercel and /vercel/promote.
 *
 * The property under test on the first route: **the agent cannot decide where
 * this box deploys.** Middleware admits the MCP bearer to every /setup-api/*
 * path and the agent holds that bearer, so the route refuses it in-handler with
 * the real cookie verifier, and the two writes carry a same-origin check on top.
 *
 * The property under test on the second: **nothing but the owner's own click
 * can put a build in front of a project's users.** Owner cookie, same origin,
 * an explicit confirmation in the body, and the deployment id checked against
 * the record rather than taken as the thing to promote — so a watcher that
 * moved on between the page load and the click cannot have the click land on a
 * build the owner never saw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

const listRuns = vi.hoisted(() => vi.fn());
const recordDeployPromotion = vi.hoisted(() => vi.fn());
const resolveProjectScope = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  listRuns,
  recordDeployPromotion,
  resolveProjectScope,
}));

const readVercelLink = vi.hoisted(() => vi.fn());
const setVercelLink = vi.hoisted(() => vi.fn());
const deleteVercelLink = vi.hoisted(() => vi.fn());
const checkVercelReadiness = vi.hoisted(() => vi.fn());
const resolveVercelAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel-link")>()),
  readVercelLink,
  setVercelLink,
  deleteVercelLink,
  checkVercelReadiness,
  resolveVercelAuth,
}));

const promoteDeployment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel")>()),
  promoteDeployment,
}));

/**
 * The error class, taken from the registry the ROUTE was loaded into.
 *
 * A top-level import would be the class from the module graph that existed
 * before `vi.resetModules()`, and the route's `instanceof` would then miss it —
 * so the test would pass or fail on module identity rather than on the route's
 * behaviour. Re-imported in `beforeEach`, after the reset.
 */
let VercelLinkError: typeof import("@/lib/vercel-state").VercelLinkError;

const SESSION_SECRET = "a".repeat(64);
/** A bearer that really verifies, so "the agent" in these tests is the agent. */
const MCP_TOKEN = "c".repeat(48);
const TOKEN = "vrc_live_Xk29fLm4Qp7sT1wZ8bN3dH6jR0aC5yE";

const LINK = {
  projectId: "prj_acme",
  teamId: null,
  tokenSecretName: "VERCEL_TOKEN",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const READINESS = {
  linked: true, projectId: "prj_acme", teamId: null, tokenSecretName: "VERCEL_TOKEN",
  tokenPresent: true, tokenValid: true, username: "acme",
  projectResolves: true, projectName: "acme-app", ready: true, problems: [], code: null,
};

const RUN = {
  id: "run-k3x9q2ab",
  projectId: null,
  directory: "/home/clawbox/projects/shop",
  vercel: {
    phase: "ready", projectId: "prj_acme", teamId: null, deploymentId: "dpl_1",
    readyState: "ready", url: "https://shop-abc.vercel.app", inspectorUrl: null,
    target: "preview", branch: "clawbox/run-k3x9q2ab", sha: "abc123",
    startedAt: 1, endedAt: 2, detail: null, fixRunId: null, feedbackSent: false, promotion: null,
  },
};

let route: typeof import("@/app/setup-api/coding-agent/vercel/route");
let promote: typeof import("@/app/setup-api/coding-agent/vercel/promote/route");
let restore: () => void;

function ownerCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0)}`;
}

function request(init: {
  method?: string;
  cookie?: string;
  bearer?: string;
  body?: unknown;
  query?: string;
  origin?: string | null;
  path?: string;
  length?: string;
} = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "clawbox.local" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.origin !== null) headers.origin = init.origin ?? "http://clawbox.local";
  if (init.length) headers["content-length"] = init.length;
  const method = init.method ?? "GET";
  const path = init.path ?? "/setup-api/coding-agent/vercel";
  return new Request(`http://clawbox.local${path}${init.query ?? "?directory=/home/clawbox/projects/shop"}`, {
    method,
    headers,
    ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(init.body ?? {}) }),
  });
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  resolveProjectScope.mockResolvedValue("shop");
  readVercelLink.mockResolvedValue(LINK);
  setVercelLink.mockResolvedValue(LINK);
  deleteVercelLink.mockResolvedValue(true);
  checkVercelReadiness.mockResolvedValue(READINESS);
  resolveVercelAuth.mockResolvedValue({ token: TOKEN, teamId: null });
  promoteDeployment.mockResolvedValue({ ok: true, promoted: true });
  listRuns.mockReturnValue([RUN]);
  recordDeployPromotion.mockImplementation(() => ({ ...RUN, vercel: { ...RUN.vercel, promotion: { deploymentId: "dpl_1", url: RUN.vercel.url, at: 5, by: "owner" } } }));
  ({ VercelLinkError } = await import("@/lib/vercel-state"));
  route = await import("@/app/setup-api/coding-agent/vercel/route");
  promote = await import("@/app/setup-api/coding-agent/vercel/promote/route");
});

afterEach(() => restore());

describe("who may read and change the link", () => {
  it("refuses the MCP bearer on every verb — the agent must not choose where this box deploys", async () => {
    for (const [name, call] of [
      ["GET", () => route.GET(request({ bearer: MCP_TOKEN }))],
      ["POST", () => route.POST(request({ method: "POST", bearer: MCP_TOKEN, body: { vercelProjectId: "prj_evil", tokenSecretName: "VERCEL_TOKEN" } }))],
      ["DELETE", () => route.DELETE(request({ method: "DELETE", bearer: MCP_TOKEN }))],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect((await res.json()).kind, name).toBe("owner_only");
    }
    expect(setVercelLink).not.toHaveBeenCalled();
    expect(deleteVercelLink).not.toHaveBeenCalled();
    // Not even the read: which projects deploy where, and to whose account, is
    // the owner's.
    expect(readVercelLink).not.toHaveBeenCalled();
  });

  it("refuses a forged cookie and a bare request identically", async () => {
    const forged = `clawbox_session=${createSessionCookie(3600, "b".repeat(64), 0)}`;
    expect((await route.GET(request({ cookie: forged }))).status).toBe(403);
    expect((await route.GET(request())).status).toBe(403);
  });

  it("refuses a WRITE from another origin, even with the owner's own cookie", async () => {
    for (const [name, call] of [
      ["POST", () => route.POST(request({ method: "POST", cookie: ownerCookie(), origin: "http://evil.example", body: { vercelProjectId: "prj_evil", tokenSecretName: "VERCEL_TOKEN" } }))],
      ["DELETE", () => route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), origin: "http://evil.example" }))],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect((await res.json()).kind, name).toBe("cross_origin");
    }
    expect(setVercelLink).not.toHaveBeenCalled();
    expect(deleteVercelLink).not.toHaveBeenCalled();
  });

  it("lets the owner read from their own page", async () => {
    const res = await route.GET(request({ cookie: ownerCookie() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scope: "shop", link: LINK, readiness: null });
  });
});

describe("reading the link", () => {
  it("does NOT call Vercel unless asked — a project page must not cost two upstream calls", async () => {
    await route.GET(request({ cookie: ownerCookie() }));
    expect(checkVercelReadiness).not.toHaveBeenCalled();
  });

  it("checks when asked", async () => {
    const res = await route.GET(request({ cookie: ownerCookie(), query: "?directory=/home/clawbox/projects/shop&check=1" }));
    expect(await res.json()).toMatchObject({ readiness: READINESS });
    expect(checkVercelReadiness).toHaveBeenCalledWith("shop");
  });

  it("answers `no_project` for a folder that is not one of this box's projects", async () => {
    resolveProjectScope.mockResolvedValue(null);
    const res = await route.GET(request({ cookie: ownerCookie() }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("no_project");
  });
});

describe("attaching", () => {
  it("saves under the resolved scope and answers the box's own re-read", async () => {
    const res = await route.POST(request({
      method: "POST",
      cookie: ownerCookie(),
      body: { directory: "/home/clawbox/projects/shop", vercelProjectId: "prj_acme", teamId: "team_x", tokenSecretName: "VERCEL_TOKEN" },
    }));
    expect(res.status).toBe(200);
    expect(setVercelLink).toHaveBeenCalledWith({
      scope: "shop", projectId: "prj_acme", teamId: "team_x", tokenSecretName: "VERCEL_TOKEN",
    });
    // Checked against Vercel on the way back, so the owner learns their token
    // is wrong now rather than when a build silently never appears.
    expect(await res.json()).toMatchObject({ link: LINK, readiness: READINESS });
  });

  it("takes the VERCEL project from `vercelProjectId`, never from `projectId`", async () => {
    // `projectId` here is the CODING-AGENT project; one name for two ids is how
    // a link ends up attached to itself.
    await route.POST(request({
      method: "POST",
      cookie: ownerCookie(),
      body: { projectId: "shop", vercelProjectId: "prj_acme", tokenSecretName: "VERCEL_TOKEN" },
    }));
    expect(setVercelLink.mock.calls[0][0].projectId).toBe("prj_acme");
    expect(resolveProjectScope).toHaveBeenCalledWith({ projectId: "shop", directory: null });
  });

  it("relays the store's refusal code so the card can word it in the owner's language", async () => {
    setVercelLink.mockRejectedValue(new VercelLinkError("invalid_project", "that is not a project id"));
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { vercelProjectId: "../etc", tokenSecretName: "VERCEL_TOKEN" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_project" });
  });

  it("refuses a body that announces more than one link can be, without reading it", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), length: "900000", body: { vercelProjectId: "prj_a", tokenSecretName: "X" } }));
    expect(res.status).toBe(413);
    expect(setVercelLink).not.toHaveBeenCalled();
  });

  it("refuses a body that is not an object", async () => {
    const bad = new Request("http://clawbox.local/setup-api/coding-agent/vercel", {
      method: "POST",
      headers: { "content-type": "application/json", host: "clawbox.local", origin: "http://clawbox.local", cookie: ownerCookie() },
      body: "[1,2,3]",
    });
    expect((await route.POST(bad)).status).toBe(400);
  });
});

describe("detaching", () => {
  it("removes the link and says so", async () => {
    const res = await route.DELETE(request({ method: "DELETE", cookie: ownerCookie() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scope: "shop", link: null, readiness: null, removed: true });
    expect(deleteVercelLink).toHaveBeenCalledWith("shop");
  });
});

describe("promoting to production", () => {
  const body = { runId: RUN.id, deploymentId: "dpl_1", confirm: true };

  it("refuses the MCP bearer — there is no tool, and there must be no route either", async () => {
    const res = await promote.POST(request({ method: "POST", bearer: MCP_TOKEN, body, path: "/setup-api/coding-agent/vercel/promote" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(promoteDeployment).not.toHaveBeenCalled();
  });

  it("refuses another origin, even with the owner's cookie", async () => {
    const res = await promote.POST(request({ method: "POST", cookie: ownerCookie(), origin: "http://evil.example", body, path: "/setup-api/coding-agent/vercel/promote" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(promoteDeployment).not.toHaveBeenCalled();
  });

  it("refuses without the explicit confirmation", async () => {
    for (const confirm of [undefined, false, "true", 1]) {
      const res = await promote.POST(request({
        method: "POST", cookie: ownerCookie(), path: "/setup-api/coding-agent/vercel/promote",
        body: { ...body, confirm },
      }));
      expect(res.status, String(confirm)).toBe(400);
      expect((await res.json()).code, String(confirm)).toBe("not_confirmed");
    }
    expect(promoteDeployment).not.toHaveBeenCalled();
  });

  it("refuses a deployment that is NOT the one on the record — the owner agreed to what they were shown", async () => {
    const res = await promote.POST(request({
      method: "POST", cookie: ownerCookie(), path: "/setup-api/coding-agent/vercel/promote",
      body: { ...body, deploymentId: "dpl_something_else" },
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("stale_deployment");
    expect(promoteDeployment).not.toHaveBeenCalled();
  });

  it("refuses a build that has not finished", async () => {
    listRuns.mockReturnValue([{ ...RUN, vercel: { ...RUN.vercel, phase: "building" } }]);
    const res = await promote.POST(request({ method: "POST", cookie: ownerCookie(), path: "/setup-api/coding-agent/vercel/promote", body }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_ready");
    expect(promoteDeployment).not.toHaveBeenCalled();
  });

  it("refuses a run with no deployment, and an unknown run", async () => {
    listRuns.mockReturnValue([{ ...RUN, vercel: null }]);
    expect((await promote.POST(request({ method: "POST", cookie: ownerCookie(), path: "/setup-api/coding-agent/vercel/promote", body }))).status).toBe(409);
    listRuns.mockReturnValue([]);
    expect((await promote.POST(request({ method: "POST", cookie: ownerCookie(), path: "/setup-api/coding-agent/vercel/promote", body }))).status).toBe(404);
    expect(promoteDeployment).not.toHaveBeenCalled();
  });

  it("refuses a link that has since been taken away", async () => {
    readVercelLink.mockResolvedValue(null);
    const res = await promote.POST(request({ method: "POST", cookie: ownerCookie(), path: "/setup-api/coding-agent/vercel/promote", body }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_linked");
    expect(promoteDeployment).not.toHaveBeenCalled();
  });

  it("promotes when every gate is open, and records WHO and WHEN", async () => {
    const res = await promote.POST(request({ method: "POST", cookie: ownerCookie(), path: "/setup-api/coding-agent/vercel/promote", body }));
    expect(res.status).toBe(200);
    expect(promoteDeployment).toHaveBeenCalledWith({ token: TOKEN, teamId: null }, "prj_acme", "dpl_1");
    const recorded = recordDeployPromotion.mock.calls[0];
    expect(recorded[0]).toBe(RUN.id);
    expect(recorded[1]).toMatchObject({ deploymentId: "dpl_1", url: RUN.vercel.url, by: "owner" });
    expect(typeof recorded[1].at).toBe("number");
    expect((await res.json()).vercel.promotion).toMatchObject({ by: "owner" });
  });

  it("does NOT record a promotion Vercel refused", async () => {
    promoteDeployment.mockResolvedValue({ ok: false, kind: "auth", detail: "insufficient scope", status: 403 });
    const res = await promote.POST(request({ method: "POST", cookie: ownerCookie(), path: "/setup-api/coding-agent/vercel/promote", body }));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("auth");
    expect(recordDeployPromotion).not.toHaveBeenCalled();
  });
});
