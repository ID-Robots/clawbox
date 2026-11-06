/**
 * /setup-api/apps/publish — the owner's "Publish to ClawBox Store". The
 * owner's session from the box's own pages, or the agent's bearer; a project
 * only by the Coding Agent's own listing; every refusal with its own status
 * (never 401), code and sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const listProjects = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", () => ({ listProjects }));
const publishProject = vi.hoisted(() => vi.fn());
const storePublishStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store-publish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store-publish")>()),
  publishProject,
  storePublishStatus,
}));

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
let route: typeof import("@/app/setup-api/apps/publish/route");
let session: SessionFixture;
let restore: () => void;
let project: string;

type Auth = { cookie?: string; bearer?: string; origin?: string };

function request(method: "GET" | "POST", query: string, body: unknown, auth: Auth = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.origin !== undefined) headers.origin = auth.origin;
  return new Request(`http://localhost/setup-api/apps/publish${query}`, {
    method,
    headers,
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

const status = { linked: true, canPublish: true, apps: [], upgradeUrl: "https://portal.example/portal/apps", portalUrl: "https://portal.example" };

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  project = fs.mkdtempSync(path.join(os.tmpdir(), "publish-route-"));
  fs.writeFileSync(path.join(project, "clawbox.json"), JSON.stringify({ name: "Tinder Clone", description: "Swipe" }));
  vi.resetModules();
  vi.clearAllMocks();
  listProjects.mockResolvedValue({ directory: path.dirname(project), projects: [{ folder: path.basename(project), directory: project, name: "Tinder Clone" }] });
  storePublishStatus.mockResolvedValue(status);
  route = await import("@/app/setup-api/apps/publish/route");
});

afterEach(() => {
  session.cleanup();
  restore();
  fs.rmSync(project, { recursive: true, force: true });
});

const owner = (): Auth => ({ cookie: session.cookie, origin: "http://localhost" });

describe("who may publish", () => {
  it("refuses a caller with no session", async () => {
    const res = await route.POST(request("POST", "", { projectId: "x", version: "1.0.0" }));
    expect(res.status).toBe(401);
    expect(publishProject).not.toHaveBeenCalled();
  });

  it("refuses the owner's cookie from another site's page", async () => {
    const res = await route.POST(request("POST", "", { projectId: path.basename(project), version: "1.0.0" }, { cookie: session.cookie, origin: "https://elsewhere.example" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, code: "cross_origin" });
    expect(publishProject).not.toHaveBeenCalled();
  });

  it("takes the agent's bearer, so app_publish works from chat", async () => {
    publishProject.mockResolvedValue({ ok: true, app: { slug: "tinder-clone" }, created: true, storeUrl: "https://portal.example/portal/apps" });
    const res = await route.POST(request("POST", "", { projectId: path.basename(project), version: "1.0.0" }, { bearer: MCP_TOKEN }));
    expect(res.status).toBe(201);
  });
});

describe("POST", () => {
  it("publishes one of the owner's projects, found through the listing", async () => {
    publishProject.mockResolvedValue({ ok: true, app: { slug: "tinder-clone", version: "1.0.0" }, created: false, storeUrl: "https://portal.example/portal/apps" });
    const res = await route.POST(request("POST", "", { projectId: path.basename(project), version: " 1.0.0 ", description: "Swipe", iconUrl: "https://i.example/x.png", slug: "tinder" }, owner()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, app: { slug: "tinder-clone", version: "1.0.0" }, created: false, storeUrl: "https://portal.example/portal/apps" });
    const [id, input, resolve] = publishProject.mock.calls[0];
    expect(id).toBe(path.basename(project));
    expect(input).toEqual({ version: "1.0.0", description: "Swipe", iconUrl: "https://i.example/x.png", slug: "tinder" });
    expect(await resolve(path.basename(project))).toEqual({ folder: path.basename(project), directory: project });
  });

  it("is 404 for a project the listing does not have, before anything is packed", async () => {
    const res = await route.POST(request("POST", "", { projectId: "not-listed", version: "1.0.0" }, owner()));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "not_found" });
    expect(publishProject).not.toHaveBeenCalled();
  });

  describe("one name, two projects (a folder and a code project)", () => {
    const codeProject = () => path.join(os.tmpdir(), "code-projects", path.basename(project));
    beforeEach(() => {
      listProjects.mockResolvedValue({
        directory: path.dirname(project),
        projects: [
          { folder: path.basename(project), directory: project, name: "Tinder Clone" },
          { folder: path.basename(project), directory: codeProject(), name: "Other" },
        ],
      });
    });

    it("refuses to guess which one a bare name means", async () => {
      const res = await route.POST(request("POST", "", { projectId: path.basename(project), version: "1.0.0" }, owner()));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, code: "invalid", field: "projectId" });
      expect(publishProject).not.toHaveBeenCalled();
    });

    it("publishes exactly the row's project when its directory is named", async () => {
      publishProject.mockResolvedValue({ ok: true, app: { slug: "other" }, created: true, storeUrl: "https://portal.example/portal/apps" });
      const res = await route.POST(request("POST", "", { projectId: path.basename(project), directory: codeProject(), version: "1.0.0" }, owner()));
      expect(res.status).toBe(201);
      const resolve = publishProject.mock.calls[0][2];
      expect(await resolve(path.basename(project))).toEqual({ folder: path.basename(project), directory: codeProject() });
    });

    it("answers the status for the row's project too", async () => {
      const res = await route.GET(request("GET", `?projectId=${encodeURIComponent(path.basename(project))}&directory=${encodeURIComponent(project)}`, undefined, owner()));
      expect(res.status).toBe(200);
      expect((await res.json()).project).toMatchObject({ name: "Tinder Clone" });
      const bare = await route.GET(request("GET", `?projectId=${encodeURIComponent(path.basename(project))}`, undefined, owner()));
      expect(bare.status).toBe(400);
    });
  });

  it("answers a refusal with its own status and body — coming_soon with the upgrade page", async () => {
    publishProject.mockResolvedValue({ ok: false, code: "coming_soon", message: "Soon.", status: 403, retryable: false, upgradeUrl: "https://portal.example/portal/apps" });
    const res = await route.POST(request("POST", "", { projectId: path.basename(project), version: "1.0.0" }, owner()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, code: "coming_soon", message: "Soon.", retryable: false, upgradeUrl: "https://portal.example/portal/apps" });
  });

  it.each([
    ["not JSON", "{", undefined],
    ["no project", { version: "1.0.0" }, "projectId"],
    ["a path for a project", { projectId: "../etc", version: "1.0.0" }, "projectId"],
    ["no version", { projectId: "x" }, "version"],
    ["a description that is not text", { projectId: "x", version: "1.0.0", description: 7 }, "description"],
  ])("refuses %s with 400", async (_what, body, field) => {
    const res = await route.POST(request("POST", "", body, owner()));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toMatchObject({ ok: false, code: "invalid" });
    if (field) expect(data.field).toBe(field);
    expect(publishProject).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("says whether the box can publish", async () => {
    const res = await route.GET(request("GET", "", undefined, owner()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...status });
  });

  it("for a project: its name, slug, and the version after the Store's", async () => {
    storePublishStatus.mockResolvedValue({ ...status, apps: [{ slug: "tinder-clone", version: "1.4.2" }] });
    const res = await route.GET(request("GET", `?projectId=${encodeURIComponent(path.basename(project))}`, undefined, owner()));
    expect((await res.json()).project).toEqual({
      projectId: path.basename(project),
      name: "Tinder Clone",
      slug: "tinder-clone",
      description: "Swipe",
      kind: "webapp",
      published: { version: "1.4.2" },
      suggestedVersion: "1.4.3",
    });
  });

  it("starts a project the Store does not have at 1.0.0", async () => {
    const res = await route.GET(request("GET", `?projectId=${encodeURIComponent(path.basename(project))}`, undefined, owner()));
    expect((await res.json()).project).toMatchObject({ published: null, suggestedVersion: "1.0.0" });
  });

  it("is 404 for a project the listing does not have, 422 for one without a manifest", async () => {
    expect((await route.GET(request("GET", "?projectId=nope", undefined, owner()))).status).toBe(404);
    fs.rmSync(path.join(project, "clawbox.json"));
    const res = await route.GET(request("GET", `?projectId=${encodeURIComponent(path.basename(project))}`, undefined, owner()));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, code: "no_manifest" });
  });
});
