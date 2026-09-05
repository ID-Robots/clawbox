/**
 * POST /setup-api/coding-agent/projects/import and
 * GET /setup-api/coding-agent/github-repos — the doors in front of
 * project-import.ts. Owner-only (the agent's bearer is refused), and the
 * import our page only: it writes into the owner's folder with the owner's
 * GitHub credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const importFolder = vi.hoisted(() => vi.fn());
const importGitHubRepo = vi.hoisted(() => vi.fn());
const listGitHubRepos = vi.hoisted(() => vi.fn());
vi.mock("@/lib/project-import", () => ({ importFolder, importGitHubRepo, listGitHubRepos }));
const listProjects = vi.hoisted(() => vi.fn());
const getDefaultDirectory = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", () => ({ listProjects, getDefaultDirectory }));

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";

let POST: (req: Request) => Promise<Response>;
let GET: (req: Request) => Promise<Response>;
let session: SessionFixture;
let restore: () => void;

function post(body: unknown, auth?: { cookie?: string; bearer?: string; origin?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (auth?.cookie) headers.cookie = auth.cookie;
  if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth?.origin !== undefined) headers.origin = auth.origin;
  return new Request("http://localhost/setup-api/coding-agent/projects/import", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function get(auth?: { cookie?: string; bearer?: string }): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (auth?.cookie) headers.cookie = auth.cookie;
  if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  return new Request("http://localhost/setup-api/coding-agent/github-repos", { headers });
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  getDefaultDirectory.mockResolvedValue("/home/clawbox/Projects");
  listProjects.mockResolvedValue({ directory: "/home/clawbox/Projects", projects: [{ folder: "old-site", directory: "/home/clawbox/Projects/old-site", name: "old-site" }] });
  importFolder.mockResolvedValue({ ok: true, directory: "/home/clawbox/Projects/old-site", folder: "old-site", initialized: true, skipped: ["node_modules"] });
  importGitHubRepo.mockResolvedValue({ ok: true, directory: "/home/clawbox/Projects/old-site", folder: "old-site", initialized: false, skipped: [] });
  listGitHubRepos.mockResolvedValue({ ok: true, login: "yalexx", repos: [], truncated: false });
  POST = (await import("@/app/setup-api/coding-agent/projects/import/route")).POST;
  GET = (await import("@/app/setup-api/coding-agent/github-repos/route")).GET;
});

afterEach(() => {
  session.cleanup();
  restore();
});

describe("the import's gates", () => {
  it("refuses the agent's bearer and no session at all", async () => {
    expect((await POST(post({ source: "folder", path: "/x" }, { bearer: MCP_TOKEN }))).status).toBe(403);
    expect(await (await POST(post({ source: "folder", path: "/x" }, { bearer: MCP_TOKEN }))).json()).toMatchObject({ kind: "owner_only" });
    expect((await POST(post({ source: "folder", path: "/x" }))).status).toBe(403);
    expect(importFolder).not.toHaveBeenCalled();
  });

  it("refuses another site's page, even with the owner's cookie", async () => {
    const res = await POST(post({ source: "folder", path: "/x" }, { cookie: session.cookie, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "cross_origin" });
    expect(importFolder).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, and a source it does not know", async () => {
    expect((await POST(post("{nope", { cookie: session.cookie, origin: "http://localhost" }))).status).toBe(400);
    const res = await POST(post({ source: "ftp" }, { cookie: session.cookie, origin: "http://localhost" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: "invalid" });
    expect((await POST(post({ source: "github" }, { cookie: session.cookie, origin: "http://localhost" }))).status).toBe(400);
    expect((await POST(post({ source: "folder" }, { cookie: session.cookie, origin: "http://localhost" }))).status).toBe(400);
  });
});

describe("the import", () => {
  it("copies a folder and answers the project's row", async () => {
    const res = await POST(post({ source: "folder", path: "~/old-site" }, { cookie: session.cookie, origin: "http://localhost" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      project: { folder: "old-site", directory: "/home/clawbox/Projects/old-site", name: "old-site" },
      directory: "/home/clawbox/Projects/old-site", folder: "old-site", initialized: true, skipped: ["node_modules"],
    });
    expect(importFolder).toHaveBeenCalledWith({ source: "~/old-site", projectsRoot: "/home/clawbox/Projects" });
  });

  it("clones a repository", async () => {
    const res = await POST(post({ source: "github", repo: "yalexx/old-site" }, { cookie: session.cookie, origin: "http://localhost" }));
    expect(res.status).toBe(200);
    expect(importGitHubRepo).toHaveBeenCalledWith({ fullName: "yalexx/old-site", projectsRoot: "/home/clawbox/Projects" });
  });

  it("maps every refusal to its status, with the sentence for the owner", async () => {
    const cases: [string, number][] = [
      ["no_project_folder", 409], ["invalid", 400], ["exists", 409], ["not_found", 404], ["not_a_folder", 400],
      ["refused", 403], ["too_big", 413], ["no_space", 507], ["no_gh", 409], ["not_connected", 409], ["gh_unreachable", 503], ["failed", 500],
    ];
    for (const [reason, status] of cases) {
      importFolder.mockResolvedValueOnce({ ok: false, reason, detail: `because ${reason}` });
      const res = await POST(post({ source: "folder", path: "/x" }, { cookie: session.cookie, origin: "http://localhost" }));
      expect(res.status, reason).toBe(status);
      expect(await res.json()).toEqual({ error: `because ${reason}`, kind: reason });
    }
  });
});

describe("the repositories listing", () => {
  it("is the owner's alone", async () => {
    expect((await GET(get({ bearer: MCP_TOKEN }))).status).toBe(403);
    expect((await GET(get())).status).toBe(403);
    expect(listGitHubRepos).not.toHaveBeenCalled();
  });

  it("answers the list, and each refusal with its status", async () => {
    listGitHubRepos.mockResolvedValueOnce({ ok: true, login: "yalexx", repos: [{ fullName: "yalexx/a" }], truncated: true });
    const ok = await GET(get({ cookie: session.cookie }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ login: "yalexx", repos: [{ fullName: "yalexx/a" }], truncated: true });
    for (const [reason, status] of [["not_connected", 409], ["no_gh", 409], ["gh_unreachable", 503], ["failed", 500]] as const) {
      listGitHubRepos.mockResolvedValueOnce({ ok: false, reason, detail: "why" });
      const res = await GET(get({ cookie: session.cookie }));
      expect(res.status, reason).toBe(status);
      expect(await res.json()).toEqual({ error: "why", kind: reason });
    }
  });
});
