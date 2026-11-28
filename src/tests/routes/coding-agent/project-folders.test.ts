/**
 * /setup-api/coding-agent/project-folders (TASK-2757) — a project's folders,
 * for the Coding Agent app's Folders card and the assistant's
 * coding_project_* tools.
 *
 * The properties under test: the owner's cookie and the MCP bearer are both
 * admitted, a signed-in non-owner and a caller with neither are 403
 * `owner_only`, another site's page is 403 `cross_origin`; create, add and
 * remove answer the list as stored; and a refusal carries its `kind`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

const dirs = vi.hoisted(() => ({ projects: "" }));
vi.mock("@/lib/coding-agent", () => ({ getDefaultDirectory: async () => dirs.projects }));

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
const ALICE = { username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: "a1b2c3d4e5f60718" };

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let session: SessionFixture;
let restore: () => void;

type Auth = { cookie?: string; bearer?: string; origin?: string };

function request(method: "GET" | "POST", query: string, body: unknown, auth: Auth): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.origin !== undefined) headers.origin = auth.origin;
  return new Request(`http://localhost/setup-api/coding-agent/project-folders${query}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function userCookie(): string {
  const dataDir = path.join(session.root, "data");
  const configPath = path.join(dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.clawbox_users = [ALICE];
  fs.writeFileSync(configPath, JSON.stringify(config));
  const secret = fs.readFileSync(path.join(dataDir, ".session-secret"), "utf8");
  return `clawbox_session=${createSessionCookie(3600, secret, 0, { u: ALICE.username, sv: ALICE.sv })}`;
}

const owner = () => ({ cookie: session.cookie });
const agent = () => ({ bearer: MCP_TOKEN });

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  dirs.projects = path.join(session.root, "Projects");
  for (const name of ["gateway", "dashboard"]) fs.mkdirSync(path.join(dirs.projects, name, ".git"), { recursive: true });
  vi.resetModules();
  const route = await import("@/app/setup-api/coding-agent/project-folders/route");
  GET = route.GET;
  POST = route.POST;
});

afterEach(() => {
  session.cleanup();
  restore();
});

describe("who may", () => {
  it("admits the owner's cookie and the MCP bearer", async () => {
    expect((await GET(request("GET", "?project=gateway", undefined, owner()))).status).toBe(200);
    expect((await GET(request("GET", "?project=gateway", undefined, agent()))).status).toBe(200);
  });

  it("refuses a signed-in non-owner, a caller with neither, and another site's page", async () => {
    const asAlice = await POST(request("POST", "", { project: "gateway", action: "add", folder: "dashboard" }, { cookie: userCookie() }));
    expect(asAlice.status).toBe(403);
    expect(await asAlice.json()).toMatchObject({ kind: "owner_only" });
    expect((await POST(request("POST", "", { project: "gateway", action: "add", folder: "dashboard" }, {}))).status).toBe(403);
    const crossSite = await POST(request("POST", "", { project: "gateway", action: "add", folder: "dashboard" }, { ...owner(), origin: "https://evil.example" }));
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ kind: "cross_origin" });
    expect(await (await GET(request("GET", "?project=gateway", undefined, owner()))).json()).toEqual({ project: "gateway", folders: [] });
  });
});

describe("create, add, remove", () => {
  it("creates a project with its own folder and answers each change with the list as stored", async () => {
    const made = await POST(request("POST", "", { project: "skyhub", action: "create", folders: ["gateway", "dashboard"] }, agent()));
    expect(made.status).toBe(200);
    expect(await made.json()).toEqual({ project: "skyhub", folders: [{ folder: "gateway" }, { folder: "dashboard" }] });
    expect(fs.statSync(path.join(dirs.projects, "skyhub")).isDirectory()).toBe(true);
    const removed = await POST(request("POST", "", { project: "skyhub", action: "remove", folder: "gateway" }, owner()));
    expect(await removed.json()).toEqual({ project: "skyhub", folders: [{ folder: "dashboard" }] });
    const all = await GET(request("GET", "", undefined, agent()));
    expect(await all.json()).toEqual({ projects: [{ project: "skyhub", folders: [{ folder: "dashboard" }] }] });
  });

  it("adds a folder to a project's page with the project's own repository first", async () => {
    const added = await POST(request("POST", "", { project: "gateway", action: "add", folder: "dashboard", base: "develop" }, owner()));
    expect(await added.json()).toEqual({ project: "gateway", folders: [{ folder: "gateway" }, { folder: "dashboard", base: "develop" }] });
  });

  it("answers a refusal with its kind", async () => {
    const notRepo = await POST(request("POST", "", { project: "gateway", action: "add", folder: "missing" }, owner()));
    expect(notRepo.status).toBe(400);
    expect(await notRepo.json()).toMatchObject({ kind: "not_a_repository" });
    await POST(request("POST", "", { project: "skyhub", action: "create", folders: ["gateway"] }, owner()));
    const twice = await POST(request("POST", "", { project: "skyhub", action: "create", folders: ["dashboard"] }, owner()));
    expect(twice.status).toBe(409);
    const unknown = await POST(request("POST", "", { project: "skyhub", action: "rename" }, owner()));
    expect(unknown.status).toBe(400);
    const notListed = await POST(request("POST", "", { project: "skyhub", action: "remove", folder: "dashboard" }, owner()));
    expect(notListed.status).toBe(404);
  });
});
