/**
 * /setup-api/coding-agent/vercel/deploy.
 *
 * The properties under test:
 *
 *  1. **A PREVIEW IS THE AGENT'S TO MAKE; PRODUCTION IS NOT.** The MCP bearer
 *     deploys a preview and is refused production outright — unless the owner
 *     has turned `coding_vercel_auto_production` on for THAT project, which is
 *     the whole of the automatic flow.
 *  2. **THE OWNER'S PRODUCTION DEPLOY CARRIES THE PROMOTE ROUTE'S FENCE**:
 *     cookie, this box's own origin, and an explicit `confirm: true`.
 *  3. **NO CALLER NAMES A VERCEL PROJECT.** Every verb takes a coding project
 *     and the device resolves the owner's link, so a prompt-injected agent
 *     cannot deploy to an account of its choosing.
 *  4. **THE SWITCH IS THE OWNER'S ALONE.** The bearer cannot turn it on, and
 *     neither can another page in the owner's browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

const listRuns = vi.hoisted(() => vi.fn());
const recordManualDeployment = vi.hoisted(() => vi.fn());
const resolveProjectScope = vi.hoisted(() => vi.fn());
const resolveWorkingDirectory = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  listRuns,
  recordManualDeployment,
  resolveProjectScope,
  resolveWorkingDirectory,
}));

const deployProject = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel-deploy", () => ({ deployProject }));

const readVercelLink = vi.hoisted(() => vi.fn());
const resolveVercelAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel-link")>()),
  readVercelLink,
  resolveVercelAuth,
}));

const readDeployment = vi.hoisted(() => vi.fn());
const readProject = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel")>()),
  readDeployment,
  readProject,
}));

const reserveProductionSlot = vi.hoisted(() => vi.fn());
const releaseProductionSlot = vi.hoisted(() => vi.fn());
const readAutoProduction = vi.hoisted(() => vi.fn());
const setAutoProduction = vi.hoisted(() => vi.fn());
const readProjectDeploy = vi.hoisted(() => vi.fn());
const recordProjectDeploy = vi.hoisted(() => vi.fn());
const updateProjectDeploy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel-deploy-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel-deploy-store")>()),
  readAutoProduction,
  setAutoProduction,
  readProjectDeploy,
  recordProjectDeploy,
  updateProjectDeploy,
  reserveProductionSlot,
  releaseProductionSlot,
}));

const SESSION_SECRET = "a".repeat(64);
const MCP_TOKEN = "c".repeat(48);
const TOKEN = "vrc_live_Xk29fLm4Qp7sT1wZ8bN3dH6jR0aC5yE"; // gitleaks:allow

const LINK = { projectId: "prj_acme", teamId: null, tokenSecretName: "VERCEL_TOKEN", createdAt: 1, updatedAt: 1 };

const DEPLOYMENT = {
  id: "dpl_new", readyState: "queued" as const, url: "https://shop-abc.vercel.app",
  inspectorUrl: null, target: "preview", branch: null, sha: null, createdAt: null, errorMessage: null,
};

const MADE = {
  ok: true as const, deployment: DEPLOYMENT, projectId: "prj_acme", teamId: null,
  source: "files" as const, gitRef: null, fileCount: 4, usedGit: true, skipped: [],
};

let route: typeof import("@/app/setup-api/coding-agent/vercel/deploy/route");
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
    `http://clawbox.local/setup-api/coding-agent/vercel/deploy${init.query ?? "?directory=/home/clawbox/projects/shop"}`,
    { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(init.body ?? {}) }) },
  );
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  resolveWorkingDirectory.mockResolvedValue({ directory: "/home/clawbox/projects/shop", projectId: null });
  resolveProjectScope.mockResolvedValue("shop");
  readVercelLink.mockResolvedValue(LINK);
  resolveVercelAuth.mockResolvedValue({ token: TOKEN, teamId: null });
  readProject.mockResolvedValue({ ok: true, id: "prj_acme", name: "shop", gitLink: null, productionDomain: "shop.example.com" });
  readDeployment.mockResolvedValue({ ok: true, deployment: DEPLOYMENT });
  deployProject.mockResolvedValue(MADE);
  readAutoProduction.mockResolvedValue(false);
  reserveProductionSlot.mockResolvedValue({ ok: true, at: 1_000 });
  releaseProductionSlot.mockResolvedValue(undefined);
  setAutoProduction.mockResolvedValue(true);
  readProjectDeploy.mockResolvedValue(null);
  recordProjectDeploy.mockImplementation(async (_scope: string, latest: unknown) => ({ latest, productionAt: [] }));
  updateProjectDeploy.mockResolvedValue(null);
  listRuns.mockReturnValue([{ id: "run-1", projectId: null, directory: "/home/clawbox/projects/shop", vercel: null, pr: null }]);
  recordManualDeployment.mockReturnValue(null);
  route = await import("@/app/setup-api/coding-agent/vercel/deploy/route");
});

afterEach(() => restore());

describe("a preview", () => {
  it("is the owner's to press", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "preview" } }));
    expect(res.status).toBe(200);
    expect(deployProject).toHaveBeenCalledWith(expect.objectContaining({ scope: "shop", target: "preview" }));
    expect(recordProjectDeploy.mock.calls[0][1]).toMatchObject({ by: "owner", target: "preview" });
  });

  it("is ALSO the agent's — a preview is a throwaway address nobody has", async () => {
    const res = await route.POST(request({ method: "POST", bearer: MCP_TOKEN, origin: null, body: { target: "preview" } }));
    expect(res.status).toBe(200);
    expect(recordProjectDeploy.mock.calls[0][1]).toMatchObject({ by: "agent" });
  });
});

describe("production", () => {
  it("needs the owner's explicit confirmation", async () => {
    for (const confirm of [undefined, false, "true", 1]) {
      vi.clearAllMocks();
      deployProject.mockResolvedValue(MADE);
      const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "production", confirm } }));
      expect(res.status, String(confirm)).toBe(400);
      expect((await res.json()).code, String(confirm)).toBe("not_confirmed");
      expect(deployProject).not.toHaveBeenCalled();
    }
  });

  it("refuses the owner's own cookie from another origin", async () => {
    const res = await route.POST(request({
      method: "POST", cookie: ownerCookie(), origin: "http://evil.example", body: { target: "production", confirm: true },
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(deployProject).not.toHaveBeenCalled();
  });

  it("goes through when the owner confirmed it from their own page", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "production", confirm: true } }));
    expect(res.status).toBe(200);
    expect(deployProject).toHaveBeenCalledWith(expect.objectContaining({ target: "production" }));
  });

  it("is refused for the AGENT while the owner's switch is off, and says where to turn it on", async () => {
    const res = await route.POST(request({ method: "POST", bearer: MCP_TOKEN, origin: null, body: { target: "production" } }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("auto_production_off");
    expect(body.error).toMatch(/Coding Agent/);
    expect(deployProject).not.toHaveBeenCalled();
  });

  it("is the agent's once the owner has turned it on for THAT project", async () => {
    readAutoProduction.mockResolvedValue(true);
    const res = await route.POST(request({ method: "POST", bearer: MCP_TOKEN, origin: null, body: { target: "production" } }));
    expect(res.status).toBe(200);
    expect(readAutoProduction).toHaveBeenCalledWith("shop");
    expect(recordProjectDeploy.mock.calls[0][1]).toMatchObject({ by: "agent", target: "production" });
  });

  it("RESERVES its slot before deploying, so two calls that arrive together cannot both pass", async () => {
    await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "production", confirm: true } }));
    expect(reserveProductionSlot).toHaveBeenCalledWith("shop");
    expect(reserveProductionSlot.mock.invocationCallOrder[0])
      .toBeLessThan(deployProject.mock.invocationCallOrder[0]);
  });

  it("is rate limited per project, and the refusal says when", async () => {
    const nextAt = Date.now() + 3_600_000;
    reserveProductionSlot.mockResolvedValue({ ok: false, nextAt });
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "production", confirm: true } }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
    expect(body.nextAt).toBe(nextAt);
    expect(deployProject).not.toHaveBeenCalled();
  });

  it("gives the slot back when nothing was deployed", async () => {
    // The counter bounds DEPLOYMENTS, not attempts: a wrong token must not lock
    // the owner out of their own domain for an hour after three instant
    // failures.
    deployProject.mockResolvedValue({ ok: false, code: "auth", detail: "insufficient scope" });
    await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "production", confirm: true } }));
    expect(releaseProductionSlot).toHaveBeenCalledWith("shop", 1_000);
  });

  it("does NOT rate limit a preview — that bound is about a domain people are on", async () => {
    expect((await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "preview" } }))).status).toBe(200);
    expect(reserveProductionSlot).not.toHaveBeenCalled();
    expect(releaseProductionSlot).not.toHaveBeenCalled();
  });
});

describe("what a caller may name", () => {
  it("never names a Vercel project — only a coding project", async () => {
    await route.POST(request({
      method: "POST", bearer: MCP_TOKEN, origin: null,
      body: { target: "preview", directory: "/home/clawbox/projects/shop", vercelProjectId: "prj_evil", teamId: "team_evil", token: "x" },
    }));
    // The link's project id is what was deployed to, and nothing from the body
    // reached the deployer.
    const sent = deployProject.mock.calls[0][0];
    expect(sent.scope).toBe("shop");
    expect(JSON.stringify(sent)).not.toContain("prj_evil");
    expect(JSON.stringify(sent)).not.toContain("team_evil");
  });

  it("refuses a target that is neither", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "staging" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_target");
  });

  it("refuses a folder that is not one of this box's projects", async () => {
    resolveProjectScope.mockResolvedValue(null);
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "preview" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("no_project");
  });
});

describe("a deploy pressed on a run", () => {
  it("is recorded on the run and followed by the watcher that already exists", async () => {
    await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "preview", runId: "run-1" } }));
    expect(recordManualDeployment).toHaveBeenCalledWith("run-1", expect.objectContaining({
      deployment: DEPLOYMENT, projectId: "prj_acme", target: "preview",
    }));
    expect(recordProjectDeploy.mock.calls[0][1]).toMatchObject({ runId: "run-1" });
  });

  it("refuses an unknown run before anything is sent", async () => {
    listRuns.mockReturnValue([]);
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "preview", runId: "run-9" } }));
    expect(res.status).toBe(404);
    expect(deployProject).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a deployment that is still building on that run", async () => {
    listRuns.mockReturnValue([{
      id: "run-1", projectId: null, directory: "/home/clawbox/projects/shop", pr: null,
      vercel: { phase: "building", deploymentId: "dpl_old", branch: "clawbox/run-1" },
    }]);
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "preview", runId: "run-1" } }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("deploy_in_flight");
    expect(deployProject).not.toHaveBeenCalled();
  });
});

describe("a deployment that is already real", () => {
  it("still answers 200 when the RUN record could not be written", async () => {
    // By that line the deployment is building on somebody's account. A 500
    // here would have the caller retry and deploy it a second time — for
    // production, building a live domain twice because a disk write hiccupped.
    recordManualDeployment.mockImplementation(() => { throw new Error("disk full"); });
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "preview", runId: "run-1" } }));
    expect(res.status).toBe(200);
    expect(recordProjectDeploy).toHaveBeenCalled();
  });
});

describe("what Vercel refused", () => {
  it("is a 502 with Vercel's own kind, not a 500", async () => {
    deployProject.mockResolvedValue({ ok: false, code: "auth", detail: "insufficient scope" });
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "preview" } }));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("auth");
    expect(recordProjectDeploy).not.toHaveBeenCalled();
  });

  it("is a 400 when this box decided it — the caller has something to fix", async () => {
    deployProject.mockResolvedValue({ ok: false, code: "no_remote", detail: "back it up to GitHub first" });
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { target: "preview" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("no_remote");
  });
});

describe("reading the state", () => {
  it("answers the owner and the agent alike, and says whether a link exists", async () => {
    for (const init of [{ cookie: ownerCookie() }, { bearer: MCP_TOKEN, origin: null as null }]) {
      const res = await route.GET(request(init));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ scope: "shop", linked: true, autoProduction: false });
    }
  });

  it("does NOT call Vercel unless there is a pending deployment to ask about", async () => {
    await route.GET(request({ cookie: ownerCookie() }));
    expect(readDeployment).not.toHaveBeenCalled();
    expect(readProject).not.toHaveBeenCalled();
  });

  it("refreshes a pending deployment and stores what it learned", async () => {
    const now = Date.now();
    readProjectDeploy.mockResolvedValue({
      latest: { target: "preview", phase: "building", projectId: "prj_acme", startedAt: now, by: "owner", deploymentId: "dpl_new" },
      productionAt: [],
    });
    readDeployment.mockResolvedValue({ ok: true, deployment: { ...DEPLOYMENT, readyState: "ready" } });
    await route.GET(request({ cookie: ownerCookie() }));
    expect(updateProjectDeploy).toHaveBeenCalledWith("shop", "dpl_new", expect.objectContaining({ phase: "ready" }));
  });

  it("asks Vercel for the project only when the domain was asked for", async () => {
    await route.GET(request({ cookie: ownerCookie(), query: "?directory=/home/clawbox/projects/shop&domain=1" }));
    expect(readProject).toHaveBeenCalled();
  });
});

describe("the switch itself", () => {
  it("refuses the MCP bearer — a tool that could turn it on would make the owner's answer temporary", async () => {
    const res = await route.PUT(request({ method: "PUT", bearer: MCP_TOKEN, origin: null, body: { autoProduction: true } }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(setAutoProduction).not.toHaveBeenCalled();
  });

  it("refuses another page in the owner's browser", async () => {
    const res = await route.PUT(request({ method: "PUT", cookie: ownerCookie(), origin: "http://evil.example", body: { autoProduction: true } }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(setAutoProduction).not.toHaveBeenCalled();
  });

  it("is the owner's to set from their own page", async () => {
    const res = await route.PUT(request({ method: "PUT", cookie: ownerCookie(), body: { autoProduction: true } }));
    expect(res.status).toBe(200);
    expect(setAutoProduction).toHaveBeenCalledWith("shop", true);
  });

  it("refuses anything that is not on or off", async () => {
    const res = await route.PUT(request({ method: "PUT", cookie: ownerCookie(), body: { autoProduction: "yes" } }));
    expect(res.status).toBe(400);
    expect(setAutoProduction).not.toHaveBeenCalled();
  });
});
